/**
 * Integration test for SqliteAdapter with the real driver (node:sqlite in a child process).
 * Needs no Docker: every test uses a copy of the seed in a temporary folder.
 *
 *   npm run test:integration
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '../../src/adapters/errors.js';
import { SqliteAdapter, sqlitePathOf } from '../../src/adapters/sqlite/sqlite-adapter.js';
import { loadSqliteFactory } from '../../src/adapters/sqlite/sqlite-driver.js';
import type { ResolvedSource } from '../../src/config/loader.js';
import { Secret } from '../../src/config/secret.js';
import { createLogger } from '../../src/observability/logger.js';

const log = createLogger({ level: 'error' });
const SEED = readFileSync(resolve('docker/seed/sqlite.sql'), 'utf8');
const FULL: ResolvedSource['access'] = ['read', 'insert', 'update', 'delete', 'ddl'];

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'multidb-sqlite-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function seededFile(name: string): string {
  const file = join(dir, name);
  const db = new DatabaseSync(file);
  db.exec(SEED);
  db.close();
  return file;
}

function adapterFor(url: string, access: ResolvedSource['access'] = FULL, timeoutSec = 10) {
  const source: ResolvedSource = {
    id: 'it_sqlite',
    driver: 'sqlite',
    env: 'local',
    description: 'integration test',
    connection: new Secret(url),
    access,
    readonly: access.every((a) => a === 'read'),
    limits: { maxRows: 200, timeoutSec, maxChars: 40_000 },
    schemas: undefined,
    lazy: true,
    baseDir: dir,
  };
  return new SqliteAdapter(source, log, { loadFactory: loadSqliteFactory });
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

describe('SqliteAdapter against a SQLite file', () => {
  let adapter: SqliteAdapter;
  const scalar = async (sql: string, params: unknown[] = []) =>
    (await adapter.execute(sql, params, ro)).rows[0]?.[0];

  beforeAll(async () => {
    seededFile('app.sqlite');
    adapter = adapterFor('sqlite:./app.sqlite');
    await adapter.connect();
  });
  afterAll(async () => {
    await adapter.close();
  });

  it('listTables: tables and views, case-insensitive search, internal tables hidden', async () => {
    expect(await adapter.listTables({ limit: 50 })).toEqual([
      { schema: 'main', name: 'customers', type: 'table' },
      { schema: 'main', name: 'orders', type: 'table' },
      { schema: 'main', name: 'v_order_summary', type: 'view' },
    ]);
    expect((await adapter.listTables({ search: 'ORD', limit: 50 })).map((t) => t.name)).toEqual([
      'orders',
      'v_order_summary',
    ]);
    expect(await adapter.listTables({ schema: 'other', limit: 50 })).toEqual([]);
  });

  it('describeTable: columns, rowid, default, PK, FK, indexes (upper-case name)', async () => {
    const detail = await adapter.describeTable('ORDERS');
    expect(detail.name).toBe('orders');
    expect(detail.columns.map((c) => [c.name, c.type, c.nullable, c.default])).toEqual([
      ['id', 'INTEGER', false, 'ROWID (automatic)'],
      ['customer_id', 'INTEGER', false, null],
      ['total', 'NUMERIC', false, null],
      ['status', 'TEXT', false, null],
      ['created_at', 'TEXT', false, 'CURRENT_TIMESTAMP'],
    ]);
    expect(detail.primaryKey).toEqual(['id']);
    expect(detail.foreignKeys).toEqual([
      {
        name: 'fk_0',
        columns: ['customer_id'],
        refSchema: 'main',
        refTable: 'customers',
        refColumns: ['id'],
      },
    ]);
    expect(detail.indexes).toEqual([
      { name: 'idx_orders_customer', columns: ['customer_id'], unique: false },
    ]);
    const customers = await adapter.describeTable('customers', 'main');
    expect(customers.indexes).toEqual([
      { name: 'sqlite_autoindex_customers_1', columns: ['email'], unique: true },
    ]);
    expect((await adapter.describeTable('v_order_summary')).type).toBe('view');
    expect((await errorOf(adapter.describeTable('does_not_exist'))).kind).toBe('not_found');
  });

  it('execute: stops at maxRows, parameter ?, and a large INTEGER stays exact', async () => {
    const result = await adapter.execute('SELECT id, status FROM orders ORDER BY id', [], ro);
    expect(result.rows).toHaveLength(100);
    expect(result.rows[0]).toEqual([1, 'paid']);
    expect(result.truncated).toBe(true);
    expect(
      await scalar('SELECT COUNT(*) FROM orders WHERE status = ? AND id > ?', ['paid', 0]),
    ).toBe(250);
    const types = await adapter.execute(
      "SELECT 9007199254740993 AS big, 42 AS small, 1.5 AS fraction, x'DEAD' AS bin, NULL AS empty, 'text' AS t",
      [],
      ro,
    );
    expect(types.rows[0]).toEqual([
      '9007199254740993',
      42,
      1.5,
      new Uint8Array([0xde, 0xad]),
      null,
      'text',
    ]);
    expect(await scalar('SELECT ?', [true])).toBe(1);
  });

  it('a very large result is cut quickly', async () => {
    const started = performance.now();
    const result = await adapter.execute(
      'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c',
      [],
      ro,
    );
    expect(result.truncated).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('a timeout stops an endless query; the connection reopens automatically', async () => {
    const started = performance.now();
    const err = await errorOf(
      adapter.execute(
        'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT COUNT(*) FROM c',
        [],
        { readonly: true, maxRows: 10, timeoutSec: 1 },
      ),
    );
    expect(err.kind).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(await scalar('SELECT COUNT(*) FROM orders')).toBe(1000);
  });

  it('a timeout in the middle of a write transaction: the change is rolled back and the file lock is released', async () => {
    const err = await errorOf(
      adapter.execute(
        "INSERT INTO orders (customer_id, total, status) WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT 1, 1, 'it-timeout' FROM c",
        [],
        { readonly: false, maxRows: 10, timeoutSec: 1 },
      ),
    );
    expect(err.kind).toBe('timeout');
    const inserted = await adapter.execute(
      "INSERT INTO orders (customer_id, total, status) VALUES (1, 1, 'it-after')",
      [],
      rw,
    );
    expect(inserted.affectedRows).toBe(1);
    expect(await scalar("SELECT COUNT(*) FROM orders WHERE status = 'it-timeout'")).toBe(0);
    await adapter.execute("DELETE FROM orders WHERE status = 'it-after'", [], rw);
  });

  it('read-write: INSERT/DELETE with affectedRows; RETURNING deletes every row even when cut', async () => {
    const inserted = await adapter.execute(
      "INSERT INTO orders (customer_id, total, status) SELECT customer_id, 1, 'it-returning' FROM orders WHERE id <= 30",
      [],
      rw,
    );
    expect(inserted.columns).toEqual([]);
    expect(inserted.affectedRows).toBe(30);
    const deleted = await adapter.execute(
      "DELETE FROM orders WHERE status = 'it-returning' RETURNING id",
      [],
      rw,
    );
    expect(deleted.rows).toHaveLength(10);
    expect(deleted.truncated).toBe(true);
    expect(await scalar("SELECT COUNT(*) FROM orders WHERE status = 'it-returning'")).toBe(0);
  });

  it('VACUUM runs (outside a transaction) on a connection with write permission', async () => {
    const result = await adapter.execute('VACUUM', [], rw);
    expect(result.columns).toEqual([]);
  });

  it('errors are classified', async () => {
    expect((await errorOf(adapter.execute('SELECT * FROM does_not_exist', [], ro))).kind).toBe(
      'not_found',
    );
    expect((await errorOf(adapter.execute('SELEC 1', [], ro))).kind).toBe('syntax');
    expect((await errorOf(adapter.execute("SELECT load_extension('x')", [], ro))).kind).toBe(
      'permission',
    );
  });
});

describe('read-only connection', () => {
  it('the file is opened read-only: SQLite itself refuses writes', async () => {
    seededFile('ro.sqlite');
    const adapter = adapterFor('sqlite:ro.sqlite', ['read']);
    await adapter.connect();
    try {
      const err = await errorOf(
        adapter.execute(
          "INSERT INTO orders (customer_id, total, status) VALUES (1, 1, 'x')",
          [],
          ro,
        ),
      );
      expect(err.kind).toBe('readonly');
      const count = await adapter.execute('SELECT COUNT(*) FROM orders', [], ro);
      expect(count.rows).toEqual([[1000]]);
    } finally {
      await adapter.close();
    }
  });
});

describe('file validation', () => {
  it('missing file: a connection error that only names the file, and the file is not created', async () => {
    const err = await errorOf(adapterFor('sqlite:./missing.sqlite').connect());
    expect(err.kind).toBe('connection');
    expect(err.message).toBe('SQLite file missing.sqlite not found');
    expect(existsSync(join(dir, 'missing.sqlite'))).toBe(false);
  });

  it('a file that is not a SQLite database', async () => {
    writeFileSync(join(dir, 'not-a-db.sqlite'), 'this is not a database'.repeat(100));
    expect((await errorOf(adapterFor('sqlite:not-a-db.sqlite').connect())).kind).toBe('connection');
  });

  it('a url without the sqlite prefix: rejected', async () => {
    expect((await errorOf(adapterFor('./app.sqlite').connect())).message).toContain(
      'sqlite:<file path>',
    );
  });

  it('sqlitePathOf: absolute path, sqlite:///, and relative to the config folder', () => {
    expect(sqlitePathOf('sqlite:/data/app.db', '/proj')).toBe('/data/app.db');
    expect(sqlitePathOf('sqlite:///data/app.db', '/proj')).toBe('/data/app.db');
    expect(sqlitePathOf('sqlite:./db/app.db', '/proj')).toBe('/proj/db/app.db');
    expect(sqlitePathOf('SQLITE:db/app.db', '/proj')).toBe('/proj/db/app.db');
  });
});
