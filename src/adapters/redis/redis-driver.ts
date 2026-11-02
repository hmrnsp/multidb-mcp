/**
 * Bridge to the official @redis/client driver.
 *
 * Important: by default the driver retries the connection without limit, including when the password
 * is wrong, so a request could hang forever. Here reconnecting is turned off and the offline
 * queue is disabled; RedisAdapter creates a new client on the next request.
 */

export interface RedisClientLike {
  readonly isReady: boolean;
  sendCommand(args: string[]): Promise<unknown>;
  /** Close cleanly (waits for the command that is running). */
  close(): Promise<void>;
  /** Force disconnect, e.g. after a timeout. */
  destroy(): void;
}

/** Settings used to create a Redis client. */
export interface RedisClientSettings {
  url: string;
  connectTimeoutMs: number;
  /** Called on a connection problem outside a command (without a listener, the Node process crashes). */
  onError: (err: Error) => void;
}

/** Creates and connects a Redis client from settings. */
export type RedisClientFactory = (settings: RedisClientSettings) => Promise<RedisClientLike>;

interface RawClient {
  readonly isReady: boolean;
  on(event: 'error', listener: (err: Error) => void): unknown;
  connect(): Promise<unknown>;
  sendCommand(args: string[]): Promise<unknown>;
  close(): Promise<void>;
  destroy(): void;
}

interface RedisModule {
  createClient(options: Record<string, unknown>): RawClient;
}

/** Load @redis/client lazily and return a factory that creates connected clients. */
export async function loadRedisClientFactory(): Promise<RedisClientFactory> {
  const module = (await import('@redis/client')) as unknown as RedisModule;

  return async (settings) => {
    const client = module.createClient({
      url: settings.url,
      socket: { connectTimeout: settings.connectTimeoutMs, reconnectStrategy: false },
      disableOfflineQueue: true,
    });
    client.on('error', settings.onError);
    await client.connect();
    return {
      get isReady() {
        return client.isReady;
      },
      sendCommand: (args) => client.sendCommand(args),
      close: () => client.close(),
      destroy: () => client.destroy(),
    };
  };
}
