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
import type { Db2ConnLike, Db2PoolFactory, Db2PoolLike } from './driver-types.js';
import { isBrokenConnection, toDb2DbError } from './errors.js';
import {
  COLUMNS_SQL,
  FOREIGN_KEYS_SQL,
  INDEXES_SQL,
  PRIMARY_KEY_SQL,
  SESSION_INFO_SQL,
  findTableSql,
  listTablesSql,
} from './sql.js';

/** Options for {@link Db2Adapter}. */
export interface Db2AdapterOptions {
  /** Driver loader. Default: the real ibm_db, loaded on first connect. */
  loadPoolFactory: () => Promise<Db2PoolFactory>;
  poolMax?: number;
}

type Row = Record<string, unknown>;
type QueryFn = (sql: string, params: readonly unknown[]) => Promise<Row[]>;

const str = (value: unknown): string => {
  if (typeof value === 'string') return value.trimEnd();
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
};
const isOne = (value: unknown): boolean => Number(value) === 1;
/** Schema name that is safe to splice in as the CurrentSchema value in the connection string. */
const PLAIN_SCHEMA = /^[A-Za-z_#@$][A-Za-z0-9_#@$]*$/;

/**
 * Make sure the connection's default schema (CURRENT SCHEMA) is in the `schemas` whitelist, so tables
 * without a schema name are not read from another schema. Without a whitelist, the connection string is used as is.
 * Exported for unit tests.
 */
export function withCurrentSchema(
  connection: string,
  schemas: readonly string[] | undefined,
): string {
  if (!schemas || schemas.length === 0) return connection;
  const allowed = schemas.map((s) => s.toUpperCase());
  const existing = /(?:^|;)\s*CURRENTSCHEMA\s*=\s*([^;]*)/i.exec(connection)?.[1]?.trim();
  if (existing !== undefined) {
    if (!allowed.includes(existing.toUpperCase())) {
      throw new DbError(
        'connection',
        `CurrentSchema in the connection string (${existing}) is not in "schemas" (${schemas.join(', ')}). Make the two match in the config.`,
      );
    }
    return connection;
  }
  const first = schemas[0]!;
  if (!PLAIN_SCHEMA.test(first)) {
    throw new DbError(
      'connection',
      `Schema "${first}" cannot be set as CurrentSchema; write CurrentSchema=... yourself in the connection string.`,
    );
  }
  return `${connection.replace(/;?\s*$/, ';')}CurrentSchema=${first.toUpperCase()};`;
}

/**
 * IBM Db2 LUW adapter (ibm_db driver).
 *
 * Every execution runs in its own transaction (autocommit turned off):
 *   prepare -> SQL_ATTR_QUERY_TIMEOUT -> fetch maxRows+1 rows -> COMMIT (write) / ROLLBACK (read)
 * Db2 has no server-enforced read-only transaction, so a read-only connection is protected by
 * the guard, a SELECT-only database user, and a ROLLBACK that always runs.
 */
export class Db2Adapter implements DbAdapter {
  readonly driver = 'db2' as const;
  readonly dialect = 'db2' as const;

  readonly #source: ResolvedSource;
  readonly #log: Logger;
  readonly #options: Db2AdapterOptions;
  #pool: Db2PoolLike | undefined;

  constructor(source: ResolvedSource, log: Logger, options: Db2AdapterOptions) {
    this.#source = source;
    this.#log = log;
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#pool) return;
    const connectionString = withCurrentSchema(
      this.#source.connection.reveal(),
      this.#source.schemas,
    );
    let factory: Db2PoolFactory;
    try {
      factory = await this.#options.loadPoolFactory();
    } catch (err) {
      throw new DbError(
        'connection',
        `Db2 driver (ibm_db) could not be loaded: ${toDb2DbError(err).message}. ` +
          'If the OS does not provide libxml2.so.2 (for example Ubuntu 26.04), run the server through the multidb-mcp Docker image.',
        { cause: err },
      );
    }
    const pool = factory({
      connectionString,
      maxPoolSize: this.#options.poolMax ?? 4,
      connectTimeoutSec: 10,
      idleTimeoutMs: 30_000,
    });
    this.#pool = pool;
    try {
      await this.#withConnection(async (conn) => {
        const [info] = await conn.query(SESSION_INFO_SQL, [], this.#source.limits.timeoutSec);
        this.#log.debug('Db2 session', {
          schema: str(info?.SCHEMA_NAME),
          server: str(info?.SERVER_NAME),
        });
      });
    } catch (err) {
      this.#pool = undefined;
      await pool.close().catch(() => undefined);
      const error = toDb2DbError(err);
      throw error.kind === 'connection'
        ? error
        : new DbError('connection', error.message, { sqlState: error.sqlState, cause: err });
    }
  }

  async ping(): Promise<void> {
    await this.#withConnection((conn) =>
      conn.query('SELECT 1 AS OK FROM SYSIBM.SYSDUMMY1', [], this.#source.limits.timeoutSec),
    );
  }

  async close(): Promise<void> {
    const pool = this.#pool;
    this.#pool = undefined;
    await pool?.close();
  }

  async listTables(options: {
    schema?: string;
    search?: string;
    limit: number;
  }): Promise<TableInfo[]> {
    const whitelist = this.#whitelist();
    const rows = await this.#readOnly((query) =>
      query(listTablesSql(whitelist.length, options.limit), [
        options.schema ?? null,
        options.schema ?? null,
        options.search ?? null,
        options.search ?? null,
        ...whitelist,
      ]),
    );
    return rows.map((r) => ({
      schema: str(r.SCHEMA_NAME),
      name: str(r.TABLE_NAME),
      type: str(r.TABLE_TYPE) === 'view' ? 'view' : 'table',
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableDetail> {
    const whitelist = this.#whitelist();
    return this.#readOnly(async (query) => {
      const candidates = await query(findTableSql(whitelist.length), [
        table,
        table,
        schema ?? null,
        schema ?? null,
        ...whitelist,
      ]);
      if (candidates.length === 0) {
        throw new DbError(
          'not_found',
          `Table or view "${table}" not found${schema ? ` in schema ${schema}` : ''}`,
        );
      }
      // Exact match first; if there is none, use the one in the connection's CURRENT SCHEMA.
      const exact = candidates.filter((c) => isOne(c.EXACT_NAME));
      let best = exact.length > 0 ? exact : candidates;
      const inDefault = best.filter((c) => isOne(c.IN_DEFAULT));
      if (best.length > 1 && inDefault.length === 1) best = inDefault;
      if (best.length > 1) {
        const names = best.map((c) => `${str(c.SCHEMA_NAME)}.${str(c.TABLE_NAME)}`).join(', ');
        throw new DbError(
          'ambiguous',
          `Name "${table}" matches several objects: ${names}. Specify the schema or the exact name.`,
        );
      }
      const target = best[0]!;
      const key = [str(target.SCHEMA_NAME), str(target.TABLE_NAME)];
      const columns = await query(COLUMNS_SQL, key);
      const primaryKey = await query(PRIMARY_KEY_SQL, key);
      const foreignKeys = await query(FOREIGN_KEYS_SQL, key);
      const indexes = await query(INDEXES_SQL, key);
      return {
        schema: key[0]!,
        name: key[1]!,
        type: str(target.TABLE_TYPE) === 'view' ? 'view' : 'table',
        columns: columns.map(toColumn),
        primaryKey: primaryKey.map((p) => str(p.COLUMN_NAME)),
        foreignKeys: groupForeignKeys(foreignKeys),
        indexes: groupIndexes(indexes),
      };
    });
  }

  async execute(
    sql: string,
    params: readonly unknown[],
    options: ExecOptions,
  ): Promise<QueryResult> {
    const conn = await this.#open();
    const startedAt = performance.now();
    let destroy = false;
    try {
      await conn.beginTransaction();
      let committed = false;
      try {
        const result = await conn.run(sql, params, options.maxRows, options.timeoutSec);
        if (!options.readonly) {
          await conn.commit();
          committed = true;
        }
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
        if (result.impreciseColumns.length > 0) {
          const columns = result.impreciseColumns.join(', ');
          output.notes = [
            `some values of column ${columns} have more than 15 digits (or are DECFLOAT) and may not be exact because the ibm_db driver reads them as a double; ` +
              `for exact values use CAST(${result.impreciseColumns[0]} AS VARCHAR(40))`,
          ];
        }
        return output;
      } finally {
        if (!committed) {
          await conn.rollback().catch(() => {
            destroy = true;
          });
        }
      }
    } catch (err) {
      if (isBrokenConnection(err)) destroy = true;
      throw toDb2DbError(err);
    } finally {
      await conn.release(destroy);
    }
  }

  /** Schema whitelist in upper case (compared with UPPER(TABSCHEMA)). */
  #whitelist(): string[] {
    return (this.#source.schemas ?? []).map((s) => s.toUpperCase());
  }

  /** Catalog query: always in a transaction that is rolled back, with this connection's timeout. */
  async #readOnly<T>(fn: (query: QueryFn) => Promise<T>): Promise<T> {
    const timeoutSec = this.#source.limits.timeoutSec;
    return this.#withConnection(async (conn) => {
      await conn.beginTransaction();
      try {
        return await fn((sql, params) => conn.query(sql, params, timeoutSec));
      } finally {
        await conn.rollback().catch(() => undefined);
      }
    });
  }

  async #open(): Promise<Db2ConnLike> {
    const pool = this.#pool;
    if (!pool) throw new DbError('connection', 'The Db2 adapter is not connected yet');
    try {
      return await pool.open();
    } catch (err) {
      throw toDb2DbError(err);
    }
  }

  async #withConnection<T>(fn: (conn: Db2ConnLike) => Promise<T>): Promise<T> {
    const conn = await this.#open();
    let destroy = false;
    try {
      return await fn(conn);
    } catch (err) {
      destroy = isBrokenConnection(err);
      throw toDb2DbError(err);
    } finally {
      await conn.release(destroy);
    }
  }
}

/** Column type as written in DDL: VARCHAR(100), DECIMAL(12,2), INTEGER. */
export function formatColumnType(typeName: string, length: number, scale: number): string {
  const type = typeName.toUpperCase();
  if (type === 'DECIMAL' || type === 'NUMERIC') return `${type}(${length},${scale})`;
  if (/^(VAR)?(CHAR|CHARACTER|GRAPHIC|BINARY)$|^(BLOB|CLOB|DBCLOB)$/.test(type)) {
    return `${type}(${length})`;
  }
  if (type === 'TIMESTAMP' && scale !== 6) return `TIMESTAMP(${scale})`;
  if (type === 'DECFLOAT') return `DECFLOAT(${length === 8 ? 16 : 34})`;
  return type;
}

function toColumn(c: Row): ColumnInfo {
  return {
    name: str(c.COLUMN_NAME),
    type: formatColumnType(str(c.TYPE_NAME), Number(c.TYPE_LENGTH), Number(c.TYPE_SCALE)),
    nullable: str(c.NULLABLE) === 'Y',
    default: columnDefault(c),
  };
}

function columnDefault(c: Row): string | null {
  const generated = str(c.GENERATED_KIND).trim();
  const always = generated === 'A' ? 'ALWAYS' : 'BY DEFAULT';
  if (str(c.IS_IDENTITY) === 'Y') return `GENERATED ${always} AS IDENTITY`;
  const text = str(c.GENERATION_TEXT).trim();
  if (generated === 'A' && text) {
    // TEXT holds "AS (expression)" for generated columns.
    return `GENERATED ALWAYS ${text.replace(/^GENERATED\s+ALWAYS\s+/i, '')}`;
  }
  const value = c.DEFAULT_VALUE;
  if (value === null || value === undefined) return null;
  const trimmed = str(value).trim();
  return trimmed === '' ? null : trimmed;
}

function groupForeignKeys(rows: Row[]): ForeignKeyInfo[] {
  const byName = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    const name = str(r.CONSTRAINT_NAME);
    let fk = byName.get(name);
    if (!fk) {
      fk = {
        name,
        columns: [],
        refSchema: str(r.REF_SCHEMA),
        refTable: str(r.REF_TABLE),
        refColumns: [],
      };
      byName.set(name, fk);
    }
    fk.columns.push(str(r.COLUMN_NAME));
    fk.refColumns.push(str(r.REF_COLUMN));
  }
  return [...byName.values()];
}

function groupIndexes(rows: Row[]): IndexInfo[] {
  const byName = new Map<string, IndexInfo>();
  for (const r of rows) {
    const name = str(r.INDEX_NAME);
    let index = byName.get(name);
    if (!index) {
      const rule = str(r.UNIQUE_RULE).trim();
      index = { name, columns: [], unique: rule === 'P' || rule === 'U' };
      byName.set(name, index);
    }
    const order = str(r.COLUMN_ORDER).trim();
    const column = str(r.COLUMN_NAME);
    index.columns.push(
      order === 'D' ? `${column} DESC` : order === 'I' ? `${column} (INCLUDE)` : column,
    );
  }
  return [...byName.values()];
}
