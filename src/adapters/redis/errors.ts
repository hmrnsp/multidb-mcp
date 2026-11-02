import { redact } from '../../observability/redact.js';
import { DbError, type DbErrorKind } from '../errors.js';

/** Error code made up by multidb-mcp for a client-side timeout. */
export const REDIS_TIMEOUT = 'MULTIDB_REDIS_TIMEOUT';

/** Prefix of a Redis error reply (the first word of the message). */
const KIND_BY_PREFIX: ReadonlyMap<string, DbErrorKind> = new Map<string, DbErrorKind>([
  ['NOPERM', 'permission'], // the ACL user may not run this command/key
  ['WRONGPASS', 'connection'],
  ['NOAUTH', 'connection'],
  ['LOADING', 'connection'], // the server is loading data
  ['MASTERDOWN', 'connection'],
  ['READONLY', 'readonly'], // connected to a replica
  ['WRONGTYPE', 'query'],
]);

/** Network/socket errors from the driver and Node. */
const CONNECTION_NAMES = new Set([
  'ClientClosedError',
  'ClientOfflineError',
  'ConnectionTimeoutError',
  'SocketClosedUnexpectedlyError',
  'SocketTimeoutError',
]);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EPIPE',
]);

/** Translate an error from @redis/client or Node into a classified {@link DbError}. */
export function toRedisDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const source = (typeof err === 'object' && err !== null ? err : {}) as {
    message?: unknown;
    code?: unknown;
    name?: unknown;
    constructor?: { name?: string };
  };
  const message = redact(typeof source.message === 'string' ? source.message : String(err));
  if (source.code === REDIS_TIMEOUT) return new DbError('timeout', message, { cause: err });

  const name = source.constructor?.name ?? (typeof source.name === 'string' ? source.name : '');
  const prefix = message.split(/\s/, 1)[0] ?? '';
  let kind: DbErrorKind = KIND_BY_PREFIX.get(prefix) ?? 'query';
  if (
    CONNECTION_NAMES.has(name) ||
    (typeof source.code === 'string' && NETWORK_CODES.has(source.code))
  ) {
    kind = 'connection';
  } else if (prefix === 'ERR' && /unknown command/i.test(message)) {
    kind = 'unsupported';
  } else if (
    prefix === 'ERR' &&
    /syntax error|wrong number of arguments|not an integer|out of range/i.test(message)
  ) {
    kind = 'syntax';
  }
  return new DbError(kind, message, { cause: err });
}

/** true when the error means the client connection must be discarded. */
export function isBrokenConnection(err: unknown): boolean {
  return toRedisDbError(err).kind === 'connection';
}
