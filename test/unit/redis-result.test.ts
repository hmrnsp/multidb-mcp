import { describe, expect, it } from 'vitest';
import { createColumnMatcher } from '../../src/guard/masker.js';
import { formatRedisReply, type RedisFormatOptions } from '../../src/output/redis-result.js';

const options = (extra: Partial<RedisFormatOptions> = {}): RedisFormatOptions => ({
  db: 'cache',
  command: 'GET',
  keys: [],
  maxRows: 3,
  maxChars: 40_000,
  isSensitive: createColumnMatcher(['password', 'session', 'token']),
  limited: false,
  durationMs: 1,
  ...extra,
});

describe('formatRedisReply', () => {
  it('a single value, nil, and masking of a sensitive key', () => {
    expect(formatRedisReply('hello', options({ keys: ['a'] })).text).toContain('\n\nhello\n');
    expect(formatRedisReply(null, options()).text).toContain('(nil)');
    const session = formatRedisReply('hunter', options({ keys: ['laravel_session:x'] }));
    expect(session.text).toContain('***');
    expect(session.text).not.toContain('hunter');
    expect(session.masked).toBe(true);
  });

  it('an array is cut at maxRows with a note', () => {
    const text = formatRedisReply(
      ['a', 'b', 'c', 'd'],
      options({ command: 'LRANGE', keys: ['l'] }),
    ).text;
    expect(text).toContain('3 | c');
    expect(text).not.toContain('4 | d');
    expect(text).toContain('cut at the limit of 3 rows');
  });

  it('HSCAN pairs with field masking; ZSCAN member/score', () => {
    const hscan = formatRedisReply(
      ['0', ['name', 'A', 'password', 'x']],
      options({ command: 'HSCAN', keys: ['user:1'] }),
    ).text;
    expect(hscan).toContain('name | A');
    expect(hscan).toContain('password | ***');
    const zscan = formatRedisReply(
      ['0', ['m1', '10']],
      options({ command: 'ZSCAN', keys: ['z'] }),
    ).text;
    expect(zscan).toContain('member | score');
    expect(zscan).toContain('m1 | 10');
  });

  it('output is cut at maxChars', () => {
    const text = formatRedisReply(
      'x'.repeat(5_000),
      options({ keys: ['a'], maxChars: 1_000 }),
    ).text;
    expect(text).toContain('output cut at 1000 characters');
    expect(text.length).toBeLessThan(1_200);
  });
});
