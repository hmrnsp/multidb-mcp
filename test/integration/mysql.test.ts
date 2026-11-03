/**
 * Integration test for MysqlAdapter with the real driver (mysql2) against Docker MySQL 8.4 and MariaDB 11.4.
 *
 *   npm run db:up
 *   npm run test:integration
 *
 * Each flavor is skipped automatically when its URL is not set in .env.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devUrl } from '../../scripts/lib/dev-connections.mjs';
import { DbError } from '../../src/adapters/errors.js';
import { MysqlAdapter, type MysqlAdapterOptions } from '../../src/adapters/mysql/mysql-adapter.js';
import { loadMysqlPoolFactory } from '../../src/adapters/mysql/mysql-driver.js';
import type { MysqlFlavor } from '../../src/adapters/mysql/sql.js';
import type { ResolvedSource } from '../../src/config/loader.js';
import { Secret } from '../../src/config/secret.js';
import { createLogger } from '../../src/observability/logger.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const log = createLogger({ level: 'warn' });

const FLAVORS: { flavor: MysqlFlavor; url: string; roUrl: string }[] = [
  { flavor: 'mysql', url: devUrl('mysql'), roUrl: devUrl('mysql', 'ro') },
  { flavor: 'mariadb', url: devUrl('mariadb'), roUrl: devUrl('mariadb', 'ro') },
];

function source(
  flavor: MysqlFlavor,
  url: string,
  extra: Partial<ResolvedSource> = {},
): ResolvedSource {
  return {
    id: `it_${flavor}`,
    driver: flavor,
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

function adapterFor(
  flavor: MysqlFlavor,
  url: string,
  extra: Partial<ResolvedSource> = {},
  options: Partial<MysqlAdapterOptions> = {},
): MysqlAdapter {
  return new MysqlAdapter(source(flavor, url, extra), log, {
    flavor,
    loadPoolFactory: loadMysqlPoolFactory,
    ...options,
  });
}

async function errorOf(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DbError) return err;
    throw new Error(`not a DbError: ${String(err)}`);
  }
  throw new Error('no error');
}

const ro = { readonly: true, maxRows: 100, timeoutSec: 10 };
const rw = { readonly: false, maxRows: 10, timeoutSec: 10 };

describe.each(FLAVORS)('MysqlAdapter against Docker $flavor', ({ flavor, url, roUrl }) => {
  describe.skipIf(url === '')('dev connection', () => {
    const adapter = adapterFor(flavor, url, {}, { watchdogGraceMs: 200 });

    beforeAll(async () => {
      await adapter.connect();
    });
    afterAll(async () => {
      await adapter.close();
    });

    const scalar = async (sql: string, params: unknown[] = []) =>
      (await adapter.execute(sql, params, ro)).rows[0]?.[0];

    it('listTables: tables and views of schema app, case-insensitive search', async () => {
      expect(await adapter.listTables({ schema: 'app', limit: 50 })).toEqual([
        { schema: 'app', name: 'customers', type: 'table' },
        { schema: 'app', name: 'orders', type: 'table' },
        { schema: 'app', name: 'v_order_summary', type: 'view' },
      ]);
      const found = await adapter.listTables({ search: 'ORD', limit: 50 });
      expect(found.map((t) => t.name)).toEqual(['orders', 'v_order_summary']);
      expect(await adapter.listTables({ schema: 'mysql', limit: 50 })).toEqual([]);
    });

    it('describeTable: columns, PK, FK, indexes (also with an upper-case name)', async () => {
      const detail = await adapter.describeTable('ORDERS', 'app');
      expect(detail.name).toBe('orders');
      // MySQL 8 no longer writes the display width of int; MariaDB still does.
      const int = flavor === 'mysql' ? 'int' : 'int(11)';
      expect(detail.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
        ['id', int, false],
        ['customer_id', int, false],
        ['total', 'decimal(12,2)', false],
        ['status', 'varchar(20)', false],
        ['created_at', 'timestamp', false],
      ]);
      expect(detail.columns[0]?.default).toBe('AUTO_INCREMENT');
      expect(detail.columns[4]?.default?.toLowerCase()).toMatch(/^current_timestamp(\(\))?$/);
      expect(detail.primaryKey).toEqual(['id']);
      expect(detail.foreignKeys).toEqual([
        {
          name: 'fk_orders_customer',
          columns: ['customer_id'],
          refSchema: 'app',
          refTable: 'customers',
          refColumns: ['id'],
        },
      ]);
      expect(detail.indexes).toEqual([
        { name: 'PRIMARY', columns: ['id'], unique: true },
        { name: 'idx_orders_customer', columns: ['customer_id'], unique: false },
      ]);

      const customers = await adapter.describeTable('customers');
      expect(customers.columns.find((c) => c.name === 'nik')?.default).toBeNull();
      expect(customers.indexes.find((i) => i.name === 'email')).toEqual({
        name: 'email',
        columns: ['email'],
        unique: true,
      });
      expect((await adapter.describeTable('v_order_summary')).type).toBe('view');
      expect((await errorOf(adapter.describeTable('does_not_exist'))).kind).toBe('not_found');
    });

    it('execute: stops at maxRows and marks truncated', async () => {
      const result = await adapter.execute('SELECT id, status FROM orders ORDER BY id', [], ro);
      expect(result.columns).toEqual(['id', 'status']);
      expect(result.rows).toHaveLength(100);
      expect(result.rows[0]).toEqual([1, 'paid']);
      expect(result.truncated).toBe(true);
      expect(Number(await scalar('SELECT 1'))).toBe(1);
    });

    it('a result of 1 million rows is cut quickly and the query on the server is stopped', async () => {
      const started = performance.now();
      const result = await adapter.execute(
        'SELECT /* it-big-result */ a.id, b.id FROM orders a CROSS JOIN orders b',
        [],
        ro,
      );
      expect(result.rows).toHaveLength(100);
      expect(result.truncated).toBe(true);
      expect(performance.now() - started).toBeLessThan(5_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const running = await scalar(
        "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE CONCAT('%it-big', '-result%') AND ID <> CONNECTION_ID()",
      );
      expect(Number(running)).toBe(0);
    });

    it('parameter ? through a prepared statement, with no statement left on the server', async () => {
      const count = async () =>
        Number(
          (await adapter.execute("SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'", [], ro))
            .rows[0]?.[1],
        );
      const before = await count();
      const result = await adapter.execute(
        'SELECT COUNT(*) AS n FROM orders WHERE status = ? AND id > ?',
        ['paid', 0],
        ro,
      );
      expect(Number(result.rows[0]?.[0])).toBe(250);
      expect(Number(await scalar('SELECT id FROM orders ORDER BY id LIMIT ?', [1]))).toBe(1);
      // A "?" inside a string is not treated as a placeholder (there is no client-side formatting).
      expect(await scalar("SELECT '?' AS q")).toBe('?');
      expect(await count()).toBe(before);
    });

    it('type mapping: bigint & decimal as text, dates without time zone shift', async () => {
      const result = await adapter.execute(
        `SELECT CAST(9007199254740993 AS SIGNED) AS bi, CAST(12345.67 AS DECIMAL(12, 2)) AS num,
                DATE '2026-01-15' AS d, TIMESTAMP '2026-01-15 10:30:00' AS ts,
                X'DEADBEEF' AS bin, JSON_OBJECT('a', 1) AS js, NULL AS nothing`,
        [],
        ro,
      );
      const [bi, num, d, ts, bin, js, nothing] = result.rows[0] ?? [];
      expect(bi).toBe('9007199254740993');
      expect(num).toBe('12345.67');
      expect(d).toBe('2026-01-15');
      expect(ts).toBe('2026-01-15 10:30:00');
      expect(Buffer.isBuffer(bin)).toBe(true);
      // MariaDB stores JSON as LONGTEXT, so the result is text.
      expect(typeof js === 'string' ? JSON.parse(js) : js).toEqual({ a: 1 });
      expect(nothing).toBeNull();
    });

    it('read-only rejects INSERT at the database level', async () => {
      const err = await errorOf(
        adapter.execute(
          "INSERT INTO orders (customer_id, total, status) VALUES (1, 1, 'x')",
          [],
          ro,
        ),
      );
      expect(err.kind).toBe('readonly');
    });

    it('more than one statement is rejected by the driver', async () => {
      expect((await errorOf(adapter.execute('SELECT 1; SELECT 2', [], ro))).kind).toBe('syntax');
    });

    it('a timeout cancels a heavy SELECT and the connection stays usable', async () => {
      const err = await errorOf(
        adapter.execute(
          'SELECT COUNT(*) FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c',
          [],
          { readonly: true, maxRows: 10, timeoutSec: 1 },
        ),
      );
      expect(err.kind).toBe('timeout');
      expect(Number(await scalar('SELECT 1'))).toBe(1);
    });

    it('a timeout also applies to UPDATE (MySQL: through the KILL QUERY watchdog)', async () => {
      const started = performance.now();
      const err = await errorOf(
        adapter.execute('UPDATE orders SET status = status WHERE id = 1 AND SLEEP(5) = 0', [], {
          readonly: false,
          maxRows: 10,
          timeoutSec: 1,
        }),
      );
      expect(err.kind).toBe('timeout');
      expect(performance.now() - started).toBeLessThan(4_000);
      expect(Number(await scalar('SELECT 1'))).toBe(1);
    });

    it('read-write: INSERT then DELETE (COMMIT) with affectedRows', async () => {
      const inserted = await adapter.execute(
        "INSERT INTO orders (customer_id, total, status) VALUES (1, 9.99, 'it-test')",
        [],
        rw,
      );
      expect(inserted.columns).toEqual([]);
      expect(inserted.affectedRows).toBe(1);
      const deleted = await adapter.execute('DELETE FROM orders WHERE status = ?', ['it-test'], rw);
      expect(deleted.affectedRows).toBe(1);
      expect(Number(await scalar('SELECT COUNT(*) FROM orders'))).toBe(1000);
    });

    it.runIf(flavor === 'mariadb')(
      'MariaDB: DELETE ... RETURNING deletes every row even when the result is cut',
      async () => {
        await adapter.execute(
          "INSERT INTO orders (customer_id, total, status) SELECT customer_id, 1, 'it-returning' FROM orders WHERE id <= 30",
          [],
          rw,
        );
        const result = await adapter.execute(
          "DELETE FROM orders WHERE status = 'it-returning' RETURNING id",
          [],
          rw,
        );
        expect(result.rows).toHaveLength(10);
        expect(result.truncated).toBe(true);
        expect(
          Number(await scalar("SELECT COUNT(*) FROM orders WHERE status = 'it-returning'")),
        ).toBe(0);
      },
    );

    it("a user's session variable does not carry over to the next query (connection reset)", async () => {
      await adapter.execute('SET @mcp_it = 5', [], rw);
      for (let i = 0; i < 6; i += 1) {
        expect(await scalar('SELECT @mcp_it')).toBeNull();
      }
    });
  });

  describe.skipIf(url === '')('validation on connect', () => {
    it('a default database outside the schemas whitelist is rejected', async () => {
      const adapter = adapterFor(flavor, url, { schemas: ['other'] });
      const err = await errorOf(adapter.connect());
      expect(err.kind).toBe('connection');
      expect(err.message).toContain('is not in "schemas"');
    });

    it('a matching whitelist: listTables returns only that schema', async () => {
      const adapter = adapterFor(flavor, url, { schemas: ['APP'] });
      await adapter.connect();
      try {
        expect(await adapter.listTables({ limit: 50 })).toHaveLength(3);
      } finally {
        await adapter.close();
      }
    });

    it('a driver in the config that does not match the server', async () => {
      const other: MysqlFlavor = flavor === 'mysql' ? 'mariadb' : 'mysql';
      const err = await errorOf(
        new MysqlAdapter(source(other, url), log, {
          flavor: other,
          loadPoolFactory: loadMysqlPoolFactory,
        }).connect(),
      );
      expect(err.kind).toBe('connection');
      expect(err.message).toContain(`Change the driver to "${flavor}"`);
    });

    it('an unsupported URL parameter is rejected (for example multipleStatements)', async () => {
      const err = await errorOf(adapterFor(flavor, `${url}?multipleStatements=true`).connect());
      expect(err.kind).toBe('connection');
      expect(err.message).toContain('multipleStatements');
      expect(err.message).not.toContain(':dev@');
    });
  });

  describe.skipIf(roUrl === '')('user SELECT-only (mcp_ro)', () => {
    it('SELECT is allowed, INSERT is rejected as a permission error even in read-write mode', async () => {
      const adapter = adapterFor(flavor, roUrl);
      await adapter.connect();
      try {
        const result = await adapter.execute('SELECT COUNT(*) FROM orders', [], ro);
        expect(Number(result.rows[0]?.[0])).toBe(1000);
        const err = await errorOf(
          adapter.execute(
            "INSERT INTO orders (customer_id, total, status) VALUES (1, 1, 'x')",
            [],
            rw,
          ),
        );
        expect(err.kind).toBe('permission');
      } finally {
        await adapter.close();
      }
    });
  });
});

describe('failed connection', () => {
  it('a wrong port yields a connection DbError without credentials', async () => {
    const err = await errorOf(
      adapterFor('mysql', 'mysql://dev:hunter-it@127.0.0.1:1/app').connect(),
    );
    expect(err.kind).toBe('connection');
    expect(err.message).not.toContain('hunter-it');
  });
});
