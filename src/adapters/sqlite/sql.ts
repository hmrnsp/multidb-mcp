/**
 * SQLite catalog queries used by SqliteAdapter. Uses sqlite_schema and the
 * pragma_*() table functions (only available for PRAGMAs that read, with no side effects).
 * User values are bound as parameters; the only thing spliced into the text is LIMIT,
 * an integer that has already been validated.
 */

/** SQLite internal tables (sqlite_sequence, sqlite_stat1, ...) are hidden. */
const USER_OBJECTS = "type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'";

function safeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid LIMIT: ${limit}`);
  return limit;
}

/** Parameter: search, search. */
export function listTablesSql(limit: number): string {
  return `
SELECT name AS table_name, type AS table_type
FROM sqlite_schema
WHERE ${USER_OBJECTS}
  AND (? IS NULL OR lower(name) LIKE '%' || lower(?) || '%')
ORDER BY name
LIMIT ${safeLimit(limit)}`;
}

/** Parameter: name. Table names in SQLite are case-insensitive, so at most one. */
export const FIND_TABLE_SQL = `
SELECT name AS table_name, type AS table_type, sql AS create_sql
FROM sqlite_schema
WHERE ${USER_OBJECTS} AND lower(name) = lower(?)
LIMIT 1`;

/** Parameter: table. hidden: 0 normal, 2 generated VIRTUAL, 3 generated STORED. */
export const COLUMNS_SQL = `
SELECT name, type, "notnull" AS not_null, dflt_value, pk, hidden
FROM pragma_table_xinfo(?)
ORDER BY cid`;

/** Parameter: table. One row per column; grouped by id by the adapter. */
export const FOREIGN_KEYS_SQL = `
SELECT id, seq, "table" AS ref_table, "from" AS column_name, "to" AS ref_column
FROM pragma_foreign_key_list(?)
ORDER BY id, seq`;

/** Parameter: table. origin: c (CREATE INDEX), u (UNIQUE), pk (PRIMARY KEY). */
export const INDEX_LIST_SQL = `
SELECT name, "unique" AS is_unique, origin
FROM pragma_index_list(?)
ORDER BY origin = 'pk' DESC, name`;

/** Parameter: index name. name NULL means an expression column. */
export const INDEX_COLUMNS_SQL = `
SELECT name FROM pragma_index_info(?) ORDER BY seqno`;
