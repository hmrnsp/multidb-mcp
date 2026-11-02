import { describe, expect, it } from 'vitest';
import type { Access } from '../../src/config/schema.js';
import { checkRedisCommand } from '../../src/guard/redis-policy.js';

const FULL: Access[] = ['read', 'insert', 'update', 'delete'];
const decide = (command: string, args: string[] = [], access: Access[] = FULL) => {
  const d = checkRedisCommand(command, args, access);
  return d.allowed ? 'allow' : d.rule;
};

describe('checkRedisCommand', () => {
  it('read commands are allowed on a read-only connection (name is case-insensitive)', () => {
    for (const command of ['GET', 'hgetall', 'Lrange', 'SCAN', 'XRANGE', 'TTL', 'TYPE', 'MGET']) {
      expect(decide(command, ['k'], ['read'])).toBe('allow');
    }
  });

  it('write commands need the matching permission', () => {
    expect(decide('SET', ['k', 'v'], ['read'])).toBe('access');
    expect(decide('SET', ['k', 'v'], ['read', 'insert'])).toBe('access');
    expect(decide('SET', ['k', 'v'], ['read', 'insert', 'update'])).toBe('allow');
    expect(decide('SET', ['k', 'v', 'NX'], ['read', 'insert'])).toBe('allow');
    expect(decide('SET', ['k', 'v', 'XX'], ['read', 'update'])).toBe('allow');
    expect(decide('ZADD', ['z', 'NX', '1', 'a'], ['read', 'insert'])).toBe('allow');
    expect(decide('LPUSH', ['l', 'a'], ['read', 'insert'])).toBe('allow');
    expect(decide('EXPIRE', ['k', '10'], ['read', 'update'])).toBe('allow');
    expect(decide('DEL', ['k'], ['read', 'delete'])).toBe('allow');
    expect(decide('RENAME', ['a', 'b'], ['read', 'update'])).toBe('access');
    expect(decide('LMOVE', ['a', 'b', 'LEFT', 'RIGHT'], ['read', 'insert'])).toBe('access');
  });

  it('dangerous commands are rejected even with full permissions, with a reason', () => {
    for (const command of [
      'FLUSHALL',
      'flushdb',
      'KEYS',
      'EVAL',
      'CONFIG',
      'SELECT',
      'MULTI',
      'BLPOP',
      'SUBSCRIBE',
      'MONITOR',
      'SHUTDOWN',
    ]) {
      expect(decide(command, ['x'])).toBe('redis_denied');
    }
    const keys = checkRedisCommand('KEYS', ['*'], FULL);
    expect(keys.allowed ? '' : keys.message).toContain('use SCAN 0 MATCH <pattern> COUNT 100');
  });

  it('a command that is not in the list is rejected as unsupported', () => {
    expect(decide('OBJECT', ['HELP'])).toBe('redis_unsupported');
    expect(decide('JSON.GET', ['k'])).toBe('redis_unsupported');
    expect(decide('SORT_RO', ['k'])).toBe('redis_unsupported');
  });

  it('key positions: one, all, in pairs, and subcommands', () => {
    const keysOf = (command: string, args: string[]) => {
      const d = checkRedisCommand(command, args, FULL);
      return d.allowed ? d.keys : [];
    };
    expect(keysOf('GET', ['a'])).toEqual(['a']);
    expect(keysOf('HMGET', ['h', 'f1', 'f2'])).toEqual(['h']);
    expect(keysOf('DEL', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(keysOf('MSET', ['a', '1', 'b', '2'])).toEqual(['a', 'b']);
    expect(keysOf('SCAN', ['0'])).toEqual([]);
    const memory = checkRedisCommand('memory', ['usage', 'user:1'], ['read']);
    expect(memory.allowed && memory.name).toBe('MEMORY USAGE');
    expect(memory.allowed && memory.keys).toEqual(['user:1']);
  });
});
