/**
 * A classified database error. Each adapter translates its driver's errors into DbError,
 * so tools can give consistent messages and hints for every kind of database.
 */
export type DbErrorKind =
  | 'timeout'
  | 'connection'
  | 'readonly'
  | 'permission'
  | 'syntax'
  | 'not_found'
  | 'ambiguous'
  | 'unsupported'
  | 'query';

/** A database error that was classified into a {@link DbErrorKind}, with an optional SQLSTATE. */
export class DbError extends Error {
  override readonly name = 'DbError';
  readonly kind: DbErrorKind;
  readonly sqlState: string | undefined;

  constructor(
    kind: DbErrorKind,
    message: string,
    options: { sqlState?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.sqlState = options.sqlState;
  }
}
