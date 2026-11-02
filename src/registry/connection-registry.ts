import {
  isSqlAdapter,
  type Adapter,
  type AdapterFactory,
  type DbAdapter,
  type KeyValueAdapter,
} from '../adapters/types.js';
import type { Limits, ResolvedSource } from '../config/loader.js';
import type { Access, Driver, Environment } from '../config/schema.js';
import type { Logger } from '../observability/logger.js';
import { redactForClient } from '../observability/redact.js';

/**
 * Connection registry: maps a connection id to its adapter.
 *
 * - Lazy: an adapter is created and connected the first time it is used (acquire).
 * - Concurrent acquire calls for the same id share one connect attempt.
 * - A failed connection does not stop the server; its status is recorded and it is retried
 *   on the next acquire.
 */

export type SourceStatus =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'connected'; since: Date }
  | { state: 'error'; message: string; at: Date }
  | { state: 'unavailable'; reason: string };

/** Connection information that is safe to display: no connection string. */
export interface SourceSummary {
  id: string;
  driver: Driver;
  env: Environment;
  description: string;
  access: Access[];
  readonly: boolean;
  limits: Limits;
  schemas: string[] | undefined;
  lazy: boolean;
  status: SourceStatus;
}

/** The requested connection id does not exist. */
export class UnknownSourceError extends Error {
  override readonly name = 'UnknownSourceError';

  constructor(
    readonly id: string,
    known: readonly string[],
  ) {
    super(`Connection "${id}" is unknown. Available connections: ${known.join(', ') || '(none)'}`);
  }
}

/** The connection cannot be used (no adapter, wrong kind of tool, or the server is stopping). */
export class SourceUnavailableError extends Error {
  override readonly name = 'SourceUnavailableError';
}

interface Entry {
  source: ResolvedSource;
  factory: AdapterFactory | undefined;
  adapter: Adapter | undefined;
  pending: Promise<Adapter> | undefined;
  status: SourceStatus;
}

/** Options for {@link ConnectionRegistry}. */
export interface RegistryOptions {
  /** Time limit for closing one adapter on shutdown. */
  closeTimeoutMs?: number;
}

/** Maps connection ids to adapters, connecting lazily and sharing one connect attempt per id. */
export class ConnectionRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #log: Logger;
  readonly #closeTimeoutMs: number;
  #closed = false;

  constructor(
    sources: readonly ResolvedSource[],
    factories: Readonly<Partial<Record<Driver, AdapterFactory>>>,
    log: Logger,
    options: RegistryOptions = {},
  ) {
    this.#log = log;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 5_000;

    for (const source of sources) {
      if (this.#entries.has(source.id)) throw new Error(`duplicate connection id: ${source.id}`);
      const factory = factories[source.driver];
      const status: SourceStatus = factory
        ? { state: 'idle' }
        : { state: 'unavailable', reason: `adapter ${source.driver} is not available` };
      this.#entries.set(source.id, {
        source,
        factory,
        adapter: undefined,
        pending: undefined,
        status,
      });
    }
  }

  ids(): string[] {
    return [...this.#entries.keys()];
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  source(id: string): ResolvedSource {
    return this.#entry(id).source;
  }

  status(id: string): SourceStatus {
    return this.#entry(id).status;
  }

  summaries(): SourceSummary[] {
    return [...this.#entries.values()].map(({ source, status }) => ({
      id: source.id,
      driver: source.driver,
      env: source.env,
      description: source.description,
      access: [...source.access],
      readonly: source.readonly,
      limits: { ...source.limits },
      schemas: source.schemas ? [...source.schemas] : undefined,
      lazy: source.lazy,
      status,
    }));
  }

  /** Get an adapter that is already connected; connect first if it is not. */
  /** SQL adapter; a Redis connection is rejected with a hint to the right tool. */
  async acquireSql(id: string): Promise<DbAdapter> {
    const adapter = await this.acquire(id);
    if (!isSqlAdapter(adapter)) {
      throw new SourceUnavailableError(`Connection "${id}" is Redis; use the redis_command tool.`);
    }
    return adapter;
  }

  /** Key-value adapter (Redis); a SQL connection is rejected with a hint to the right tool. */
  async acquireKeyValue(id: string): Promise<KeyValueAdapter> {
    const adapter = await this.acquire(id);
    if (isSqlAdapter(adapter)) {
      throw new SourceUnavailableError(
        `Connection "${id}" is a SQL database; use list_tables, describe_table, or execute_sql.`,
      );
    }
    return adapter;
  }

  async acquire(id: string): Promise<Adapter> {
    if (this.#closed)
      throw new SourceUnavailableError('The server is shutting down; new connections are refused');
    const entry = this.#entry(id);
    if (entry.adapter && entry.status.state === 'connected') return entry.adapter;
    if (entry.pending) return entry.pending;
    if (!entry.factory) {
      const reason =
        entry.status.state === 'unavailable' ? entry.status.reason : 'adapter not available';
      throw new SourceUnavailableError(`Connection "${id}": ${reason}`);
    }

    const adapter = entry.factory(entry.source, this.#log.child({ db: id }));
    entry.status = { state: 'connecting' };
    entry.pending = (async () => {
      const startedAt = Date.now();
      try {
        await adapter.connect();
        if (this.#closed) {
          throw new SourceUnavailableError(
            'The server is shutting down; new connections are refused',
          );
        }
        entry.adapter = adapter;
        entry.status = { state: 'connected', since: new Date() };
        this.#log.info('connection opened', {
          db: id,
          driver: entry.source.driver,
          ms: Date.now() - startedAt,
        });
        return adapter;
      } catch (err) {
        entry.adapter = undefined;
        // The only place where a failed/rejected adapter is closed (avoids a double close).
        await adapter.close().catch(() => undefined);
        if (this.#closed) {
          entry.status = { state: 'idle' };
        } else {
          const message = redactForClient(err instanceof Error ? err.message : String(err));
          entry.status = { state: 'error', message, at: new Date() };
          this.#log.warn('connection failed', { db: id, driver: entry.source.driver, error: err });
        }
        throw err;
      } finally {
        entry.pending = undefined;
      }
    })();
    return entry.pending;
  }

  /** Connect the sources with lazy=false at server start. Failures are only logged. */
  async connectEager(): Promise<void> {
    const eager = [...this.#entries.values()].filter((e) => !e.source.lazy && e.factory);
    await Promise.allSettled(eager.map((e) => this.acquire(e.source.id)));
  }

  /** Close every adapter. Safe to call more than once. */
  async closeAll(): Promise<void> {
    this.#closed = true;
    const closing = [...this.#entries.values()].map(async (entry) => {
      const adapter = entry.adapter ?? (await entry.pending?.catch(() => undefined));
      entry.adapter = undefined;
      if (entry.status.state === 'connected' || entry.status.state === 'connecting') {
        entry.status = { state: 'idle' };
      }
      if (!adapter) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          adapter.close(),
          new Promise<void>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('timed out while closing the connection')),
              this.#closeTimeoutMs,
            );
          }),
        ]);
        this.#log.info('connection closed', { db: entry.source.id });
      } catch (err) {
        this.#log.warn('failed to close the connection cleanly', {
          db: entry.source.id,
          error: err,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    await Promise.all(closing);
  }

  #entry(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new UnknownSourceError(id, this.ids());
    return entry;
  }
}
