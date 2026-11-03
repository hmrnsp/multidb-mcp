#!/usr/bin/env node
// Fill the development Redis with sample data that looks like a Laravel app (cache, sessions, queues).
// Database 0 is emptied first. Only for LOCAL Redis (127.0.0.1).
//
//   npm run db:up && npm run seed:redis

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@redis/client';
import { devUrl } from './lib/dev-connections.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

const url = devUrl('redis');
if (!url) throw new Error('REDIS_LOCAL_PASSWORD is not set in .env');
const host = new URL(url).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error(`The seed is only for a local Redis, not "${host}". Aborted.`);
}

const client = createClient({ url });
await client.connect();
const cmd = (...args) => client.sendCommand(args.map(String));
const statuses = ['pending', 'paid', 'shipped', 'cancelled'];

await cmd('FLUSHDB');
for (let i = 1; i <= 50; i += 1) {
  await cmd(
    'SET',
    `laravel_cache:product:${i}`,
    JSON.stringify({ id: i, name: `Product ${i}`, price: i * 1500 }),
  );
  await cmd(
    'HSET',
    `user:${i}`,
    'name',
    `Customer ${i}`,
    'email',
    `customer${i}@example.test`,
    'nik',
    String(i).padStart(16, '0'),
    'password_hash',
    `hash-${i}`,
  );
  await cmd('ZADD', 'leaderboard', i * 10, `user:${i}`);
}
for (let i = 1; i <= 5; i += 1) {
  const id = `sess${String(i).padStart(36, '0')}`;
  await cmd('SET', `laravel_session:${id}`, `a:1:{s:7:"user_id";i:${i};}`, 'EX', 7200);
}
for (let i = 1; i <= 20; i += 1) {
  await cmd(
    'RPUSH',
    'queues:default',
    JSON.stringify({ job: 'SendInvoice', order_id: i, attempts: 0 }),
  );
}
for (let i = 1; i <= 30; i += 1) {
  await cmd('XADD', 'events', '*', 'type', 'order', 'status', statuses[i % 4], 'order_id', i);
}
await cmd('SADD', 'tags:popular', 'laptop', 'monitor', 'keyboard', 'mouse');
await cmd('SET', 'counter:visits', 1234);
await cmd('SET', 'laravel_cache:temp', 'temporary', 'EX', 3600);

// Big keys to test the limits on O(N) commands (HGETALL, SMEMBERS, LRANGE 0 -1, ...).
for (let start = 0; start < 5000; start += 500) {
  const members = Array.from({ length: 500 }, (_, k) => `m${start + k}`);
  await cmd('SADD', 'big:set', ...members);
  await cmd('RPUSH', 'big:list', ...members);
  await cmd('HSET', 'big:hash', ...members.flatMap((m) => [m, 'x']));
}

console.log(`Done: ${await cmd('DBSIZE')} keys in the local Redis (database 0).`);
await client.close();
