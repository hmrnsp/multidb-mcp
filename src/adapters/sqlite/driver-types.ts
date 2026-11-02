/**
 * Interface between SqliteAdapter and the child process that holds the SQLite connection.
 *
 * The node:sqlite driver is synchronous: a running query blocks its thread and
 * cannot be stopped, not even by worker.terminate(). So every SQLite connection
 * runs in its own child process; a timeout kills that process (SIGKILL), then the operating system
 * releases the file lock and SQLite rolls back the uncommitted transaction.
 */

export interface SqliteRunRequest {
  sql: string;
  params: readonly SqliteParam[];
  /** Fetch at most maxRows + 1 rows. */
  maxRows: number;
  /** true: COMMIT at the end; false: always ROLLBACK. */
  write: boolean;
}

/** A bind parameter accepted by SQLite. */
export type SqliteParam = string | number | null;

/** Result of running one statement in the SQLite child process. */
export interface SqliteRunResult {
  /** Column names; empty for a command without a result. */
  fields: string[];
  rows: unknown[][];
  /** Number of rows affected by a command without a result. */
  affectedRows: number | null;
}

/** A handle to the child process that holds one SQLite connection. */
export interface SqliteHandleLike {
  run(request: SqliteRunRequest, timeoutMs: number): Promise<SqliteRunResult>;
  close(): Promise<void>;
}

/** Settings used to open a SQLite database. */
export interface SqliteSettings {
  /** Absolute path of the database file. */
  path: string;
  readOnly: boolean;
  /** How long to wait when another process (an application) holds the file lock. */
  busyTimeoutMs: number;
}

/** Creates a handle to a SQLite child process from settings. */
export type SqliteFactory = (settings: SqliteSettings) => SqliteHandleLike;
