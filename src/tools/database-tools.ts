import type { TableDetail } from '../adapters/types.js';
import type { ResolvedSource } from '../config/loader.js';
import type { StatementInfo } from '../guard/analyzer.js';
import { checkSql, DIALECT_OF, maskResult, type ColumnMatcher } from '../guard/index.js';
import type { AuditTrace } from '../observability/audit.js';
import type { Logger } from '../observability/logger.js';
import { formatQueryResult } from '../output/query-result.js';
import { formatCell, renderTable } from '../output/text-table.js';
import type { ConnectionRegistry } from '../registry/connection-registry.js';
import { isConnectionError, withReconnect } from './reconnect.js';
import { errorReason, errorResult, fail, ok, type ToolResult } from './result.js';
import type { DescribeTableArgs, ExecuteSqlArgs, ListTablesArgs } from './schemas.js';

/** Dependencies shared by the SQL tools. */
export interface ToolDeps {
  registry: ConnectionRegistry;
  log: Logger;
  /** true when this column's values must be masked (from maskColumns in the config). */
  isSensitiveColumn: ColumnMatcher;
}

/** Maximum number of tables list_tables shows (at most 200 entries). */
export const LIST_TABLES_LIMIT = 200;

/** Registration metadata of the list_tables tool. */
export const LIST_TABLES_TOOL = {
  name: 'list_tables',
  title: 'List tables',
  description:
    'Lists the tables and views of one database connection (schema, name, type), at most 200 entries. ' +
    'Use the search parameter to find a table by name, or schema to limit to one schema.',
} as const;

/** Registration metadata of the describe_table tool. */
export const DESCRIBE_TABLE_TOOL = {
  name: 'describe_table',
  title: 'Table structure',
  description:
    'Shows the structure of one table or view: columns (type, nullable, default), primary key, ' +
    'foreign keys, and indexes. Call this before writing a query so column names and relations are correct.',
} as const;

/** Registration metadata of the execute_sql tool. */
export const EXECUTE_SQL_TOOL = {
  name: 'execute_sql',
  title: 'Run SQL',
  description:
    'Runs ONE SQL statement on a given connection and returns the result as a compact table. ' +
    'Use params for values instead of concatenating strings. Results are limited by maxRows and the connection timeout. ' +
    'The statement kinds allowed are set by the access column in list_databases: "read-only" means only ' +
    'SELECT, WITH ... SELECT, VALUES, SHOW, DESCRIBE, and EXPLAIN; otherwise only the listed write kinds ' +
    '(insert, update, delete, ddl, call). BEGIN/COMMIT, SET, GRANT, and dynamic SQL are always rejected. ' +
    'If unsure which connection to use, call list_databases first.',
} as const;

/**
 * Reject a schema parameter outside the whitelist. In PostgreSQL schema names are compared exactly;
 * in MySQL/MariaDB and Db2 case-insensitively (Db2 stores unquoted names in upper case,
 * so "app" means APP).
 */
function schemaRejection(
  source: ResolvedSource,
  schema: string | undefined,
): ToolResult | undefined {
  if (!schema || !source.schemas) return undefined;
  const same =
    source.driver === 'postgres'
      ? (s: string) => s === schema
      : (s: string) => s.toLowerCase() === schema.toLowerCase();
  if (source.schemas.some(same)) return undefined;
  return fail(
    `Schema "${schema}" is not one of the schemas allowed for ${source.id}: ${source.schemas.join(', ')}.`,
  );
}

function timeoutOf(registry: ConnectionRegistry, db: string): number | undefined {
  return registry.has(db) ? registry.source(db).limits.timeoutSec : undefined;
}

/** Handler of list_tables. */
export async function runListTables(
  { registry, log }: ToolDeps,
  args: ListTablesArgs,
  trace: AuditTrace = {},
): Promise<ToolResult> {
  try {
    const source = registry.source(args.db);
    const rejected = schemaRejection(source, args.schema);
    if (rejected) {
      Object.assign(trace, { outcome: 'rejected', reason: 'schema' });
      return rejected;
    }
    const tables = await withReconnect(
      { registry, log, db: args.db, safeToRetry: true, trace },
      async () =>
        (await registry.acquireSql(args.db)).listTables({
          schema: args.schema,
          search: args.search,
          limit: LIST_TABLES_LIMIT + 1,
        }),
    );
    const more = tables.length > LIST_TABLES_LIMIT;
    const shown = tables.slice(0, LIST_TABLES_LIMIT);
    Object.assign(trace, { rows: shown.length, truncated: more });
    const scope = [
      args.schema ? `schema ${args.schema}` : undefined,
      args.search ? `name contains "${args.search}"` : undefined,
    ]
      .filter((s): s is string => s !== undefined)
      .join(', ');
    const where = scope ? ` (${scope})` : '';

    if (shown.length === 0) {
      return ok(
        `There are no tables or views in ${args.db}${where} that this database user can access.`,
      );
    }
    const lines = [
      `${shown.length}${more ? '+' : ''} tables/views in ${args.db}${where}:`,
      '',
      renderTable(
        ['schema', 'name', 'type'],
        shown.map((t) => [t.schema, t.name, t.type]),
      ),
    ];
    if (more) {
      lines.push(
        '',
        `The list was cut off at ${LIST_TABLES_LIMIT} entries; narrow it with the search or schema parameter.`,
      );
    }
    return ok(lines.join('\n'));
  } catch (err) {
    trace.reason = errorReason(err);
    return errorResult(err, { db: args.db, timeoutSec: timeoutOf(registry, args.db) });
  }
}

/** Format a table structure as text for Claude. */
export function formatTableDetail(detail: TableDetail, db: string): string {
  const lines = [
    `${detail.type === 'view' ? 'View' : 'Table'} ${detail.schema}.${detail.name} in ${db}`,
    '',
    renderTable(
      ['column', 'type', 'null', 'default'],
      detail.columns.map((c) => [c.name, c.type, c.nullable ? 'yes' : 'no', c.default ?? '']),
    ),
    '',
    `Primary key: ${detail.primaryKey.length > 0 ? detail.primaryKey.join(', ') : '(none)'}`,
  ];
  if (detail.foreignKeys.length > 0) {
    lines.push('Foreign key:');
    for (const fk of detail.foreignKeys) {
      lines.push(
        `- ${fk.name}: (${fk.columns.join(', ')}) -> ${fk.refSchema}.${fk.refTable} (${fk.refColumns.join(', ')})`,
      );
    }
  } else {
    lines.push('Foreign key: (none)');
  }
  if (detail.indexes.length > 0) {
    lines.push('Index:');
    for (const index of detail.indexes) {
      lines.push(
        `- ${index.name}${index.unique ? ' (unique)' : ''}: ${index.columns.map((c) => formatCell(c, 120)).join(', ')}`,
      );
    }
  } else {
    lines.push('Index: (none)');
  }
  return lines.join('\n');
}

/** Handler of describe_table. */
export async function runDescribeTable(
  { registry, log }: ToolDeps,
  args: DescribeTableArgs,
  trace: AuditTrace = {},
): Promise<ToolResult> {
  trace.table = args.schema ? `${args.schema}.${args.table}` : args.table;
  try {
    const source = registry.source(args.db);
    const rejected = schemaRejection(source, args.schema);
    if (rejected) {
      Object.assign(trace, { outcome: 'rejected', reason: 'schema' });
      return rejected;
    }
    const detail = await withReconnect(
      { registry, log, db: args.db, safeToRetry: true, trace },
      async () => (await registry.acquireSql(args.db)).describeTable(args.table, args.schema),
    );
    return ok(formatTableDetail(detail, args.db));
  } catch (err) {
    trace.reason = errorReason(err);
    return errorResult(err, { db: args.db, timeoutSec: timeoutOf(registry, args.db) });
  }
}

/** A statement that is safe to repeat after a dropped connection: read-only, with no INTO or row lock. */
function isPureRead(info: StatementInfo | undefined): boolean {
  return (
    info !== undefined &&
    info.kind === 'read' &&
    info.writeKeywords.length === 0 &&
    !info.hasInto &&
    info.lockClause === undefined
  );
}

/**
 * Handler of execute_sql: guard first, then execute, mask, and format.
 * Rejected and failed calls come back as tool results with isError set; this function does not throw.
 */
export async function runExecuteSql(
  { registry, log, isSensitiveColumn }: ToolDeps,
  args: ExecuteSqlArgs,
  trace: AuditTrace = {},
): Promise<ToolResult> {
  Object.assign(trace, { sql: args.sql, paramCount: args.params?.length ?? 0 });
  let write = true;
  try {
    const source = registry.source(args.db);
    if (source.driver === 'redis') {
      return fail(`Connection ${args.db} is Redis; use the redis_command tool.`);
    }

    // The guard runs BEFORE the connection is opened: a rejected query never touches the database.
    const decision = checkSql(args.sql, {
      dialect: DIALECT_OF[source.driver],
      access: source.access,
      env: source.env,
      schemas: source.schemas,
    });
    if (!decision.allowed) {
      Object.assign(trace, { outcome: 'rejected', reason: decision.rule });
      log.warn('guard rejected query', { db: args.db, env: source.env, rule: decision.rule });
      log.debug('rejected query', { db: args.db, sql: args.sql.slice(0, 500) });
      return fail(`Rejected by the guard (${decision.rule}): ${decision.message}`);
    }
    for (const warning of decision.warnings) log.warn('guard', { db: args.db, warning });
    write = !isPureRead(decision.statement);
    trace.statement = decision.statement?.head;

    const { maxRows, timeoutSec, maxChars } = source.limits;
    const raw = await withReconnect(
      { registry, log, db: args.db, safeToRetry: !write, trace },
      async () =>
        (await registry.acquireSql(args.db)).execute(args.sql, args.params ?? [], {
          readonly: source.readonly,
          maxRows,
          timeoutSec,
        }),
    );
    const { result, masked } = maskResult(raw, isSensitiveColumn);
    Object.assign(trace, {
      rows: result.rows.length,
      truncated: result.truncated,
      affectedRows: result.affectedRows,
      masked: masked.length > 0,
    });
    log.info('execute_sql finished', {
      db: args.db,
      statement: decision.statement?.head,
      rows: result.rows.length,
      truncated: result.truncated,
      affectedRows: result.affectedRows,
      masked,
      ms: result.durationMs,
    });
    return ok(
      formatQueryResult(result, {
        db: args.db,
        maxRows,
        maxChars,
        maskedColumns: masked,
        warnings: decision.warnings,
      }),
    );
  } catch (err) {
    log.info('execute_sql failed', { db: args.db, error: err });
    trace.reason = errorReason(err);
    const result = errorResult(err, { db: args.db, timeoutSec: timeoutOf(registry, args.db) });
    if (write && isConnectionError(err) && registry.status(args.db).state === 'connected') {
      // Connection dropped during a write: the COMMIT may or may not have reached the server.
      result.content.push({
        type: 'text',
        text:
          'The connection dropped while a write was running, so the change may or may not have been saved. ' +
          'Check with a SELECT before retrying; writes are not retried automatically.',
      });
    }
    return result;
  }
}
