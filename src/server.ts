import { McpServer } from '@modelcontextprotocol/server';
import { createColumnMatcher } from './guard/index.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from './meta.js';
import { NO_AUDIT, type AuditLog, type AuditTrace } from './observability/audit.js';
import type { Logger } from './observability/logger.js';
import type { ConnectionRegistry } from './registry/connection-registry.js';
import {
  DESCRIBE_TABLE_TOOL,
  EXECUTE_SQL_TOOL,
  LIST_TABLES_TOOL,
  runDescribeTable,
  runExecuteSql,
  runListTables,
  type ToolDeps,
} from './tools/database-tools.js';
import { buildListDatabasesText, LIST_DATABASES_TOOL } from './tools/list-databases.js';
import {
  REDIS_COMMAND_TOOL,
  REDIS_SENSITIVE_PATTERNS,
  runRedisCommand,
  type RedisToolDeps,
} from './tools/redis-command.js';
import type { ToolResult } from './tools/result.js';
import {
  describeTableInput,
  executeSqlInput,
  listTablesInput,
  redisCommandInput,
  type DescribeTableArgs,
  type ExecuteSqlArgs,
  type ListTablesArgs,
  type RedisCommandArgs,
} from './tools/schemas.js';

/** Dependencies of {@link createMcpServer}. */
export interface ServerDeps {
  registry: ConnectionRegistry;
  log: Logger;
  /** Column-name patterns that are sensitive (built-ins + maskColumns from the config). */
  maskColumns: readonly string[];
  /** Audit log for each tool call. Default: no recording. */
  audit?: AuditLog;
}

/** Wrap a tool handler: write one audit line per call, whatever the outcome. */
function audited<A extends { db?: string }>(
  registry: ConnectionRegistry,
  audit: AuditLog,
  tool: string,
  run: (args: A, trace: AuditTrace) => Promise<ToolResult>,
): (args: A) => Promise<ToolResult> {
  return async (args) => {
    const trace: AuditTrace = {};
    const startedAt = performance.now();
    const result = await run(args, trace);
    const env =
      args.db !== undefined && registry.has(args.db) ? registry.source(args.db).env : undefined;
    audit.record({
      tool,
      db: args.db,
      env,
      ...trace,
      outcome: trace.outcome ?? (result.isError === true ? 'error' : 'ok'),
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  };
}

/** SQL and Redis connection ids; tools are only registered for the connection kinds present in the config. */
function splitIds(registry: ConnectionRegistry): { sql: string[]; redis: string[] } {
  const ids = registry.ids();
  return {
    sql: ids.filter((id) => registry.source(id).driver !== 'redis'),
    redis: ids.filter((id) => registry.source(id).driver === 'redis'),
  };
}

/** Names of the tools registered for this config. */
export function toolsFor(registry: ConnectionRegistry): string[] {
  const { sql, redis } = splitIds(registry);
  return [
    LIST_DATABASES_TOOL.name,
    ...(sql.length > 0
      ? [LIST_TABLES_TOOL.name, DESCRIBE_TABLE_TOOL.name, EXECUTE_SQL_TOOL.name]
      : []),
    ...(redis.length > 0 ? [REDIS_COMMAND_TOOL.name] : []),
  ];
}

/**
 * Create one McpServer instance. Called by serveStdio; the registry is shared
 * so database connections are not recreated per session.
 */
export function createMcpServer({
  registry,
  log,
  maskColumns,
  audit = NO_AUDIT,
}: ServerDeps): McpServer {
  const deps: ToolDeps = { registry, log, isSensitiveColumn: createColumnMatcher(maskColumns) };
  const redisDeps: RedisToolDeps = {
    registry,
    log,
    isSensitiveKey: createColumnMatcher([...maskColumns, ...REDIS_SENSITIVE_PATTERNS]),
  };
  const { sql: sqlIds, redis: redisIds } = splitIds(registry);
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: SERVER_TITLE,
      description: 'Access PostgreSQL, MySQL/MariaDB, IBM Db2, SQLite, and Redis with guardrails',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    LIST_DATABASES_TOOL.name,
    {
      title: LIST_DATABASES_TOOL.title,
      description: LIST_DATABASES_TOOL.description,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    audited(registry, audit, LIST_DATABASES_TOOL.name, () =>
      Promise.resolve({
        content: [{ type: 'text' as const, text: buildListDatabasesText(registry) }],
      }),
    ),
  );

  if (redisIds.length > 0) {
    server.registerTool(
      REDIS_COMMAND_TOOL.name,
      {
        title: REDIS_COMMAND_TOOL.title,
        description: REDIS_COMMAND_TOOL.description,
        inputSchema: redisCommandInput(redisIds),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      audited(registry, audit, REDIS_COMMAND_TOOL.name, (args: RedisCommandArgs, trace) =>
        runRedisCommand(redisDeps, args, trace),
      ),
    );
  }

  if (sqlIds.length === 0) return server;

  server.registerTool(
    LIST_TABLES_TOOL.name,
    {
      title: LIST_TABLES_TOOL.title,
      description: LIST_TABLES_TOOL.description,
      inputSchema: listTablesInput(sqlIds),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    audited(registry, audit, LIST_TABLES_TOOL.name, (args: ListTablesArgs, trace) =>
      runListTables(deps, args, trace),
    ),
  );

  server.registerTool(
    DESCRIBE_TABLE_TOOL.name,
    {
      title: DESCRIBE_TABLE_TOOL.title,
      description: DESCRIBE_TABLE_TOOL.description,
      inputSchema: describeTableInput(sqlIds),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    audited(registry, audit, DESCRIBE_TABLE_TOOL.name, (args: DescribeTableArgs, trace) =>
      runDescribeTable(deps, args, trace),
    ),
  );

  server.registerTool(
    EXECUTE_SQL_TOOL.name,
    {
      title: EXECUTE_SQL_TOOL.title,
      description: EXECUTE_SQL_TOOL.description,
      inputSchema: executeSqlInput(sqlIds),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    audited(registry, audit, EXECUTE_SQL_TOOL.name, (args: ExecuteSqlArgs, trace) =>
      runExecuteSql(deps, args, trace),
    ),
  );

  return server;
}
