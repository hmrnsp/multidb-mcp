import type { ResolvedSource } from '../config/loader.js';
import type { Driver } from '../config/schema.js';
import type { Logger } from '../observability/logger.js';

/**
 * The adapter contract.
 * Every difference between databases is hidden here; tools and the guard never
 * know which database they are talking to.
 */

export type SqlDialect = 'postgresql' | 'mysql' | 'mariadb' | 'db2' | 'sqlite';

/** Options for one SQL execution. */
export interface ExecOptions {
  readonly: boolean;
  maxRows: number;
  timeoutSec: number;
}

/** The result of one SQL execution. */
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** true when the result was cut off at maxRows. */
  truncated: boolean;
  /** Number of rows affected by DML (INSERT/UPDATE/DELETE). */
  affectedRows?: number;
  durationMs: number;
  /** Notes from the adapter about data accuracy (e.g. DECIMAL precision in Db2). */
  notes?: string[];
}

/** A table or view, as listed by list_tables. */
export interface TableInfo {
  schema: string;
  name: string;
  type: 'table' | 'view';
}

/** One column of a table. */
export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

/** One foreign key of a table. */
export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

/** One index of a table. */
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

/** Full structure of one table or view, as shown by describe_table. */
export interface TableDetail extends TableInfo {
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
}

/** Adapter for a SQL database (PostgreSQL, MySQL/MariaDB, Db2, SQLite). */
export interface DbAdapter {
  readonly driver: Driver;
  readonly dialect: SqlDialect;
  connect(): Promise<void>;
  ping(): Promise<void>;
  listTables(options: { schema?: string; search?: string; limit: number }): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<TableDetail>;
  execute(sql: string, params: readonly unknown[], options: ExecOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

/** Key-value adapter (Redis): not SQL, so it is served by the redis_command tool. */
export interface KeyValueAdapter {
  readonly driver: 'redis';
  connect(): Promise<void>;
  ping(): Promise<void>;
  /** Send one raw command (command name + arguments). The reply is in RESP3 form. */
  command(args: readonly string[], timeoutSec: number): Promise<unknown>;
  close(): Promise<void>;
}

/** Any adapter: SQL or key-value. */
export type Adapter = DbAdapter | KeyValueAdapter;

/** Type guard: true for a SQL adapter, false for a key-value (Redis) adapter. */
export function isSqlAdapter(adapter: Adapter): adapter is DbAdapter {
  return adapter.driver !== 'redis';
}

/** Creates the adapter for one configured connection. */
export type AdapterFactory = (source: ResolvedSource, log: Logger) => Adapter;
