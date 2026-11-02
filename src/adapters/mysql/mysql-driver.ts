import type {
  ExcessRows,
  MysqlConnLike,
  MysqlPoolFactory,
  MysqlPoolSettings,
  MysqlRunResult,
} from './driver-types.js';

/**
 * Bridge to the real mysql2 driver (callback API, not .stream()).
 *
 * Loaded dynamically when the first MySQL/MariaDB connection opens, so the server can still
 * start even if the driver has a problem. The module is accessed through the minimal interface below.
 *
 * Why not .stream(): in mysql2 3.x, stream.destroy() does not stop row reading,
 * and if the connection is paused at that moment, it is never resumed.
 */

interface RawField {
  name: string;
}
interface RawCommand {
  on(event: 'fields', listener: (fields: RawField[] | undefined) => void): RawCommand;
  on(event: 'result', listener: (row: unknown, index?: number) => void): RawCommand;
  on(event: 'end', listener: () => void): RawCommand;
  on(event: 'error', listener: (err: Error) => void): RawCommand;
}
interface StatementOptions {
  sql: string;
  rowsAsArray: boolean;
}
/** The slice of a mysql2 connection that this project uses. */
export interface RawConnection {
  threadId: number | null;
  query(options: StatementOptions): RawCommand;
  execute(options: StatementOptions, values: unknown[]): RawCommand;
  unprepare(options: StatementOptions): void;
  reset(callback: (err: Error | null) => void): void;
  release(): void;
  destroy(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}
interface RawPool {
  getConnection(callback: (err: Error | null, connection: RawConnection) => void): void;
  end(callback: (err?: Error | null) => void): void;
}
interface RawSingleConnection {
  query(sql: string, callback: (err: Error | null) => void): void;
  end(callback: (err?: Error | null) => void): void;
  destroy(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}
interface Mysql2Module {
  createPool(options: Record<string, unknown>): RawPool;
  createConnection(options: Record<string, unknown>): RawSingleConnection;
}

/** Row limit for adapter-owned SQL (the catalog queries already use their own LIMIT). */
const INTERNAL_MAX_ROWS = 10_000;

/** URL parameters that may be used. The rest are rejected so they cannot change safe settings. */
const ALLOWED_URL_PARAMS: ReadonlySet<string> = new Set(['ssl', 'charset']);

/**
 * Turn a connection string mysql://user:pass@host:port/db into mysql2 options.
 * mysql2's `uri` option is not used: mysql2 lets URL parameters override explicit
 * options whose value is false, for example ?multipleStatements=true.
 * Exported for unit tests. Error messages never contain the connection string.
 */
export function parseMysqlUrl(uri: string): Record<string, unknown> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(
      'Invalid MySQL/MariaDB connection string (format: mysql://user:pass@host:port/database)',
    );
  }
  if (url.protocol !== 'mysql:' && url.protocol !== 'mariadb:') {
    throw new Error(
      `MySQL/MariaDB connection string must start with mysql:// (not ${url.protocol}//)`,
    );
  }
  const options: Record<string, unknown> = {
    host: decodeURIComponent(url.hostname.replace(/^\[(.*)\]$/, '$1')),
    port: url.port ? Number.parseInt(url.port, 10) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database) options.database = database;
  for (const [key, value] of url.searchParams) {
    if (!ALLOWED_URL_PARAMS.has(key)) {
      throw new Error(
        `Parameter "${key}" in the MySQL/MariaDB connection string is not supported (supported: ${[...ALLOWED_URL_PARAMS].join(', ')})`,
      );
    }
    try {
      options[key] = JSON.parse(value) as unknown;
    } catch {
      options[key] = value;
    }
  }
  return options;
}

function isResultHeader(row: unknown): row is { affectedRows: number } {
  return (
    typeof row === 'object' &&
    row !== null &&
    !Array.isArray(row) &&
    typeof (row as { affectedRows?: unknown }).affectedRows === 'number'
  );
}

/** Exported for unit tests. */
export function runStatement(
  connection: RawConnection,
  sql: string,
  params: readonly unknown[],
  maxRows: number,
  excess: ExcessRows,
): Promise<MysqlRunResult> {
  return new Promise((resolve, reject) => {
    const options: StatementOptions = { sql, rowsAsArray: true };
    const prepared = params.length > 0;
    // Without parameters: text protocol, the SQL is sent as is (no client-side "?" formatting).
    // With parameters: a prepared statement, values are bound on the server.
    const command = prepared ? connection.execute(options, [...params]) : connection.query(options);
    const limit = maxRows + 1;
    const rows: unknown[][] = [];
    let fields: string[] | undefined;
    let affectedRows: number | null = null;
    let settled = false;

    const finish = (aborted: boolean) => {
      settled = true;
      if (prepared && !aborted) connection.unprepare(options);
      resolve({ fields: fields ?? [], rows, affectedRows, aborted });
    };

    command.on('fields', (meta) => {
      if (fields === undefined && meta) fields = meta.map((f) => f.name);
    });
    command.on('result', (row, index) => {
      if (settled) return;
      // Only the first result set (CALL can return several).
      if ((index ?? 0) > 0) return;
      if (isResultHeader(row)) {
        affectedRows ??= row.affectedRows;
        return;
      }
      if (!Array.isArray(row) || rows.length >= limit) return;
      rows.push(row as unknown[]);
      if (rows.length >= limit && excess === 'abort') {
        // Drop the connection so the remaining rows are not read. The "connection closed" error that follows is ignored.
        connection.on('error', () => undefined);
        connection.destroy();
        finish(true);
      }
    });
    command.on('end', () => {
      if (!settled) finish(false);
    });
    command.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (prepared) connection.unprepare(options);
      reject(err);
    });
  });
}

function unwrapDefault<T>(module: unknown): T {
  const withDefault = module as { default?: unknown };
  return (withDefault.default ?? module) as T;
}

/** Load mysql2 lazily and return a factory that creates connection pools. */
export async function loadMysqlPoolFactory(): Promise<MysqlPoolFactory> {
  const mysql = unwrapDefault<Mysql2Module>(await import('mysql2'));

  return (settings: MysqlPoolSettings) => {
    const base: Record<string, unknown> = {
      ...parseMysqlUrl(settings.uri),
      connectTimeout: settings.connectTimeoutMillis,
      // Large numbers and dates as text: no loss of precision and no time zone shift.
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      multipleStatements: false,
      // LOAD DATA LOCAL INFILE is disabled at the protocol level (the guard rejects it too).
      flags: ['-LOCAL_FILES'],
      connectAttributes: { program_name: 'multidb-mcp' },
    };
    const pool = mysql.createPool({
      ...base,
      connectionLimit: settings.connectionLimit,
      maxIdle: settings.connectionLimit,
      idleTimeout: settings.idleTimeoutMillis,
      enableKeepAlive: true,
      waitForConnections: true,
    });

    const wrap = (raw: RawConnection): MysqlConnLike => ({
      threadId: raw.threadId ?? -1,
      query: async (sql, params = []) => {
        const result = await runStatement(raw, sql, params, INTERNAL_MAX_ROWS, 'drain');
        return result.rows.map((row) =>
          Object.fromEntries(result.fields.map((name, i) => [name, row[i]])),
        );
      },
      run: (sql, params, maxRows, excess) => runStatement(raw, sql, params, maxRows, excess),
      reset: () =>
        new Promise((resolve, reject) => raw.reset((err) => (err ? reject(err) : resolve()))),
      release: (destroy) => (destroy ? raw.destroy() : raw.release()),
    });

    return {
      getConnection: () =>
        new Promise((resolve, reject) =>
          pool.getConnection((err, raw) => (err ? reject(err) : resolve(wrap(raw)))),
        ),
      killQuery: (threadId) => {
        if (!Number.isSafeInteger(threadId) || threadId <= 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const killer = mysql.createConnection(base);
          killer.on('error', () => undefined);
          killer.query(`KILL QUERY ${threadId}`, (err) => {
            killer.end(() => (err ? reject(err) : resolve()));
          });
        });
      },
      end: () =>
        new Promise((resolve, reject) => pool.end((err) => (err ? reject(err) : resolve()))),
    };
  };
}
