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
import type { PgClientLike, PgPoolFactory, PgPoolLike } from './driver-types.js';
import { isBrokenConnection, toPgDbError } from './errors.js';
import {
  COLUMNS_SQL,
  FIND_TABLE_SQL,
  FOREIGN_KEYS_SQL,
  INDEXES_SQL,
  LIST_TABLES_SQL,
  PRIMARY_KEY_SQL,
} from './sql.js';

/** Options for {@link PostgresAdapter}. */
export interface PostgresAdapterOptions {
  /** Driver loader. Default: the real pg + pg-cursor, loaded on first connect. */
  loadPoolFactory: () => Promise<PgPoolFactory>;
  poolMax?: number;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : String(value));
const strArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(str) : []);

/**
 * PostgreSQL adapter.
 *
 * Every execution runs in its own transaction:
 *   BEGIN [READ ONLY] -> SET LOCAL statement_timeout -> SET LOCAL search_path (when there is a whitelist)
 *   -> cursor fetches maxRows+1 rows -> COMMIT (write) / ROLLBACK (read)
 * A read-write connection runs DISCARD ALL afterwards so a user's session SET does not
 * carry over to the next query on the same pooled connection.
 */
export class PostgresAdapter implements DbAdapter {
  readonly driver = 'postgres' as const;
  readonly dialect = 'postgresql' as const;

  readonly #source: ResolvedSource;
  readonly #log: Logger;
  readonly #options: PostgresAdapterOptions;
  #pool: PgPoolLike | undefined;

  constructor(source: ResolvedSource, log: Logger, options: PostgresAdapterOptions) {
    this.#source = source;
    this.#log = log;
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#pool) return;
    let factory: PgPoolFactory;
    try {
      factory = await this.#options.loadPoolFactory();
    } catch (err) {
      throw new DbError(
        'connection',
        `PostgreSQL driver (pg) could not be loaded: ${toPgDbError(err).message}`,
        {
          cause: err,
        },
      );
    }
    const pool = factory({
      connectionString: this.#source.connection.reveal(),
      max: this.#options.poolMax ?? 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      applicationName: 'multidb-mcp',
      onIdleError: (err) => this.#log.warn('idle PostgreSQL connection dropped', { error: err }),
    });
    this.#pool = pool;
    try {
      await this.ping();
    } catch (err) {
      this.#pool = undefined;
      await pool.end().catch(() => undefined);
      throw toPgDbError(err);
    }
  }

  async ping(): Promise<void> {
    await this.#withClient((client) => client.query('SELECT 1'));
  }

  async close(): Promise<void> {
    const pool = this.#pool;
    this.#pool = undefined;
    await pool?.end();
  }

  async listTables(options: {
    schema?: string;
    search?: string;
    limit: number;
  }): Promise<TableInfo[]> {
    const rows = await this.#readOnly((query) =>
      query(LIST_TABLES_SQL, [
        options.schema ?? null,
        this.#source.schemas ?? null,
        options.search ?? null,
        options.limit,
      ]),
    );
    return rows.map((r) => ({
      schema: str(r.schema_name),
      name: str(r.table_name),
      type: r.table_type === 'view' ? 'view' : 'table',
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableDetail> {
    // All catalog queries on one connection and in one read-only transaction.
    return this.#readOnly(async (query) => {
      const candidates = await query(FIND_TABLE_SQL, [
        table,
        schema ?? null,
        this.#source.schemas ?? null,
      ]);
      if (candidates.length === 0) {
        throw new DbError(
          'not_found',
          `Table or view "${table}" not found${schema ? ` in schema ${schema}` : ''}`,
        );
      }
      const exact = candidates.filter((c) => c.exact === true);
      const best = exact.length > 0 ? exact : candidates;
      if (best.length > 1) {
        const names = best.map((c) => `${str(c.schema_name)}.${str(c.table_name)}`).join(', ');
        throw new DbError(
          'ambiguous',
          `Name "${table}" matches several objects: ${names}. Specify the schema or the exact name.`,
        );
      }
      const target = best[0]!;
      const oid = str(target.oid);
      const columns = await query(COLUMNS_SQL, [oid]);
      const primaryKey = await query(PRIMARY_KEY_SQL, [oid]);
      const foreignKeys = await query(FOREIGN_KEYS_SQL, [oid]);
      const indexes = await query(INDEXES_SQL, [oid]);
      return this.#toDetail(target, columns, primaryKey, foreignKeys, indexes);
    });
  }

  #toDetail(
    target: Record<string, unknown>,
    columns: Record<string, unknown>[],
    primaryKey: Record<string, unknown>[],
    foreignKeys: Record<string, unknown>[],
    indexes: Record<string, unknown>[],
  ): TableDetail {
    return {
      schema: str(target.schema_name),
      name: str(target.table_name),
      type: target.table_type === 'view' ? 'view' : 'table',
      columns: columns.map((c): ColumnInfo => ({
        name: str(c.column_name),
        type: str(c.data_type),
        nullable: c.nullable === true,
        default:
          c.default_value === null || c.default_value === undefined ? null : str(c.default_value),
      })),
      primaryKey: primaryKey.map((p) => str(p.column_name)),
      foreignKeys: foreignKeys.map((f): ForeignKeyInfo => ({
        name: str(f.constraint_name),
        columns: strArray(f.columns),
        refSchema: str(f.ref_schema),
        refTable: str(f.ref_table),
        refColumns: strArray(f.ref_columns),
      })),
      indexes: indexes.map((i): IndexInfo => ({
        name: str(i.index_name),
        columns: strArray(i.columns),
        unique: i.is_unique === true,
      })),
    };
  }

  async execute(
    sql: string,
    params: readonly unknown[],
    options: ExecOptions,
  ): Promise<QueryResult> {
    return this.#withClient(async (client) => {
      const startedAt = performance.now();
      await client.query(options.readonly ? 'BEGIN READ ONLY' : 'BEGIN');
      let committed = false;
      try {
        await this.#prepareTransaction(client, options.timeoutSec);
        const result = await client.cursor(sql, params, options.maxRows + 1);
        if (!options.readonly) {
          await client.query('COMMIT');
          committed = true;
        }
        const truncated = result.rows.length > options.maxRows;
        const output: QueryResult = {
          columns: result.fields,
          rows: truncated ? result.rows.slice(0, options.maxRows) : result.rows,
          truncated,
          durationMs: Math.round(performance.now() - startedAt),
        };
        if (result.fields.length === 0 && result.rowCount !== null)
          output.affectedRows = result.rowCount;
        return output;
      } finally {
        if (!committed) await client.query('ROLLBACK').catch(() => undefined);
        if (!options.readonly) await client.query('DISCARD ALL').catch(() => undefined);
      }
    });
  }

  /** Catalog query: always in a read-only transaction with this connection's timeout. */
  async #readOnly<T>(
    fn: (
      query: (sql: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.#withClient(async (client) => {
      await client.query('BEGIN READ ONLY');
      try {
        await this.#prepareTransaction(client, this.#source.limits.timeoutSec);
        return await fn(async (sql, params) => (await client.query(sql, params)).rows);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    });
  }

  async #prepareTransaction(client: PgClientLike, timeoutSec: number): Promise<void> {
    const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const schemas = this.#source.schemas;
    if (schemas && schemas.length > 0) {
      await client.query(
        `SET LOCAL search_path TO ${schemas.map((s) => client.escapeIdentifier(s)).join(', ')}`,
      );
    }
  }

  async #withClient<T>(fn: (client: PgClientLike) => Promise<T>): Promise<T> {
    const pool = this.#pool;
    if (!pool) throw new DbError('connection', 'The PostgreSQL adapter is not connected yet');
    let client: PgClientLike;
    try {
      client = await pool.connect();
    } catch (err) {
      throw toPgDbError(err);
    }
    let destroy = false;
    try {
      return await fn(client);
    } catch (err) {
      destroy = isBrokenConnection(err);
      throw toPgDbError(err);
    } finally {
      client.release(destroy);
    }
  }
}
