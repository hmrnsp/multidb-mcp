import * as z from 'zod/v4';

/**
 * Tool input schemas. The db parameter is always an enum of the IDs in the config, so Claude
 * cannot use a connection name that does not exist.
 */

function dbParam(ids: readonly string[]) {
  const [first, ...rest] = ids;
  if (first === undefined)
    throw new Error('At least one connection is required to build the tool schema');
  return z.enum([first, ...rest]).describe('Database connection ID (see list_databases)');
}

/** Input schema of list_tables. */
export function listTablesInput(ids: readonly string[]) {
  return z.object({
    db: dbParam(ids),
    schema: z.string().trim().min(1).max(128).optional().describe('Limit to one schema (optional)'),
    search: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe('Find tables whose name contains this text (optional, case-insensitive)'),
  });
}

/** Input schema of describe_table. */
export function describeTableInput(ids: readonly string[]) {
  return z.object({
    db: dbParam(ids),
    table: z.string().trim().min(1).max(128).describe('Table or view name'),
    schema: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe('Schema of the table; required when the same name exists in several schemas'),
  });
}

/** Input schema of execute_sql. */
export function executeSqlInput(ids: readonly string[]) {
  return z.object({
    db: dbParam(ids),
    sql: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .describe('ONE SQL statement. Use placeholders for values'),
    params: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .max(100)
      .optional()
      .describe('Values for the placeholders in order ($1, $2 in PostgreSQL; ? in MySQL/Db2)'),
  });
}

/** Input schema of redis_command. */
export function redisCommandInput(ids: readonly string[]) {
  return z.object({
    db: dbParam(ids),
    command: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z_.]+$/, 'command name only, without arguments')
      .describe('Redis command name, e.g. GET, HGETALL, SCAN'),
    args: z
      .array(z.union([z.string().max(10_000), z.number()]))
      .max(200)
      .optional()
      .describe(
        'Command arguments in order, e.g. ["user:1"] or ["0", "MATCH", "user:*", "COUNT", "100"]',
      ),
  });
}

/** Validated arguments of redis_command. */
export type RedisCommandArgs = {
  db: string;
  command: string;
  args?: (string | number)[] | undefined;
};

/** Validated arguments of list_tables. */
export type ListTablesArgs = {
  db: string;
  schema?: string | undefined;
  search?: string | undefined;
};
/** Validated arguments of describe_table. */
export type DescribeTableArgs = { db: string; table: string; schema?: string | undefined };
/** Validated arguments of execute_sql. */
export type ExecuteSqlArgs = {
  db: string;
  sql: string;
  params?: (string | number | boolean | null)[] | undefined;
};
