import type {
  PgClientLike,
  PgCursorResult,
  PgPoolFactory,
  PgPoolSettings,
} from './driver-types.js';

/**
 * Bridge to the real driver: pg (Pool) + pg-cursor.
 *
 * Loaded dynamically when the first PostgreSQL connection opens, so the server can still
 * start (and list_databases still works) even if the driver has a problem.
 * The module shape is accessed through the minimal interface below so it is not tied to
 * the details of a particular @types package version.
 */

/**
 * Date/time types are returned as text exactly as the database sends them:
 * date (1082), time (1083), timestamp (1114), timestamptz (1184), interval (1186), timetz (1266).
 * By default pg turns DATE into a JavaScript Date in the local time zone, which can
 * shift the date by a day on a machine with a different time zone.
 */
const TEXT_TYPE_OIDS: ReadonlySet<number> = new Set([1082, 1083, 1114, 1184, 1186, 1266]);

interface RawField {
  name: string;
}
interface RawResult {
  rows?: unknown[];
  fields?: RawField[];
  rowCount?: number | null;
  command?: string | null;
}
/** The slice of a pg-cursor instance that this project uses. */
export interface RawCursor {
  /** Internal pg-cursor state; used only as a fallback for column metadata. */
  _result?: RawResult;
  read(
    rowCount: number,
    callback: (err: Error | undefined, rows: unknown[], result?: RawResult) => void,
  ): void;
  close(callback: (err?: Error) => void): void;
}
interface RawClient {
  query(textOrSubmittable: unknown, values?: unknown[]): unknown;
  escapeIdentifier(name: string): string;
  release(destroy?: boolean): void;
}
interface RawPool {
  connect(): Promise<RawClient>;
  end(): Promise<void>;
  on(event: 'error', listener: (err: Error) => void): unknown;
}
interface PgModule {
  Pool: new (config: Record<string, unknown>) => RawPool;
  types: { getTypeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown };
}
type CursorConstructor = new (
  text: string,
  values: unknown[],
  config: Record<string, unknown>,
) => RawCursor;

function unwrapDefault<T>(module: unknown): T {
  const withDefault = module as { default?: unknown };
  return (withDefault.default ?? module) as T;
}

/** Exported for unit tests. */
export function readCursor(cursor: RawCursor, maxRows: number): Promise<PgCursorResult> {
  return new Promise((resolve, reject) => {
    cursor.read(maxRows, (err, rows, result) => {
      // After an error the portal has been closed by the server; the transaction is rolled back by the adapter.
      if (err) {
        reject(err);
        return;
      }
      // The official documentation only guarantees the promise form (rows only). Column metadata is taken
      // from the third callback argument, or from the cursor state as a fallback.
      const meta = result ?? cursor._result;
      const data = rows as unknown[][];
      let fields = (meta?.fields ?? []).map((f) => f.name);
      const width = data[0]?.length ?? 0;
      if (fields.length === 0 && width > 0) {
        fields = Array.from({ length: width }, (_, i) => `column_${i + 1}`);
      }
      const output: PgCursorResult = {
        fields,
        rows: data,
        rowCount: typeof meta?.rowCount === 'number' ? meta.rowCount : null,
        command: typeof meta?.command === 'string' ? meta.command : null,
      };
      cursor.close((closeErr) => (closeErr ? reject(closeErr) : resolve(output)));
    });
  });
}

/** Load pg and pg-cursor lazily and return a factory that creates connection pools. */
export async function loadPgPoolFactory(): Promise<PgPoolFactory> {
  const pg = unwrapDefault<PgModule>(await import('pg'));
  const Cursor = unwrapDefault<CursorConstructor>(await import('pg-cursor'));

  const types = {
    getTypeParser: (oid: number, format?: 'text' | 'binary') =>
      TEXT_TYPE_OIDS.has(oid) && format !== 'binary'
        ? (value: string) => value
        : pg.types.getTypeParser(oid, format),
  };

  return (settings: PgPoolSettings) => {
    const pool = new pg.Pool({
      connectionString: settings.connectionString,
      max: settings.max,
      idleTimeoutMillis: settings.idleTimeoutMillis,
      connectionTimeoutMillis: settings.connectionTimeoutMillis,
      application_name: settings.applicationName,
      keepAlive: true,
      types,
    });
    pool.on('error', settings.onIdleError);

    return {
      async connect(): Promise<PgClientLike> {
        const client = await pool.connect();
        return {
          async query(text, values) {
            const result = (await client.query(
              text,
              values ? [...values] : undefined,
            )) as RawResult;
            return { rows: (result.rows ?? []) as Record<string, unknown>[] };
          },
          cursor(text, values, maxRows) {
            // Custom types are given directly to Cursor: pg does not pass client types on to the cursor.
            const cursor = client.query(
              new Cursor(text, [...values], { rowMode: 'array', types }),
            ) as RawCursor;
            return readCursor(cursor, maxRows);
          },
          escapeIdentifier: (name) => client.escapeIdentifier(name),
          release: (destroy) => client.release(destroy),
        };
      },
      end: () => pool.end(),
    };
  };
}
