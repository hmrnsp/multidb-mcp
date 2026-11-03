/**
 * Integration test for the development config: loads databases.dev.json exactly as the server does,
 * opens every connection through the registry, and runs one trivial command on each. It keeps the
 * config (separate host/port/user fields + ${VAR} passwords) in step with docker-compose.yml.
 *
 *   npm run db:up && npm run seed:sqlite && npm run seed:redis
 *   npm run test:integration
 *
 * Skipped automatically when .env is missing. Db2 is skipped unless its container is running.
 */
import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { ADAPTER_FACTORIES } from '../../src/adapters/index.js';
import { loadConfig } from '../../src/config/loader.js';
import { createLogger } from '../../src/observability/logger.js';
import { ConnectionRegistry } from '../../src/registry/connection-registry.js';

const hasEnv = existsSync('.env');
if (hasEnv) process.loadEnvFile('.env');

const ONLINE = ['local_pg', 'local_mysql', 'local_mariadb', 'local_redis'] as const;

describe.skipIf(!hasEnv)('databases.dev.json against the Docker databases', () => {
  const config = hasEnv ? loadConfig('databases.dev.json') : undefined;
  const registry = new ConnectionRegistry(
    config?.sources ?? [],
    ADAPTER_FACTORIES,
    createLogger({ level: 'error' }),
  );
  afterAll(async () => {
    await registry.closeAll();
  });

  it('resolves every connection from separate fields, without a url', () => {
    expect(registry.ids()).toEqual([
      'local_pg',
      'local_mysql',
      'local_mariadb',
      'local_db2',
      'local_sqlite',
      'local_redis',
    ]);
  });

  it.each(ONLINE.filter((id) => id !== 'local_redis'))('%s: runs SELECT 1', async (id) => {
    const adapter = await registry.acquireSql(id);
    const result = await adapter.execute('SELECT 1 AS n', [], {
      readonly: true,
      maxRows: 10,
      timeoutSec: 10,
    });
    expect(String(result.rows[0]?.[0])).toBe('1');
  });

  it('local_redis: answers PING', async () => {
    const adapter = await registry.acquireKeyValue('local_redis');
    expect(await adapter.command(['PING'], 10)).toBe('PONG');
  });

  it.skipIf(!existsSync('.data/app.sqlite'))('local_sqlite: lists the sample tables', async () => {
    const adapter = await registry.acquireSql('local_sqlite');
    const tables = await adapter.listTables({ limit: 50 });
    expect(tables.map((t) => t.name)).toContain('orders');
  });
});
