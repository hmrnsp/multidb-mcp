import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  parseMysqlUrl,
  runStatement,
  type RawConnection,
} from '../../src/adapters/mysql/mysql-driver.js';

describe('parseMysqlUrl', () => {
  it('splits a URL into mysql2 options, including an encoded password', () => {
    expect(parseMysqlUrl('mysql://dev:p%40ss%3Aw@127.0.0.1:53306/app')).toEqual({
      host: '127.0.0.1',
      port: 53306,
      user: 'dev',
      password: 'p@ss:w',
      database: 'app',
    });
    expect(parseMysqlUrl('mariadb://u:p@[::1]/db')).toMatchObject({ host: '::1', port: 3306 });
    expect(parseMysqlUrl('mysql://u:p@h')).not.toHaveProperty('database');
  });

  it('only the ssl and charset parameters are accepted', () => {
    expect(
      parseMysqlUrl('mysql://u:p@h/db?ssl={"rejectUnauthorized":true}&charset=utf8mb4'),
    ).toMatchObject({ ssl: { rejectUnauthorized: true }, charset: 'utf8mb4' });
    for (const param of ['multipleStatements=true', 'flags=LOCAL_FILES', 'debug=true']) {
      expect(() => parseMysqlUrl(`mysql://u:hunter@h/db?${param}`)).toThrow(/not supported/);
    }
  });

  it('an invalid URL or another scheme: a message without credentials', () => {
    expect(() => parseMysqlUrl('not a url hunter')).toThrow(/Invalid/);
    try {
      parseMysqlUrl('postgres://u:hunter@h/db');
      throw new Error('should have failed');
    } catch (err) {
      expect((err as Error).message).toContain('mysql://');
      expect((err as Error).message).not.toContain('hunter');
    }
  });
});

/** A fake mysql2 connection: every query returns a command (EventEmitter) that the test controls. */
class FakeRaw extends EventEmitter {
  threadId = 9;
  command = new EventEmitter();
  calls: string[] = [];
  unprepared: unknown[] = [];
  destroyed = false;

  query(options: { sql: string }) {
    this.calls.push(`query ${options.sql}`);
    return this.command;
  }
  execute(options: { sql: string }, values: unknown[]) {
    this.calls.push(`execute ${options.sql} ${JSON.stringify(values)}`);
    return this.command;
  }
  unprepare(options: unknown) {
    this.unprepared.push(options);
  }
  reset(callback: (err: Error | null) => void) {
    callback(null);
  }
  release() {}
  destroy() {
    this.destroyed = true;
  }
}

function raw(): FakeRaw & RawConnection {
  return new FakeRaw();
}

function emitRows(conn: FakeRaw, n: number) {
  conn.command.emit('fields', [{ name: 'id' }, { name: 'name' }], 0);
  for (let i = 0; i < n; i += 1) conn.command.emit('result', [i, `b${i}`], 0);
}

describe('runStatement', () => {
  it('without parameters: text protocol, the SQL is sent as is', async () => {
    const conn = raw();
    const pending = runStatement(conn, "SELECT '?'", [], 10, 'abort');
    emitRows(conn, 2);
    conn.command.emit('end');
    const result = await pending;
    expect(conn.calls).toEqual(["query SELECT '?'"]);
    expect(result).toEqual({
      fields: ['id', 'name'],
      rows: [
        [0, 'b0'],
        [1, 'b1'],
      ],
      affectedRows: null,
      aborted: false,
    });
    expect(conn.unprepared).toEqual([]);
  });

  it('with parameters: a prepared statement closed with the same cache key', async () => {
    const conn = raw();
    const pending = runStatement(conn, 'SELECT ?', [1], 10, 'abort');
    emitRows(conn, 1);
    conn.command.emit('end');
    await pending;
    expect(conn.calls).toEqual(['execute SELECT ? [1]']);
    expect(conn.unprepared).toEqual([{ sql: 'SELECT ?', rowsAsArray: true }]);
  });

  it('abort: stops at maxRows+1, the connection is dropped, the error afterwards is ignored', async () => {
    const conn = raw();
    const pending = runStatement(conn, 'SELECT ?', [1], 3, 'abort');
    emitRows(conn, 10);
    conn.command.emit('error', new Error('Connection lost'));
    const result = await pending;
    expect(result.rows).toHaveLength(4);
    expect(result.aborted).toBe(true);
    expect(conn.destroyed).toBe(true);
    // The connection is already gone: the statement is closed on the server too, no unprepare needed.
    expect(conn.unprepared).toEqual([]);
    expect(conn.listenerCount('error')).toBe(1);
  });

  it('drain: excess rows are discarded until the end, the connection is not dropped', async () => {
    const conn = raw();
    const pending = runStatement(conn, 'DELETE FROM t RETURNING id', [], 3, 'drain');
    emitRows(conn, 10);
    conn.command.emit('end');
    const result = await pending;
    expect(result.rows).toHaveLength(4);
    expect(result.aborted).toBe(false);
    expect(conn.destroyed).toBe(false);
  });

  it('DML: affectedRows from the result header; a following result set (CALL) is ignored', async () => {
    const conn = raw();
    const pending = runStatement(conn, 'UPDATE t SET a = 1', [], 10, 'drain');
    conn.command.emit('fields', undefined);
    conn.command.emit('result', { affectedRows: 5, fieldCount: 0 });
    conn.command.emit('result', [1, 'second set'], 1);
    conn.command.emit('end');
    expect(await pending).toEqual({ fields: [], rows: [], affectedRows: 5, aborted: false });
  });

  it('error: rejected, and the prepared statement is still closed', async () => {
    const conn = raw();
    const pending = runStatement(conn, 'SELECT ?', ['x'], 10, 'abort');
    conn.command.emit('error', Object.assign(new Error('syntax'), { errno: 1064 }));
    await expect(pending).rejects.toThrow('syntax');
    expect(conn.unprepared).toHaveLength(1);
  });
});
