import { describe, expect, it } from 'vitest';
import type { AdapterFactory, DbAdapter } from '../../src/adapters/types.js';
import type { ResolvedSource } from '../../src/config/loader.js';
import type { Driver } from '../../src/config/schema.js';
import { Secret } from '../../src/config/secret.js';
import { createLogger } from '../../src/observability/logger.js';
import {
  ConnectionRegistry,
  SourceUnavailableError,
  UnknownSourceError,
} from '../../src/registry/connection-registry.js';

const silent = createLogger({ write: () => undefined });

function source(id: string, driver: Driver, extra: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    id,
    driver,
    env: 'local',
    description: `source ${id}`,
    connection: new Secret(`postgres://u:hunter@h/${id}`),
    access: ['read', 'insert', 'update', 'delete', 'ddl', 'call'],
    readonly: false,
    limits: { maxRows: 200, timeoutSec: 30, maxChars: 40_000 },
    schemas: undefined,
    lazy: true,
    baseDir: process.cwd(),
    ...extra,
  };
}

interface FakeControl {
  connects: number;
  closes: number;
  failNext: Error | undefined;
  connectDelayMs: number;
}

function fakeFactory(control: FakeControl): AdapterFactory {
  return (src) => {
    const adapter: DbAdapter = {
      driver: src.driver,
      dialect: 'postgresql',
      connect: async () => {
        control.connects += 1;
        await new Promise((r) => setTimeout(r, control.connectDelayMs));
        const failure = control.failNext;
        control.failNext = undefined;
        if (failure) throw failure;
      },
      ping: () => Promise.resolve(),
      listTables: () => Promise.resolve([]),
      describeTable: () => Promise.reject(new Error('not used')),
      execute: () => Promise.reject(new Error('not used')),
      close: () => {
        control.closes += 1;
        return Promise.resolve();
      },
    };
    return adapter;
  };
}

function newControl(): FakeControl {
  return { connects: 0, closes: 0, failNext: undefined, connectDelayMs: 5 };
}

describe('ConnectionRegistry', () => {
  it('a driver without an adapter has the status unavailable', async () => {
    const registry = new ConnectionRegistry([source('prod_db2', 'db2')], {}, silent, {});
    expect(registry.status('prod_db2')).toEqual({
      state: 'unavailable',
      reason: 'adapter db2 is not available',
    });
    await expect(registry.acquire('prod_db2')).rejects.toThrow(SourceUnavailableError);
  });

  it('an unknown id lists the available connections', async () => {
    const registry = new ConnectionRegistry(
      [source('a', 'postgres'), source('b', 'mysql')],
      {},
      silent,
    );
    await expect(registry.acquire('c')).rejects.toThrow(UnknownSourceError);
    await expect(registry.acquire('c')).rejects.toThrow(/Available connections: a, b/);
  });

  it('lazy: connect once, concurrent calls share one connect', async () => {
    const control = newControl();
    const registry = new ConnectionRegistry(
      [source('a', 'postgres')],
      { postgres: fakeFactory(control) },
      silent,
    );
    expect(registry.status('a').state).toBe('idle');
    const [x, y] = await Promise.all([registry.acquire('a'), registry.acquire('a')]);
    expect(x).toBe(y);
    expect(control.connects).toBe(1);
    expect(registry.status('a').state).toBe('connected');
    await registry.acquire('a');
    expect(control.connects).toBe(1);
  });

  it('a failed connect is logged without credentials, then retried on the next acquire', async () => {
    const control = newControl();
    control.failNext = new Error('auth failed for postgres://u:hunter@h/a');
    const registry = new ConnectionRegistry(
      [source('a', 'postgres')],
      { postgres: fakeFactory(control) },
      silent,
    );

    await expect(registry.acquire('a')).rejects.toThrow(/auth failed/);
    const status = registry.status('a');
    expect(status.state).toBe('error');
    expect(status.state === 'error' ? status.message : '').not.toContain('hunter');
    expect(control.closes).toBe(1);

    await registry.acquire('a');
    expect(registry.status('a').state).toBe('connected');
    expect(control.connects).toBe(2);
  });

  it('connectEager only connects sources with lazy=false and does not throw', async () => {
    const control = newControl();
    control.failNext = new Error('down');
    const registry = new ConnectionRegistry(
      [source('eager', 'postgres', { lazy: false }), source('lazy', 'postgres')],
      { postgres: fakeFactory(control) },
      silent,
    );
    await registry.connectEager();
    expect(control.connects).toBe(1);
    expect(registry.status('eager').state).toBe('error');
    expect(registry.status('lazy').state).toBe('idle');
  });

  it('closeAll closes adapters and refuses acquire afterwards', async () => {
    const control = newControl();
    const registry = new ConnectionRegistry(
      [source('a', 'postgres'), source('b', 'postgres')],
      { postgres: fakeFactory(control) },
      silent,
    );
    await registry.acquire('a');
    await registry.closeAll();
    await registry.closeAll();
    expect(control.closes).toBe(1);
    expect(registry.status('a').state).toBe('idle');
    await expect(registry.acquire('b')).rejects.toThrow(/shutting down/);
  });

  it('closeAll while a connect is still running still closes that adapter', async () => {
    const control = newControl();
    control.connectDelayMs = 30;
    const registry = new ConnectionRegistry(
      [source('a', 'postgres')],
      { postgres: fakeFactory(control) },
      silent,
    );
    const pending = registry.acquire('a');
    await registry.closeAll();
    await expect(pending).rejects.toThrow(/shutting down/);
    expect(control.closes).toBe(1);
  });

  it('summaries do not contain the connection string', () => {
    const registry = new ConnectionRegistry([source('a', 'postgres')], {}, silent);
    const text = JSON.stringify(registry.summaries());
    expect(text).not.toContain('hunter');
    expect(text).not.toContain('connection');
  });
});
