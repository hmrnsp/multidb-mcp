/**
 * Integration test for Redis through the redis_command tool (guard + adapter + limits + masking)
 * with the real driver against Docker Redis 7.4.
 *
 *   npm run db:up
 *   npm run test:integration
 *
 * Uses Redis database number 1 so the sample data in database 0 (npm run seed:redis) is left alone.
 * Skipped automatically when REDIS_LOCAL_PASSWORD is not set in .env.
 */
import { existsSync } from 'node:fs';
import { createClient } from '@redis/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devUrl } from '../../scripts/lib/dev-connections.mjs';
import { ADAPTER_FACTORIES } from '../../src/adapters/index.js';
import type { Access } from '../../src/config/schema.js';
import { parseConfig } from '../../src/config/loader.js';
import { createColumnMatcher } from '../../src/guard/masker.js';
import { createLogger } from '../../src/observability/logger.js';
import { ConnectionRegistry } from '../../src/registry/connection-registry.js';
import { runExecuteSql } from '../../src/tools/database-tools.js';
import { REDIS_SENSITIVE_PATTERNS, runRedisCommand } from '../../src/tools/redis-command.js';
import type { ToolResult } from '../../src/tools/result.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const BASE = devUrl('redis');
const RO_BASE = devUrl('redis', 'ro');
const onDb1 = (url: string) => url.replace(/\/\d*$/, '/1');
const log = createLogger({ level: 'error' });
const FULL: Access[] = ['read', 'insert', 'update', 'delete'];

function setup(connections: { id: string; url: string; access: Access[] }[]) {
  const config = parseConfig(
    JSON.stringify({
      databases: connections.map((c) => ({
        id: c.id,
        driver: 'redis',
        env: 'local',
        access: c.access,
        description: 'redis integration test',
        url: '${URL_' + c.id.toUpperCase() + '}',
      })),
    }),
    {
      path: 'databases.json',
      env: Object.fromEntries(connections.map((c) => [`URL_${c.id.toUpperCase()}`, c.url])),
    },
  );
  const registry = new ConnectionRegistry(config.sources, ADAPTER_FACTORIES, log);
  const deps = {
    registry,
    log,
    isSensitiveKey: createColumnMatcher([...config.maskColumns, ...REDIS_SENSITIVE_PATTERNS]),
  };
  const run = (db: string, command: string, args: (string | number)[] = []) =>
    runRedisCommand(deps, { db, command, args });
  return { registry, run };
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

describe.skipIf(BASE === '')('redis_command against Docker Redis', () => {
  const { registry, run } = setup([
    { id: 'rw', url: onDb1(BASE), access: FULL },
    { id: 'ro', url: onDb1(BASE), access: ['read'] },
    { id: 'del_only', url: onDb1(BASE), access: ['read', 'delete'] },
  ]);

  beforeAll(async () => {
    const client = createClient({ url: onDb1(BASE) });
    await client.connect();
    const cmd = (...args: (string | number)[]) => client.sendCommand(args.map(String));
    await cmd('FLUSHDB');
    await cmd(
      'HSET',
      'user:1',
      'name',
      'Customer 1',
      'password_hash',
      'hash-1',
      'nik',
      '0000000000000001',
    );
    await cmd('SET', 'laravel_cache:product:1', '{"id":1}');
    await cmd('SET', 'laravel_session:abc123', 'hunter-session', 'EX', 600);
    await cmd('ZADD', 'leaderboard', 10, 'user:1', 20, 'user:2');
    for (let i = 0; i < 5; i += 1)
      await cmd('XADD', 'events', '*', 'status', 'paid', 'token', `t${i}`);
    const members = Array.from({ length: 500 }, (_, k) => `m${k}`);
    await cmd('RPUSH', 'big:list', ...members);
    await cmd('HSET', 'big:hash', ...members.flatMap((m) => [m, 'x']));
    await client.close();
  });
  afterAll(async () => {
    await registry.closeAll();
  });

  it('SCAN: keys with sensitive names are hidden, the cursor is reported', async () => {
    const result = text(await run('ro', 'SCAN', ['0', 'MATCH', 'laravel_*', 'COUNT', '100']));
    expect(result).toContain('laravel_cache:product:1');
    expect(result).not.toContain('abc123');
    expect(result).toContain('1 key(s) with sensitive names');
    expect(result).toContain('next cursor:');
  });

  it('GET: ordinary values are shown, the value of a session key is masked', async () => {
    expect(text(await run('ro', 'GET', ['laravel_cache:product:1']))).toContain('{"id":1}');
    const session = text(await run('ro', 'GET', ['laravel_session:abc123']));
    expect(session).toContain('***');
    expect(session).not.toContain('hunter-session');
    expect(text(await run('ro', 'GET', ['missing:key']))).toContain('(nil)');
  });

  it('HGETALL: field/value table, sensitive fields are masked', async () => {
    const result = text(await run('ro', 'HGETALL', ['user:1']));
    expect(result).toContain('name | Customer 1');
    expect(result).toContain('password_hash | ***');
    expect(result).toContain('nik | ***');
    expect(result).not.toContain('hash-1');
  });

  it('MGET: masking per key', async () => {
    const result = text(
      await run('ro', 'MGET', ['laravel_cache:product:1', 'laravel_session:abc123']),
    );
    expect(result).toContain('laravel_cache:product:1 | {"id":1}');
    expect(result).toContain('laravel_session:abc123 | ***');
  });

  it('ZRANGE WITHSCORES and XRANGE (COUNT is added automatically, the token field is masked)', async () => {
    const zrange = text(await run('ro', 'ZRANGE', ['leaderboard', '0', '-1', 'WITHSCORES']));
    expect(zrange).toContain('member | score');
    expect(zrange).toContain('user:2 | 20');
    const xrange = text(await run('ro', 'XRANGE', ['events', '-', '+']));
    expect(xrange).toContain('status=paid, token=***');
  });

  it('heavy commands are limited before they run', async () => {
    const hgetall = await run('ro', 'HGETALL', ['big:hash']);
    expect(hgetall.isError).toBe(true);
    expect(text(hgetall)).toContain('big:hash holds 500 elements, over the limit of 200');
    expect(text(hgetall)).toContain('HSCAN big:hash 0 COUNT 100');
    const lrange = text(await run('ro', 'LRANGE', ['big:list', '0', '-1']));
    expect(lrange).toContain('\n200 | m199');
    expect(lrange).not.toContain('m200');
    expect(lrange).toContain('result limited to 200 elements');
  });

  it('dangerous and unknown commands are always rejected, even with full permissions', async () => {
    for (const [command, args] of [
      ['FLUSHALL', []],
      ['KEYS', ['*']],
      ['EVAL', ['return 1', '0']],
      ['CONFIG', ['GET', '*']],
      ['SELECT', ['2']],
    ] as const) {
      const result = await run('rw', command, [...args]);
      expect(text(result)).toContain('Rejected by the guard (redis_denied)');
    }
    expect(text(await run('rw', 'OBJECT', ['HELP']))).toContain('redis_unsupported');
  });

  it('permissions: read-only rejects SET; the delete permission allows DEL but not SET', async () => {
    expect(text(await run('ro', 'SET', ['a', '1']))).toContain(
      'Rejected by the guard (access): This connection only allows read; command SET needs permission insert, update.',
    );
    expect(text(await run('del_only', 'SET', ['a', '1']))).toContain(
      'needs permission insert, update',
    );
    expect(text(await run('del_only', 'DEL', ['missing:key']))).toContain('0');
  });

  it('read-write: SET, EXPIRE, TTL, DEL', async () => {
    expect(text(await run('rw', 'SET', ['it:x', 'value']))).toContain('OK');
    expect(text(await run('rw', 'EXPIRE', ['it:x', 100]))).toContain('1');
    expect(Number(/\n\n(\d+)/.exec(text(await run('rw', 'TTL', ['it:x'])))?.[1])).toBeGreaterThan(
      90,
    );
    expect(text(await run('rw', 'DEL', ['it:x']))).toContain('1');
  });

  it('Redis errors are translated without SQL terminology', async () => {
    const wrongType = text(await run('ro', 'HGETALL', ['laravel_cache:product:1']));
    expect(wrongType).toContain('Error Redis: WRONGTYPE');
    expect(text(await run('ro', 'GET', []))).toContain('Invalid Redis command arguments');
  });

  it('the SQL tool rejects a Redis connection with a hint', async () => {
    const result = await runExecuteSql(
      { registry, log, isSensitiveColumn: () => false },
      { db: 'ro', sql: 'SELECT 1' },
    );
    expect(text(result)).toContain('is Redis; use the redis_command tool');
  });
});

describe.skipIf(RO_BASE === '')('read-only Redis user (ACL mcp_ro)', () => {
  it('the config allows writes, but Redis itself refuses: a permission message', async () => {
    const { registry, run } = setup([{ id: 'acl', url: onDb1(RO_BASE), access: FULL }]);
    try {
      expect(text(await run('acl', 'GET', ['missing:key']))).toContain('(nil)');
      expect(text(await run('acl', 'SET', ['a', '1']))).toContain(
        'The Redis user for acl lacks permission for this command: NOPERM',
      );
    } finally {
      await registry.closeAll();
    }
  });
});

describe.skipIf(BASE === '')('failed connection', () => {
  it('wrong password and dead port: fail fast, no credentials in the message', async () => {
    const wrong = BASE.replace(/:[^:@/]*@/, ':wrong-hunter@');
    const { registry, run } = setup([
      { id: 'wrong', url: onDb1(wrong), access: ['read'] },
      { id: 'dead', url: 'redis://127.0.0.1:1/0', access: ['read'] },
    ]);
    try {
      const started = performance.now();
      const auth = text(await run('wrong', 'PING'));
      expect(auth).toContain('Cannot connect to wrong');
      expect(auth).toContain('WRONGPASS');
      expect(auth).not.toContain('wrong-hunter');
      expect(text(await run('dead', 'PING'))).toContain('Cannot connect to dead');
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      await registry.closeAll();
    }
  });
});
