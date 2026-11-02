import { describe, expect, it } from 'vitest';
import { readCursor, type RawCursor } from '../../src/adapters/postgres/pg-driver.js';

type ReadCallback = Parameters<RawCursor['read']>[1];

function fakeCursor(respond: (cb: ReadCallback) => void, internal?: RawCursor['_result']) {
  const calls = { read: [] as number[], closed: 0 };
  const cursor: RawCursor = {
    _result: internal,
    read: (n, cb) => {
      calls.read.push(n);
      respond(cb);
    },
    close: (cb) => {
      calls.closed += 1;
      cb();
    },
  };
  return { cursor, calls };
}

describe('readCursor', () => {
  it('uses metadata from the third callback argument, then closes the cursor', async () => {
    const { cursor, calls } = fakeCursor((cb) =>
      cb(undefined, [[1, 'a']], {
        fields: [{ name: 'id' }, { name: 'name' }],
        rowCount: 1,
        command: 'SELECT',
      }),
    );
    const result = await readCursor(cursor, 201);
    expect(result).toEqual({
      fields: ['id', 'name'],
      rows: [[1, 'a']],
      rowCount: 1,
      command: 'SELECT',
    });
    expect(calls.read).toEqual([201]);
    expect(calls.closed).toBe(1);
  });

  it('fallback: metadata from the cursor internal state', async () => {
    const { cursor } = fakeCursor((cb) => cb(undefined, [[1]]), {
      fields: [{ name: 'n' }],
      rowCount: 1,
    });
    expect((await readCursor(cursor, 10)).fields).toEqual(['n']);
  });

  it('last fallback: column_N names so the result does not appear without a header', async () => {
    const { cursor } = fakeCursor((cb) => cb(undefined, [[1, 2, 3]]));
    expect((await readCursor(cursor, 10)).fields).toEqual(['column_1', 'column_2', 'column_3']);
  });

  it('a command without a result: empty columns and rowCount from CommandComplete', async () => {
    const { cursor } = fakeCursor((cb) =>
      cb(undefined, [], { fields: [], rowCount: 3, command: 'UPDATE' }),
    );
    expect(await readCursor(cursor, 10)).toEqual({
      fields: [],
      rows: [],
      rowCount: 3,
      command: 'UPDATE',
    });
  });

  it('error: rejected without calling close', async () => {
    const { cursor, calls } = fakeCursor((cb) => cb(new Error('syntax error'), []));
    await expect(readCursor(cursor, 10)).rejects.toThrow(/syntax error/);
    expect(calls.closed).toBe(0);
  });
});
