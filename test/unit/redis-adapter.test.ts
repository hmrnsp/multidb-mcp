import { describe, expect, it } from 'vitest';
import type { RedisClientFactory, RedisClientLike } from '../../src/adapters/redis/redis-driver.js';
import { RedisAdapter } from '../../src/adapters/redis/redis-adapter.js';
import { DbError } from '../../src/adapters/errors.js';
import type { ResolvedSource } from '../../src/config/loader.js';
import { Secret } from '../../src/config/secret.js';
import { createLogger } from '../../src/observability/logger.js';

const silent = createLogger({ write: () => undefined });

class FakeClient implements RedisClientLike {
  isReady = true;
  destroyed = false;
  closed = false;
  constructor(readonly reply: (args: string[]) => Promise<unknown>) {}
  sendCommand(args: string[]) {
    return this.reply(args);
  }
  close() {
    this.closed = true;
    this.isReady = false;
    return Promise.resolve();
  }
  destroy() {
    this.destroyed = true;
    this.isReady = false;
  }
}

function source(): ResolvedSource {
  return {
    id: 'cache',
    driver: 'redis',
    env: 'local',
    description: 'test',
    connection: new Secret('redis://default:hunter@127.0.0.1:6379/0'),
    access: ['read'],
    readonly: true,
    limits: { maxRows: 200, timeoutSec: 30, maxChars: 40_000 },
    schemas: undefined,
    lazy: true,
    baseDir: process.cwd(),
  };
}

function adapterWith(clients: FakeClient[], failConnect?: Error) {
  const created: FakeClient[] = [];
  const factory: RedisClientFactory = (settings) => {
    expect(settings.url).toBe('redis://default:hunter@127.0.0.1:6379/0');
    if (failConnect) return Promise.reject(failConnect);
    const next = clients[created.length] ?? clients.at(-1)!;
    created.push(next);
    return Promise.resolve(next);
  };
  const adapter = new RedisAdapter(source(), silent, {
    loadClientFactory: () => Promise.resolve(factory),
  });
  return { adapter, created };
}

async function errorOf(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DbError) return err;
    throw err;
  }
  throw new Error('no error');
}

describe('RedisAdapter', () => {
  it('connect creates the client; command passes the arguments on', async () => {
    const client = new FakeClient((args) => Promise.resolve(args.join(' ')));
    const { adapter, created } = adapterWith([client]);
    await adapter.connect();
    expect(await adapter.command(['GET', 'k'], 30)).toBe('GET k');
    expect(created).toHaveLength(1);
    await adapter.close();
    expect(client.closed).toBe(true);
  });

  it('a timeout disconnects the client; the next command uses a new client', async () => {
    const stuck = new FakeClient(() => new Promise(() => undefined));
    const fresh = new FakeClient(() => Promise.resolve('PONG'));
    const { adapter, created } = adapterWith([stuck, fresh]);
    await adapter.connect();
    const err = await errorOf(adapter.command(['HGETALL', 'big'], 0.02));
    expect(err.kind).toBe('timeout');
    expect(stuck.destroyed).toBe(true);
    expect(await adapter.command(['PING'], 30)).toBe('PONG');
    expect(created).toHaveLength(2);
  });

  it('connection dropped mid-command: the client is discarded, a connection error', async () => {
    class SocketClosedUnexpectedlyError extends Error {}
    const broken = new FakeClient(() =>
      Promise.reject(new SocketClosedUnexpectedlyError('Socket closed')),
    );
    const { adapter } = adapterWith([broken]);
    await adapter.connect();
    expect((await errorOf(adapter.command(['GET', 'k'], 30))).kind).toBe('connection');
    expect(broken.destroyed).toBe(true);
  });

  it('failed connect (wrong password): a connection error without credentials', async () => {
    class SimpleError extends Error {}
    const { adapter } = adapterWith(
      [],
      new SimpleError('WRONGPASS invalid username-password pair'),
    );
    const err = await errorOf(adapter.connect());
    expect(err.kind).toBe('connection');
    expect(err.message).not.toContain('hunter');
  });
});
