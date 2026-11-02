/**
 * Minimal interface to the mysql2 driver used by MysqlAdapter.
 * The adapter depends only on this interface, so its logic can be tested with a
 * fake pool and no database, while the real driver is loaded when needed.
 */

export type ExcessRows =
  /** Stop as soon as rows exceed the limit: the connection is dropped (safe for read queries). */
  | 'abort'
  /** Read to the end without keeping the excess, so a write statement completes in full. */
  | 'drain';

/** Result of running one statement on MySQL/MariaDB. */
export interface MysqlRunResult {
  /** Column names in order. Empty for commands without a result (INSERT/UPDATE/DDL). */
  fields: string[];
  /** At most maxRows + 1 rows. */
  rows: unknown[][];
  /** Number of rows affected by a command without a result. */
  affectedRows: number | null;
  /** true when run stopped with excess 'abort': the connection is already dropped and the query needs a KILL. */
  aborted: boolean;
}

/** One checked-out MySQL/MariaDB connection. */
export interface MysqlConnLike {
  /** Connection id on the server, for KILL QUERY. */
  readonly threadId: number;
  /** Adapter-owned SQL (catalog, SET, transactions). Parameters are bound on the server when present. */
  query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /**
   * User SQL: fetch at most maxRows + 1 rows. With parameters, it runs as a
   * prepared statement that is closed again afterwards.
   */
  run(
    sql: string,
    params: readonly unknown[],
    maxRows: number,
    excess: ExcessRows,
  ): Promise<MysqlRunResult>;
  /** COM_RESET_CONNECTION: clears session variables, temporary tables, and prepared statements. */
  reset(): Promise<void>;
  /** destroy=true: the connection is dropped from the pool (used when the connection is broken or was KILLed). */
  release(destroy?: boolean): void;
}

/** A pool of MySQL/MariaDB connections. */
export interface MysqlPoolLike {
  getConnection(): Promise<MysqlConnLike>;
  /** KILL QUERY through a separate connection (the pool may be full). */
  killQuery(threadId: number): Promise<void>;
  end(): Promise<void>;
}

/** Settings used to create a MySQL/MariaDB pool. */
export interface MysqlPoolSettings {
  uri: string;
  connectionLimit: number;
  idleTimeoutMillis: number;
  connectTimeoutMillis: number;
}

/** Creates a MySQL/MariaDB pool from settings. */
export type MysqlPoolFactory = (settings: MysqlPoolSettings) => MysqlPoolLike;
