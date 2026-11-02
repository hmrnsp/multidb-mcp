import type { ResolvedSource } from '../../config/loader.js';
import type { Logger } from '../../observability/logger.js';
import { DbError } from '../errors.js';
import type { KeyValueAdapter } from '../types.js';
import { isBrokenConnection, REDIS_TIMEOUT, toRedisDbError } from './errors.js';
import type { RedisClientFactory, RedisClientLike } from './redis-driver.js';

/** Options for {@link RedisAdapter}. */
export interface RedisAdapterOptions {
  /** Driver loader. Default: the real @redis/client, loaded on first connect. */
  loadClientFactory: () => Promise<RedisClientFactory>;
}

/**
 * Redis adapter: one client per connection, recreated automatically when it drops or after a timeout.
 *
 * Redis runs commands one at a time, so a slow command cannot be cancelled on the
 * server; the timeout here only disconnects the client so the tool does not hang. The main protection
 * against heavy commands lives in the redis_command tool (size limits before the command runs).
 */
export class RedisAdapter implements KeyValueAdapter {
  readonly driver = 'redis' as const;

  readonly #source: ResolvedSource;
  readonly #log: Logger;
  readonly #options: RedisAdapterOptions;
  #factory: RedisClientFactory | undefined;
  #client: RedisClientLike | undefined;
  #connecting: Promise<RedisClientLike> | undefined;

  constructor(source: ResolvedSource, log: Logger, options: RedisAdapterOptions) {
    this.#source = source;
    this.#log = log;
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (!this.#factory) {
      try {
        this.#factory = await this.#options.loadClientFactory();
      } catch (err) {
        throw new DbError(
          'connection',
          `Redis driver could not be loaded: ${toRedisDbError(err).message}`,
          {
            cause: err,
          },
        );
      }
    }
    await this.#ensureClient();
  }

  async ping(): Promise<void> {
    await this.command(['PING'], this.#source.limits.timeoutSec);
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    await client?.close().catch(() => client.destroy());
  }

  async command(args: readonly string[], timeoutSec: number): Promise<unknown> {
    const client = await this.#ensureClient();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Disconnect this client; the next command uses a new client.
        if (this.#client === client) this.#client = undefined;
        client.destroy();
        reject(
          Object.assign(new Error(`Redis command exceeded the ${timeoutSec} second limit`), {
            code: REDIS_TIMEOUT,
          }),
        );
      }, timeoutSec * 1000);
    });
    try {
      return await Promise.race([client.sendCommand([...args]), timeout]);
    } catch (err) {
      if (isBrokenConnection(err) && this.#client === client) {
        this.#client = undefined;
        client.destroy();
      }
      throw toRedisDbError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  async #ensureClient(): Promise<RedisClientLike> {
    if (this.#client?.isReady) return this.#client;
    if (this.#connecting) return this.#connecting;
    const factory = this.#factory;
    if (!factory) throw new DbError('connection', 'The Redis adapter is not connected yet');
    this.#connecting = (async () => {
      try {
        const client = await factory({
          url: this.#source.connection.reveal(),
          connectTimeoutMs: 10_000,
          onError: (err) =>
            this.#log.warn('Redis connection problem', { db: this.#source.id, error: err }),
        });
        this.#client = client;
        return client;
      } catch (err) {
        const error = toRedisDbError(err);
        throw error.kind === 'connection'
          ? error
          : new DbError('connection', error.message, { cause: err });
      } finally {
        this.#connecting = undefined;
      }
    })();
    return this.#connecting;
  }
}
