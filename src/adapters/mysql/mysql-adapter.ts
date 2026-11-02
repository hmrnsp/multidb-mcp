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
import type {
  MysqlConnLike,
  MysqlPoolFactory,
  MysqlPoolLike,
  MysqlRunResult,
} from './driver-types.js';
import { ER_QUERY_INTERRUPTED, errnoOf, isBrokenConnection, toMysqlDbError } from './errors.js';
import {
  COLUMNS_SQL,
  FOREIGN_KEYS_SQL,
  PRIMARY_KEY_SQL,
  SESSION_INFO_SQL,
  findTableSql,
  indexesSql,
  listTablesSql,
  type MysqlFlavor,
} from './sql.js';

/** Options for {@link MysqlAdapter}. */
export interface MysqlAdapterOptions {
  flavor: MysqlFlavor;
  /** Driver loader. Default: the real mysql2, loaded on first connect. */
  loadPoolFactory: () => Promise<MysqlPoolFactory>;
  poolMax?: number;
  /** Delay after a timeout before the watchdog sends KILL QUERY. */
  watchdogGraceMs?: number;
}

type Row = Record<string, unknown>;
type QueryFn = (sql: string, params: readonly unknown[]) => Promise<Row[]>;

const str = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Buffer.isBuffer(value)
      ? value.toString('utf8')
      : String(value);
const isOne = (value: unknown): boolean => Number(value) === 1;
const FLAVOR_NAME: Record<MysqlFlavor, string> = { mysql: 'MySQL', mariadb: 'MariaDB' };

/**
 * MySQL 8.4 and MariaDB 11.4 adapter (one driver: mysql2).
 *
 * Every execution runs in its own transaction:
 *   SET SESSION timeout -> START TRANSACTION [READ ONLY] -> fetch maxRows+1 rows
 *   -> COMMIT (write) / ROLLBACK (read)
 * A read-write connection is reset (COM_RESET_CONNECTION) afterwards so a user's session variables and
 * temporary tables do not carry over to the next query.
 *
 * When a read result exceeds maxRows, the connection is dropped and the query is KILLed from another connection:
 * closing the socket alone does not stop the query on the server.
 */
export class MysqlAdapter implements DbAdapter {
  readonly driver: MysqlFlavor;
  readonly dialect: MysqlFlavor;

  readonly #source: ResolvedSource;
  readonly #log: Logger;
  readonly #options: MysqlAdapterOptions;
  #pool: MysqlPoolLike | undefined;

  constructor(source: ResolvedSource, log: Logger, options: MysqlAdapterOptions) {
    this.#source = source;
    this.#log = log;
    this.#options = options;
    this.driver = options.flavor;
    this.dialect = options.flavor;
  }

  async connect(): Promise<void> {
    if (this.#pool) return;
    const name = FLAVOR_NAME[this.#options.flavor];
    let pool: MysqlPoolLike;
    try {
      const factory = await this.#options.loadPoolFactory();
      pool = factory({
        uri: this.#source.connection.reveal(),
        connectionLimit: this.#options.poolMax ?? 4,
        idleTimeoutMillis: 30_000,
        connectTimeoutMillis: 10_000,
      });
    } catch (err) {
      throw new DbError(
        'connection',
        `${name} driver (mysql2) could not be prepared: ${toMysqlDbError(err).message}`,
        { cause: err },
      );
    }
    this.#pool = pool;
    try {
      await this.#withConnection(async (conn) => this.#checkSession(conn));
    } catch (err) {
      this.#pool = undefined;
      await pool.end().catch(() => undefined);
      const error = toMysqlDbError(err);
      throw error.kind === 'connection'
        ? error
        : new DbError('connection', error.message, { sqlState: error.sqlState, cause: err });
    }
  }

  /** Make sure the server matches the driver in the config and the default schema is in the whitelist. */
  async #checkSession(conn: MysqlConnLike): Promise<void> {
    const [info] = await conn.query(SESSION_INFO_SQL);
    const version = str(info?.version ?? '');
    const isMaria = /mariadb/i.test(version);
    const expected = this.#options.flavor;
    if (isMaria !== (expected === 'mariadb')) {
      const actual: MysqlFlavor = isMaria ? 'mariadb' : 'mysql';
      throw new DbError(
        'connection',
        `Server ${this.#source.id} is ${FLAVOR_NAME[actual]} ${version}, but the driver in the config is "${expected}". ` +
          `Change the driver to "${actual}" so the guard and timeout use the right rules.`,
      );
    }
    const db = info?.db === null || info?.db === undefined ? null : str(info.db);
    const schemas = this.#source.schemas;
    if (db !== null && schemas && !schemas.some((s) => s.toLowerCase() === db.toLowerCase())) {
      throw new DbError(
        'connection',
        `The default database in the connection string (${db}) is not in "schemas" (${schemas.join(', ')}). ` +
          'Tables without a schema name will be read from that database; make the two match in the config.',
      );
    }
  }

  async ping(): Promise<void> {
    await this.#withConnection((conn) => conn.query('SELECT 1'));
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
      schema: str(r.schema_name),
      name: str(r.table_name),
      type: r.table_type === 'view' ? 'view' : 'table',
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
      // Exact match first; if there is none, use the one in the connection's default database.
      const exact = candidates.filter((c) => isOne(c.exact_name));
      let best = exact.length > 0 ? exact : candidates;
      const inDefault = best.filter((c) => isOne(c.in_default));
      if (best.length > 1 && inDefault.length === 1) best = inDefault;
      if (best.length > 1) {
        const names = best.map((c) => `${str(c.schema_name)}.${str(c.table_name)}`).join(', ');
        throw new DbError(
          'ambiguous',
          `Name "${table}" matches several objects: ${names}. Specify the schema or the exact name.`,
        );
      }
      const target = best[0]!;
      const key = [str(target.schema_name), str(target.table_name)];
      const columns = await query(COLUMNS_SQL, key);
      const primaryKey = await query(PRIMARY_KEY_SQL, key);
      const foreignKeys = await query(FOREIGN_KEYS_SQL, key);
      const indexes = await query(indexesSql(this.#options.flavor), key);
      return {
        schema: key[0]!,
        name: key[1]!,
        type: target.table_type === 'view' ? 'view' : 'table',
        columns: columns.map((c) => this.#toColumn(c)),
        primaryKey: primaryKey.map((p) => str(p.column_name)),
        foreignKeys: groupForeignKeys(foreignKeys),
        indexes: groupIndexes(indexes),
      };
    });
  }

  #toColumn(c: Row): ColumnInfo {
    return {
      name: str(c.column_name),
      type: str(c.column_type),
      nullable: c.is_nullable === 'YES',
      default: this.#columnDefault(c),
    };
  }

  #columnDefault(c: Row): string | null {
    const extra = c.extra === null || c.extra === undefined ? '' : str(c.extra);
    const generated = /\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/i.exec(extra);
    const expression = c.generation_expression ? str(c.generation_expression) : '';
    if (generated && expression) {
      return `GENERATED ALWAYS AS (${expression}) ${generated[1]!.toUpperCase()}`;
    }
    if (/auto_increment/i.test(extra)) return 'AUTO_INCREMENT';
    if (c.column_default === null || c.column_default === undefined) return null;
    const value = str(c.column_default);
    // MariaDB writes a NULL default as the text 'NULL' (a text literal is written quoted: 'NULL').
    if (this.#options.flavor === 'mariadb' && value === 'NULL') return null;
    return value;
  }

  async execute(
    sql: string,
    params: readonly unknown[],
    options: ExecOptions,
  ): Promise<QueryResult> {
    const pool = this.#requirePool();
    const conn = await this.#acquire(pool);
    const startedAt = performance.now();
    let destroy = false;
    let timedOut = false;
    try {
      await this.#setTimeout(conn, options.timeoutSec);
      await conn.query(options.readonly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');

      // Fallback when the server timeout does not apply (MySQL's max_execution_time only covers SELECT).
      const watchdog = setTimeout(
        () => {
          timedOut = true;
          void this.#kill(pool, conn.threadId);
        },
        options.timeoutSec * 1000 + (this.#options.watchdogGraceMs ?? 1_000),
      );
      let result: MysqlRunResult;
      try {
        result = await conn.run(sql, params, options.maxRows, options.readonly ? 'abort' : 'drain');
      } finally {
        clearTimeout(watchdog);
      }

      if (result.aborted) {
        destroy = true;
        await this.#kill(pool, conn.threadId);
      } else {
        await conn.query(options.readonly ? 'ROLLBACK' : 'COMMIT');
      }
      // The watchdog's KILL may arrive after the query finished: do not reuse that connection.
      if (timedOut) destroy = true;

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
      if (timedOut) {
        destroy = true;
        if (errnoOf(err) === ER_QUERY_INTERRUPTED || isBrokenConnection(err)) {
          throw new DbError('timeout', `Query stopped after ${options.timeoutSec} seconds`, {
            cause: err,
          });
        }
      }
      if (isBrokenConnection(err)) destroy = true;
      if (!destroy) {
        await conn.query('ROLLBACK').catch(() => {
          destroy = true;
        });
      }
      throw toMysqlDbError(err);
    } finally {
      if (!destroy && !options.readonly) {
        await conn.reset().catch(() => {
          destroy = true;
        });
      }
      conn.release(destroy);
    }
  }

  async #kill(pool: MysqlPoolLike, threadId: number): Promise<void> {
    try {
      await pool.killQuery(threadId);
    } catch (err) {
      // 1094 (unknown thread): the query had already finished.
      if (errnoOf(err) !== 1094) this.#log.warn('KILL QUERY failed', { error: err });
    }
  }

  async #setTimeout(conn: MysqlConnLike, timeoutSec: number): Promise<void> {
    const seconds = Math.max(1, Math.round(timeoutSec));
    await conn.query(
      this.#options.flavor === 'mariadb'
        ? `SET SESSION max_statement_time = ${seconds}`
        : `SET SESSION max_execution_time = ${seconds * 1000}`,
    );
  }

  /** Schema whitelist in lower case (compared with LOWER(TABLE_SCHEMA)). */
  #whitelist(): string[] {
    return (this.#source.schemas ?? []).map((s) => s.toLowerCase());
  }

  /** Catalog query: always in a read-only transaction with this connection's timeout. */
  async #readOnly<T>(fn: (query: QueryFn) => Promise<T>): Promise<T> {
    return this.#withConnection(async (conn) => {
      await this.#setTimeout(conn, this.#source.limits.timeoutSec);
      await conn.query('START TRANSACTION READ ONLY');
      try {
        return await fn((sql, params) => conn.query(sql, params));
      } finally {
        await conn.query('ROLLBACK').catch(() => undefined);
      }
    });
  }

  #requirePool(): MysqlPoolLike {
    const pool = this.#pool;
    if (!pool) {
      throw new DbError(
        'connection',
        `${FLAVOR_NAME[this.#options.flavor]} adapter is not connected yet`,
      );
    }
    return pool;
  }

  async #acquire(pool: MysqlPoolLike): Promise<MysqlConnLike> {
    try {
      return await pool.getConnection();
    } catch (err) {
      throw toMysqlDbError(err);
    }
  }

  async #withConnection<T>(fn: (conn: MysqlConnLike) => Promise<T>): Promise<T> {
    const conn = await this.#acquire(this.#requirePool());
    let destroy = false;
    try {
      return await fn(conn);
    } catch (err) {
      destroy = isBrokenConnection(err);
      throw toMysqlDbError(err);
    } finally {
      conn.release(destroy);
    }
  }
}

function groupForeignKeys(rows: Row[]): ForeignKeyInfo[] {
  const byName = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    const name = str(r.constraint_name);
    let fk = byName.get(name);
    if (!fk) {
      fk = {
        name,
        columns: [],
        refSchema: str(r.ref_schema),
        refTable: str(r.ref_table),
        refColumns: [],
      };
      byName.set(name, fk);
    }
    fk.columns.push(str(r.column_name));
    fk.refColumns.push(str(r.ref_column));
  }
  return [...byName.values()];
}

function groupIndexes(rows: Row[]): IndexInfo[] {
  const byName = new Map<string, IndexInfo>();
  for (const r of rows) {
    const name = str(r.index_name);
    let index = byName.get(name);
    if (!index) {
      index = { name, columns: [], unique: Number(r.non_unique) === 0 };
      byName.set(name, index);
    }
    const column =
      r.column_name === null || r.column_name === undefined
        ? `(${str(r.expression ?? '?')})`
        : str(r.column_name);
    const prefix = r.sub_part === null || r.sub_part === undefined ? '' : `(${str(r.sub_part)})`;
    index.columns.push(`${column}${prefix}`);
  }
  return [...byName.values()];
}
