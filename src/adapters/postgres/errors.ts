import { redact } from '../../observability/redact.js';
import { DbError, type DbErrorKind } from '../errors.js';

/** Node.js network error codes meaning the database is unreachable. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
]);

/** PostgreSQL SQLSTATE classification (see the "Error Codes" appendix of the PostgreSQL documentation). */
function kindFor(code: string | undefined, message: string): DbErrorKind {
  if (code === '57014') return 'timeout';
  if (code === '25006') return 'readonly';
  if (code === '42501') return 'permission';
  if (code === '42601') return 'syntax';
  if (code === '42P01' || code === '42703' || code === '3F000' || code === '42883') {
    return 'not_found';
  }
  if (code === '25001' || code === '0A000') return 'unsupported';
  if (
    (code !== undefined &&
      (code.startsWith('08') || code.startsWith('28') || NETWORK_CODES.has(code))) ||
    code === '57P01' ||
    code === '57P03' ||
    code === '3D000' || // database does not exist (wrong name in the connection string)
    /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED/i.test(
      message,
    )
  ) {
    return 'connection';
  }
  return 'query';
}

/** Translate an error from pg into a DbError. The message always goes through redact(). */
export function toPgDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const source = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const code = typeof source.code === 'string' ? source.code : undefined;
  const message = redact(typeof source.message === 'string' ? source.message : String(err));
  const sqlState = code !== undefined && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  return new DbError(kindFor(code, message), message, { sqlState, cause: err });
}

/** true when the error means the connection is broken, so it must be dropped from the pool. */
export function isBrokenConnection(err: unknown): boolean {
  return toPgDbError(err).kind === 'connection';
}
