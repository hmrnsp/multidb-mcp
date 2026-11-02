import type {
  Db2ConnLike,
  Db2PoolFactory,
  Db2PoolLike,
  Db2PoolSettings,
  Db2RunResult,
} from './driver-types.js';
import { SQLCODE_TIMEOUT, sqlcodeOf } from './errors.js';

/**
 * Bridge to the real ibm_db driver (native module + IBM's Db2 CLI driver).
 *
 * Loaded dynamically when the first Db2 connection opens. On an OS that cannot load the
 * Db2 CLI driver (for example Ubuntu 26.04 without libxml2.so.2), the server still starts and the Db2
 * connection gets a failed status with a clear message; run the server through the Docker image.
 *
 * ibm_db's own pool is not used: close() on a pooled connection only returns it to the pool, so
 * a broken connection is hard to discard reliably. The small pool below is enough for one developer.
 */

interface RawColumnMeta {
  SQL_DESC_NAME: string;
  /** ibm_db really spells it "CONSIZE". */
  SQL_DESC_CONSIZE_TYPE: number;
  SQL_DESC_DISPLAY_SIZE: number;
  SQL_DESC_SCALE: number;
}
interface RawResult {
  getColumnMetadataSync(): RawColumnMeta[];
  getAffectedRowsSync(): number;
  fetch(options: { fetchMode: number }, callback: (err: Error | null, row: unknown) => void): void;
  closeSync(): void;
}
interface RawStatement {
  setAttrSync(attribute: number, value: number): void;
  execute(params: unknown[], callback: (err: Error | null, result: RawResult) => void): void;
  closeSync(): void;
}
/** The slice of an ibm_db connection that the pool uses. */
export interface RawDatabase {
  prepare(sql: string, callback: (err: Error | null, stmt: RawStatement) => void): void;
  beginTransaction(callback: (err: Error | null) => void): void;
  commitTransaction(callback: (err: Error | null) => void): void;
  rollbackTransaction(callback: (err: Error | null) => void): void;
  close(callback: (err: Error | null) => void): void;
}
/** The slice of the ibm_db module that this project uses. */
export interface IbmDbModule {
  open(
    connectionString: string,
    options: { connectTimeout: number },
    callback: (err: Error | null, db: RawDatabase) => void,
  ): void;
  FETCH_ARRAY: number;
  SQL_ATTR_QUERY_TIMEOUT: number;
}

/** SQL type ODBC: SQL_NUMERIC = 2, SQL_DECIMAL = 3, SQL_DECFLOAT = -360. */
const SQL_NUMERIC = 2;
const SQL_DECIMAL = 3;
const SQL_DECFLOAT = -360;
/** A double holds 15 significant decimal digits exactly. */
const EXACT_DIGITS = 15;
/** Row limit for adapter-owned SQL (the catalog queries already use their own FETCH FIRST). */
const INTERNAL_MAX_ROWS = 10_000;

function call<T>(fn: (callback: (err: Error | null, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, value) => (err ? reject(err) : resolve(value)));
  });
}

function callVoid(fn: (callback: (err: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    fn((err) => (err ? reject(err) : resolve()));
  });
}

/** Result of converting one value: exact=false when the value may already have shifted in the driver. */
type ColumnConverter = (value: unknown) => { value: unknown; exact: boolean };

/**
 * ibm_db always reads DECIMAL/NUMERIC/DECFLOAT as a double (see src/odbc.cpp).
 * A double holds 15 decimal digits exactly, so a DECIMAL(p,s) value below
 * 10^(15-s) is restored exactly through toFixed(s). This applies per value, not per column:
 * SUM() in Db2 is always DECIMAL(31,s), but the total is usually far below that limit.
 * DECFLOAT has no fixed scale, so it is always treated as possibly inexact.
 */
export function decimalConverter(meta: RawColumnMeta): ColumnConverter | undefined {
  const type = meta.SQL_DESC_CONSIZE_TYPE;
  if (type === SQL_DECIMAL || type === SQL_NUMERIC) {
    const scale = Math.min(100, Math.max(0, meta.SQL_DESC_SCALE));
    const safeBelow = 10 ** (EXACT_DIGITS - scale);
    return (value) => {
      if (typeof value !== 'number') return { value, exact: true };
      if (Math.abs(value) < safeBelow) return { value: value.toFixed(scale), exact: true };
      return { value: String(value), exact: false };
    };
  }
  if (type === SQL_DECFLOAT) {
    return (value) =>
      typeof value === 'number' ? { value: String(value), exact: false } : { value, exact: true };
  }
  return undefined;
}

/** Exported for unit tests. */
export async function runStatement(
  ibmdb: Pick<IbmDbModule, 'FETCH_ARRAY' | 'SQL_ATTR_QUERY_TIMEOUT'>,
  db: RawDatabase,
  sql: string,
  params: readonly unknown[],
  maxRows: number,
  timeoutSec: number,
): Promise<Db2RunResult> {
  const startedAt = Date.now();
  const timeoutMs = timeoutSec * 1000;
  const stmt = await call<RawStatement>((cb) => db.prepare(sql, cb));
  let result: RawResult | undefined;
  try {
    stmt.setAttrSync(ibmdb.SQL_ATTR_QUERY_TIMEOUT, Math.max(1, Math.round(timeoutSec)));
    result = await call<RawResult>((cb) => stmt.execute([...params], cb));
    const meta = result.getColumnMetadataSync();
    if (meta.length === 0) {
      return {
        fields: [],
        rows: [],
        affectedRows: result.getAffectedRowsSync(),
        impreciseColumns: [],
      };
    }
    const converters = meta.map(decimalConverter);
    const imprecise = new Set<number>();
    const rows: unknown[][] = [];
    const limit = maxRows + 1;
    const open = result;
    while (rows.length < limit) {
      const row = await call<unknown>((cb) => open.fetch({ fetchMode: ibmdb.FETCH_ARRAY }, cb));
      if (!Array.isArray(row)) break;
      rows.push(
        (row as unknown[]).map((value, i) => {
          const convert = converters[i];
          if (!convert) return value;
          const converted = convert(value);
          if (!converted.exact) imprecise.add(i);
          return converted.value;
        }),
      );
    }
    return {
      fields: meta.map((m) => m.SQL_DESC_NAME),
      rows,
      affectedRows: null,
      impreciseColumns: [...imprecise].sort((a, b) => a - b).map((i) => meta[i]!.SQL_DESC_NAME),
    };
  } catch (err) {
    // On a query timeout, ibm_db reports an error without a message (sqlcode 0) instead of SQL0952N.
    const elapsed = Date.now() - startedAt;
    if (sqlcodeOf(err) === undefined && elapsed >= timeoutMs - 250) {
      throw Object.assign(new Error(`SQL0952N Query cancelled after ${timeoutSec} seconds`), {
        sqlcode: SQLCODE_TIMEOUT,
        cause: err,
      });
    }
    throw err;
  } finally {
    // Closing the result set closes the cursor on the server: the remaining rows are not sent.
    try {
      result?.closeSync();
    } finally {
      stmt.closeSync();
    }
  }
}

function rowsToObjects(result: Db2RunResult): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.fields.map((name, i) => [name, row[i]])),
  );
}

/** Load ibm_db lazily and return a factory that creates connection pools. */
export async function loadDb2PoolFactory(): Promise<Db2PoolFactory> {
  const module = (await import('ibm_db')) as { default?: unknown };
  const ibmdb = (module.default ?? module) as IbmDbModule;
  return (settings) => createDb2Pool(ibmdb, settings);
}

/**
 * A small pool on top of ibm_db. An idle connection is closed after idleTimeoutMs: a connection that has been
 * idle for a long time may have been dropped silently by a firewall or a Db2 restart, and the first
 * query that uses it would fail.
 */
export function createDb2Pool(ibmdb: IbmDbModule, settings: Db2PoolSettings): Db2PoolLike {
  const idle: { db: RawDatabase; timer: NodeJS.Timeout }[] = [];
  let closed = false;
  const closeRaw = (db: RawDatabase) => callVoid((cb) => db.close(cb)).catch(() => undefined);

  const park = (db: RawDatabase) => {
    const entry = {
      db,
      timer: setTimeout(() => {
        const index = idle.indexOf(entry);
        if (index !== -1) idle.splice(index, 1);
        void closeRaw(db);
      }, settings.idleTimeoutMs),
    };
    entry.timer.unref();
    idle.push(entry);
  };

  const wrap = (db: RawDatabase): Db2ConnLike => {
    let released = false;
    return {
      query: async (sql, params, timeoutSec) =>
        rowsToObjects(await runStatement(ibmdb, db, sql, params, INTERNAL_MAX_ROWS, timeoutSec)),
      run: (sql, params, maxRows, timeoutSec) =>
        runStatement(ibmdb, db, sql, params, maxRows, timeoutSec),
      beginTransaction: () => callVoid((cb) => db.beginTransaction(cb)),
      commit: () => callVoid((cb) => db.commitTransaction(cb)),
      rollback: () => callVoid((cb) => db.rollbackTransaction(cb)),
      release: async (destroy) => {
        if (released) return;
        released = true;
        if (destroy || closed || idle.length >= settings.maxPoolSize) {
          await closeRaw(db);
        } else {
          park(db);
        }
      },
    };
  };

  return {
    open: async () => {
      if (closed) throw new Error('The Db2 pool is already closed');
      const reused = idle.pop();
      if (reused) {
        clearTimeout(reused.timer);
        return wrap(reused.db);
      }
      const db = await call<RawDatabase>((cb) =>
        ibmdb.open(settings.connectionString, { connectTimeout: settings.connectTimeoutSec }, cb),
      );
      return wrap(db);
    },
    close: async () => {
      closed = true;
      const parked = idle.splice(0);
      for (const entry of parked) clearTimeout(entry.timer);
      await Promise.all(parked.map((entry) => closeRaw(entry.db)));
    },
  };
}
