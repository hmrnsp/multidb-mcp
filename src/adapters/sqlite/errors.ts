import { redact } from '../../observability/redact.js';
import { DbError, type DbErrorKind } from '../errors.js';
import { SQLITE_CHILD_EXIT, SQLITE_TIMEOUT } from './sqlite-driver.js';

/** Primary SQLite result code (the lower 8 bits of the extended result code). */
const KIND_BY_RESULT_CODE: ReadonlyMap<number, DbErrorKind> = new Map<number, DbErrorKind>([
  [8, 'readonly'], // SQLITE_READONLY: the file was opened read-only
  [9, 'timeout'], // SQLITE_INTERRUPT
  [14, 'connection'], // SQLITE_CANTOPEN
  [23, 'permission'], // SQLITE_AUTH
  [26, 'connection'], // SQLITE_NOTADB: the file is not a SQLite database
]);

interface SqliteErrorShape {
  message?: unknown;
  code?: unknown;
  errcode?: unknown;
}

/** SQLITE_ERROR (1) is used for many things; the kind is told apart by the message. */
function kindOfGenericError(message: string): DbErrorKind {
  if (/^no such (table|column|function|index|view|module)\b/i.test(message)) return 'not_found';
  if (/syntax error|incomplete input|unrecognized token/i.test(message)) return 'syntax';
  if (/not authorized/i.test(message)) return 'permission';
  return 'query';
}

/** Translate an error from node:sqlite / the child process into a DbError. The message always goes through redact(). */
export function toSqliteDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const source = (typeof err === 'object' && err !== null ? err : {}) as SqliteErrorShape;
  const message = redact(typeof source.message === 'string' ? source.message : String(err));
  if (source.code === SQLITE_TIMEOUT) return new DbError('timeout', message, { cause: err });
  if (source.code === SQLITE_CHILD_EXIT) return new DbError('connection', message, { cause: err });

  const errcode = typeof source.errcode === 'number' ? source.errcode : undefined;
  const primary = errcode === undefined ? undefined : errcode & 0xff;
  let kind: DbErrorKind =
    (primary === undefined ? undefined : KIND_BY_RESULT_CODE.get(primary)) ?? 'query';
  if (kind === 'query' && primary === 1) kind = kindOfGenericError(message);
  return new DbError(kind, message, { cause: err });
}

/** true when the error means the SQLite child process is gone and must be restarted. */
export function isBrokenConnection(err: unknown): boolean {
  return toSqliteDbError(err).kind === 'connection';
}
