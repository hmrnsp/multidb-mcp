import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDb2Pool,
  decimalConverter,
  type IbmDbModule,
  runStatement,
  type RawDatabase,
} from '../../src/adapters/db2/db2-driver.js';
import { toDb2DbError } from '../../src/adapters/db2/errors.js';

const meta = (name: string, type: number, display = 10, scale = 0) => ({
  SQL_DESC_NAME: name,
  SQL_DESC_CONSIZE_TYPE: type,
  SQL_DESC_DISPLAY_SIZE: display,
  SQL_DESC_SCALE: scale,
});

describe('decimalConverter', () => {
  const convert = (m: ReturnType<typeof meta>, value: unknown) => decimalConverter(m)!(value);

  it('DECIMAL is restored exactly as text with the column scale when below 10^(15-scale)', () => {
    const dec12 = meta('TOTAL', 3, 14, 2); // DECIMAL(12,2)
    expect(convert(dec12, 12345.67)).toEqual({ value: '12345.67', exact: true });
    expect(convert(dec12, 1.5)).toEqual({ value: '1.50', exact: true });
    expect(convert(dec12, -0.1)).toEqual({ value: '-0.10', exact: true });
    expect(convert(dec12, null)).toEqual({ value: null, exact: true });
    expect(convert(meta('X', 2, 7, 3), 1.005)).toEqual({ value: '1.005', exact: true });
  });

  it('a SUM of type DECIMAL(31,2) stays exact while its value is small', () => {
    const sum = meta('TOTAL', 3, 33, 2);
    expect(convert(sum, 15750)).toEqual({ value: '15750.00', exact: true });
    expect(convert(sum, 9999999999999.99)).toEqual({ value: '9999999999999.99', exact: true });
    expect(convert(sum, 1234567890123456800)).toEqual({
      value: '1234567890123456800',
      exact: false,
    });
  });

  it('DECFLOAT is always flagged as possibly inexact; other types are unchanged', () => {
    expect(convert(meta('DF', -360, 42), 1.5)).toEqual({ value: '1.5', exact: false });
    expect(decimalConverter(meta('ID', 4))).toBeUndefined();
  });
});

/** A fake ibm_db database: one statement with rows and metadata defined by the test. */
function fakeDb(options: {
  meta?: ReturnType<typeof meta>[];
  rows?: unknown[][];
  affected?: number;
  executeError?: Error;
  executeDelayMs?: number;
}) {
  const calls: string[] = [];
  let fetched = 0;
  const result = {
    getColumnMetadataSync: () => options.meta ?? [],
    getAffectedRowsSync: () => options.affected ?? 0,
    fetch: (_o: unknown, cb: (err: Error | null, row: unknown) => void) => {
      const row = options.rows?.[fetched] ?? null;
      fetched += 1;
      cb(null, row);
    },
    closeSync: () => calls.push('result.close'),
  };
  const stmt = {
    setAttrSync: (attr: number, value: number) => calls.push(`setAttr ${attr}=${value}`),
    execute: (params: unknown[], cb: (err: Error | null, r: typeof result) => void) => {
      calls.push(`execute ${JSON.stringify(params)}`);
      setTimeout(
        () => (options.executeError ? cb(options.executeError, result) : cb(null, result)),
        options.executeDelayMs ?? 0,
      );
    },
    closeSync: () => calls.push('stmt.close'),
  };
  const db = {
    prepare: (sql: string, cb: (err: Error | null, s: typeof stmt) => void) => {
      calls.push(`prepare ${sql}`);
      cb(null, stmt);
    },
  } as unknown as RawDatabase;
  return { db, calls, fetchCount: () => fetched };
}

const ibmdb = { FETCH_ARRAY: 3, SQL_ATTR_QUERY_TIMEOUT: 0 };

describe('runStatement', () => {
  it('prepare, set the timeout, fetch maxRows+1 rows, then close the result and statement', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => [i, 1.5]);
    const fake = fakeDb({ meta: [meta('ID', 4), meta('TOTAL', 3, 14, 2)], rows });
    const out = await runStatement(ibmdb, fake.db, 'SELECT ID, TOTAL FROM T', [7], 3, 30);
    expect(out.fields).toEqual(['ID', 'TOTAL']);
    expect(out.rows).toEqual([
      [0, '1.50'],
      [1, '1.50'],
      [2, '1.50'],
      [3, '1.50'],
    ]);
    expect(fake.fetchCount()).toBe(4);
    expect(fake.calls).toEqual([
      'prepare SELECT ID, TOTAL FROM T',
      'setAttr 0=30',
      'execute [7]',
      'result.close',
      'stmt.close',
    ]);
  });

  it('a command without a result: affectedRows', async () => {
    const fake = fakeDb({ affected: 4 });
    const out = await runStatement(ibmdb, fake.db, 'UPDATE T SET A = 1', [], 10, 30);
    expect(out).toEqual({ fields: [], rows: [], affectedRows: 4, impreciseColumns: [] });
  });

  it('a DECIMAL column is reported only when a value passes the exact limit', async () => {
    const small = fakeDb({ meta: [meta('BESAR', 3, 33, 2)], rows: [[10.5]] });
    const ok = await runStatement(ibmdb, small.db, 'SELECT BESAR FROM T', [], 10, 30);
    expect(ok.impreciseColumns).toEqual([]);
    const fake = fakeDb({ meta: [meta('BESAR', 3, 33, 2)], rows: [[10.5], [1e18]] });
    const out = await runStatement(ibmdb, fake.db, 'SELECT BESAR FROM T', [], 10, 30);
    expect(out.impreciseColumns).toEqual(['BESAR']);
  });

  it('an error without a message after the time limit counts as a timeout (SQL0952N)', async () => {
    const empty = Object.assign(new Error(''), { sqlcode: 0, sqlstate: '00000' });
    const fake = fakeDb({ executeError: empty, executeDelayMs: 30 });
    const err = await runStatement(ibmdb, fake.db, 'SELECT 1', [], 10, 0.02).catch(
      (e: unknown) => e,
    );
    expect(toDb2DbError(err).kind).toBe('timeout');
    expect(fake.calls.at(-1)).toBe('stmt.close');
  });

  it('an error without a message before the time limit does not count as a timeout', async () => {
    const empty = Object.assign(new Error(''), { sqlcode: 0 });
    const fake = fakeDb({ executeError: empty });
    const err = await runStatement(ibmdb, fake.db, 'SELECT 1', [], 10, 30).catch((e: unknown) => e);
    expect(err).toBe(empty);
  });
});

describe('createDb2Pool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fake ibm_db that records connections opened and closed. */
  function fakeModule() {
    const events: string[] = [];
    let opened = 0;
    const module = {
      FETCH_ARRAY: 3,
      SQL_ATTR_QUERY_TIMEOUT: 0,
      open: (_cs: string, _o: unknown, cb: (err: Error | null, db: RawDatabase) => void) => {
        opened += 1;
        const name = `db${opened}`;
        events.push(`open ${name}`);
        cb(null, {
          close: (done: (err: Error | null) => void) => {
            events.push(`close ${name}`);
            done(null);
          },
        } as unknown as RawDatabase);
      },
    } as unknown as IbmDbModule;
    return { module, events };
  }
  const settings = {
    connectionString: 'DATABASE=X;',
    maxPoolSize: 2,
    connectTimeoutSec: 10,
    idleTimeoutMs: 30_000,
  };

  it('reuses an idle connection; a broken connection (destroy) is closed', async () => {
    const { module, events } = fakeModule();
    const pool = createDb2Pool(module, settings);
    await (await pool.open()).release();
    await (await pool.open()).release(true);
    await pool.open();
    expect(events).toEqual(['open db1', 'close db1', 'open db2']);
  });

  it('a connection idle past idleTimeoutMs is closed and not used again', async () => {
    vi.useFakeTimers();
    const { module, events } = fakeModule();
    const pool = createDb2Pool(module, settings);
    await (await pool.open()).release();
    await vi.advanceTimersByTimeAsync(29_000);
    await (await pool.open()).release();
    expect(events).toEqual(['open db1']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toEqual(['open db1', 'close db1']);
    await pool.open();
    expect(events).toEqual(['open db1', 'close db1', 'open db2']);
  });

  it('close closes idle connections and refuses the next open', async () => {
    const { module, events } = fakeModule();
    const pool = createDb2Pool(module, settings);
    const a = await pool.open();
    const b = await pool.open();
    await a.release();
    await b.release();
    await pool.close();
    expect(events.filter((e) => e.startsWith('close')).sort()).toEqual(['close db1', 'close db2']);
    await expect(pool.open()).rejects.toThrow('already closed');
  });
});
