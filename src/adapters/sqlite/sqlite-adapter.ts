import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { ResolvedSource } from '../../config/loader.js';
import type { Logger } from '../../observability/logger.js';
import { DbError } from '../errors.js';
import type {
  ColumnInfo,
  DbAdapter,
  ExecOptions,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  TableDetail,
  TableInfo,
} from '../types.js';
import type { SqliteFactory, SqliteHandleLike, SqliteParam } from './driver-types.js';
import { isBrokenConnection, toSqliteDbError } from './errors.js';
import {
  COLUMNS_SQL,
  FIND_TABLE_SQL,
  FOREIGN_KEYS_SQL,
  INDEX_COLUMNS_SQL,
  INDEX_LIST_SQL,
  listTablesSql,
} from './sql.js';

/** Options for {@link SqliteAdapter}. */
export interface SqliteAdapterOptions {
  /** Driver loader. Default: a child process using Node's built-in node:sqlite. */
  loadFactory: () => Promise<SqliteFactory>;
}

type Row = Record<string, unknown>;

/** A SQLite file only has the "main" schema (ATTACH is rejected by the guard). */
const SCHEMA = 'main';
const CATALOG_MAX_ROWS = 10_000;

const str = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'bigint'
      ? String(value)
      : '';

/**
 * File path from the config url: "sqlite:/abs/app.db", "sqlite:///abs/app.db", or a path relative
 * to the config file's folder ("sqlite:./database/database.sqlite"). Exported for unit tests.
 */
export function sqlitePathOf(url: string, baseDir: string): string {
  const match = /^sqlite:(.*)$/i.exec(url.trim());
  const path = match?.[1]?.replace(/^\/\/(?=\/)/, '');
  if (!path) {
    throw new DbError(
      'connection',
      'SQLite url must look like sqlite:<file path>, for example sqlite:./database/database.sqlite',
    );
  }
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

/** MCP parameter (string, number, boolean, null) to a value node:sqlite accepts. */
function toParam(value: unknown): SqliteParam {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
  return value === undefined ? null : JSON.stringify(value);
}

function rowsToObjects(fields: string[], rows: unknown[][]): Row[] {
  return rows.map((row) => Object.fromEntries(fields.map((name, i) => [name, row[i]])));
}

/**
 * SQLite adapter (Node's built-in node:sqlite driver, in a child process).
 *
 * Every execution: BEGIN -> statement -> COMMIT (with write permission) / ROLLBACK (read only).
 * A `["read"]` connection opens the file read-only, so SQLite itself rejects writes.
 * A timeout kills the child process; the connection reopens automatically on the next request.
 */
export class SqliteAdapter implements DbAdapter {
  readonly driver = 'sqlite' as const;
  readonly dialect = 'sqlite' as const;

  readonly #source: ResolvedSource;
  readonly #log: Logger;
  readonly #options: SqliteAdapterOptions;
  #handle: SqliteHandleLike | undefined;

  constructor(source: ResolvedSource, log: Logger, options: SqliteAdapterOptions) {
    this.#source = source;
    this.#log = log;
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#handle) return;
    const path = sqlitePathOf(this.#source.connection.reveal(), this.#source.baseDir);
    // Messages to Claude only mention the file name, not the full path (it could contain a user name).
    const name = basename(path);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      this.#log.warn('SQLite file not found', { db: this.#source.id, path });
      throw new DbError('connection', `SQLite file ${name} not found`);
    }
    let factory: SqliteFactory;
    try {
      factory = await this.#options.loadFactory();
    } catch (err) {
      throw new DbError(
        'connection',
        `SQLite driver could not be loaded: ${toSqliteDbError(err).message}`,
        {
          cause: err,
        },
      );
    }
    const handle = factory({
      path,
      readOnly: this.#source.readonly,
      busyTimeoutMs: this.#source.limits.timeoutSec * 1000,
    });
    this.#handle = handle;
    try {
      await this.#catalog('SELECT 1 AS ok', []);
    } catch (err) {
      this.#handle = undefined;
      await handle.close().catch(() => undefined);
      const error = toSqliteDbError(err);
      throw error.kind === 'connection'
        ? error
        : new DbError('connection', `File ${name}: ${error.message}`, { cause: err });
    }
  }

  async ping(): Promise<void> {
    await this.#catalog('SELECT 1 AS ok', []);
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close();
  }

  async listTables(options: {
    schema?: string;
    search?: string;
    limit: number;
  }): Promise<TableInfo[]> {
    if (options.schema && options.schema.toLowerCase() !== SCHEMA) return [];
    const rows = await this.#catalog(listTablesSql(options.limit), [
      options.search ?? null,
      options.search ?? null,
    ]);
    return rows.map((r) => ({
      schema: SCHEMA,
      name: str(r.table_name),
      type: r.table_type === 'view' ? 'view' : 'table',
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableDetail> {
    const [target] =
      schema && schema.toLowerCase() !== SCHEMA ? [] : await this.#catalog(FIND_TABLE_SQL, [table]);
    if (!target) {
      throw new DbError(
        'not_found',
        `Table or view "${table}" not found${schema ? ` in schema ${schema}` : ''}`,
      );
    }
    const name = str(target.table_name);
    const columns = await this.#catalog(COLUMNS_SQL, [name]);
    const foreignKeys = await this.#catalog(FOREIGN_KEYS_SQL, [name]);
    const indexList = await this.#catalog(INDEX_LIST_SQL, [name]);
    const indexes: IndexInfo[] = [];
    for (const index of indexList) {
      const indexName = str(index.name);
      const indexColumns = await this.#catalog(INDEX_COLUMNS_SQL, [indexName]);
      indexes.push({
        name: indexName,
        columns: indexColumns.map((c) => (c.name === null ? '(expression)' : str(c.name))),
        unique: Number(index.is_unique) === 1,
      });
    }

    const pkColumns = columns
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk));
    // A lone INTEGER PRIMARY KEY is an alias of rowid: its value is automatic and can never be NULL.
    const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(str(target.create_sql));
    const rowidAlias =
      !withoutRowid && pkColumns.length === 1 && str(pkColumns[0]!.type).toUpperCase() === 'INTEGER'
        ? str(pkColumns[0]!.name)
        : undefined;

    return {
      schema: SCHEMA,
      name,
      type: target.table_type === 'view' ? 'view' : 'table',
      columns: columns.map((c) => toColumn(c, rowidAlias)),
      primaryKey: pkColumns.map((c) => str(c.name)),
      foreignKeys: await this.#groupForeignKeys(foreignKeys),
      indexes,
    };
  }

  async #groupForeignKeys(rows: Row[]): Promise<ForeignKeyInfo[]> {
    const byId = new Map<string, ForeignKeyInfo>();
    for (const r of rows) {
      const id = str(r.id);
      let fk = byId.get(id);
      if (!fk) {
        fk = {
          name: `fk_${id}`,
          columns: [],
          refSchema: SCHEMA,
          refTable: str(r.ref_table),
          refColumns: [],
        };
        byId.set(id, fk);
      }
      fk.columns.push(str(r.column_name));
      fk.refColumns.push(r.ref_column === null ? '' : str(r.ref_column));
    }
    // FOREIGN KEY ... REFERENCES t (without columns) refers to the primary key of table t.
    for (const fk of byId.values()) {
      if (fk.refColumns.every((c) => c !== '')) continue;
      const refColumns = await this.#catalog(COLUMNS_SQL, [fk.refTable]);
      const pk = refColumns
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => str(c.name));
      fk.refColumns = fk.refColumns.map((c, i) => c || pk[i] || '(primary key)');
    }
    return [...byId.values()];
  }

  async execute(
    sql: string,
    params: readonly unknown[],
    options: ExecOptions,
  ): Promise<QueryResult> {
    const handle = this.#requireHandle();
    const startedAt = performance.now();
    try {
      const result = await handle.run(
        { sql, params: params.map(toParam), maxRows: options.maxRows, write: !options.readonly },
        options.timeoutSec * 1000,
      );
      const truncated = result.rows.length > options.maxRows;
      const output: QueryResult = {
        columns: result.fields,
        rows: truncated ? result.rows.slice(0, options.maxRows) : result.rows,
        truncated,
        durationMs: Math.round(performance.now() - startedAt),
      };
      if (result.fields.length === 0 && result.affectedRows !== null) {
        output.affectedRows = result.affectedRows;
      }
      return output;
    } catch (err) {
      if (isBrokenConnection(err))
        this.#log.warn('SQLite process stopped', { db: this.#source.id });
      throw toSqliteDbError(err);
    }
  }

  async #catalog(sql: string, params: SqliteParam[]): Promise<Row[]> {
    const handle = this.#requireHandle();
    try {
      const result = await handle.run(
        { sql, params, maxRows: CATALOG_MAX_ROWS, write: false },
        this.#source.limits.timeoutSec * 1000,
      );
      return rowsToObjects(result.fields, result.rows);
    } catch (err) {
      throw toSqliteDbError(err);
    }
  }

  #requireHandle(): SqliteHandleLike {
    if (!this.#handle) throw new DbError('connection', 'The SQLite adapter is not connected yet');
    return this.#handle;
  }
}

function toColumn(c: Row, rowidAlias: string | undefined): ColumnInfo {
  const name = str(c.name);
  const hidden = Number(c.hidden);
  let defaultValue: string | null =
    c.dflt_value === null || c.dflt_value === undefined ? null : str(c.dflt_value);
  if (hidden === 2) defaultValue = 'GENERATED ALWAYS (VIRTUAL)';
  if (hidden === 3) defaultValue = 'GENERATED ALWAYS (STORED)';
  if (name === rowidAlias) defaultValue = 'ROWID (automatic)';
  return {
    name,
    // A column without a type (allowed by SQLite) is shown as ANY.
    type: str(c.type) || 'ANY',
    nullable: name === rowidAlias ? false : Number(c.not_null) === 0,
    default: defaultValue,
  };
}
