/**
 * Child process that holds one SQLite connection (see driver-types.ts for the reason).
 *
 * Started with child_process.fork by sqlite-driver.ts and communicates over IPC.
 * Uses only Node built-in modules so it can run directly, both from dist/ (.js)
 * and from source during tests (.ts with Node 24's built-in type stripping).
 * This process's stdout is ignored by its parent; never write to stdout.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

interface OpenMessage {
  type: 'open';
  path: string;
  readOnly: boolean;
  busyTimeoutMs: number;
}

interface RunMessage {
  type: 'run';
  id: number;
  sql: string;
  params: SQLInputValue[];
  maxRows: number;
  write: boolean;
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

let db: DatabaseSync | undefined;

function send(message: unknown): void {
  process.send?.(message);
}

function describeError(err: unknown): Record<string, unknown> {
  const source = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  return {
    message: typeof source.message === 'string' ? source.message : String(err),
    code: source.code,
    errcode: source.errcode,
    errstr: source.errstr,
  };
}

/** INTEGER is read as BigInt so no precision is lost, then converted to number when safe. */
function toValue(value: unknown): unknown {
  if (typeof value !== 'bigint') return value;
  return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
}

function runStatement(database: DatabaseSync, message: RunMessage) {
  const stmt = database.prepare(message.sql);
  stmt.setReadBigInts(true);
  stmt.setReturnArrays(true);
  const fields = stmt.columns().map((column) => column.name);
  if (fields.length === 0) {
    const result = stmt.run(...message.params);
    return { fields, rows: [], affectedRows: Number(result.changes) };
  }
  // Every change made by INSERT/UPDATE/DELETE ... RETURNING happens in the first step,
  // so stopping after maxRows + 1 rows does not leave its changes half done.
  const rows: unknown[][] = [];
  const limit = message.maxRows + 1;
  for (const row of stmt.iterate(...message.params)) {
    rows.push((row as unknown as unknown[]).map(toValue));
    if (rows.length >= limit) break;
  }
  return { fields, rows, affectedRows: null };
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    if (database.isTransaction) database.exec('ROLLBACK');
  } catch {
    // The transaction may already have been cancelled by SQLite itself.
  }
}

function handleRun(message: RunMessage) {
  if (!db) throw new Error('The SQLite database has not been opened');
  const database = db;
  database.exec('BEGIN');
  try {
    const result = runStatement(database, message);
    database.exec(message.write ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    rollbackQuietly(database);
    // VACUUM cannot run inside a transaction; run it without one when writing is allowed.
    const text = err instanceof Error ? err.message : '';
    if (message.write && /cannot VACUUM from within a transaction/i.test(text)) {
      return runStatement(database, message);
    }
    throw err;
  }
}

function handleOpen(message: OpenMessage): void {
  // Without this check SQLite (read-write mode) silently creates a new empty file.
  if (!existsSync(message.path)) {
    throw Object.assign(new Error('SQLite database file not found'), { errcode: 14 });
  }
  db = new DatabaseSync(message.path, {
    readOnly: message.readOnly,
    timeout: message.busyTimeoutMs,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
}

process.on('message', (raw: unknown) => {
  const message = raw as OpenMessage | RunMessage;
  if (message.type === 'open') {
    try {
      handleOpen(message);
      send({ type: 'opened' });
    } catch (err) {
      send({ type: 'error', error: describeError(err) });
    }
    return;
  }
  if (message.type === 'run') {
    try {
      send({ type: 'result', id: message.id, result: handleRun(message) });
    } catch (err) {
      send({ type: 'error', id: message.id, error: describeError(err) });
    }
  }
});

// The parent closes the IPC channel when the adapter is closed or its process stops.
process.on('disconnect', () => {
  try {
    db?.close();
  } finally {
    process.exit(0);
  }
});
