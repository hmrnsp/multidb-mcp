/**
 * Db2 LUW catalog queries (SYSCAT) used by Db2Adapter.
 * Every user value is bound as a parameter (?); only the number of placeholders and
 * a FETCH FIRST limit that is a validated integer are spliced into the text.
 *
 * Db2 stores unquoted identifiers in UPPER CASE, so names are compared through UPPER():
 * Claude can simply write "orders" for the table APP.ORDERS. CHAR columns in the catalog are RTRIMmed.
 */

/** A parameter with no type context must be CAST in Db2 (e.g. "? IS NULL"). */
const P = 'CAST(? AS VARCHAR(128))';

/** T: table, S: materialized query table, U: typed table, N: nickname, V/W: view. */
const TABLE_TYPES = "('T', 'S', 'U', 'N', 'V', 'W')";
const TABLE_TYPE = "CASE WHEN T.TYPE IN ('V', 'W') THEN 'view' ELSE 'table' END";
/** Db2 system schemas start with SYS; NULLID and SQLJ hold driver packages. */
const USER_SCHEMAS = "T.TABSCHEMA NOT LIKE 'SYS%' AND T.TABSCHEMA NOT IN ('NULLID', 'SQLJ')";

function whitelistClause(count: number): string {
  return count > 0
    ? `AND UPPER(T.TABSCHEMA) IN (${Array.from({ length: count }, () => P).join(', ')})`
    : '';
}

function safeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid LIMIT: ${limit}`);
  return limit;
}

/** Parameters: schema, schema, search, search, then the schema whitelist (upper case). */
export function listTablesSql(whitelistCount: number, limit: number): string {
  return `
SELECT RTRIM(T.TABSCHEMA) AS SCHEMA_NAME,
       RTRIM(T.TABNAME) AS TABLE_NAME,
       ${TABLE_TYPE} AS TABLE_TYPE
FROM SYSCAT.TABLES T
WHERE T.TYPE IN ${TABLE_TYPES}
  AND ${USER_SCHEMAS}
  AND (${P} IS NULL OR UPPER(T.TABSCHEMA) = UPPER(${P}))
  AND (${P} IS NULL OR UPPER(T.TABNAME) LIKE '%' || UPPER(${P}) || '%')
  ${whitelistClause(whitelistCount)}
ORDER BY T.TABSCHEMA, T.TABNAME
FETCH FIRST ${safeLimit(limit)} ROWS ONLY`;
}

/**
 * Find a table by name: an exact name is preferred, then the connection's CURRENT SCHEMA.
 * Parameters: name (exact), name, schema, schema, then the schema whitelist (upper case).
 */
export function findTableSql(whitelistCount: number): string {
  return `
SELECT RTRIM(T.TABSCHEMA) AS SCHEMA_NAME,
       RTRIM(T.TABNAME) AS TABLE_NAME,
       ${TABLE_TYPE} AS TABLE_TYPE,
       CASE WHEN T.TABNAME = ${P} THEN 1 ELSE 0 END AS EXACT_NAME,
       CASE WHEN T.TABSCHEMA = CURRENT SCHEMA THEN 1 ELSE 0 END AS IN_DEFAULT
FROM SYSCAT.TABLES T
WHERE T.TYPE IN ${TABLE_TYPES}
  AND UPPER(T.TABNAME) = UPPER(${P})
  AND (${P} IS NULL OR UPPER(T.TABSCHEMA) = UPPER(${P}))
  AND ${USER_SCHEMAS}
  ${whitelistClause(whitelistCount)}
ORDER BY EXACT_NAME DESC, IN_DEFAULT DESC, T.TABSCHEMA
FETCH FIRST 20 ROWS ONLY`;
}

/** Parameters: schema, table (the exact name from findTableSql). */
export const COLUMNS_SQL = `
SELECT RTRIM(COLNAME) AS COLUMN_NAME,
       RTRIM(TYPENAME) AS TYPE_NAME,
       LENGTH AS TYPE_LENGTH,
       SCALE AS TYPE_SCALE,
       NULLS AS NULLABLE,
       "DEFAULT" AS DEFAULT_VALUE,
       IDENTITY AS IS_IDENTITY,
       GENERATED AS GENERATED_KIND,
       CAST(TEXT AS VARCHAR(2000)) AS GENERATION_TEXT
FROM SYSCAT.COLUMNS
WHERE TABSCHEMA = ? AND TABNAME = ?
ORDER BY COLNO`;

/** Parameters: schema, table. */
export const PRIMARY_KEY_SQL = `
SELECT RTRIM(K.COLNAME) AS COLUMN_NAME
FROM SYSCAT.KEYCOLUSE K
JOIN SYSCAT.TABCONST C
  ON C.CONSTNAME = K.CONSTNAME AND C.TABSCHEMA = K.TABSCHEMA AND C.TABNAME = K.TABNAME
WHERE C.TYPE = 'P' AND K.TABSCHEMA = ? AND K.TABNAME = ?
ORDER BY K.COLSEQ`;

/**
 * Parameters: schema, table. One row per column pair; grouped by the adapter.
 * Columns come from KEYCOLUSE, not FK_COLNAMES, which is space-separated text.
 */
export const FOREIGN_KEYS_SQL = `
SELECT RTRIM(R.CONSTNAME) AS CONSTRAINT_NAME,
       RTRIM(K.COLNAME) AS COLUMN_NAME,
       RTRIM(R.REFTABSCHEMA) AS REF_SCHEMA,
       RTRIM(R.REFTABNAME) AS REF_TABLE,
       RTRIM(PK.COLNAME) AS REF_COLUMN
FROM SYSCAT.REFERENCES R
JOIN SYSCAT.KEYCOLUSE K
  ON K.CONSTNAME = R.CONSTNAME AND K.TABSCHEMA = R.TABSCHEMA AND K.TABNAME = R.TABNAME
JOIN SYSCAT.KEYCOLUSE PK
  ON PK.CONSTNAME = R.REFKEYNAME AND PK.TABSCHEMA = R.REFTABSCHEMA
 AND PK.TABNAME = R.REFTABNAME AND PK.COLSEQ = K.COLSEQ
WHERE R.TABSCHEMA = ? AND R.TABNAME = ?
ORDER BY R.CONSTNAME, K.COLSEQ`;

/**
 * Parameters: schema, table. One row per index column.
 * UNIQUERULE: P = primary key, U = unique, D = duplicates allowed. COLORDER: A, D (desc), I (include).
 */
export const INDEXES_SQL = `
SELECT RTRIM(I.INDNAME) AS INDEX_NAME,
       I.UNIQUERULE AS UNIQUE_RULE,
       RTRIM(C.COLNAME) AS COLUMN_NAME,
       C.COLORDER AS COLUMN_ORDER
FROM SYSCAT.INDEXES I
JOIN SYSCAT.INDEXCOLUSE C ON C.INDSCHEMA = I.INDSCHEMA AND C.INDNAME = I.INDNAME
WHERE I.TABSCHEMA = ? AND I.TABNAME = ?
ORDER BY CASE WHEN I.UNIQUERULE = 'P' THEN 0 ELSE 1 END, I.INDNAME, C.COLSEQ`;

/** Session info on connect. */
export const SESSION_INFO_SQL = `
SELECT RTRIM(CURRENT SCHEMA) AS SCHEMA_NAME, RTRIM(CURRENT SERVER) AS SERVER_NAME
FROM SYSIBM.SYSDUMMY1`;
