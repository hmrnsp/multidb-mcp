import { describe, expect, it } from 'vitest';
import { DbError } from '../../src/adapters/errors.js';
import type {
  PgClientLike,
  PgCursorResult,
  PgPoolFactory,
  PgPoolSettings,
} from '../../src/adapters/postgres/driver-types.js';
import { PostgresAdapter } from '../../src/adapters/postgres/postgres-adapter.js';
import type { ResolvedSource } from '../../src/config/loader.js';
import { Secret } from '../../src/config/secret.js';
import { createLogger } from '../../src/observability/logger.js';

const silent = createLogger({ write: () => undefined });

type QueryHandler = (
  text: string,
  values?: readonly unknown[],
) => Record<string, unknown>[] | Error | undefined;
type CursorHandler = (
  text: string,
  values: readonly unknown[],
  maxRows: number,
) => PgCursorResult | Error;

/** A fake pool that records every command, so the transaction order can be checked. */
class FakeDriver {
  readonly log: string[] = [];
  readonly releases: boolean[] = [];
  settings: PgPoolSettings | undefined;
  ended = 0;
  loads = 0;
  onQuery: QueryHandler = () => undefined;
  onCursor: CursorHandler = () => ({ fields: [], rows: [], rowCount: 0, command: null });
  failConnect: Error | undefined;

  factory: PgPoolFactory = (settings) => {
    this.settings = settings;
    return {
      connect: () => {
        if (this.failConnect) return Promise.reject(this.failConnect);
        return Promise.resolve(this.client());
      },
      end: () => {
        this.ended += 1;
        return Promise.resolve();
      },
    };
  };

  load = (): Promise<PgPoolFactory> => {
    this.loads += 1;
    return Promise.resolve(this.factory);
  };

  client(): PgClientLike {
    return {
      query: (text, values) => {
        this.log.push(text.trim().split('\n')[0]!.trim());
        const result = this.onQuery(text, values);
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve({ rows: result ?? [] });
      },
      cursor: (text, values, maxRows) => {
        this.log.push(`CURSOR max=${maxRows}`);
        const result = this.onCursor(text, values, maxRows);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
      escapeIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
      release: (destroy) => {
        this.releases.push(destroy === true);
      },
    };
  }
}

function source(extra: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    id: 'local_pg',
    driver: 'postgres',
    env: 'local',
    description: 'test',
    connection: new Secret('postgres://dev:hunter@127.0.0.1:55432/app'),
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
  const adapter = new PostgresAdapter(source(extra), silent, { loadPoolFactory: driver.load });
  await adapter.connect();
  driver.log.length = 0;
  driver.releases.length = 0;
  return adapter;
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function rows(n: number): unknown[][] {
  return Array.from({ length: n }, (_, i) => [i + 1, `row ${i + 1}`]);
}

describe('PostgresAdapter: connection', () => {
  it('loads the driver once, creates the pool with safe settings, then pings', async () => {
    const driver = new FakeDriver();
    const adapter = new PostgresAdapter(source(), silent, { loadPoolFactory: driver.load });
    await adapter.connect();
    await adapter.connect();
    expect(driver.loads).toBe(1);
    expect(driver.settings?.connectionString).toBe('postgres://dev:hunter@127.0.0.1:55432/app');
    expect(driver.settings?.applicationName).toBe('multidb-mcp');
    expect(driver.settings?.max).toBe(4);
    expect(driver.log).toContain('SELECT 1');
  });

  it('failed connection: the pool is closed, a classified error, and it can be retried', async () => {
    const driver = new FakeDriver();
    driver.failConnect = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:55432'), {
      code: 'ECONNREFUSED',
    });
    const adapter = new PostgresAdapter(source(), silent, { loadPoolFactory: driver.load });
    await expect(adapter.connect()).rejects.toThrow(DbError);
    expect(driver.ended).toBe(1);
    driver.failConnect = undefined;
    await adapter.connect();
    expect(driver.loads).toBe(2);
  });

  it('the driver cannot be loaded: a clear message', async () => {
    const adapter = new PostgresAdapter(source(), silent, {
      loadPoolFactory: () => Promise.reject(new Error("Cannot find package 'pg'")),
    });
    await expect(adapter.connect()).rejects.toThrow(/PostgreSQL driver \(pg\) could not be loaded/);
  });

  it('close ends the pool; later operations are rejected', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    await adapter.close();
    expect(driver.ended).toBe(1);
    await expect(adapter.ping()).rejects.toThrow(/not connected yet/);
  });
});

describe('PostgresAdapter: execute', () => {
  it('read-only: BEGIN READ ONLY, timeout, search_path, cursor maxRows+1, always ROLLBACK', async () => {
    const driver = new FakeDriver();
    driver.onCursor = () => ({
      fields: ['id', 'name'],
      rows: rows(201),
      rowCount: 201,
      command: 'SELECT',
    });
    const adapter = await connected(driver, { schemas: ['app', 'Data "X"'] });

    const result = await adapter.execute('SELECT * FROM orders', [], {
      readonly: true,
      maxRows: 200,
      timeoutSec: 30,
    });

    expect(driver.log).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 30000',
      'SET LOCAL search_path TO "app", "Data ""X"""',
      'CURSOR max=201',
      'ROLLBACK',
    ]);
    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.affectedRows).toBeUndefined();
    expect(driver.releases).toEqual([false]);
  });

  it('read-write: COMMIT then DISCARD ALL; DML reports affectedRows', async () => {
    const driver = new FakeDriver();
    driver.onCursor = () => ({ fields: [], rows: [], rowCount: 3, command: 'UPDATE' });
    const adapter = await connected(driver);

    const result = await adapter.execute('UPDATE t SET x = $1', [1], {
      readonly: false,
      maxRows: 200,
      timeoutSec: 5,
    });

    expect(driver.log).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 5000',
      'CURSOR max=201',
      'COMMIT',
      'DISCARD ALL',
    ]);
    expect(result.affectedRows).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('query error: ROLLBACK, DISCARD ALL, a classified error, the connection is returned', async () => {
    const driver = new FakeDriver();
    driver.onCursor = () => pgError('57014', 'canceling statement due to statement timeout');
    const adapter = await connected(driver);

    await expect(
      adapter.execute('SELECT pg_sleep(60)', [], { readonly: false, maxRows: 10, timeoutSec: 2 }),
    ).rejects.toThrow(DbError);
    expect(driver.log).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 2000',
      'CURSOR max=11',
      'ROLLBACK',
      'DISCARD ALL',
    ]);
    expect(driver.releases).toEqual([false]);
  });

  it('a connection broken mid-query: the connection is dropped from the pool', async () => {
    const driver = new FakeDriver();
    driver.onCursor = () => pgError('ECONNRESET', 'Connection terminated unexpectedly');
    const adapter = await connected(driver);
    await expect(
      adapter.execute('SELECT 1', [], { readonly: true, maxRows: 10, timeoutSec: 2 }),
    ).rejects.toThrow(/Connection terminated/);
    expect(driver.releases).toEqual([true]);
  });

  it('parameters are passed on to the cursor as they are', async () => {
    const driver = new FakeDriver();
    let seen: readonly unknown[] = [];
    driver.onCursor = (_text, values) => {
      seen = values;
      return { fields: ['n'], rows: [[42]], rowCount: 1, command: 'SELECT' };
    };
    const adapter = await connected(driver);
    await adapter.execute('SELECT $1::int + $2::int AS n', [40, 2], {
      readonly: true,
      maxRows: 10,
      timeoutSec: 2,
    });
    expect(seen).toEqual([40, 2]);
  });
});

describe('PostgresAdapter: catalog', () => {
  it('listTables sends schema, whitelist, search word, and limit as parameters', async () => {
    const driver = new FakeDriver();
    let params: readonly unknown[] | undefined;
    driver.onQuery = (text, values) => {
      if (text.includes('pg_class')) {
        params = values;
        return [
          { schema_name: 'app', table_name: 'orders', table_type: 'table' },
          { schema_name: 'app', table_name: 'v_order_summary', table_type: 'view' },
        ];
      }
      return undefined;
    };
    const adapter = await connected(driver, { schemas: ['app'] });
    const tables = await adapter.listTables({ search: 'ord', limit: 201 });
    expect(params).toEqual([null, ['app'], 'ord', 201]);
    expect(tables).toEqual([
      { schema: 'app', name: 'orders', type: 'table' },
      { schema: 'app', name: 'v_order_summary', type: 'view' },
    ]);
    expect(driver.log[0]).toBe('BEGIN READ ONLY');
    expect(driver.log.at(-1)).toBe('ROLLBACK');
  });

  it('describeTable: one read-only transaction for all catalog queries', async () => {
    const driver = new FakeDriver();
    driver.onQuery = (text) => {
      if (text.includes('AS exact')) {
        return [
          {
            oid: '16398',
            schema_name: 'app',
            table_name: 'orders',
            table_type: 'table',
            exact: true,
          },
        ];
      }
      if (text.includes('format_type')) {
        return [
          {
            column_name: 'id',
            data_type: 'integer',
            nullable: false,
            default_value: "nextval('x')",
          },
          { column_name: 'note', data_type: 'text', nullable: true, default_value: null },
        ];
      }
      if (text.includes("contype = 'p'")) return [{ column_name: 'id' }];
      if (text.includes("contype = 'f'")) {
        return [
          {
            constraint_name: 'fk',
            columns: ['customer_id'],
            ref_schema: 'app',
            ref_table: 'customers',
            ref_columns: ['id'],
          },
        ];
      }
      if (text.includes('pg_index')) {
        return [{ index_name: 'orders_pkey', is_unique: true, columns: ['id'] }];
      }
      return undefined;
    };
    const adapter = await connected(driver);
    const detail = await adapter.describeTable('orders');

    expect(detail).toEqual({
      schema: 'app',
      name: 'orders',
      type: 'table',
      columns: [
        { name: 'id', type: 'integer', nullable: false, default: "nextval('x')" },
        { name: 'note', type: 'text', nullable: true, default: null },
      ],
      primaryKey: ['id'],
      foreignKeys: [
        {
          name: 'fk',
          columns: ['customer_id'],
          refSchema: 'app',
          refTable: 'customers',
          refColumns: ['id'],
        },
      ],
      indexes: [{ name: 'orders_pkey', columns: ['id'], unique: true }],
    });
    expect(driver.releases).toEqual([false]);
    expect(driver.log.filter((l) => l === 'BEGIN READ ONLY')).toHaveLength(1);
  });

  it('describeTable: not found and an ambiguous name', async () => {
    const driver = new FakeDriver();
    const adapter = await connected(driver);
    await expect(adapter.describeTable('does_not_exist')).rejects.toThrow(/not found/);

    driver.onQuery = (text) =>
      text.includes('AS exact')
        ? [
            {
              oid: '1',
              schema_name: 'app',
              table_name: 'orders',
              table_type: 'table',
              exact: true,
            },
            {
              oid: '2',
              schema_name: 'test',
              table_name: 'orders',
              table_type: 'table',
              exact: true,
            },
          ]
        : undefined;
    await expect(adapter.describeTable('orders')).rejects.toThrow(/app\.orders, test\.orders/);
  });

  it('describeTable: an exact name is preferred over a case difference', async () => {
    const driver = new FakeDriver();
    driver.onQuery = (text) =>
      text.includes('AS exact')
        ? [
            {
              oid: '1',
              schema_name: 'app',
              table_name: 'Orders',
              table_type: 'table',
              exact: true,
            },
            {
              oid: '2',
              schema_name: 'app',
              table_name: 'orders',
              table_type: 'table',
              exact: false,
            },
          ]
        : undefined;
    const adapter = await connected(driver);
    const detail = await adapter.describeTable('Orders');
    expect(detail.name).toBe('Orders');
  });
});
