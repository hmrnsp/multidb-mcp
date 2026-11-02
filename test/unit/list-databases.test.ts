import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/loader.js';
import { createLogger } from '../../src/observability/logger.js';
import { ConnectionRegistry } from '../../src/registry/connection-registry.js';
import {
  buildListDatabasesText,
  describeAccess,
  describeStatus,
} from '../../src/tools/list-databases.js';

const env = {
  LOCAL_PG_URL: 'postgres://dev:hunter-local@127.0.0.1:55432/app',
  PROD_DB2_CONN: 'DATABASE=APPDB;HOSTNAME=db2.prod.internal;PORT=50000;UID=mcp_ro;PWD=hunter-prod;',
};

const config = parseConfig(
  JSON.stringify({
    databases: [
      {
        id: 'local_pg',
        driver: 'postgres',
        env: 'local',
        access: ['read', 'insert', 'update', 'delete', 'ddl', 'call'],
        description: 'PostgreSQL docker | sample data',
        url: '${LOCAL_PG_URL}',
        schemas: ['app'],
      },
      {
        id: 'prod_db2',
        driver: 'db2',
        env: 'production',
        access: ['read'],
        description: 'Core transaction data, for reports only',
        url: '${PROD_DB2_CONN}',
        maxRows: 500,
      },
    ],
  }),
  { path: 'databases.json', env },
);

const registry = new ConnectionRegistry(
  config.sources,
  {},
  createLogger({ write: () => undefined }),
  {},
);

describe('list_databases', () => {
  const text = buildListDatabasesText(registry);

  it('shows every connection with its attributes', () => {
    expect(text).toMatch(/^2 database connections\./);
    expect(text).toContain('id | driver | env | access | limits | schema | status | description');
    expect(text).toContain(
      'local_pg | postgres | local | read + insert, update, delete, ddl, call | 200 rows, 30 s | app | adapter postgres is not available | PostgreSQL docker \\| sample data',
    );
    expect(text).toContain('prod_db2 | db2 | production | read-only | 500 rows, 30 s | all |');
  });

  it('does not leak the host, user, or password', () => {
    for (const leak of [
      'hunter',
      '127.0.0.1',
      'db2.prod.internal',
      'mcp_ro',
      'UID=',
      'postgres://',
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('mentions the redis_command tool only when there is a Redis connection', () => {
    expect(text).not.toContain('redis_command');
    const withRedis = parseConfig(
      JSON.stringify({
        databases: [
          {
            id: 'cache',
            driver: 'redis',
            env: 'local',
            access: ['read', 'delete'],
            description: 'Redis application cache',
            url: 'redis://127.0.0.1:6379/0',
          },
        ],
      }),
      { path: 'databases.json', env },
    );
    const redisText = buildListDatabasesText(
      new ConnectionRegistry(withRedis.sources, {}, createLogger({ write: () => undefined })),
    );
    expect(redisText).toContain('cache | redis | local | read + delete | 200 rows, 30 s | - |');
    expect(redisText).toContain('Redis connections use the redis_command tool');
  });

  it('access text', () => {
    expect(describeAccess(['read'])).toBe('read-only');
    expect(describeAccess(['read', 'update', 'delete'])).toBe('read + update, delete');
  });

  it('status text', () => {
    expect(describeStatus({ state: 'idle' })).toBe('ready (not connected yet)');
    expect(describeStatus({ state: 'error', message: 'timeout', at: new Date() })).toBe(
      'failed to connect: timeout',
    );
  });
});
