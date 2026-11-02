/**
 * MySQL/MariaDB catalog queries (information_schema) used by MysqlAdapter.
 * Every user value is bound as a prepared-statement parameter (bound on the server,
 * never concatenated into the SQL text). Only the number of placeholders and a LIMIT
 * that is a validated integer are spliced into the text.
 *
 * Name comparison uses LOWER() because the case sensitivity of table names in MySQL depends
 * on lower_case_table_names and the server's operating system.
 */

export type MysqlFlavor = 'mysql' | 'mariadb';

const SYSTEM_SCHEMAS = "('mysql', 'information_schema', 'performance_schema', 'sys')";
const TABLE_TYPE = "CASE WHEN TABLE_TYPE IN ('VIEW', 'SYSTEM VIEW') THEN 'view' ELSE 'table' END";

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function whitelistClause(count: number): string {
  return count > 0 ? `AND LOWER(TABLE_SCHEMA) IN (${placeholders(count)})` : '';
}

function safeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid LIMIT: ${limit}`);
  return limit;
}

/**
 * Parameters: schema, schema, search, search, then the schema whitelist (lower case).
 * Without a schema filter, every non-system schema the user can see is listed;
 * information_schema only shows tables that user may access.
 */
export function listTablesSql(whitelistCount: number, limit: number): string {
  return `
SELECT TABLE_SCHEMA AS schema_name,
       TABLE_NAME AS table_name,
       ${TABLE_TYPE} AS table_type
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ${SYSTEM_SCHEMAS}
  AND (? IS NULL OR LOWER(TABLE_SCHEMA) = LOWER(?))
  AND (? IS NULL OR LOWER(TABLE_NAME) LIKE CONCAT('%', LOWER(?), '%'))
  ${whitelistClause(whitelistCount)}
ORDER BY TABLE_SCHEMA, TABLE_NAME
LIMIT ${safeLimit(limit)}`;
}

/**
 * Find a table by name: an exact name is preferred, then the connection's default schema.
 * Parameters: name (exact), name, schema, schema, then the schema whitelist (lower case).
 */
export function findTableSql(whitelistCount: number): string {
  return `
SELECT TABLE_SCHEMA AS schema_name,
       TABLE_NAME AS table_name,
       ${TABLE_TYPE} AS table_type,
       CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY) AS exact_name,
       COALESCE(TABLE_SCHEMA = DATABASE(), 0) AS in_default
FROM information_schema.TABLES
WHERE LOWER(TABLE_NAME) = LOWER(?)
  AND (? IS NULL OR LOWER(TABLE_SCHEMA) = LOWER(?))
  AND TABLE_SCHEMA NOT IN ${SYSTEM_SCHEMAS}
  ${whitelistClause(whitelistCount)}
ORDER BY exact_name DESC, in_default DESC, TABLE_SCHEMA
LIMIT 20`;
}

/** Parameters: schema, table (the exact name from findTableSql). */
export const COLUMNS_SQL = `
SELECT COLUMN_NAME AS column_name,
       COLUMN_TYPE AS column_type,
       IS_NULLABLE AS is_nullable,
       COLUMN_DEFAULT AS column_default,
       EXTRA AS extra,
       GENERATION_EXPRESSION AS generation_expression
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION`;

/** Parameters: schema, table. */
export const PRIMARY_KEY_SQL = `
SELECT COLUMN_NAME AS column_name
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
ORDER BY ORDINAL_POSITION`;

/** Parameters: schema, table. One row per column; grouped by constraint by the adapter. */
export const FOREIGN_KEYS_SQL = `
SELECT CONSTRAINT_NAME AS constraint_name,
       COLUMN_NAME AS column_name,
       REFERENCED_TABLE_SCHEMA AS ref_schema,
       REFERENCED_TABLE_NAME AS ref_table,
       REFERENCED_COLUMN_NAME AS ref_column
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;

/**
 * Parameters: schema, table. One row per index column.
 * The EXPRESSION column (functional index) only exists in MySQL 8.0.13+, not in MariaDB.
 */
export function indexesSql(flavor: MysqlFlavor): string {
  return `
SELECT INDEX_NAME AS index_name,
       NON_UNIQUE AS non_unique,
       COLUMN_NAME AS column_name,
       SUB_PART AS sub_part,
       ${flavor === 'mysql' ? 'EXPRESSION' : 'NULL'} AS expression
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`;
}

/** Session info on connect: confirms the server flavor and the default schema. */
export const SESSION_INFO_SQL = 'SELECT VERSION() AS version, DATABASE() AS db';
