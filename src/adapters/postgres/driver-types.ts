/**
 * Minimal interface to the pg driver used by PostgresAdapter.
 * The adapter depends only on this interface, so its logic can be tested with a
 * fake pool and no database, while the real driver (pg + pg-cursor) is loaded when needed.
 */

export interface PgRowsResult {
  rows: Record<string, unknown>[];
}

/** Rows and column metadata read from a cursor. */
export interface PgCursorResult {
  /** Column names in order. Empty for commands without a result (INSERT/UPDATE/DDL). */
  fields: string[];
  rows: unknown[][];
  /** Number of rows affected by DML, when the driver reports it. */
  rowCount: number | null;
  command: string | null;
}

/** One checked-out PostgreSQL client. */
export interface PgClientLike {
  query(text: string, values?: readonly unknown[]): Promise<PgRowsResult>;
  /** Run a statement through a cursor and fetch at most maxRows rows. */
  cursor(text: string, values: readonly unknown[], maxRows: number): Promise<PgCursorResult>;
  escapeIdentifier(name: string): string;
  /** destroy=true: the connection is dropped from the pool (used when the connection is broken). */
  release(destroy?: boolean): void;
}

/** A pool of PostgreSQL clients. */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

/** Settings used to create a PostgreSQL pool. */
export interface PgPoolSettings {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  applicationName: string;
  /** Called when an idle pool connection drops (without a listener, the Node process would crash). */
  onIdleError: (err: Error) => void;
}

/** Creates a PostgreSQL pool from settings. */
export type PgPoolFactory = (settings: PgPoolSettings) => PgPoolLike;
