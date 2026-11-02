import { redact } from '../../observability/redact.js';
import { DbError, type DbErrorKind } from '../errors.js';

/** Node.js and mysql2 network error codes meaning the database is unreachable. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
]);

/** MySQL/MariaDB server errno values (see "Server Error Message Reference"). */
const KIND_BY_ERRNO: ReadonlyMap<number, DbErrorKind> = new Map<number, DbErrorKind>([
  [3024, 'timeout'], // MySQL: max_execution_time exceeded
  [1969, 'timeout'], // MariaDB: max_statement_time exceeded
  [1792, 'readonly'], // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
  [1044, 'permission'], // ER_DBACCESS_DENIED_ERROR
  [1142, 'permission'], // ER_TABLEACCESS_DENIED_ERROR
  [1143, 'permission'], // ER_COLUMNACCESS_DENIED_ERROR
  [1227, 'permission'], // ER_SPECIFIC_ACCESS_DENIED_ERROR
  [1370, 'permission'], // ER_PROCACCESS_DENIED_ERROR
  [1064, 'syntax'], // ER_PARSE_ERROR
  [1149, 'syntax'], // ER_SYNTAX_ERROR
  [1046, 'not_found'], // ER_NO_DB_ERROR: no default database
  [1049, 'not_found'], // ER_BAD_DB_ERROR
  [1054, 'not_found'], // ER_BAD_FIELD_ERROR
  [1146, 'not_found'], // ER_NO_SUCH_TABLE
  [1305, 'not_found'], // ER_SP_DOES_NOT_EXIST (function/procedure)
  [1235, 'unsupported'], // ER_NOT_SUPPORTED_YET
  [1295, 'unsupported'], // ER_UNSUPPORTED_PS: cannot be used as a prepared statement
  [1040, 'connection'], // ER_CON_COUNT_ERROR
  [1045, 'connection'], // ER_ACCESS_DENIED_ERROR (login failed)
  [1129, 'connection'], // ER_HOST_IS_BLOCKED
  [1130, 'connection'], // ER_HOST_NOT_PRIVILEGED
  [1203, 'connection'], // ER_TOO_MANY_USER_CONNECTIONS
  [1927, 'connection'], // MariaDB ER_CONNECTION_KILLED
  [2006, 'connection'], // CR_SERVER_GONE_ERROR
  [2013, 'connection'], // CR_SERVER_LOST
  [4031, 'connection'], // MySQL: disconnected by the server because it was idle
]);

/** errno ER_QUERY_INTERRUPTED: the query was stopped by KILL QUERY. */
export const ER_QUERY_INTERRUPTED = 1317;

interface MysqlErrorShape {
  code?: unknown;
  errno?: unknown;
  sqlState?: unknown;
  message?: unknown;
  fatal?: unknown;
}

function shapeOf(err: unknown): MysqlErrorShape {
  return typeof err === 'object' && err !== null ? err : {};
}

/** Extract the MySQL errno from an error, or undefined when it has none. */
export function errnoOf(err: unknown): number | undefined {
  const errno = shapeOf(err).errno;
  return typeof errno === 'number' ? errno : undefined;
}

/** Translate an error from mysql2 into a DbError. The message always goes through redact(). */
export function toMysqlDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const source = shapeOf(err);
  const code = typeof source.code === 'string' ? source.code : undefined;
  const errno = errnoOf(err);
  const message = redact(typeof source.message === 'string' ? source.message : String(err));
  const sqlState =
    typeof source.sqlState === 'string' && /^[0-9A-Z]{5}$/.test(source.sqlState)
      ? source.sqlState
      : undefined;

  let kind: DbErrorKind = (errno === undefined ? undefined : KIND_BY_ERRNO.get(errno)) ?? 'query';
  if (
    kind === 'query' &&
    ((code !== undefined && NETWORK_CODES.has(code)) || source.fatal === true)
  ) {
    kind = 'connection';
  }
  // HY000 is a generic SQLSTATE; it does not help, so it is not shown.
  return new DbError(kind, message, {
    sqlState: sqlState === 'HY000' ? undefined : sqlState,
    cause: err,
  });
}

/** true when the error means the connection is broken, so it must be dropped from the pool. */
export function isBrokenConnection(err: unknown): boolean {
  return shapeOf(err).fatal === true || toMysqlDbError(err).kind === 'connection';
}
