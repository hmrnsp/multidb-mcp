/**
 * Integration test for Db2Adapter with the real driver (ibm_db) against Docker Db2 Community Edition.
 *
 *   npm run db:up:db2 && npm run seed:db2      (the seed runs through docker:dev)
 *   npm run docker:dev -- npm run test:db2
 *
 * Skipped automatically when DB2_LOCAL_CONN is not set in .env.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db2Adapter } from '../../src/adapters/db2/db2-adapter.js';
import { loadDb2PoolFactory } from '../../src/adapters/db2/db2-driver.js';
import { DbError } from '../../src/adapters/errors.js';
import type { ResolvedSource } from '../../src/config/loader.js';
import { Secret } from '../../src/config/secret.js';
import { createLogger } from '../../src/observability/logger.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const CONN = process.env.DB2_LOCAL_CONN?.trim() ?? '';
const log = createLogger({ level: 'warn' });

function source(connection: string, extra: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    id: 'it_db2',
    driver: 'db2',
    env: 'local',
    description: 'integration test',
    connection: new Secret(connection),
    access: ['read', 'insert', 'update', 'delete', 'ddl', 'call'],
    readonly: false,
    limits: { maxRows: 200, timeoutSec: 10, maxChars: 40_000 },
    schemas: ['APP'],
    lazy: true,
    baseDir: process.cwd(),
    ...extra,
  };
}

const adapterFor = (connection: string, extra: Partial<ResolvedSource> = {}) =>
  new Db2Adapter(source(connection, extra), log, { loadPoolFactory: loadDb2PoolFactory });

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

describe.skipIf(CONN === '')('Db2Adapter against Docker Db2', () => {
  const adapter = adapterFor(CONN);
  const scalar = async (sql: string, params: unknown[] = []) =>
    (await adapter.execute(sql, params, ro)).rows[0]?.[0];

  beforeAll(async () => {
    await adapter.connect();
  });
  afterAll(async () => {
    await adapter.close();
  });

  it('listTables: schema name and case-insensitive search', async () => {
    expect(await adapter.listTables({ schema: 'app', limit: 50 })).toEqual([
      { schema: 'APP', name: 'CUSTOMERS', type: 'table' },
      { schema: 'APP', name: 'ORDERS', type: 'table' },
      { schema: 'APP', name: 'V_ORDER_SUMMARY', type: 'view' },
    ]);
    const found = await adapter.listTables({ search: 'ord', limit: 50 });
    expect(found.map((t) => t.name)).toEqual(['ORDERS', 'V_ORDER_SUMMARY']);
  });

  it('describeTable: columns, identity, default, PK, FK, indexes (lower-case name)', async () => {
    const detail = await adapter.describeTable('orders');
    expect(detail.schema).toBe('APP');
    expect(detail.name).toBe('ORDERS');
    expect(detail.columns.map((c) => [c.name, c.type, c.nullable, c.default])).toEqual([
      ['ID', 'INTEGER', false, 'GENERATED ALWAYS AS IDENTITY'],
      ['CUSTOMER_ID', 'INTEGER', false, null],
      ['TOTAL', 'DECIMAL(12,2)', false, null],
      ['STATUS', 'VARCHAR(20)', false, null],
      ['CREATED_AT', 'TIMESTAMP', false, 'CURRENT TIMESTAMP'],
    ]);
    expect(detail.primaryKey).toEqual(['ID']);
    expect(detail.foreignKeys).toEqual([
      {
        name: 'FK_ORDERS_CUSTOMER',
        columns: ['CUSTOMER_ID'],
        refSchema: 'APP',
        refTable: 'CUSTOMERS',
        refColumns: ['ID'],
      },
    ]);
    // Db2 names the primary key index automatically (SQL...), and it always appears first.
    expect(detail.indexes[0]).toMatchObject({ columns: ['ID'], unique: true });
    expect(detail.indexes[1]).toEqual({
      name: 'IDX_ORDERS_CUSTOMER',
      columns: ['CUSTOMER_ID'],
      unique: false,
    });

    const customers = await adapter.describeTable('CUSTOMERS', 'app');
    expect(customers.columns.find((c) => c.name === 'NIK')).toMatchObject({
      type: 'CHARACTER(16)',
      nullable: true,
      default: null,
    });
    expect(customers.indexes.some((i) => i.unique && i.columns.join() === 'EMAIL')).toBe(true);
    expect((await adapter.describeTable('v_order_summary')).type).toBe('view');
    expect((await errorOf(adapter.describeTable('does_not_exist'))).kind).toBe('not_found');
  });

  it('execute: a name without a schema uses CurrentSchema, stops at maxRows', async () => {
    const result = await adapter.execute('SELECT ID, STATUS FROM ORDERS ORDER BY ID', [], ro);
    expect(result.columns).toEqual(['ID', 'STATUS']);
    expect(result.rows).toHaveLength(100);
    expect(result.rows[0]).toEqual([1, 'paid']);
    expect(result.truncated).toBe(true);
  });

  it('a very large result is cut quickly and the connection stays usable', async () => {
    const started = performance.now();
    const result = await adapter.execute(
      'SELECT A.COLNAME, B.COLNAME FROM SYSCAT.COLUMNS A, SYSCAT.COLUMNS B',
      [],
      ro,
    );
    expect(result.truncated).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(await scalar('SELECT 1 FROM SYSIBM.SYSDUMMY1')).toBe(1);
  });

  it('parameter ?', async () => {
    expect(
      await scalar('SELECT COUNT(*) FROM ORDERS WHERE STATUS = ? AND ID > ?', ['paid', 0]),
    ).toBe(250);
  });

  it('type mapping: DECIMAL exactly as text, BIGINT text, dates text, BLOB buffer', async () => {
    const result = await adapter.execute(
      `SELECT CAST(12345.67 AS DECIMAL(12, 2)) AS DEC_VAL, CAST(0.1 AS DECIMAL(5, 3)) AS DEC_KECIL,
              CAST(9007199254740993 AS BIGINT) AS BI, DATE('2026-01-15') AS D,
              TIMESTAMP('2026-01-15 10:30:00') AS TS, BLOB(X'DEADBEEF') AS BIN, CAST(NULL AS DECIMAL(5,2)) AS NULL_COL
       FROM SYSIBM.SYSDUMMY1`,
      [],
      ro,
    );
    expect(result.rows[0]).toEqual([
      '12345.67',
      '0.100',
      '9007199254740993',
      '2026-01-15',
      '2026-01-15 10:30:00.000000',
      Buffer.from('deadbeef', 'hex'),
      null,
    ]);
    expect(result.notes).toBeUndefined();
  });

  it('SUM (DECIMAL(31,2) in Db2) stays exact without a note when the value is small', async () => {
    const result = await adapter.execute('SELECT SUM(TOTAL) AS TOTAL FROM ORDERS', [], ro);
    expect(result.rows).toEqual([['750750.00']]);
    expect(result.notes).toBeUndefined();
  });

  it('DECIMAL over 15 digits: a note is added because it may be inexact', async () => {
    const result = await adapter.execute(
      "SELECT CAST('1234567890123456789.12' AS DECIMAL(31, 2)) AS BESAR, CAST(CAST('1234567890123456789.12' AS DECIMAL(31, 2)) AS VARCHAR(40)) AS PERSIS FROM SYSIBM.SYSDUMMY1",
      [],
      ro,
    );
    expect(result.notes?.[0]).toContain('CAST(BESAR AS VARCHAR(40))');
    expect(result.notes?.[0]).not.toContain('PERSIS');
    expect(result.rows[0]?.[1]).toBe('1234567890123456789.12');
  });

  it('a timeout cancels a heavy query and the connection stays usable', async () => {
    const started = performance.now();
    const err = await errorOf(
      adapter.execute(
        'SELECT COUNT(*) FROM SYSCAT.COLUMNS A, SYSCAT.COLUMNS B, SYSCAT.COLUMNS C',
        [],
        { readonly: true, maxRows: 10, timeoutSec: 1 },
      ),
    );
    expect(err.kind).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(await scalar('SELECT 1 FROM SYSIBM.SYSDUMMY1')).toBe(1);
  });

  it('read-only: a write is never saved because there is always a ROLLBACK', async () => {
    const before = await scalar('SELECT COUNT(*) FROM ORDERS');
    const inserted = await adapter.execute(
      "INSERT INTO ORDERS (CUSTOMER_ID, TOTAL, STATUS) VALUES (1, 1, 'it-ro')",
      [],
      ro,
    );
    expect(inserted.affectedRows).toBe(1);
    expect(await scalar('SELECT COUNT(*) FROM ORDERS')).toBe(before);
  });

  it('read-write: INSERT then DELETE (COMMIT) with affectedRows', async () => {
    const inserted = await adapter.execute(
      "INSERT INTO ORDERS (CUSTOMER_ID, TOTAL, STATUS) VALUES (1, 9.99, 'it-test')",
      [],
      rw,
    );
    expect(inserted.columns).toEqual([]);
    expect(inserted.affectedRows).toBe(1);
    const deleted = await adapter.execute('DELETE FROM ORDERS WHERE STATUS = ?', ['it-test'], rw);
    expect(deleted.affectedRows).toBe(1);
    expect(await scalar('SELECT COUNT(*) FROM ORDERS')).toBe(1000);
  });

  it('errors are classified with the real Db2 SQLSTATE', async () => {
    const missing = await errorOf(adapter.execute('SELECT * FROM TIDAK_ADA', [], ro));
    expect(missing.kind).toBe('not_found');
    expect(missing.sqlState).toBe('42704');
    expect(missing.message).toContain('SQL0204N');
    expect((await errorOf(adapter.execute('SELEC 1', [], ro))).kind).toBe('syntax');
  });
});

describe.skipIf(CONN === '')('validation on connect', () => {
  it('CurrentSchema in the connection string must be in the whitelist', async () => {
    const err = await errorOf(adapterFor(`${CONN}CurrentSchema=OTHER;`).connect());
    expect(err.kind).toBe('connection');
    expect(err.message).toContain('CurrentSchema');
  });

  it('another whitelist schema: the APP tables are not visible', async () => {
    const adapter = adapterFor(CONN, { schemas: ['OTHER'] });
    await adapter.connect();
    try {
      expect(await adapter.listTables({ limit: 50 })).toEqual([]);
      expect((await errorOf(adapter.describeTable('ORDERS'))).kind).toBe('not_found');
    } finally {
      await adapter.close();
    }
  });
});

describe('failed connection', () => {
  it('a wrong port yields a connection DbError without credentials', async () => {
    const err = await errorOf(
      adapterFor(
        'DATABASE=APPDB;HOSTNAME=127.0.0.1;PORT=1;PROTOCOL=TCPIP;UID=db2inst1;PWD=hunter-it;',
      ).connect(),
    );
    expect(err.kind).toBe('connection');
    expect(err.message).not.toContain('hunter-it');
  });
});
