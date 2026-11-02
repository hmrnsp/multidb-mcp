import { fork, type ChildProcess } from 'node:child_process';
import type {
  SqliteFactory,
  SqliteHandleLike,
  SqliteRunRequest,
  SqliteRunResult,
  SqliteSettings,
} from './driver-types.js';

/** Error codes made up by multidb-mcp, read by toSqliteDbError. */
export const SQLITE_TIMEOUT = 'MULTIDB_SQLITE_TIMEOUT';
/** Error code used when the SQLite child process exits unexpectedly. */
export const SQLITE_CHILD_EXIT = 'MULTIDB_SQLITE_CHILD_EXIT';

const OPEN_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;

/** From source (tests) the child file is .ts; from dist/ it is .js. */
const CHILD_URL = new URL(
  import.meta.url.endsWith('.ts') ? './sqlite-child.ts' : './sqlite-child.js',
  import.meta.url,
);

interface ChildMessage {
  type: 'opened' | 'result' | 'error';
  id?: number;
  result?: SqliteRunResult;
  error?: { message?: string; code?: unknown; errcode?: unknown; errstr?: unknown };
}

function toError(error: ChildMessage['error']): Error {
  return Object.assign(new Error(error?.message ?? 'SQLite error without a message'), {
    code: error?.code,
    errcode: error?.errcode,
    errstr: error?.errstr,
  });
}

/** One SQLite connection = one child process. Requests run one after another. */
class ChildHandle implements SqliteHandleLike {
  readonly #settings: SqliteSettings;
  #child: ChildProcess | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #nextId = 1;
  #closed = false;

  constructor(settings: SqliteSettings) {
    this.#settings = settings;
  }

  run(request: SqliteRunRequest, timeoutMs: number): Promise<SqliteRunResult> {
    const task = this.#queue.then(() => this.#runNow(request, timeoutMs));
    this.#queue = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.disconnect();
    const timer = setTimeout(() => child.kill('SIGKILL'), CLOSE_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }

  #exchange(
    child: ChildProcess,
    message: unknown,
    accept: (reply: ChildMessage) => boolean,
    timeoutMs: number,
    onTimeout: () => Error,
  ): Promise<ChildMessage> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      const onMessage = (raw: unknown) => {
        const reply = raw as ChildMessage;
        if (!accept(reply)) return;
        cleanup();
        resolve(reply);
      };
      const onExit = (code: number | null, signal: string | null) => {
        cleanup();
        this.#child = undefined;
        reject(
          Object.assign(
            new Error(`SQLite process stopped unexpectedly (${signal ?? `code ${code}`})`),
            {
              code: SQLITE_CHILD_EXIT,
            },
          ),
        );
      };
      // A query past the limit cannot be stopped from inside; kill the process.
      const timer = setTimeout(() => {
        cleanup();
        this.#child = undefined;
        child.kill('SIGKILL');
        reject(onTimeout());
      }, timeoutMs);
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.send(message as object);
    });
  }

  async #ensureChild(): Promise<ChildProcess> {
    if (this.#closed) throw new Error('The SQLite connection is already closed');
    const current = this.#child;
    if (current && current.exitCode === null && current.signalCode === null) return current;

    const child = fork(CHILD_URL, [], {
      serialization: 'advanced',
      // The server's stdout is reserved for the MCP protocol: the child's stdout is ignored, stderr is forwarded.
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      execArgv: [],
    });
    this.#child = child;
    const reply = await this.#exchange(
      child,
      { type: 'open', ...this.#settings },
      (m) => m.type === 'opened' || m.type === 'error',
      OPEN_TIMEOUT_MS,
      () =>
        Object.assign(new Error('Opening the SQLite database exceeded the time limit'), {
          code: SQLITE_TIMEOUT,
        }),
    );
    if (reply.type === 'error') {
      this.#child = undefined;
      child.kill('SIGKILL');
      throw toError(reply.error);
    }
    return child;
  }

  async #runNow(request: SqliteRunRequest, timeoutMs: number): Promise<SqliteRunResult> {
    const child = await this.#ensureChild();
    const id = this.#nextId++;
    const reply = await this.#exchange(
      child,
      { type: 'run', id, ...request },
      (m) => m.id === id,
      timeoutMs,
      () =>
        Object.assign(new Error(`Query cancelled after ${Math.round(timeoutMs / 1000)} seconds`), {
          code: SQLITE_TIMEOUT,
        }),
    );
    if (reply.type === 'error') throw toError(reply.error);
    return reply.result!;
  }
}

/** Return a factory that starts one child process per SQLite connection. */
export function loadSqliteFactory(): Promise<SqliteFactory> {
  return Promise.resolve((settings) => new ChildHandle(settings));
}
