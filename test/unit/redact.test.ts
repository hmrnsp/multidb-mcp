import { describe, expect, it } from 'vitest';
import { Secret } from '../../src/config/secret.js';
import { redact, redactForClient } from '../../src/observability/redact.js';

describe('redact', () => {
  it('masks PWD and PASSWORD in the Db2/ODBC keyword format', () => {
    const out = redact(
      'DATABASE=APPDB;HOSTNAME=db2.internal;PORT=50000;UID=mcp_ro;PWD=Hunter!123;',
    );
    expect(out).not.toContain('Hunter');
    expect(out).toContain('PWD=***;');
    expect(out).toContain('UID=mcp_ro');
    expect(redact('uid=a;pwd=xyz')).toBe('uid=a;pwd=***');
    expect(redact('User=a;Password=p;Host=h')).toBe('User=a;Password=***;Host=h');
  });

  it('masks the password in a URL', () => {
    expect(redact('postgres://dev:dev@127.0.0.1:55432/app')).toBe(
      'postgres://dev:***@127.0.0.1:55432/app',
    );
    expect(redact('mysql://u:p@ss:w@rd@db.example.com/app')).toBe(
      'mysql://u:***@db.example.com/app',
    );
  });

  it('masks the ?password= parameter', () => {
    expect(redact('postgres://db/app?user=a&password=s3cret&ssl=true')).toBe(
      'postgres://db/app?user=a&password=***&ssl=true',
    );
  });

  it('masks a connection string inside an error message', () => {
    expect(redact('connect ECONNREFUSED for postgres://dev:topsecret@10.0.0.5/app')).not.toContain(
      'topsecret',
    );
  });

  it('an empty value becomes an empty string', () => {
    expect(redact(undefined)).toBe('');
    expect(redact(null)).toBe('');
  });
});

describe('Secret', () => {
  it('does not leak through String, template, JSON, and inspect', async () => {
    const secret = new Secret('postgres://u:hunter@h/db');
    const { inspect } = await import('node:util');
    expect(String(secret)).not.toContain('hunter');
    expect(`${secret.toString()}`).not.toContain('hunter');
    expect(JSON.stringify({ secret })).not.toContain('hunter');
    expect(inspect({ secret })).not.toContain('hunter');
    expect(secret.reveal()).toBe('postgres://u:hunter@h/db');
  });
});

describe('redactForClient', () => {
  it('hides the host and port in a Node network error', () => {
    expect(redactForClient('connect ECONNREFUSED 127.0.0.1:55432')).toBe(
      'connect ECONNREFUSED <host>',
    );
    expect(redactForClient('getaddrinfo ENOTFOUND db.office.internal')).toBe(
      'getaddrinfo ENOTFOUND <host>',
    );
    expect(redactForClient('connect EHOSTUNREACH 10.0.0.5:3306 - Local (0.0.0.0:0)')).toBe(
      'connect EHOSTUNREACH <host>',
    );
  });

  it('hides the host, user, and password in a URL and connection string', () => {
    const out = redactForClient('failed: postgres://dev:hunter@10.0.0.5:5432/app?ssl=true');
    expect(out).toBe('failed: postgres://<host>/app?ssl=true');
    const db2 = redactForClient('HOSTNAME=db2.internal;PORT=50000;UID=mcp_ro;PWD=x;');
    for (const leak of ['db2.internal', '50000', 'mcp_ro']) expect(db2).not.toContain(leak);
  });

  it('hides the user name and host in an authentication message', () => {
    expect(redactForClient('password authentication failed for user "dev"')).toBe(
      "password authentication failed for user '***'",
    );
    expect(
      redactForClient("Access denied for user 'mcp_ro'@'172.18.0.1' (using password: YES)"),
    ).toBe("Access denied for user '***' (using password: YES)");
  });
});
