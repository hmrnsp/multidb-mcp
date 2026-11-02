import { describe, expect, it } from 'vitest';
import { DbError } from '../../src/adapters/errors.js';
import { isBrokenConnection, toPgDbError } from '../../src/adapters/postgres/errors.js';

const pgError = (code: string, message = 'message') => Object.assign(new Error(message), { code });

describe('toPgDbError', () => {
  it('maps SQLSTATE to an error kind', () => {
    const cases: [string, string][] = [
      ['57014', 'timeout'],
      ['25006', 'readonly'],
      ['42501', 'permission'],
      ['42601', 'syntax'],
      ['42P01', 'not_found'],
      ['42703', 'not_found'],
      ['25001', 'unsupported'],
      ['08006', 'connection'],
      ['28P01', 'connection'],
      ['3D000', 'connection'],
      ['23505', 'query'],
    ];
    for (const [code, kind] of cases) {
      const err = toPgDbError(pgError(code));
      expect(err.kind).toBe(kind);
      expect(err.sqlState).toBe(code);
    }
  });

  it('Node network errors and the pool timeout message count as a connection error', () => {
    expect(toPgDbError(pgError('ECONNREFUSED')).kind).toBe('connection');
    expect(toPgDbError(pgError('ECONNREFUSED')).sqlState).toBeUndefined();
    expect(toPgDbError(new Error('timeout exceeded when trying to connect')).kind).toBe(
      'connection',
    );
    expect(isBrokenConnection(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isBrokenConnection(pgError('42601'))).toBe(false);
  });

  it('the message is filtered of credentials and a DbError is passed on unchanged', () => {
    const err = toPgDbError(pgError('28P01', 'auth failed for postgres://dev:hunter@h/app'));
    expect(err.message).not.toContain('hunter');
    const original = new DbError('ambiguous', 'x');
    expect(toPgDbError(original)).toBe(original);
    expect(toPgDbError('plain text').kind).toBe('query');
  });
});
