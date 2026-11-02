/**
 * Minimal interface to the ibm_db driver used by Db2Adapter.
 * The adapter depends only on this interface, so its logic can be tested with a
 * fake pool and no database (ibm_db is a native module that does not load on every OS).
 */

export interface Db2RunResult {
  /** Column names in order. Empty for commands without a result (INSERT/UPDATE/DDL). */
  fields: string[];
  /** At most maxRows + 1 rows. */
  rows: unknown[][];
  /** Number of rows affected by a command without a result. */
  affectedRows: number | null;
  /** DECIMAL/DECFLOAT columns whose values may be inexact (ibm_db reads them as a double). */
  impreciseColumns: string[];
}

/** One checked-out Db2 connection. */
export interface Db2ConnLike {
  /** Adapter-owned SQL (catalog). Rows are returned as objects keyed by column name. */
  query(
    sql: string,
    params: readonly unknown[],
    timeoutSec: number,
  ): Promise<Record<string, unknown>[]>;
  /** User SQL: prepare, set the timeout, then fetch at most maxRows + 1 rows. */
  run(
    sql: string,
    params: readonly unknown[],
    maxRows: number,
    timeoutSec: number,
  ): Promise<Db2RunResult>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** destroy=true: the connection is really closed, not returned to the pool. */
  release(destroy?: boolean): Promise<void>;
}

/** A small pool of Db2 connections. */
export interface Db2PoolLike {
  open(): Promise<Db2ConnLike>;
  close(): Promise<void>;
}

/** Settings used to create a Db2 pool. */
export interface Db2PoolSettings {
  /** Connection string in ibm_db keyword format: DATABASE=..;HOSTNAME=..;PORT=..;UID=..;PWD=..; */
  connectionString: string;
  maxPoolSize: number;
  connectTimeoutSec: number;
  /** Idle connections are closed after this interval. */
  idleTimeoutMs: number;
}

/** Creates a Db2 pool from settings. */
export type Db2PoolFactory = (settings: Db2PoolSettings) => Db2PoolLike;
