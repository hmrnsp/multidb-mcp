import { describe, expect, it } from 'vitest';
import { isBrokenConnection, sqlcodeOf, toDb2DbError } from '../../src/adapters/db2/errors.js';
import { DbError } from '../../src/adapters/errors.js';

/** Shape of an ibm_db error: the message holds Db2 text, a negative sqlcode, and the ODBC sqlstate code. */
const db2Error = (sqlcode: number, sqlstate: string, message: string) =>
  Object.assign(new Error(message), { sqlcode, sqlstate, error: '[ibm_db] SQL_ERROR' });

describe('toDb2DbError', () => {
  it('maps SQLCODE to an error kind', () => {
    const cases: [number, string][] = [
      [-952, 'timeout'],
      [-551, 'permission'],
      [-104, 'syntax'],
      [-204, 'not_found'],
      [-206, 'not_found'],
      [-84, 'unsupported'],
      [-30081, 'connection'],
      [-30082, 'connection'],
      [-1598, 'connection'],
      [-803, 'query'],
    ];
    for (const [sqlcode, kind] of cases) {
      expect(toDb2DbError(db2Error(sqlcode, 'HY000', `SQL${-sqlcode}N message`)).kind).toBe(kind);
    }
  });

  it("the real Db2 SQLSTATE is taken from the message, not from ibm_db's ODBC code", () => {
    const err = toDb2DbError(
      db2Error(
        -204,
        '42S02',
        '[IBM][CLI Driver][DB2/LINUXX8664] SQL0204N  "APP.X" is an undefined name.  SQLSTATE=42704\n',
      ),
    );
    expect(err.sqlState).toBe('42704');
    expect(err.message).toBe('SQL0204N "APP.X" is an undefined name. SQLSTATE=42704');
  });

  it('without a sqlcode: the SQLCODE is read from the SQLnnnnN text, then the SQLSTATE class', () => {
    expect(sqlcodeOf(new Error('SQL30081N A communication error'))).toBe(-30081);
    expect(sqlcodeOf(Object.assign(new Error(''), { sqlcode: 0 }))).toBeUndefined();
    expect(toDb2DbError(db2Error(-99999, '08001', 'x SQLSTATE=08001')).kind).toBe('connection');
    expect(toDb2DbError(db2Error(-99999, 'HY000', 'x SQLSTATE=42501')).kind).toBe('permission');
  });

  it('an error without a message still has a message; credentials are filtered; a DbError passes through', () => {
    expect(toDb2DbError(Object.assign(new Error(''), { sqlcode: 0 })).message).toContain(
      'without a message',
    );
    expect(toDb2DbError(new Error('failed: UID=a;PWD=hunter;')).message).not.toContain('hunter');
    const original = new DbError('timeout', 'x');
    expect(toDb2DbError(original)).toBe(original);
  });

  it('isBrokenConnection is only for connection errors', () => {
    expect(isBrokenConnection(db2Error(-30081, '08001', 'SQL30081N'))).toBe(true);
    expect(isBrokenConnection(db2Error(-204, '42S02', 'SQL0204N'))).toBe(false);
  });
});
