import type { SqlDialect } from '../adapters/types.js';
import { ACCESS_LEVELS, type Access, type Environment } from '../config/schema.js';
import { analyzeStatement, splitStatements, type StatementInfo } from './analyzer.js';
import { LexError, lexVariants, type LexResult } from './lexer.js';

/**
 * SQL guard: decides whether one execute_sql request may run.
 *
 * This is the FIRST layer, not the only one. The layers that still apply in the database:
 * read-only transactions, statement_timeout, and a database user with minimal privileges.
 */

export interface GuardContext {
  dialect: SqlDialect;
  /** Connection permissions from the config; always contains "read". */
  access: readonly Access[];
  env: Environment;
  /** Connection schema whitelist; undefined means unrestricted. */
  schemas?: readonly string[] | undefined;
}

/** Name of the guard rule that rejected a request. */
export type GuardRule =
  | 'parse'
  | 'empty'
  | 'multi_statement'
  | 'executable_comment'
  | 'denied_statement'
  | 'denied_function'
  | 'transaction_control'
  | 'session_command'
  | 'dynamic_sql'
  | 'unsupported'
  | 'readonly'
  | 'readonly_write'
  | 'lock'
  | 'select_into'
  | 'access'
  | 'schema';

/** The guard's verdict: allowed (maybe with warnings) or rejected with a rule and a message. */
export type GuardDecision =
  | { allowed: true; warnings: string[]; statement: StatementInfo | undefined }
  | { allowed: false; rule: GuardRule; message: string };

/** System schemas that may be read even with a whitelist (metadata catalogs). */
const SYSTEM_SCHEMAS: Record<SqlDialect, readonly string[]> = {
  postgresql: ['pg_catalog', 'information_schema'],
  mysql: ['information_schema'],
  mariadb: ['information_schema'],
  db2: ['SYSIBM', 'SYSCAT', 'SYSSTAT', 'SYSFUN'],
  sqlite: ['main', 'temp'],
};

type WriteAccess = Exclude<Access, 'read'>;
const WRITE_ACCESS = ACCESS_LEVELS.filter((a): a is WriteAccess => a !== 'read');

/**
 * Write permissions each write keyword requires. Words are searched across the whole statement, so
 * "INSERT ... ON CONFLICT DO UPDATE" needs insert + update, and a deleting CTE needs delete.
 * Words not mapped here (COPY, GRANT, EXECUTE, ...) are treated as needing every write permission.
 */
const ACCESS_BY_WORD: Readonly<Record<string, readonly WriteAccess[]>> = {
  INSERT: ['insert'],
  UPDATE: ['update'],
  DELETE: ['delete'],
  MERGE: ['insert', 'update', 'delete'],
  UPSERT: ['insert', 'update'],
  REPLACE: ['insert', 'delete'],
  TRUNCATE: ['ddl', 'delete'],
  CREATE: ['ddl'],
  ALTER: ['ddl'],
  DROP: ['ddl'],
  CALL: ['call'],
};

/** Write permissions a statement needs, with the reason for use in the rejection message. */
function requiredAccess(info: StatementInfo): Map<WriteAccess, string> {
  const needed = new Map<WriteAccess, string>();
  const need = (levels: readonly WriteAccess[], reason: string) => {
    for (const level of levels) if (!needed.has(level)) needed.set(level, reason);
  };
  for (const word of info.writeKeywords) need(ACCESS_BY_WORD[word] ?? WRITE_ACCESS, word);
  if (info.kind === 'ddl') need(['ddl'], info.head);
  if (info.kind === 'call') need(['call'], info.head);
  if (info.kind === 'write' && needed.size === 0) need(WRITE_ACCESS, info.head);
  // A lock clause is used to modify rows; SELECT INTO (PostgreSQL) creates a new table.
  if (info.lockClause) need(['update'], info.lockClause);
  if (info.hasInto) need(['ddl'], 'SELECT ... INTO');
  return needed;
}

const formatAccess = (access: readonly Access[]): string => access.join(', ');

const deny = (rule: GuardRule, message: string): GuardDecision => ({
  allowed: false,
  rule,
  message,
});

function schemaAllowed(schema: string, context: GuardContext): boolean {
  const caseInsensitive =
    context.dialect === 'mysql' || context.dialect === 'mariadb' || context.dialect === 'sqlite';
  const same = (a: string, b: string) =>
    caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  return [...(context.schemas ?? []), ...SYSTEM_SCHEMAS[context.dialect]].some((s) =>
    same(s, schema),
  );
}

function evaluate(lexed: LexResult, context: GuardContext): GuardDecision {
  if (lexed.executableComment) {
    return deny(
      'executable_comment',
      'MySQL executable comments (/*! ... */) are not allowed because the server runs their contents.',
    );
  }

  const statements = splitStatements(lexed.tokens);
  if (statements.length === 0) return deny('empty', 'There is no SQL statement to run.');
  if (statements.length > 1) {
    return deny(
      'multi_statement',
      `Only one statement per call; found ${statements.length}. Run them one at a time.`,
    );
  }

  const info = analyzeStatement(statements[0]!, context.dialect);

  switch (info.kind) {
    case 'dcl':
      return deny('denied_statement', `${info.head} is not allowed through multidb-mcp.`);
    case 'transaction':
      return deny(
        'transaction_control',
        'Transactions are managed by the server (each call = one transaction). Send only the statement, without BEGIN/COMMIT/ROLLBACK.',
      );
    case 'session':
      return deny(
        'session_command',
        `Session command ${info.head} is not allowed; every query runs in a clean session.`,
      );
    case 'dynamic':
      return deny(
        'dynamic_sql',
        `${info.head} is not allowed because it runs dynamic SQL that the guard cannot inspect.`,
      );
    case 'unsupported':
      return deny('unsupported', `Statement ${info.head} is not supported through multidb-mcp.`);
    default:
      break;
  }

  if (info.deniedPatterns.length > 0) {
    return deny(
      'denied_statement',
      `${info.deniedPatterns.join(', ')} is not allowed through multidb-mcp.`,
    );
  }
  if (info.deniedFunctions.length > 0) {
    return deny('denied_function', `Function ${info.deniedFunctions.join(', ')} is not allowed.`);
  }

  const readonly = context.access.every((a) => a === 'read');
  if (readonly) {
    if (info.kind !== 'read') {
      return deny(
        'readonly',
        `Read-only connection: only SELECT, WITH ... SELECT, VALUES, SHOW, DESCRIBE, and EXPLAIN are allowed (found ${info.head}).`,
      );
    }
    if (info.lockClause) {
      return deny(
        'lock',
        `Locking clause (${info.lockClause}) is not allowed on a read-only connection.`,
      );
    }
    if (info.writeKeywords.length > 0) {
      return deny(
        'readonly_write',
        `Found a write command (${info.writeKeywords.join(', ')}) inside a read-only query, e.g. a data-modifying CTE.`,
      );
    }
    if (info.hasInto) {
      return deny(
        'select_into',
        'SELECT ... INTO (including INTO OUTFILE) is not allowed on a read-only connection.',
      );
    }
  } else {
    const missing = [...requiredAccess(info)].filter(([level]) => !context.access.includes(level));
    if (missing.length > 0) {
      const detail = missing.map(([level, reason]) => `${level} (${reason})`).join(', ');
      return deny(
        'access',
        `This connection only allows ${formatAccess(context.access)}; this statement needs permission ${detail}.`,
      );
    }
  }

  if (context.schemas && context.schemas.length > 0) {
    for (const ref of info.tables) {
      if (ref.parts.length < 2) continue; // name without a schema: limited by the connection's search_path/default schema
      const schema = ref.parts[ref.parts.length - 2]!;
      if (!schemaAllowed(schema, context)) {
        return deny(
          'schema',
          `${ref.display} is in schema ${schema}, outside the schemas allowed for this connection (${context.schemas.join(', ')}).`,
        );
      }
    }
  }

  return { allowed: true, warnings: [], statement: info };
}

/**
 * Check SQL for one connection. Every string interpretation (see lexVariants) must pass.
 * If the SQL cannot be analyzed it is rejected, except on a local connection that allows every kind
 * of write (allowed with a warning): the SQL is unknown, so it may only
 * pass when anything it could contain is permitted anyway.
 */
export function checkSql(sql: string, context: GuardContext): GuardDecision {
  const variants = lexVariants(sql, context.dialect);
  const lexed = variants.filter((v): v is LexResult => !(v instanceof LexError));

  if (lexed.length === 0) {
    const first = variants.find((v): v is LexError => v instanceof LexError);
    const reason = first ? `${first.message} (position ${first.position})` : 'unknown';
    const fullAccess = WRITE_ACCESS.every((level) => context.access.includes(level));
    if (context.env === 'local' && fullAccess) {
      return {
        allowed: true,
        warnings: [`The guard could not analyze this SQL: ${reason}`],
        statement: undefined,
      };
    }
    return deny('parse', `The guard could not analyze this SQL: ${reason}.`);
  }

  let accepted: GuardDecision | undefined;
  for (const variant of lexed) {
    const decision = evaluate(variant, context);
    if (!decision.allowed) return decision;
    accepted ??= decision;
  }
  return accepted!;
}
