import { redact } from '../../observability/redact.js';
import { DbError, type DbErrorKind } from '../errors.js';

/** Db2 LUW SQLCODEs (see "SQL messages" in the Db2 documentation). */
const KIND_BY_SQLCODE: ReadonlyMap<number, DbErrorKind> = new Map<number, DbErrorKind>([
  [-952, 'timeout'], // SQL0952N: cancelled by an interrupt (query timeout)
  [-551, 'permission'], // SQL0551N: no privilege on the object
  [-552, 'permission'], // SQL0552N: not authorized to run the operation
  [-7, 'syntax'],
  [-10, 'syntax'], // string not closed
  [-104, 'syntax'], // SQL0104N: unexpected token
  [-199, 'syntax'],
  [-204, 'not_found'], // SQL0204N: unknown name (table, view, schema)
  [-206, 'not_found'], // SQL0206N: invalid column
  [-440, 'not_found'], // SQL0440N: function/procedure not found
  [-84, 'unsupported'], // SQL0084N: the statement cannot be prepared
  [-142, 'unsupported'],
  [-900, 'connection'],
  [-1013, 'connection'], // database alias not found
  [-1031, 'connection'],
  [-1032, 'connection'], // the database manager has not been started
  [-1060, 'connection'], // the user has no CONNECT privilege
  [-1224, 'connection'],
  [-1336, 'connection'], // host not found
  [-1598, 'connection'], // needs a DB2 Connect license (Db2 for i / z/OS)
  [-30080, 'connection'],
  [-30081, 'connection'], // SQL30081N: communication error (host, port, firewall)
  [-30082, 'connection'], // SQL30082N: login failed
  [-30108, 'connection'],
]);

/** SQLCODE of a cancelled statement (SQL0952N); used to report query timeouts. */
export const SQLCODE_TIMEOUT = -952;

interface Db2ErrorShape {
  message?: unknown;
  sqlcode?: unknown;
  sqlstate?: unknown;
}

function shapeOf(err: unknown): Db2ErrorShape {
  return typeof err === 'object' && err !== null ? err : {};
}

/** Extract the SQLCODE from an ibm_db error, or undefined when it has none. */
export function sqlcodeOf(err: unknown): number | undefined {
  const source = shapeOf(err);
  if (typeof source.sqlcode === 'number' && source.sqlcode !== 0) return source.sqlcode;
  const message = typeof source.message === 'string' ? source.message : '';
  const match = /\bSQL(\d{4,5})N\b/.exec(message);
  return match ? -Number(match[1]) : undefined;
}

/** Db2 messages start with "[IBM][CLI Driver][DB2/LINUXX8664] "; that prefix does not help Claude. */
function cleanMessage(message: string): string {
  return message
    .replace(/^(\[[^\]]*\])+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Translate an error from ibm_db into a DbError. The message always goes through redact(). */
export function toDb2DbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const source = shapeOf(err);
  const raw = typeof source.message === 'string' ? source.message : String(err);
  const message = redact(cleanMessage(raw)) || 'Db2 returned an error without a message';
  // The real Db2 SQLSTATE is in the message text; ibm_db's sqlstate field holds the ODBC code.
  const fromMessage = /SQLSTATE=([0-9A-Z]{5})/.exec(raw)?.[1];
  const odbc = typeof source.sqlstate === 'string' ? source.sqlstate : undefined;
  const sqlState = fromMessage ?? (odbc && odbc !== '00000' ? odbc : undefined);
  const sqlcode = sqlcodeOf(err);

  let kind: DbErrorKind =
    (sqlcode === undefined ? undefined : KIND_BY_SQLCODE.get(sqlcode)) ?? 'query';
  if (kind === 'query' && sqlState !== undefined) {
    if (sqlState.startsWith('08')) kind = 'connection';
    else if (sqlState === '42501' || sqlState === '42502') kind = 'permission';
    else if (sqlState === '42601') kind = 'syntax';
  }
  return new DbError(kind, message, { sqlState, cause: err });
}

/** true when the error means the connection is broken, so it must be closed, not returned. */
export function isBrokenConnection(err: unknown): boolean {
  return toDb2DbError(err).kind === 'connection';
}
