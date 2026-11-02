import { describe, expect, it } from 'vitest';
import { DbError } from '../../src/adapters/errors.js';
import { isBrokenConnection, toMysqlDbError } from '../../src/adapters/mysql/errors.js';

const mysqlError = (errno: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error('message'), { errno, ...extra });

describe('toMysqlDbError', () => {
  it('maps a server errno to an error kind', () => {
    const cases: [number, string][] = [
      [3024, 'timeout'],
      [1969, 'timeout'],
      [1792, 'readonly'],
      [1142, 'permission'],
      [1227, 'permission'],
      [1064, 'syntax'],
      [1146, 'not_found'],
      [1054, 'not_found'],
      [1046, 'not_found'],
      [1295, 'unsupported'],
      [1045, 'connection'],
      [2013, 'connection'],
      [1062, 'query'],
      [1317, 'query'],
    ];
    for (const [errno, kind] of cases) expect(toMysqlDbError(mysqlError(errno)).kind).toBe(kind);
  });

  it('the SQLSTATE is passed on, except HY000, which is too generic', () => {
    expect(toMysqlDbError(mysqlError(1146, { sqlState: '42S02' })).sqlState).toBe('42S02');
    expect(toMysqlDbError(mysqlError(3024, { sqlState: 'HY000' })).sqlState).toBeUndefined();
  });

  it('network errors and fatal mysql2 errors count as a broken connection', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(toMysqlDbError(refused).kind).toBe('connection');
    const lost = Object.assign(new Error('Connection lost'), {
      code: 'PROTOCOL_CONNECTION_LOST',
      fatal: true,
    });
    expect(isBrokenConnection(lost)).toBe(true);
    expect(isBrokenConnection(Object.assign(new Error('x'), { fatal: true }))).toBe(true);
    expect(isBrokenConnection(mysqlError(1064))).toBe(false);
  });

  it('the message is filtered of credentials and a DbError is passed on unchanged', () => {
    const err = toMysqlDbError(
      Object.assign(new Error('failed to reach mysql://dev:hunter@h/app'), { errno: 1045 }),
    );
    expect(err.message).not.toContain('hunter');
    const original = new DbError('timeout', 'already classified');
    expect(toMysqlDbError(original)).toBe(original);
    expect(toMysqlDbError('text').kind).toBe('query');
  });
});
