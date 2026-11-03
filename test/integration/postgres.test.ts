/**
 * Integration test for PostgresAdapter with the real driver (pg + pg-cursor) against Docker PostgreSQL.
 *
 *   npm run db:up
 *   npm run test:integration
 *
 * Skipped automatically when PG_LOCAL_PASSWORD is not set in .env.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devUrl } from '../../scripts/lib/dev-connections.mjs';
import { DbError } from '../../src/adapters/errors.js';
import { loadPgPoolFactory } from '../../src/adapters/postgres/pg-driver.js';
import { PostgresAdapter } from '../../src/adapters/postgres/postgres-adapter.js';
import type { ResolvedSource } from '../../src/config/loader.js';
import { Secret } from '../../src/config/secret.js';
import { createLogger } from '../../src/observability/logger.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const URL = devUrl('postgres');
const RO_URL = devUrl('postgres', 'ro');
const log = createLogger({ level: 'warn' });

function source(url: string, extra: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    id: 'it_pg',
    driver: 'postgres',
    env: 'local',
    description: 'integration test',
    connection: new Secret(url),
    access: ['read', 'insert', 'update', 'delete', 'ddl', 'call'],
    readonly: false,
    limits: { maxRows: 200, timeoutSec: 10, maxChars: 40_000 },
    schemas: undefined,
    lazy: true,
    baseDir: process.cwd(),
    ...extra,
  };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof DbError ? err.kind : `not a DbError: ${String(err)}`;
  }
  return 'no error';
}

describe.skipIf(URL === '')('PostgresAdapter against Docker PostgreSQL', () => {
  const adapter = new PostgresAdapter(source(URL), log, { loadPoolFactory: loadPgPoolFactory });
  const ro = { readonly: true, maxRows: 100, timeoutSec: 10 };

  beforeAll(async () => {
    await adapter.connect();
  });
  afterAll(async () => {
    await adapter.close();
  });

  it('listTables: tables and views of schema app', async () => {
    const tables = await adapter.listTables({ schema: 'app', limit: 50 });
    expect(tables).toEqual([
      { schema: 'app', name: 'customers', type: 'table' },
      { schema: 'app', name: 'orders', type: 'table' },
      { schema: 'app', name: 'v_order_summary', type: 'view' },
    ]);
    const found = await adapter.listTables({ search: 'ORD', limit: 50 });
    expect(found.map((t) => t.name)).toEqual(['orders', 'v_order_summary']);
  });

  it('describeTable: columns, PK, FK, indexes (also with an upper-case name)', async () => {
    const detail = await adapter.describeTable('ORDERS', 'app');
    expect(detail.name).toBe('orders');
    expect(detail.columns.map((c) => c.name)).toEqual([
      'id',
      'customer_id',
      'total',
      'status',
      'created_at',
    ]);
    expect(detail.primaryKey).toEqual(['id']);
    expect(detail.foreignKeys).toEqual([
      {
        name: 'orders_customer_id_fkey',
        columns: ['customer_id'],
        refSchema: 'app',
        refTable: 'customers',
        refColumns: ['id'],
      },
    ]);
    expect(detail.indexes.map((i) => i.name).sort()).toEqual([
      'idx_orders_customer',
      'orders_pkey',
    ]);
    expect(await kindOf(adapter.describeTable('does_not_exist'))).toBe('not_found');
  });

  it('execute: the cursor stops at maxRows and marks truncated', async () => {
    const result = await adapter.execute('SELECT id, status FROM app.orders ORDER BY id', [], ro);
    expect(result.columns).toEqual(['id', 'status']);
    expect(result.rows).toHaveLength(100);
    expect(result.rows[0]).toEqual([1, 'paid']);
    expect(result.truncated).toBe(true);
  });

  it('execute: parameter $1', async () => {
    const result = await adapter.execute(
      'SELECT count(*)::int AS n FROM app.orders WHERE status = $1',
      ['paid'],
      ro,
    );
    expect(result.rows).toEqual([[250]]);
    expect(result.truncated).toBe(false);
  });

  it('type mapping: bigint & numeric as text, dates without time zone shift', async () => {
    const result = await adapter.execute(
      `SELECT 9007199254740993::bigint AS bi, 12345.67::numeric(12, 2) AS num, DATE '2026-01-15' AS d,
              TIMESTAMP '2026-01-15 10:30:00' AS ts, '\\xdeadbeef'::bytea AS bin, '{"a": 1}'::jsonb AS js`,
      [],
      ro,
    );
    const [bi, num, d, ts, bin, js] = result.rows[0] ?? [];
    expect(bi).toBe('9007199254740993');
    expect(num).toBe('12345.67');
    expect(d).toBe('2026-01-15');
    expect(ts).toBe('2026-01-15 10:30:00');
    expect(Buffer.isBuffer(bin)).toBe(true);
    expect(js).toEqual({ a: 1 });
  });

  it('read-only rejects INSERT, a deleting CTE, and EXPLAIN ANALYZE DELETE', async () => {
    expect(
      await kindOf(
        adapter.execute(
          "INSERT INTO app.orders (customer_id, total, status) VALUES (1, 1, 'x')",
          [],
          ro,
        ),
      ),
    ).toBe('readonly');
    expect(
      await kindOf(
        adapter.execute(
          'WITH d AS (DELETE FROM app.orders WHERE id = -1 RETURNING *) SELECT * FROM d',
          [],
          ro,
        ),
      ),
    ).toBe('readonly');
    expect(
      await kindOf(adapter.execute('EXPLAIN ANALYZE DELETE FROM app.orders WHERE id = -1', [], ro)),
    ).toBe('readonly');
  });

  it('more than one statement is rejected by the PostgreSQL protocol', async () => {
    expect(await kindOf(adapter.execute('SELECT 1; SELECT 2', [], ro))).toBe('syntax');
  });

  it('a timeout cancels the query and the connection stays usable', async () => {
    expect(
      await kindOf(
        adapter.execute('SELECT pg_sleep(5)', [], { readonly: true, maxRows: 10, timeoutSec: 1 }),
      ),
    ).toBe('timeout');
    const ok = await adapter.execute('SELECT 1 AS ok', [], ro);
    expect(ok.rows).toEqual([[1]]);
  });

  it('read-write: INSERT ... RETURNING then DELETE (COMMIT)', async () => {
    const rw = { readonly: false, maxRows: 10, timeoutSec: 10 };
    const inserted = await adapter.execute(
      "INSERT INTO app.orders (customer_id, total, status) VALUES (1, 9.99, 'it-test') RETURNING id",
      [],
      rw,
    );
    const id = inserted.rows[0]?.[0];
    expect(typeof id).toBe('number');
    const deleted = await adapter.execute('DELETE FROM app.orders WHERE id = $1', [id], rw);
    expect(deleted.columns).toEqual([]);
    expect(deleted.affectedRows).toBe(1);
  });

  it("a user's session SET does not carry over to the next query (DISCARD ALL)", async () => {
    const rw = { readonly: false, maxRows: 10, timeoutSec: 10 };
    await adapter.execute("SET search_path TO 'app'", [], rw);
    for (let i = 0; i < 6; i += 1) {
      const result = await adapter.execute("SELECT current_setting('search_path') AS sp", [], ro);
      expect(result.rows[0]?.[0]).not.toBe('app');
    }
  });

  it('the schema whitelist is applied as search_path', async () => {
    const scoped = new PostgresAdapter(source(URL, { schemas: ['app'] }), log, {
      loadPoolFactory: loadPgPoolFactory,
    });
    await scoped.connect();
    try {
      const result = await scoped.execute('SELECT count(*)::int FROM orders', [], ro);
      expect(result.rows).toEqual([[1000]]);
      expect(await scoped.listTables({ limit: 50 })).toHaveLength(3);
    } finally {
      await scoped.close();
    }
  });
});

describe.skipIf(RO_URL === '')('user SELECT-only (mcp_ro)', () => {
  it('SELECT is allowed, INSERT is rejected as a permission error even in read-write mode', async () => {
    const adapter = new PostgresAdapter(source(RO_URL), log, {
      loadPoolFactory: loadPgPoolFactory,
    });
    await adapter.connect();
    try {
      const result = await adapter.execute('SELECT count(*)::int FROM app.orders', [], {
        readonly: true,
        maxRows: 10,
        timeoutSec: 10,
      });
      expect(result.rows).toEqual([[1000]]);
      expect(
        await kindOf(
          adapter.execute(
            "INSERT INTO app.orders (customer_id, total, status) VALUES (1, 1, 'x')",
            [],
            {
              readonly: false,
              maxRows: 10,
              timeoutSec: 10,
            },
          ),
        ),
      ).toBe('permission');
    } finally {
      await adapter.close();
    }
  });
});

describe('failed connection', () => {
  it('a wrong port yields a connection DbError without credentials', async () => {
    const adapter = new PostgresAdapter(source('postgres://dev:hunter-it@127.0.0.1:1/app'), log, {
      loadPoolFactory: loadPgPoolFactory,
    });
    try {
      await adapter.connect();
      throw new Error('should have failed');
    } catch (err) {
      expect(err).toBeInstanceOf(DbError);
      expect((err as DbError).kind).toBe('connection');
      expect((err as DbError).message).not.toContain('hunter-it');
    }
  });
});
