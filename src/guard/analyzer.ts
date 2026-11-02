import type { SqlDialect } from '../adapters/types.js';
import type { Token } from './lexer.js';

/**
 * Structural analysis of a statement from its tokens. Not a full parser: enough to answer
 * the guard's questions (statement kind, a write word anywhere, SELECT INTO,
 * lock clause, forbidden functions, schema-qualified table references) conservatively.
 */

export type StatementKind =
  'read' | 'write' | 'ddl' | 'call' | 'dcl' | 'transaction' | 'session' | 'dynamic' | 'unsupported';

/** A table referenced by a statement. */
export interface TableRef {
  /** Name parts, normalized per dialect (e.g. unquoted: PG lower case, Db2 upper case). */
  parts: string[];
  /** Name as written, for messages. */
  display: string;
}

/** What the guard needs to know about one statement. */
export interface StatementInfo {
  /** Main keyword (after WITH ... and EXPLAIN ...). */
  head: string;
  kind: StatementKind;
  /** Write keywords found anywhere in the statement (e.g. DELETE inside a CTE). */
  writeKeywords: string[];
  /** An INTO word appears in a read statement (SELECT INTO, INTO OUTFILE, INTO @var). */
  hasInto: boolean;
  /** Row-locking clause found, e.g. "FOR UPDATE". */
  lockClause: string | undefined;
  deniedFunctions: string[];
  /** Patterns forbidden in every mode, e.g. "CREATE USER", "INTO OUTFILE". */
  deniedPatterns: string[];
  tables: TableRef[];
}

const READ_HEADS = new Set(['SELECT', 'VALUES', 'TABLE', 'SHOW', 'DESCRIBE', 'DESC', 'HELP']);
const WRITE_HEADS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE']);
const DDL_HEADS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'COMMENT',
  'REFRESH',
  'REINDEX',
  'CLUSTER',
  'VACUUM',
  'ANALYZE',
  'OPTIMIZE',
  'REPAIR',
]);
const DCL_HEADS = new Set(['GRANT', 'REVOKE']);
const TRANSACTION_HEADS = new Set([
  'BEGIN',
  'START',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'END',
  'ABORT',
  'XA',
]);
const SESSION_HEADS = new Set([
  'SET',
  'RESET',
  'USE',
  'DISCARD',
  'LOCK',
  'UNLOCK',
  'CONNECT',
  'DISCONNECT',
  // SQLite: PRAGMA changes connection settings. ATTACH/DETACH (opening another database file)
  // are deliberately not recognized, so they are rejected as unsupported statements.
  'PRAGMA',
]);
const DYNAMIC_HEADS = new Set([
  'DO',
  'EXECUTE',
  'EXEC',
  'PREPARE',
  'DEALLOCATE',
  'DECLARE',
  'HANDLER',
]);

/** Words that change data/schema when they appear as a keyword anywhere. */
const WRITE_WORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'REPLACE',
  'TRUNCATE',
  'CREATE',
  'ALTER',
  'DROP',
  'GRANT',
  'REVOKE',
  'COPY',
  'CALL',
  'EXEC',
  'EXECUTE',
]);

/** Statement heads that can be EXPLAINed. */
const EXPLAINABLE_HEADS = new Set([
  'SELECT',
  'WITH',
  'VALUES',
  'TABLE',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'REPLACE',
  'CREATE',
  'DECLARE',
  'EXECUTE',
]);

/**
 * Functions rejected on every connection: delaying the server, reading/writing server files,
 * taking locks, changing session settings, or running SQL from a string
 * (which the guard cannot inspect).
 */
const DENIED_FUNCTIONS = new Set([
  // PostgreSQL
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_stat_file',
  'lo_import',
  'lo_export',
  'lo_get',
  'lo_put',
  'lo_from_bytea',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_promote',
  'pg_switch_wal',
  'pg_notify',
  'pg_file_write',
  'pg_file_rename',
  'pg_file_unlink',
  'pg_logdir_ls',
  'set_config',
  'pg_advisory_lock',
  'pg_advisory_lock_shared',
  'pg_advisory_xact_lock',
  'pg_advisory_xact_lock_shared',
  'pg_try_advisory_lock',
  'pg_try_advisory_xact_lock',
  'query_to_xml',
  'query_to_xml_and_xmlschema',
  'query_to_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'table_to_xml',
  'table_to_xml_and_xmlschema',
  'table_to_xmlschema',
  'schema_to_xml',
  'schema_to_xml_and_xmlschema',
  'schema_to_xmlschema',
  'database_to_xml',
  'database_to_xml_and_xmlschema',
  'database_to_xmlschema',
  // MySQL / MariaDB
  'sleep',
  'benchmark',
  'load_file',
  'get_lock',
  'release_lock',
  'release_all_locks',
  'is_free_lock',
  'master_pos_wait',
  'source_pos_wait',
  'sys_exec',
  'sys_eval',
  // Db2
  'admin_cmd',
  'sysproc.admin_cmd',
  'dbms_lock.sleep',
  // SQLite: loading native code, reading/writing files (fileio), and other dangerous functions.
  'load_extension',
  'readfile',
  'writefile',
  'edit',
  'fts3_tokenizer',
]);
/** dblink: connection to another server; crosstab/connectby (tablefunc): run SQL from a string. */
const DENIED_FUNCTION_PREFIXES = ['dblink', 'pg_ls_', 'crosstab', 'connectby'];

/** Words that end the table list in a FROM/USING clause. */
const FROM_TERMINATORS = new Set([
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'WINDOW',
  'FOR',
  'ON',
  'USING',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'STRAIGHT_JOIN',
  'RETURNING',
  'SET',
  'VALUES',
  'WITH',
  'INTO',
  'QUALIFY',
]);

const isName = (t: Token | undefined): t is Token => t?.type === 'word' || t?.type === 'quoted';
const isPunct = (t: Token | undefined, value: string): boolean =>
  t?.type === 'punct' && t.value === value;
const isWord = (t: Token | undefined, upper: string): boolean =>
  t?.type === 'word' && t.upper === upper;

/** Index after the matching parenthesis, starting from the index of '('. */
function skipParens(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (isPunct(tokens[i], '(')) depth += 1;
    else if (isPunct(tokens[i], ')')) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return tokens.length;
}

/** Split tokens into statements at ";" (empty statements are dropped). */
export function splitStatements(tokens: readonly Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (isPunct(token, ';')) {
      if (current.length > 0) statements.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

/** Skip the WITH ... block (CTE definitions) and the opening parenthesis; return the index of the main keyword. */
function skipWith(tokens: readonly Token[], start: number): number {
  let i = start;
  while (isPunct(tokens[i], '(')) i += 1;
  if (!isWord(tokens[i], 'WITH')) return i;
  i += 1;
  if (isWord(tokens[i], 'RECURSIVE')) i += 1;
  for (;;) {
    if (!isName(tokens[i])) return i;
    i += 1;
    if (isPunct(tokens[i], '(')) i = skipParens(tokens, i);
    if (!isWord(tokens[i], 'AS')) return i;
    i += 1;
    if (isWord(tokens[i], 'NOT')) i += 1;
    if (isWord(tokens[i], 'MATERIALIZED')) i += 1;
    if (!isPunct(tokens[i], '(')) return i;
    i = skipParens(tokens, i);
    if (isPunct(tokens[i], ',')) {
      i += 1;
      continue;
    }
    break;
  }
  while (isPunct(tokens[i], '(')) i += 1;
  return i;
}

function classifyHead(
  tokens: readonly Token[],
  index: number,
  dialect: SqlDialect,
): { head: string; kind: StatementKind } {
  const token = tokens[index];
  const head = token?.type === 'word' ? token.upper : '';

  if (head === 'EXPLAIN') {
    // Db2: EXPLAIN writes to the explain tables.
    if (dialect === 'db2') return { head, kind: 'unsupported' };
    let i = index + 1;
    if (isPunct(tokens[i], '(')) i = skipParens(tokens, i);
    while (
      i < tokens.length &&
      !(tokens[i]?.type === 'word' && EXPLAINABLE_HEADS.has(tokens[i]!.upper))
    )
      i += 1;
    if (i >= tokens.length) return { head, kind: 'read' }; // MySQL: EXPLAIN table_name
    const inner = classifyHead(tokens, skipWith(tokens, i), dialect);
    return {
      head: `EXPLAIN ${inner.head}`.trim(),
      kind: inner.kind === 'read' ? 'read' : inner.kind,
    };
  }
  if (READ_HEADS.has(head)) return { head, kind: 'read' };
  if (WRITE_HEADS.has(head)) return { head, kind: 'write' };
  if (DDL_HEADS.has(head)) return { head, kind: 'ddl' };
  if (DCL_HEADS.has(head)) return { head, kind: 'dcl' };
  if (TRANSACTION_HEADS.has(head)) return { head, kind: 'transaction' };
  if (SESSION_HEADS.has(head)) return { head, kind: 'session' };
  if (DYNAMIC_HEADS.has(head)) return { head, kind: 'dynamic' };
  if (head === 'CALL') return { head, kind: 'call' };
  return { head: head || '(unrecognized)', kind: 'unsupported' };
}

function findLockClause(tokens: readonly Token[]): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const a = tokens[i];
    if (a?.type !== 'word') continue;
    const b = tokens[i + 1]?.upper;
    const c = tokens[i + 2]?.upper;
    const d = tokens[i + 3]?.upper;
    if (a.upper === 'FOR') {
      if (b === 'UPDATE' || b === 'SHARE') return `FOR ${b}`;
      if (b === 'NO' && c === 'KEY' && d === 'UPDATE') return 'FOR NO KEY UPDATE';
      if (b === 'KEY' && c === 'SHARE') return 'FOR KEY SHARE';
    }
    if (a.upper === 'LOCK' && b === 'IN' && c === 'SHARE' && d === 'MODE')
      return 'LOCK IN SHARE MODE';
    if (a.upper === 'USE' && b === 'AND' && c === 'KEEP') return 'USE AND KEEP ... LOCKS';
  }
  return undefined;
}

function findWriteKeywords(tokens: readonly Token[]): string[] {
  const found = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.type !== 'word' || !WRITE_WORDS.has(t.upper)) continue;
    if (isPunct(tokens[i + 1], '(')) continue; // a function, e.g. REPLACE(...) or INSERT(...) in MySQL
    if (isPunct(tokens[i - 1], '.')) continue; // an aliased column, e.g. t.update
    const prev = tokens[i - 1]?.upper;
    const prev2 = tokens[i - 2]?.upper;
    // The lock-clause part, reported separately.
    if (
      (t.upper === 'UPDATE' || t.upper === 'SHARE') &&
      (prev === 'FOR' || (prev === 'KEY' && prev2 === 'NO'))
    ) {
      continue;
    }
    found.add(t.upper);
  }
  return [...found];
}

function findDeniedFunctions(tokens: readonly Token[]): string[] {
  const found = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (!isName(t) || !isPunct(tokens[i + 1], '(')) continue;
    const name = t.value.toLowerCase();
    const qualifier =
      isPunct(tokens[i - 1], '.') && isName(tokens[i - 2])
        ? tokens[i - 2]!.value.toLowerCase()
        : '';
    const full = qualifier ? `${qualifier}.${name}` : name;
    if (
      DENIED_FUNCTIONS.has(name) ||
      DENIED_FUNCTIONS.has(full) ||
      DENIED_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      found.add(full);
    }
  }
  return [...found];
}

function findDeniedPatterns(tokens: readonly Token[], head: string): string[] {
  const found: string[] = [];
  const words = tokens.map((t) => (t.type === 'word' ? t.upper : ''));
  const first = words[0] ?? '';
  const second = words[1] ?? '';
  if (
    ['CREATE', 'ALTER', 'DROP'].includes(first) &&
    ['USER', 'ROLE', 'LOGIN', 'GROUP'].includes(second)
  ) {
    found.push(`${first} ${second}`);
  }
  if (first === 'DROP' && (second === 'DATABASE' || second === 'SCHEMA'))
    found.push(`DROP ${second}`);
  if (first === 'ALTER' && second === 'SYSTEM') found.push('ALTER SYSTEM');
  for (let i = 0; i < words.length - 1; i += 1) {
    if (words[i] === 'INTO' && (words[i + 1] === 'OUTFILE' || words[i + 1] === 'DUMPFILE')) {
      found.push(`INTO ${words[i + 1]}`);
    }
  }
  if (head === 'COPY' || first === 'COPY') found.push('COPY');
  // SQLite: VACUUM INTO 'path' writes a copy of the database to any file.
  if (first === 'VACUUM' && words.includes('INTO')) found.push('VACUUM INTO');
  return found;
}

function normalizeName(token: Token, dialect: SqlDialect): string {
  if (token.type === 'quoted') return token.value;
  if (dialect === 'postgresql') return token.value.toLowerCase();
  if (dialect === 'db2') return token.value.toUpperCase();
  return token.value;
}

/** Read a qualified name a.b.c starting at index i. */
function readQualifiedName(
  tokens: readonly Token[],
  start: number,
  dialect: SqlDialect,
): { ref: TableRef; end: number } | undefined {
  let i = start;
  if (!isName(tokens[i])) return undefined;
  const parts: string[] = [];
  const display: string[] = [];
  for (;;) {
    const t = tokens[i]!;
    parts.push(normalizeName(t, dialect));
    display.push(t.type === 'quoted' ? `"${t.value}"` : t.value);
    i += 1;
    if (isPunct(tokens[i], '.') && isName(tokens[i + 1])) {
      i += 1;
      continue;
    }
    break;
  }
  return { ref: { parts, display: display.join('.') }, end: i };
}

const TABLE_INTRODUCERS = new Set([
  'FROM',
  'JOIN',
  'UPDATE',
  'INTO',
  'TABLE',
  'USING',
  'DESCRIBE',
  'DESC',
]);
const TABLE_MODIFIERS = new Set([
  'ONLY',
  'LATERAL',
  'IGNORE',
  'LOW_PRIORITY',
  'HIGH_PRIORITY',
  'DELAYED',
  'QUICK',
]);

/** Collect table references after FROM, JOIN, UPDATE, INTO, TABLE, USING (at every depth). */
export function extractTableRefs(tokens: readonly Token[], dialect: SqlDialect): TableRef[] {
  const refs: TableRef[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.type !== 'word' || !TABLE_INTRODUCERS.has(t.upper)) continue;
    const listMode = t.upper === 'FROM' || t.upper === 'USING';
    // After FROM/JOIN/USING, "name(" is a table function. After INTO/TABLE/UPDATE,
    // "name(" is a table followed by a column list, e.g. INSERT INTO x.t (a, b).
    const parenMeansFunction = listMode || t.upper === 'JOIN';
    let j = i + 1;
    for (;;) {
      while (tokens[j]?.type === 'word' && TABLE_MODIFIERS.has(tokens[j]!.upper)) j += 1;
      if (isPunct(tokens[j], '(')) break; // a subquery; its contents are scanned in another iteration
      const read = readQualifiedName(tokens, j, dialect);
      if (!read) break;
      j = read.end;
      if (parenMeansFunction && isPunct(tokens[j], '(')) break; // e.g. generate_series(...)
      refs.push(read.ref);
      if (!listMode) break;
      // Skip the alias up to ',' (next table) or the end of the clause.
      let depth = 0;
      let more = false;
      for (; j < tokens.length; j += 1) {
        const k = tokens[j]!;
        if (isPunct(k, '(')) depth += 1;
        else if (isPunct(k, ')')) {
          if (depth === 0) break;
          depth -= 1;
        } else if (depth === 0 && isPunct(k, ',')) {
          more = true;
          j += 1;
          break;
        } else if (depth === 0 && k.type === 'word' && FROM_TERMINATORS.has(k.upper)) break;
      }
      if (!more) break;
    }
  }
  return refs;
}

/**
 * Analyze one statement (a token list without the terminating ";") conservatively.
 *
 * @param tokens Tokens of exactly one statement.
 * @param dialect SQL dialect of the connection.
 */
export function analyzeStatement(tokens: readonly Token[], dialect: SqlDialect): StatementInfo {
  const { head, kind } = classifyHead(tokens, skipWith(tokens, 0), dialect);
  return {
    head,
    kind,
    writeKeywords: findWriteKeywords(tokens),
    hasInto: kind === 'read' && tokens.some((t) => isWord(t, 'INTO')),
    lockClause: findLockClause(tokens),
    deniedFunctions: findDeniedFunctions(tokens),
    deniedPatterns: findDeniedPatterns(tokens, head),
    tables: extractTableRefs(tokens, dialect),
  };
}
