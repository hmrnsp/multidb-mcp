import { describe, expect, it } from 'vitest';
import { DbError } from '../../src/adapters/errors.js';
import type {
  ExcessRows,
  MysqlConnLike,
  MysqlPoolFactory,
  MysqlPoolSettings,
  MysqlRunResult,
} from '../../src/adapters/mysql/driver-types.js';
import { MysqlAdapter } from '../../src/adapters/mysql/mysql-adapter.js';
import type { MysqlFlavor } from '../../src/adapters/mysql/sql.js';
import type { ResolvedSource } from '../../src/config/loader.js';
import { Secret } from '../../src/config/secret.js';
import { createLogger } from '../../src/observability/logger.js';

const silent = createLogger({ write: () => undefined });

type QueryHandler = (sql: string, params: readonly unknown[]) => Record<string, unknown>[] | Error;
type RunHandler = (
  sql: string,
  params: readonly unknown[],
  maxRows: number,
  excess: ExcessRows,
) => MysqlRunResult | Error | Promise<MysqlRunResult>;

const THREAD_ID = 77;

/** A fake pool that records every command, so the transaction order can be checked. */
class FakeDriver {
  readonly log: string[] = [];
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  readonly releases: boolean[] = [];
  readonly kills: number[] = [];
  settings: MysqlPoolSettings | undefined;
  ended = 0;
  loads = 0;
  version = '8.4.13';
  database: string | null = 'app';
  failConnect: Error | undefined;
  onQuery: QueryHandler = () => [];
  onRun: RunHandler = () => result([], []);
  onKill: () => void = () => undefined;

  factory: MysqlPoolFactory = (settings) => {
    this.settings = settings;
    return {
      getConnection: () =>
        this.failConnect ? Promise.reject(this.failConnect) : Promise.resolve(this.conn()),
      killQuery: (threadId) => {
        this.kills.push(threadId);
        this.onKill();
        return Promise.resolve();
      },
      end: () => {
        this.ended += 1;
        return Promise.resolve();
      },
    };
  };

  load = (): Promise<MysqlPoolFactory> => {
    this.loads += 1;
    return Promise.resolve(this.factory);
  };

  conn(): MysqlConnLike {
    return {
      threadId: THREAD_ID,
      query: (sql, params = []) => {
        const head = sql.trim().split('\n')[0]!.trim();
        this.log.push(head);
        this.queries.push({ sql, params });
        if (sql.includes('VERSION()')) {
          return Promise.resolve([{ version: this.version, db: this.database }]);
        }
        const out = this.onQuery(sql, params);
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
      },
      run: async (sql, params, maxRows, excess) => {
        this.log.push(`RUN max=${maxRows} ${excess}`);
        const out = await this.onRun(sql, params, maxRows, excess);
        if (out instanceof Error) throw out;
        return out;
      },
      reset: () => {
        this.log.push('RESET');
        return Promise.resolve();
      },
      release: (destroy) => {
        this.releases.push(destroy === true);
      },
    };
  }
}

function result(
  fields: string[],
  rows: unknown[][],
  extra: Partial<MysqlRunResult> = {},
): MysqlRunResult {
  return { fields, rows, affectedRows: null, aborted: false, ...extra };
}

function rows(n: number): unknown[][] {
  return Array.from({ length: n }, (_, i) => [i + 1, `row ${i + 1}`]);
}

function mysqlError(
  errno: number,
  message = 'message',
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(message), { errno, ...extra });
}

function source(extra: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    id: 'local_mysql',
    driver: 'mysql',
    env: 'local',
    description: 'test',
    connection: new Secret('mysql://dev:hunter@127.0.0.1:53306/app'),
    access: ['read', 'insert', 'update', 'delete', 'ddl', 'call'],
    readonly: false,
    limits: { maxRows: 200, timeoutSec: 30, maxChars: 40_000 },
    schemas: undefined,
    lazy: true,
    baseDir: process.cwd(),
    ...extra,
  };
}

function adapterFor(
  driver: FakeDriver,
  flavor: MysqlFlavor = 'mysql',
  extra: Partial<ResolvedSource> = {},
): MysqlAdapter {
  return new MysqlAdapter(source(extra), silent, {
    flavor,
    loadPoolFactory: driver.load,
    watchdogGraceMs: 0,
  });
}

async function connected(
  driver: FakeDriver,
  flavor: MysqlFlavor = 'mysql',
  extra: Partial<ResolvedSource> = {},
) {
  if (flavor === 'mariadb') driver.version = '11.4.13-MariaDB-ubu2404';
  const adapter = adapterFor(driver, flavor, extra);
  await adapter.connect();
  driver.log.length = 0;
  driver.queries.length = 0;
  driver.releases.length = 0;
  return adapter;
}

async function errorOf(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DbError) return err;
    throw err;
  }
  throw new Error('no error');
}

const ro = { readonly: true, maxRows: 200, timeoutSec: 30 };
const rw = { readonly: false, maxRows: 200, timeoutSec: 30 };

describe('MysqlAdapter: connection', () => {
  it('loads the driver once, creates the pool, then checks the version and default database', async () => {
    const driver = new FakeDriver();
    const adapter = adapterFor(driver);
    await adapter.connect();
    await adapter.connect();
    expect(driver.loads).toBe(1);
    expect(driver.settings?.uri).toBe('mysql://dev:hunter@127.0.0.1:53306/app');
    expect(driver.settings?.connectionLimit).toBe(4);
    expect(driver.log).toEqual(['SELECT VERSION() AS version, DATABASE() AS db']);
    expect(driver.releases).toEqual([false]);
    expect(adapter.dialect).toBe('mysql');
  });

  it('a driver in the config that does not match the server: a connection error that names the fix', async () => {
    const driver = new FakeDriver();
    driver.version = '11.4.13-MariaDB';
    const err = await errorOf(adapterFor(driver, 'mysql').connect());
    expect(err.kind).toBe('connection');
    expect(err.message).toContain('MariaDB 11.4.13-MariaDB');
    expect(err.message).toContain('Change the driver to "mariadb"');
    expect(driver.ended).toBe(1);

    const reverse = new FakeDriver();
    const err2 = await errorOf(adapterFor(reverse, 'mariadb').connect());
    expect(err2.message).toContain('Change the driver to "mysql"');
  });

  it('the default database must be in the schemas whitelist (case-insensitive)', async () => {
    const outside = new FakeDriver();
    const err = await errorOf(adapterFor(outside, 'mysql', { schemas: ['other'] }).connect());
    expect(err.kind).toBe('connection');
    expect(err.message).toContain('(app) is not in "schemas" (other)');

    await adapterFor(new FakeDriver(), 'mysql', { schemas: ['APP'] }).connect();

    const noDefault = new FakeDriver();
    noDefault.database = null;
    await adapterFor(noDefault, 'mysql', { schemas: ['other'] }).connect();
  });

  it('failed connection: the pool is closed, a classified error, and it can be retried', async () => {
    const driver = new FakeDriver();
    driver.failConnect = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:53306'), {
      code: 'ECONNREFUSED',
    });
    const adapter = adapterFor(driver);
    expect((await errorOf(adapter.connect())).kind).toBe('connection');
    expect(driver.ended).toBe(1);

    driver.failConnect = undefined;
    await adapter.connect();
    expect(driver.loads).toBe(2);
  });

  it('a refused login (1045) and a missing database (1049) count as connection errors', async () => {
    for (const errno of [1045, 1049]) {
      const driver = new FakeDriver();
      driver.failConnect = mysqlError(errno, "Access denied for user 'dev'");
      expect((await errorOf(adapterFor(driver).connect())).kind).toBe('connection');
    }
  });

  it('the driver cannot be prepared (e.g. a wrong URL): a clear message without credentials', async () => {
    const adapter = new MysqlAdapter(source(), silent, {
      flavor: 'mysql',
      loadPoolFactory: () =>
        Promise.resolve(() => {
          throw new Error(
            'Parameter "multipleStatements" in the connection string is not supported',
          );
        }),
    });
    const err = await errorOf(adapter.connect());
    expect(err.kind).toBe('connection');
    expect(err.message).toContain('MySQL driver (mysql2) could not be prepared');
    expect(err.message).not.toContain('hunter');
  });

  it('close ends the pool; later operations are rejected', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    await adapter.close();
    expect(driver.ended).toBe(1);
    const err = await errorOf(adapter.execute('SELECT 1', [], ro));
    expect(err.kind).toBe('connection');
    expect(err.message).toContain('not connected yet');
  });
});

describe('MysqlAdapter: execute', () => {
  it('read-only MySQL: timeout ms, START TRANSACTION READ ONLY, maxRows+1 then ROLLBACK', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () => result(['id', 'name'], rows(3));
    const out = await adapter.execute('SELECT id, name FROM t', [], ro);
    expect(driver.log).toEqual([
      'SET SESSION max_execution_time = 30000',
      'START TRANSACTION READ ONLY',
      'RUN max=200 abort',
      'ROLLBACK',
    ]);
    expect(driver.releases).toEqual([false]);
    expect(out.columns).toEqual(['id', 'name']);
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(false);
    expect(out.affectedRows).toBeUndefined();
  });

  it('MariaDB: timeout through max_statement_time in seconds', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver, 'mariadb');
    await adapter.execute('SELECT 1', [], ro);
    expect(driver.log[0]).toBe('SET SESSION max_statement_time = 30');
    expect(adapter.dialect).toBe('mariadb');
  });

  it('a read-only result over the limit: the connection is dropped and the query is KILLed', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = (_sql, _params, maxRows) =>
      result(['id', 'name'], rows(maxRows + 1), { aborted: true });
    const out = await adapter.execute('SELECT * FROM big_table', [], ro);
    expect(out.rows).toHaveLength(200);
    expect(out.truncated).toBe(true);
    expect(driver.kills).toEqual([THREAD_ID]);
    expect(driver.log).not.toContain('ROLLBACK');
    expect(driver.releases).toEqual([true]);
  });

  it('read-write: rows are read to the end, COMMIT, connection reset; DML reports affectedRows', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () => result([], [], { affectedRows: 3 });
    const out = await adapter.execute('UPDATE t SET a = 1', [], rw);
    expect(driver.log).toEqual([
      'SET SESSION max_execution_time = 30000',
      'START TRANSACTION',
      'RUN max=200 drain',
      'COMMIT',
      'RESET',
    ]);
    expect(out.affectedRows).toBe(3);
    expect(out.columns).toEqual([]);
    expect(driver.releases).toEqual([false]);
  });

  it('read-write with a result over maxRows: still COMMIT, marked truncated', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = (_sql, _params, maxRows) => result(['id'], rows(maxRows + 1));
    const out = await adapter.execute('DELETE FROM t RETURNING id', [], { ...rw, maxRows: 5 });
    expect(out.rows).toHaveLength(5);
    expect(out.truncated).toBe(true);
    expect(driver.log).toContain('COMMIT');
    expect(driver.kills).toEqual([]);
  });

  it('query error: ROLLBACK, reset, a classified error, the connection is returned', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () => mysqlError(1146, "Table 'app.x' doesn't exist", { sqlState: '42S02' });
    const err = await errorOf(adapter.execute('SELECT * FROM x', [], rw));
    expect(err.kind).toBe('not_found');
    expect(err.sqlState).toBe('42S02');
    expect(driver.log.slice(-2)).toEqual(['ROLLBACK', 'RESET']);
    expect(driver.releases).toEqual([false]);
  });

  it('a connection broken mid-query: the connection is discarded without ROLLBACK', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () =>
      Object.assign(new Error('Connection lost'), {
        code: 'PROTOCOL_CONNECTION_LOST',
        fatal: true,
      });
    expect((await errorOf(adapter.execute('SELECT 1', [], ro))).kind).toBe('connection');
    expect(driver.log).not.toContain('ROLLBACK');
    expect(driver.releases).toEqual([true]);
  });

  it('watchdog: a query past the timeout is KILLed and reported as a timeout', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    let interrupt: (err: Error) => void = () => undefined;
    driver.onRun = () =>
      new Promise<MysqlRunResult>((_resolve, reject) => {
        interrupt = reject;
      });
    driver.onKill = () => interrupt(mysqlError(1317, 'Query execution was interrupted'));
    const err = await errorOf(
      adapter.execute('UPDATE t SET a = SLEEP(10)', [], { ...rw, timeoutSec: 0.01 }),
    );
    expect(err.kind).toBe('timeout');
    expect(driver.kills).toEqual([THREAD_ID]);
    expect(driver.releases).toEqual([true]);
    expect(driver.log).not.toContain('RESET');
  });

  it('a server timeout (MySQL 3024, MariaDB 1969) becomes a timeout', async () => {
    for (const errno of [3024, 1969]) {
      const driver = new FakeDriver();
      const adapter = await connected(driver);
      driver.onRun = () => mysqlError(errno, 'maximum statement execution time exceeded');
      expect((await errorOf(adapter.execute('SELECT 1', [], ro))).kind).toBe('timeout');
      expect(driver.releases).toEqual([false]);
    }
  });

  it('parameters are passed on as they are', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    let seen: readonly unknown[] = [];
    driver.onRun = (_sql, params) => {
      seen = params;
      return result(['n'], [[1]]);
    };
    await adapter.execute('SELECT ? + ?', [1, 'two'], ro);
    expect(seen).toEqual([1, 'two']);
  });
});

describe('MysqlAdapter: catalog', () => {
  it('listTables: read-only transaction, parameters, lower-case whitelist, and LIMIT', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver, 'mysql', { schemas: ['App', 'Other'] });
    driver.onQuery = (sql) =>
      sql.includes('information_schema.TABLES')
        ? [
            { schema_name: 'app', table_name: 'orders', table_type: 'table' },
            { schema_name: 'app', table_name: 'v_sum', table_type: 'view' },
          ]
        : [];
    const tables = await adapter.listTables({ schema: 'app', search: 'ord', limit: 201 });
    expect(tables).toEqual([
      { schema: 'app', name: 'orders', type: 'table' },
      { schema: 'app', name: 'v_sum', type: 'view' },
    ]);
    expect(driver.log[0]).toBe('SET SESSION max_execution_time = 30000');
    expect(driver.log[1]).toBe('START TRANSACTION READ ONLY');
    expect(driver.log.at(-1)).toBe('ROLLBACK');
    const catalog = driver.queries.find((q) => q.sql.includes('information_schema.TABLES'))!;
    expect(catalog.params).toEqual(['app', 'app', 'ord', 'ord', 'app', 'other']);
    expect(catalog.sql).toContain('LOWER(TABLE_SCHEMA) IN (?, ?)');
    expect(catalog.sql).toContain('LIMIT 201');
  });

  it('listTables rejects a LIMIT that is not a positive integer', async () => {
    const adapter = await connected(new FakeDriver());
    await expect(adapter.listTables({ limit: 0 })).rejects.toThrow('Invalid LIMIT');
  });

  it('describeTable: columns, defaults, PK, FK, and indexes grouped', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver, 'mariadb');
    driver.onQuery = (sql) => {
      if (sql.includes('information_schema.TABLES')) {
        return [
          {
            schema_name: 'app',
            table_name: 'orders',
            table_type: 'table',
            exact_name: 0,
            in_default: 1,
          },
        ];
      }
      if (sql.includes('information_schema.COLUMNS')) {
        return [
          {
            column_name: 'id',
            column_type: 'int(11)',
            is_nullable: 'NO',
            column_default: null,
            extra: 'auto_increment',
            generation_expression: null,
          },
          {
            column_name: 'nik',
            column_type: 'char(16)',
            is_nullable: 'YES',
            column_default: 'NULL',
            extra: '',
            generation_expression: null,
          },
          {
            column_name: 'notes',
            column_type: 'varchar(10)',
            is_nullable: 'YES',
            column_default: "'NULL'",
            extra: '',
            generation_expression: null,
          },
          {
            column_name: 'total2',
            column_type: 'decimal(12,2)',
            is_nullable: 'YES',
            column_default: null,
            extra: 'VIRTUAL GENERATED',
            generation_expression: '`total` * 2',
          },
          {
            column_name: 'created',
            column_type: 'timestamp',
            is_nullable: 'NO',
            column_default: 'current_timestamp()',
            extra: '',
            generation_expression: null,
          },
        ];
      }
      if (sql.includes("CONSTRAINT_NAME = 'PRIMARY'")) return [{ column_name: 'id' }];
      if (sql.includes('REFERENCED_TABLE_NAME IS NOT NULL')) {
        return [
          {
            constraint_name: 'fk_a',
            column_name: 'a1',
            ref_schema: 'app',
            ref_table: 'x',
            ref_column: 'id1',
          },
          {
            constraint_name: 'fk_a',
            column_name: 'a2',
            ref_schema: 'app',
            ref_table: 'x',
            ref_column: 'id2',
          },
        ];
      }
      if (sql.includes('information_schema.STATISTICS')) {
        return [
          {
            index_name: 'PRIMARY',
            non_unique: 0,
            column_name: 'id',
            sub_part: null,
            expression: null,
          },
          {
            index_name: 'idx_name',
            non_unique: '1',
            column_name: 'name',
            sub_part: 10,
            expression: null,
          },
          {
            index_name: 'idx_name',
            non_unique: '1',
            column_name: 'city',
            sub_part: null,
            expression: null,
          },
          {
            index_name: 'idx_function',
            non_unique: 1,
            column_name: null,
            sub_part: null,
            expression: 'lower(`email`)',
          },
        ];
      }
      return [];
    };
    const detail = await adapter.describeTable('ORDERS');
    expect(detail.name).toBe('orders');
    expect(detail.columns.map((c) => [c.name, c.nullable, c.default])).toEqual([
      ['id', false, 'AUTO_INCREMENT'],
      ['nik', true, null],
      ['notes', true, "'NULL'"],
      ['total2', true, 'GENERATED ALWAYS AS (`total` * 2) VIRTUAL'],
      ['created', false, 'current_timestamp()'],
    ]);
    expect(detail.primaryKey).toEqual(['id']);
    expect(detail.foreignKeys).toEqual([
      {
        name: 'fk_a',
        columns: ['a1', 'a2'],
        refSchema: 'app',
        refTable: 'x',
        refColumns: ['id1', 'id2'],
      },
    ]);
    expect(detail.indexes).toEqual([
      { name: 'PRIMARY', columns: ['id'], unique: true },
      { name: 'idx_name', columns: ['name(10)', 'city'], unique: false },
      { name: 'idx_function', columns: ['(lower(`email`))'], unique: false },
    ]);
    // Follow-up catalog queries use the exact schema and name found by the search.
    const columnsQuery = driver.queries.find((q) => q.sql.includes('information_schema.COLUMNS'))!;
    expect(columnsQuery.params).toEqual(['app', 'orders']);
    expect(driver.queries.some((q) => q.sql.includes('NULL AS expression'))).toBe(true);
    expect(driver.log.at(-1)).toBe('ROLLBACK');
  });

  it('describeTable: not found, ambiguous, and candidate priority order', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    let candidates: Record<string, unknown>[] = [];
    driver.onQuery = (sql) => (sql.includes('information_schema.TABLES') ? candidates : []);

    expect((await errorOf(adapter.describeTable('x', 'app'))).message).toContain(
      '"x" not found in schema app',
    );

    const c = (schema: string, name: string, exact: number, inDefault: number) => ({
      schema_name: schema,
      table_name: name,
      table_type: 'table',
      exact_name: exact,
      in_default: inDefault,
    });
    candidates = [c('a', 'Orders', 0, 0), c('b', 'orders', 0, 0)];
    const ambiguous = await errorOf(adapter.describeTable('ORDERS'));
    expect(ambiguous.kind).toBe('ambiguous');
    expect(ambiguous.message).toContain('a.Orders, b.orders');

    candidates = [c('a', 'orders', 0, 0), c('app', 'orders', 0, 1)];
    expect((await adapter.describeTable('ORDERS')).schema).toBe('app');

    candidates = [c('b', 'Orders', 1, 0), c('app', 'orders', 0, 1)];
    expect((await adapter.describeTable('Orders')).schema).toBe('b');
  });
});
