import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devDb2Conn, devUrl } from '../../scripts/lib/dev-connections.mjs';

const VARIABLES = [
  'PG_LOCAL_PASSWORD',
  'MYSQL_LOCAL_PASSWORD',
  'MARIADB_LOCAL_PASSWORD',
  'REDIS_LOCAL_PASSWORD',
  'DB2_LOCAL_PASSWORD',
] as const;
const KINDS = ['postgres', 'mysql', 'mariadb', 'redis'] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
});
afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('dev-connections', () => {
  it('returns nothing until the read-write password is set, so tests skip themselves', () => {
    for (const kind of KINDS) {
      expect(devUrl(kind)).toBe('');
      expect(devUrl(kind, 'ro')).toBe('');
    }
    expect(devDb2Conn()).toBe('');
  });

  it('builds a URL from the password, encoding characters that would break it', () => {
    process.env.PG_LOCAL_PASSWORD = 'p@ss:w/rd#1';
    expect(devUrl('postgres')).toBe('postgres://dev:p%40ss%3Aw%2Frd%231@127.0.0.1:55432/app');
  });

  it('the read-only user always uses the fixed fixture password, never the .env one', () => {
    process.env.MYSQL_LOCAL_PASSWORD = 'something-else';
    const url = devUrl('mysql', 'ro');
    expect(url).toBe('mysql://mcp_ro:mcp_ro@127.0.0.1:53306/app');
    expect(url).not.toContain('something-else');
  });

  it('only ever addresses 127.0.0.1', () => {
    for (const name of VARIABLES) process.env[name] = 'x';
    const all = [...KINDS.flatMap((kind) => [devUrl(kind), devUrl(kind, 'ro')]), devDb2Conn()];
    for (const text of all) {
      expect(text).not.toBe('');
      expect(text).toMatch(/127\.0\.0\.1/);
      expect(text).not.toMatch(/localhost|\b10\.|192\.168|\.internal/);
    }
  });

  it('db2: a connection string for the local container', () => {
    process.env.DB2_LOCAL_PASSWORD = 'db2pw';
    expect(devDb2Conn()).toBe(
      'DATABASE=APPDB;HOSTNAME=127.0.0.1;PORT=55000;PROTOCOL=TCPIP;UID=db2inst1;PWD=db2pw;',
    );
  });
});
