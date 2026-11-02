import { describe, expect, it } from 'vitest';
import {
  Db2Adapter,
  formatColumnType,
  withCurrentSchema,
} from '../../src/adapters/db2/db2-adapter.js';
import type {
  Db2ConnLike,
  Db2PoolFactory,
  Db2PoolSettings,
  Db2RunResult,
} from '../../src/adapters/db2/driver-types.js';
import { DbError } from '../../src/adapters/errors.js';
import type { ResolvedSource } from '../../src/config/loader.js';
import { Secret } from '../../src/config/secret.js';
import { createLogger } from '../../src/observability/logger.js';

const silent = createLogger({ write: () => undefined });
const CONN = 'DATABASE=APPDB;HOSTNAME=127.0.0.1;PORT=55000;UID=u;PWD=hunter;';

type QueryHandler = (sql: string, params: readonly unknown[]) => Record<string, unknown>[] | Error;

/** A fake pool that records every command, so the transaction order can be checked. */
class FakeDriver {
  readonly log: string[] = [];
  readonly queries: { sql: string; params: readonly unknown[]; timeoutSec: number }[] = [];
  readonly releases: boolean[] = [];
  settings: Db2PoolSettings | undefined;
  closed = 0;
  failOpen: Error | undefined;
  failLoad: Error | undefined;
  onQuery: QueryHandler = () => [];
  onRun: () => Db2RunResult | Error = () => result([], []);

  load = (): Promise<Db2PoolFactory> =>
    this.failLoad ? Promise.reject(this.failLoad) : Promise.resolve(this.factory);

  factory: Db2PoolFactory = (settings) => {
    this.settings = settings;
    return {
      open: () => (this.failOpen ? Promise.reject(this.failOpen) : Promise.resolve(this.conn())),
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    };
  };

  conn(): Db2ConnLike {
    const step = (name: string) => {
      this.log.push(name);
      return Promise.resolve();
    };
    return {
      query: (sql, params, timeoutSec) => {
        this.log.push(sql.trim().split('\n')[0]!.trim());
        this.queries.push({ sql, params, timeoutSec });
        const out = this.onQuery(sql, params);
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
      },
      run: (_sql, _params, maxRows, timeoutSec) => {
        this.log.push(`RUN max=${maxRows} timeout=${timeoutSec}`);
        const out = this.onRun();
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
      },
      beginTransaction: () => step('BEGIN'),
      commit: () => step('COMMIT'),
      rollback: () => step('ROLLBACK'),
      release: (destroy) => {
        this.releases.push(destroy === true);
        return Promise.resolve();
      },
    };
  }
}

function result(
  fields: string[],
  rows: unknown[][],
  extra: Partial<Db2RunResult> = {},
): Db2RunResult {
  return { fields, rows, affectedRows: null, impreciseColumns: [], ...extra };
}

function source(extra: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    id: 'local_db2',
    driver: 'db2',
    env: 'local',
    description: 'test',
    connection: new Secret(CONN),
    access: ['read', 'insert', 'update', 'delete', 'ddl', 'call'],
    readonly: false,
    limits: { maxRows: 200, timeoutSec: 30, maxChars: 40_000 },
    schemas: undefined,
    lazy: true,
    baseDir: process.cwd(),
    ...extra,
  };
}

async function connected(driver: FakeDriver, extra: Partial<ResolvedSource> = {}) {
  const adapter = new Db2Adapter(source(extra), silent, { loadPoolFactory: driver.load });
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

describe('withCurrentSchema', () => {
  it('without a whitelist: the connection string as is', () => {
    expect(withCurrentSchema(CONN, undefined)).toBe(CONN);
  });

  it('whitelist: CurrentSchema of the first schema is added (upper case)', () => {
    expect(withCurrentSchema('DATABASE=X;UID=u', ['app', 'other'])).toBe(
      'DATABASE=X;UID=u;CurrentSchema=APP;',
    );
    expect(withCurrentSchema(CONN, ['APP'])).toBe(`${CONN}CurrentSchema=APP;`);
  });

  it('an existing CurrentSchema must be in the whitelist', () => {
    expect(withCurrentSchema(`${CONN}currentschema=app;`, ['APP'])).toBe(
      `${CONN}currentschema=app;`,
    );
    expect(() => withCurrentSchema(`${CONN}CurrentSchema=OTHER;`, ['APP'])).toThrow(
      /is not in "schemas"/,
    );
  });

  it('a schema name that is unsafe to splice in is rejected', () => {
    expect(() => withCurrentSchema(CONN, ['A;PWD=x'])).toThrow(/cannot be set as CurrentSchema/);
  });
});

describe('formatColumnType', () => {
  it('writes the type as in DDL', () => {
    expect(formatColumnType('DECIMAL', 12, 2)).toBe('DECIMAL(12,2)');
    expect(formatColumnType('VARCHAR', 100, 0)).toBe('VARCHAR(100)');
    expect(formatColumnType('CHARACTER', 16, 0)).toBe('CHARACTER(16)');
    expect(formatColumnType('INTEGER', 4, 0)).toBe('INTEGER');
    expect(formatColumnType('TIMESTAMP', 10, 6)).toBe('TIMESTAMP');
    expect(formatColumnType('TIMESTAMP', 13, 12)).toBe('TIMESTAMP(12)');
    expect(formatColumnType('DECFLOAT', 16, 0)).toBe('DECFLOAT(34)');
    expect(formatColumnType('BLOB', 1048576, 0)).toBe('BLOB(1048576)');
  });
});

describe('Db2Adapter: connection', () => {
  it('creates the pool with CurrentSchema from the whitelist, then checks the session', async () => {
    const driver = new FakeDriver();
    const adapter = new Db2Adapter(source({ schemas: ['APP'] }), silent, {
      loadPoolFactory: driver.load,
    });
    await adapter.connect();
    await adapter.connect();
    expect(driver.settings?.connectionString).toBe(`${CONN}CurrentSchema=APP;`);
    expect(driver.settings?.maxPoolSize).toBe(4);
    expect(driver.log).toEqual([
      'SELECT RTRIM(CURRENT SCHEMA) AS SCHEMA_NAME, RTRIM(CURRENT SERVER) AS SERVER_NAME',
    ]);
    expect(driver.releases).toEqual([false]);
  });

  it('driver cannot be loaded (libxml2.so.2): the message suggests the Docker image', async () => {
    const driver = new FakeDriver();
    driver.failLoad = new Error('libxml2.so.2: cannot open shared object file');
    const err = await errorOf(
      new Db2Adapter(source(), silent, { loadPoolFactory: driver.load }).connect(),
    );
    expect(err.kind).toBe('connection');
    expect(err.message).toContain('libxml2.so.2');
    expect(err.message).toContain('Docker image');
  });

  it('failed connection: the pool is closed, a connection error without credentials', async () => {
    const driver = new FakeDriver();
    driver.failOpen = Object.assign(
      new Error('[IBM][CLI Driver] SQL30081N A communication error ... SQLSTATE=08001'),
      { sqlcode: -30081 },
    );
    const err = await errorOf(
      new Db2Adapter(source(), silent, { loadPoolFactory: driver.load }).connect(),
    );
    expect(err.kind).toBe('connection');
    expect(err.message).not.toContain('hunter');
    expect(driver.closed).toBe(1);
  });
});

describe('Db2Adapter: execute', () => {
  it('read-only: BEGIN, run maxRows+1 with a timeout, always ROLLBACK', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () => result(['ID'], [[1], [2]]);
    const out = await adapter.execute('SELECT ID FROM T', [], ro);
    expect(driver.log).toEqual(['BEGIN', 'RUN max=200 timeout=30', 'ROLLBACK']);
    expect(out.rows).toEqual([[1], [2]]);
    expect(out.truncated).toBe(false);
    expect(driver.releases).toEqual([false]);
  });

  it('read-write: COMMIT; DML reports affectedRows', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () => result([], [], { affectedRows: 2 });
    const out = await adapter.execute('UPDATE T SET A = 1', [], rw);
    expect(driver.log).toEqual(['BEGIN', 'RUN max=200 timeout=30', 'COMMIT']);
    expect(out.affectedRows).toBe(2);
  });

  it('a result over maxRows is marked truncated', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () => result(['ID'], [[1], [2], [3]]);
    const out = await adapter.execute('SELECT ID FROM T', [], { ...ro, maxRows: 2 });
    expect(out.rows).toEqual([[1], [2]]);
    expect(out.truncated).toBe(true);
  });

  it('a DECIMAL column that may be inexact produces a note suggesting CAST', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () => result(['BIG'], [['1e18']], { impreciseColumns: ['BIG'] });
    const out = await adapter.execute('SELECT BIG FROM T', [], ro);
    expect(out.notes?.[0]).toContain('CAST(BIG AS VARCHAR(40))');
  });

  it('query error: ROLLBACK, a classified error, the connection is returned', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () =>
      Object.assign(new Error('SQL0204N "APP.X" is an undefined name. SQLSTATE=42704'), {
        sqlcode: -204,
      });
    const err = await errorOf(adapter.execute('SELECT * FROM X', [], rw));
    expect(err.kind).toBe('not_found');
    expect(err.sqlState).toBe('42704');
    expect(driver.log).toEqual(['BEGIN', 'RUN max=200 timeout=30', 'ROLLBACK']);
    expect(driver.releases).toEqual([false]);
  });

  it('broken connection: the connection is closed, not returned to the pool', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onRun = () => Object.assign(new Error('SQL30081N'), { sqlcode: -30081 });
    expect((await errorOf(adapter.execute('SELECT 1', [], ro))).kind).toBe('connection');
    expect(driver.releases).toEqual([true]);
  });
});

describe('Db2Adapter: catalog', () => {
  it('listTables: parameters, upper-case whitelist, FETCH FIRST, and the connection timeout', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver, { schemas: ['app'] });
    driver.onQuery = (sql) =>
      sql.includes('FROM SYSCAT.TABLES')
        ? [
            { SCHEMA_NAME: 'APP', TABLE_NAME: 'ORDERS', TABLE_TYPE: 'table' },
            { SCHEMA_NAME: 'APP', TABLE_NAME: 'V_SUM', TABLE_TYPE: 'view' },
          ]
        : [];
    const tables = await adapter.listTables({ search: 'ord', limit: 201 });
    expect(tables).toEqual([
      { schema: 'APP', name: 'ORDERS', type: 'table' },
      { schema: 'APP', name: 'V_SUM', type: 'view' },
    ]);
    const catalog = driver.queries.find((q) => q.sql.includes('FROM SYSCAT.TABLES'))!;
    expect(catalog.params).toEqual([null, null, 'ord', 'ord', 'APP']);
    expect(catalog.sql).toContain('FETCH FIRST 201 ROWS ONLY');
    expect(catalog.timeoutSec).toBe(30);
    expect(driver.log[0]).toBe('BEGIN');
    expect(driver.log.at(-1)).toBe('ROLLBACK');
  });

  it('describeTable: identity, generated, default, FK & indexes grouped', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    driver.onQuery = (sql) => {
      if (sql.includes('FROM SYSCAT.TABLES')) {
        return [
          {
            SCHEMA_NAME: 'APP',
            TABLE_NAME: 'ORDERS',
            TABLE_TYPE: 'table',
            EXACT_NAME: 0,
            IN_DEFAULT: 1,
          },
        ];
      }
      if (sql.includes('FROM SYSCAT.COLUMNS')) {
        return [
          {
            COLUMN_NAME: 'ID',
            TYPE_NAME: 'INTEGER',
            TYPE_LENGTH: 4,
            TYPE_SCALE: 0,
            NULLABLE: 'N',
            DEFAULT_VALUE: null,
            IS_IDENTITY: 'Y',
            GENERATED_KIND: 'A',
            GENERATION_TEXT: null,
          },
          {
            COLUMN_NAME: 'TOTAL',
            TYPE_NAME: 'DECIMAL',
            TYPE_LENGTH: 12,
            TYPE_SCALE: 2,
            NULLABLE: 'N',
            DEFAULT_VALUE: null,
            IS_IDENTITY: 'N',
            GENERATED_KIND: ' ',
            GENERATION_TEXT: null,
          },
          {
            COLUMN_NAME: 'DUA',
            TYPE_NAME: 'DECIMAL',
            TYPE_LENGTH: 13,
            TYPE_SCALE: 2,
            NULLABLE: 'Y',
            DEFAULT_VALUE: null,
            IS_IDENTITY: 'N',
            GENERATED_KIND: 'A',
            GENERATION_TEXT: 'AS (TOTAL * 2)',
          },
          {
            COLUMN_NAME: 'STATUS',
            TYPE_NAME: 'VARCHAR',
            TYPE_LENGTH: 20,
            TYPE_SCALE: 0,
            NULLABLE: 'N',
            DEFAULT_VALUE: "'new'",
            IS_IDENTITY: 'N',
            GENERATED_KIND: ' ',
            GENERATION_TEXT: null,
          },
          {
            COLUMN_NAME: 'CREATED',
            TYPE_NAME: 'TIMESTAMP',
            TYPE_LENGTH: 10,
            TYPE_SCALE: 6,
            NULLABLE: 'N',
            DEFAULT_VALUE: 'CURRENT TIMESTAMP',
            IS_IDENTITY: 'N',
            GENERATED_KIND: ' ',
            GENERATION_TEXT: null,
          },
        ];
      }
      if (sql.includes('FROM SYSCAT.KEYCOLUSE K\nJOIN SYSCAT.TABCONST'))
        return [{ COLUMN_NAME: 'ID' }];
      if (sql.includes('FROM SYSCAT.REFERENCES')) {
        return [
          {
            CONSTRAINT_NAME: 'FK_A',
            COLUMN_NAME: 'A1',
            REF_SCHEMA: 'APP',
            REF_TABLE: 'X',
            REF_COLUMN: 'K1',
          },
          {
            CONSTRAINT_NAME: 'FK_A',
            COLUMN_NAME: 'A2',
            REF_SCHEMA: 'APP',
            REF_TABLE: 'X',
            REF_COLUMN: 'K2',
          },
        ];
      }
      if (sql.includes('FROM SYSCAT.INDEXES')) {
        return [
          { INDEX_NAME: 'SQL2611', UNIQUE_RULE: 'P', COLUMN_NAME: 'ID', COLUMN_ORDER: 'A' },
          { INDEX_NAME: 'IDX_B', UNIQUE_RULE: 'D', COLUMN_NAME: 'STATUS', COLUMN_ORDER: 'D' },
          { INDEX_NAME: 'IDX_B', UNIQUE_RULE: 'D', COLUMN_NAME: 'TOTAL', COLUMN_ORDER: 'I' },
        ];
      }
      return [];
    };
    const detail = await adapter.describeTable('orders');
    expect(detail.columns.map((c) => [c.name, c.type, c.nullable, c.default])).toEqual([
      ['ID', 'INTEGER', false, 'GENERATED ALWAYS AS IDENTITY'],
      ['TOTAL', 'DECIMAL(12,2)', false, null],
      ['DUA', 'DECIMAL(13,2)', true, 'GENERATED ALWAYS AS (TOTAL * 2)'],
      ['STATUS', 'VARCHAR(20)', false, "'new'"],
      ['CREATED', 'TIMESTAMP', false, 'CURRENT TIMESTAMP'],
    ]);
    expect(detail.primaryKey).toEqual(['ID']);
    expect(detail.foreignKeys).toEqual([
      {
        name: 'FK_A',
        columns: ['A1', 'A2'],
        refSchema: 'APP',
        refTable: 'X',
        refColumns: ['K1', 'K2'],
      },
    ]);
    expect(detail.indexes).toEqual([
      { name: 'SQL2611', columns: ['ID'], unique: true },
      { name: 'IDX_B', columns: ['STATUS DESC', 'TOTAL (INCLUDE)'], unique: false },
    ]);
    const columnsQuery = driver.queries.find((q) => q.sql.includes('FROM SYSCAT.COLUMNS'))!;
    expect(columnsQuery.params).toEqual(['APP', 'ORDERS']);
  });

  it('describeTable: not found and ambiguous', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    let candidates: Record<string, unknown>[] = [];
    driver.onQuery = (sql) => (sql.includes('FROM SYSCAT.TABLES') ? candidates : []);
    expect((await errorOf(adapter.describeTable('x', 'APP'))).message).toContain(
      '"x" not found in schema APP',
    );
    candidates = [
      { SCHEMA_NAME: 'A', TABLE_NAME: 'ORDERS', TABLE_TYPE: 'table', EXACT_NAME: 0, IN_DEFAULT: 0 },
      { SCHEMA_NAME: 'B', TABLE_NAME: 'ORDERS', TABLE_TYPE: 'table', EXACT_NAME: 0, IN_DEFAULT: 0 },
    ];
    expect((await errorOf(adapter.describeTable('orders'))).kind).toBe('ambiguous');
  });
});
