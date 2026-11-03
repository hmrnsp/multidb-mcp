import { describe, expect, it } from 'vitest';
import { isValidHost } from '../../src/config/connection.js';
import { ConfigError, parseConfig } from '../../src/config/loader.js';

const env = {
  DB_PASSWORD: 'p@ss:w/rd#1',
  REDIS_PASSWORD: 'r3dis',
  DB_HOST: 'db.internal',
  PG_URL: 'postgres://u:p@h/db',
};

function resolved(entry: Record<string, unknown>, vars: NodeJS.ProcessEnv = env) {
  const config = parseConfig(
    JSON.stringify({
      databases: [
        { id: 'x', env: 'local', access: ['read'], description: 'test connection', ...entry },
      ],
    }),
    { path: '/proj/databases.json', env: vars },
  );
  return config.sources[0]!.connection.reveal();
}

function problems(entry: Record<string, unknown>, vars: NodeJS.ProcessEnv = env): string {
  try {
    resolved(entry, vars);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems.join('\n');
    throw err;
  }
  throw new Error('expected a ConfigError');
}

const pg = { driver: 'postgres', password: '${DB_PASSWORD}' };

describe('separate connection fields', () => {
  it('postgres: builds a URL, encodes the password, and uses the default port', () => {
    expect(resolved({ ...pg, host: '${DB_HOST}', database: 'app', user: 'dev' })).toBe(
      'postgres://dev:p%40ss%3Aw%2Frd%231@db.internal:5432/app',
    );
  });

  it('mysql and mariadb: mysql:// with the default port 3306 and an explicit port', () => {
    const mysql = { password: '${REDIS_PASSWORD}', user: 'u', database: 'd' };
    expect(resolved({ driver: 'mysql', host: 'h', ...mysql })).toBe('mysql://u:r3dis@h:3306/d');
    expect(resolved({ driver: 'mariadb', host: 'h', port: 3307, user: 'u', database: 'd' })).toBe(
      'mysql://u@h:3307/d',
    );
  });

  it('redis: database number and no user', () => {
    expect(
      resolved({ driver: 'redis', host: 'cache', password: '${REDIS_PASSWORD}', database: 2 }),
    ).toBe('redis://:r3dis@cache:6379/2');
  });

  it('an IPv6 host gets brackets in the URL', () => {
    expect(resolved({ ...pg, host: '::1', user: 'u', database: 'd' })).toContain('@[::1]:5432/d');
  });

  it('db2: keyword connection string', () => {
    expect(
      resolved({
        driver: 'db2',
        host: 'db2.local',
        database: 'APPDB',
        user: 'mcp',
        password: '${REDIS_PASSWORD}',
      }),
    ).toBe('DATABASE=APPDB;HOSTNAME=db2.local;PORT=50000;PROTOCOL=TCPIP;UID=mcp;PWD=r3dis;');
  });

  it('sqlite: file', () => {
    expect(resolved({ driver: 'sqlite', file: './db/app.sqlite' })).toBe('sqlite:./db/app.sqlite');
  });

  it('url still works, with ${VAR} for the secret part', () => {
    expect(resolved({ driver: 'postgres', url: '${PG_URL}' })).toBe('postgres://u:p@h/db');
    expect(resolved({ driver: 'postgres', url: 'postgres://u:${REDIS_PASSWORD}@h/db' })).toBe(
      'postgres://u:r3dis@h/db',
    );
  });
});

describe('host validation (injection)', () => {
  it('accepts host names and IP addresses', () => {
    for (const host of ['db', 'db.internal', 'a-b.c1.example.com', '127.0.0.1', '::1', 'fe80::1']) {
      expect(isValidHost(host), host).toBe(true);
    }
  });

  it('rejects anything that could change the meaning of a URL', () => {
    const bad = [
      'a/b',
      'h?x=1',
      'u@h',
      'h#f',
      'h h',
      'h:5432',
      'evil.com/db?sslmode=disable',
      '-h',
      'h.',
      '',
      'h\nx',
    ];
    for (const host of bad) expect(isValidHost(host), JSON.stringify(host)).toBe(false);
  });

  it('a bad host fails the config without printing the value', () => {
    const text = problems({ ...pg, host: 'evil.com/db?sslmode=disable', user: 'u' });
    expect(text).toContain('host must be a host name or an IP address');
    expect(text).not.toContain('evil.com');
  });

  it('a bad host that comes from an environment variable is rejected too', () => {
    const text = problems({ ...pg, host: '${EVIL_HOST}', user: 'u' }, { ...env, EVIL_HOST: 'a@b' });
    expect(text).toContain('host must be a host name');
    expect(text).not.toContain('a@b');
  });

  it('control characters are refused in every field', () => {
    const variables = { ...env, BAD: 'x\r\ny' };
    expect(problems({ ...pg, host: 'h', user: '${BAD}' }, variables)).toContain(
      'user contains a control character',
    );
    expect(problems({ ...pg, host: 'h', database: '${BAD}' }, variables)).toContain(
      'database contains a control character',
    );
    expect(problems({ driver: 'sqlite', file: '${BAD}' }, variables)).toContain(
      'file contains a control character',
    );
  });

  it('db2: a ";" in a value is refused with a hint', () => {
    const text = problems({
      driver: 'db2',
      host: 'h',
      database: 'D',
      user: 'u;x',
      password: '${DB_PASSWORD}',
    });
    expect(text).toContain('cannot hold');
    expect(text).not.toContain('u;x');
  });
});

describe('separate connection fields: rejected configs', () => {
  it('url together with separate fields', () => {
    expect(problems({ driver: 'postgres', url: 'postgres://h/d', host: 'h' })).toContain(
      'either url or separate fields',
    );
  });

  it('neither url nor host', () => {
    expect(problems({ driver: 'postgres', user: 'u' })).toContain('host: required');
  });

  it('sqlite needs file; network fields and file are checked per driver', () => {
    expect(problems({ driver: 'sqlite', host: 'h' })).toContain('required for sqlite');
    expect(problems({ driver: 'postgres', host: 'h', file: 'x' })).toContain(
      'only used for sqlite',
    );
    expect(problems({ driver: 'redis', host: 'h', database: 'abc' })).toContain('database number');
  });

  it('a missing variable names the field and the variable', () => {
    const text = problems({ driver: 'postgres', host: 'h', password: '${NOPE_PW}' });
    expect(text).toContain('used in password');
    expect(text).toContain('NOPE_PW');
  });

  it('limits the length of the fields', () => {
    expect(problems({ ...pg, host: 'a'.repeat(300) })).toContain('at most 253 characters');
    expect(problems({ ...pg, host: 'h', user: 'u'.repeat(200) })).toContain('at most 128');
  });
});

describe('a password is never written in the config', () => {
  const literal = { driver: 'postgres', host: 'h', user: 'u', password: 'hunter' };

  it('is rejected in every env, local included, and is not echoed', () => {
    for (const environment of ['local', 'staging', 'production']) {
      const text = problems({ ...literal, env: environment });
      expect(text).toContain('the password is written directly');
      expect(text).not.toContain('hunter');
    }
  });

  it('is rejected when only part of the password is a variable', () => {
    expect(problems({ ...literal, password: 'pre${DB_PASSWORD}' })).toContain('written directly');
  });

  it('is rejected inside url for every env, local included', () => {
    for (const environment of ['local', 'production']) {
      const text = problems({
        driver: 'postgres',
        env: environment,
        url: 'postgres://u:hunter@h/db',
      });
      expect(text).toContain('written directly');
      expect(text).not.toContain('hunter');
    }
  });

  it('a user name without a password is fine (for example a trusted local socket setup)', () => {
    expect(resolved({ driver: 'postgres', host: 'h', user: 'u' })).toBe('postgres://u@h:5432');
  });
});
