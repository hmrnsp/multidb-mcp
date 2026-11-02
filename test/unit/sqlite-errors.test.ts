import { describe, expect, it } from 'vitest';
import { DbError } from '../../src/adapters/errors.js';
import { SQLITE_CHILD_EXIT, SQLITE_TIMEOUT } from '../../src/adapters/sqlite/sqlite-driver.js';
import { isBrokenConnection, toSqliteDbError } from '../../src/adapters/sqlite/errors.js';

const sqliteError = (errcode: number, message: string) =>
  Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });

describe('toSqliteDbError', () => {
  it('maps SQLite result codes (including extended codes) to an error kind', () => {
    const cases: [number, string, string][] = [
      [8, 'attempt to write a readonly database', 'readonly'],
      [264, 'attempt to write a readonly database', 'readonly'], // SQLITE_READONLY_RECOVERY
      [9, 'interrupted', 'timeout'],
      [14, 'unable to open database file', 'connection'],
      [26, 'file is not a database', 'connection'],
      [19, 'UNIQUE constraint failed: customers.email', 'query'],
      [5, 'database is locked', 'query'],
    ];
    for (const [errcode, message, kind] of cases) {
      expect(toSqliteDbError(sqliteError(errcode, message)).kind).toBe(kind);
    }
  });

  it('SQLITE_ERROR (1) is told apart by its message', () => {
    expect(toSqliteDbError(sqliteError(1, 'no such table: x')).kind).toBe('not_found');
    expect(toSqliteDbError(sqliteError(1, 'no such column: y')).kind).toBe('not_found');
    expect(toSqliteDbError(sqliteError(1, 'near "SELEC": syntax error')).kind).toBe('syntax');
    expect(toSqliteDbError(sqliteError(1, 'not authorized')).kind).toBe('permission');
    expect(toSqliteDbError(sqliteError(1, 'too many terms in compound SELECT')).kind).toBe('query');
  });

  it('errors made up by the driver: a timeout and the child process stopping', () => {
    expect(toSqliteDbError(Object.assign(new Error('t'), { code: SQLITE_TIMEOUT })).kind).toBe(
      'timeout',
    );
    const exit = Object.assign(new Error('dead'), { code: SQLITE_CHILD_EXIT });
    expect(toSqliteDbError(exit).kind).toBe('connection');
    expect(isBrokenConnection(exit)).toBe(true);
  });

  it('a DbError is passed on unchanged', () => {
    const original = new DbError('timeout', 'x');
    expect(toSqliteDbError(original)).toBe(original);
  });
});
