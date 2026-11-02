import { describe, expect, it } from 'vitest';
import {
  REDIS_TIMEOUT,
  isBrokenConnection,
  toRedisDbError,
} from '../../src/adapters/redis/errors.js';

class SimpleError extends Error {}
class ConnectionTimeoutError extends Error {}

describe('toRedisDbError', () => {
  it('maps the prefix of a Redis error reply', () => {
    const cases: [string, string][] = [
      ["NOPERM User mcp_ro has no permissions to run the 'set' command", 'permission'],
      ['WRONGPASS invalid username-password pair or user is disabled.', 'connection'],
      ['NOAUTH Authentication required.', 'connection'],
      ["READONLY You can't write against a read only replica.", 'readonly'],
      ['WRONGTYPE Operation against a key holding the wrong kind of value', 'query'],
      ["ERR unknown command 'FOO', with args beginning with:", 'unsupported'],
      ["ERR wrong number of arguments for 'get' command", 'syntax'],
      ['ERR value is not an integer or out of range', 'syntax'],
      ['ERR something else', 'query'],
    ];
    for (const [message, kind] of cases) {
      expect(toRedisDbError(new SimpleError(message)).kind).toBe(kind);
    }
  });

  it('network errors, driver error classes, and timeouts', () => {
    expect(
      toRedisDbError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
        .kind,
    ).toBe('connection');
    expect(isBrokenConnection(new ConnectionTimeoutError('Connection timeout'))).toBe(true);
    expect(toRedisDbError(Object.assign(new Error('lama'), { code: REDIS_TIMEOUT })).kind).toBe(
      'timeout',
    );
  });

  it('credentials in the message are filtered', () => {
    expect(
      toRedisDbError(new Error('failed to reach redis://default:hunter@h:6379/0')).message,
    ).not.toContain('hunter');
  });
});
