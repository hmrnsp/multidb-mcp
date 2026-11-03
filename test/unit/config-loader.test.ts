import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_LIMITS,
  ConfigError,
  DEFAULT_MASK_COLUMNS,
  loadConfig,
  parseConfig,
} from '../../src/config/loader.js';

const env = {
  LOCAL_MYSQL_URL: 'mysql://dev:dev@127.0.0.1:53306/app',
  PROD_DB2_CONN: 'DATABASE=APPDB;HOSTNAME=db2.internal;PORT=50000;UID=mcp_ro;PWD=Hunter!;',
  DEV_PG_URL: 'postgres://dev:dev@127.0.0.1/app',
};

const validConfig = {
  defaults: { maxRows: 200, timeoutSec: 30, maxChars: 40_000 },
  maskColumns: ['Salary'],
  databases: [
    {
      id: 'local_mysql',
      driver: 'mysql',
      env: 'local',
      access: ['delete', 'read', 'insert', 'update'],
      description: 'Laravel application database for development',
      url: '${LOCAL_MYSQL_URL}',
    },
    {
      id: 'prod_db2',
      driver: 'db2',
      env: 'production',
      access: ['read'],
      description: 'Core transaction data, for reports only',
      url: '${PROD_DB2_CONN}',
      maxRows: 500,
      schemas: ['CORE', 'REPORT', 'CORE'],
    },
  ],
};

function parse(config: unknown, environment: NodeJS.ProcessEnv = env) {
  return parseConfig(JSON.stringify(config), { path: 'databases.json', env: environment });
}

/** Run fn and return the ConfigError it throws. */
function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('Expected a ConfigError, but no error was thrown');
}

function withDatabases(...databases: unknown[]) {
  return { databases };
}

const base = {
  id: 'x',
  driver: 'postgres',
  env: 'local',
  access: ['read'],
  description: 'sample description',
  url: '${DEV_PG_URL}',
};

describe('parseConfig: config valid', () => {
  it('produces sources with effective values', () => {
    const config = parse(validConfig);
    expect(config.sources).toHaveLength(2);
    const [mysql, db2] = config.sources;

    expect(mysql?.readonly).toBe(false);
    // Sorted like ACCESS_LEVELS, whatever the order in the config.
    expect(mysql?.access).toEqual(['read', 'insert', 'update', 'delete']);
    expect(mysql?.lazy).toBe(true);
    expect(mysql?.limits).toEqual({ maxRows: 200, timeoutSec: 30, maxChars: 40_000 });
    expect(mysql?.connection.reveal()).toBe(env.LOCAL_MYSQL_URL);

    expect(db2?.readonly).toBe(true);
    expect(db2?.access).toEqual(['read']);
    expect(db2?.limits.maxRows).toBe(500);
    expect(db2?.schemas).toEqual(['CORE', 'REPORT']);
  });

  it('production may write when access allows it; permissions are the same for every env', () => {
    const config = parse(
      withDatabases({
        ...base,
        env: 'production',
        access: ['read', 'update', 'delete'],
        url: '${LOCAL_MYSQL_URL}',
      }),
    );
    expect(config.sources[0]?.access).toEqual(['read', 'update', 'delete']);
    expect(config.sources[0]?.readonly).toBe(false);
  });

  it('built-in limits are used when defaults is absent', () => {
    const config = parse(withDatabases(base));
    expect(config.sources[0]?.limits).toEqual({ ...BUILTIN_LIMITS });
  });

  it('maskColumns adds to the built-in list (lower case, unique)', () => {
    const config = parse(validConfig);
    expect(config.maskColumns).toContain('salary');
    for (const column of DEFAULT_MASK_COLUMNS) expect(config.maskColumns).toContain(column);
  });

  it('credentials do not appear when the config is serialized', () => {
    const config = parse(validConfig);
    expect(JSON.stringify(config)).not.toContain('Hunter!');
  });

  it('a UTF-8 BOM at the start of the file (common on Windows) is accepted', () => {
    const config = parseConfig(`\uFEFF${JSON.stringify(validConfig)}`, { path: 'x', env });
    expect(config.sources).toHaveLength(2);
  });
});

describe('parseConfig: rejected configs', () => {
  it('broken JSON', () => {
    expect(configError(() => parseConfig('{ "databases": [', { path: 'x', env })).message).toMatch(
      /is not valid JSON/,
    );
  });

  it('a mistyped field is not silently ignored', () => {
    const err = configError(() => parse(withDatabases({ ...base, readOnly: true })));
    expect(err.problems.join('\n')).toMatch(/databases\[0\]/);
    expect(err.problems.join('\n')).toMatch(/readOnly/);
  });

  it('invalid and duplicate ids', () => {
    const err = configError(() => parse(withDatabases({ ...base, id: 'Prod-DB' }, base, base)));
    const text = err.problems.join('\n');
    expect(text).toMatch(/databases\[0\]\.id/);
    expect(text).toMatch(/is already used by databases\[1\]/);
  });

  it('driver and env outside the allowed list', () => {
    const err = configError(() => parse(withDatabases({ ...base, driver: 'oracle', env: 'dev' })));
    const text = err.problems.join('\n');
    expect(text).toMatch(/databases\[0\]\.driver/);
    expect(text).toMatch(/databases\[0\]\.env/);
  });

  it('the legacy readonly field is rejected with a message on how to replace it', () => {
    const err = configError(() => parse(withDatabases({ ...base, readonly: true })));
    const text = err.problems.join('\n');
    expect(text).toMatch(/databases\[0\]\.readonly/);
    expect(text).toMatch(/was replaced by access/);
  });

  it('redis: schemas is not used; ddl/call (and call for sqlite) do not apply', () => {
    const redis = { ...base, driver: 'redis', url: 'redis://127.0.0.1:6379/0' };
    const err = configError(() =>
      parse(
        withDatabases(
          { ...redis, id: 'a', schemas: ['x'] },
          { ...redis, id: 'b', access: ['read', 'ddl'] },
          { ...base, id: 'c', driver: 'sqlite', url: 'sqlite:./a.db', access: ['read', 'call'] },
        ),
      ),
    );
    const text = err.problems.join('\n');
    expect(text).toMatch(/databases\[0\]\.schemas: not used for redis/);
    expect(text).toMatch(/databases\[1\]\.access: ddl does not apply to redis/);
    expect(text).toMatch(/databases\[2\]\.access: call does not apply to sqlite/);
  });

  it('sqlite does not use schemas', () => {
    const err = configError(() =>
      parse(
        withDatabases({ ...base, driver: 'sqlite', url: 'sqlite:./app.db', schemas: ['main'] }),
      ),
    );
    expect(err.problems.join('\n')).toMatch(/databases\[0\]\.schemas: not used for sqlite/);
  });

  it('access is required, must contain read, and values must be known and not repeated', () => {
    const withoutAccess: Record<string, unknown> = { ...base };
    delete withoutAccess.access;
    const cases: [unknown, RegExp][] = [
      [withoutAccess, /access: required/],
      [{ ...base, access: 'read' }, /access: must be a list/],
      [{ ...base, access: [] }, /"read" is required/],
      [{ ...base, access: ['insert'] }, /"read" is required/],
      [
        { ...base, access: ['read', 'updte'] },
        /access\[1\]: unknown value; choose from: read, insert/,
      ],
      [{ ...base, access: ['read', 'read'] }, /a value is listed twice/],
    ];
    for (const [entry, expected] of cases) {
      expect(configError(() => parse(withDatabases(entry))).problems.join('\n')).toMatch(expected);
    }
  });

  it('a literal password is rejected in every env, local included', () => {
    const literal = 'postgres://ro:hunter@db.internal/app';
    for (const environment of ['local', 'staging', 'production']) {
      const err = configError(() =>
        parse(withDatabases({ ...base, env: environment, url: literal })),
      );
      expect(err.problems.join('\n')).toMatch(/password is written directly/);
      expect(err.message).not.toContain('hunter');
    }
  });

  it('missing environment variables are all reported at once', () => {
    const err = configError(() =>
      parse(
        withDatabases(
          { ...base, id: 'a', url: '${TIDAK_ADA_1}' },
          { ...base, id: 'b', url: 'postgres://u:${TIDAK_ADA_2}@h/db' },
        ),
      ),
    );
    expect(err.problems).toHaveLength(2);
    expect(err.message).toMatch(/TIDAK_ADA_1/);
    expect(err.message).toMatch(/TIDAK_ADA_2/);
  });

  it('limits out of range and an empty databases list', () => {
    expect(
      configError(() => parse(withDatabases({ ...base, maxRows: 0 }))).problems.join(),
    ).toMatch(/maxRows/);
    expect(
      configError(() => parse(withDatabases({ ...base, timeoutSec: 1.5 }))).problems.join(),
    ).toMatch(/timeoutSec/);
    expect(configError(() => parse({ databases: [] })).problems.join()).toMatch(
      /at least one connection/,
    );
  });
});

describe('loadConfig', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads a file from disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'multidb-'));
    const file = join(dir, 'databases.json');
    writeFileSync(file, JSON.stringify(validConfig));
    const config = loadConfig(file, env);
    expect(config.path).toBe(file);
    expect(config.sources.map((s) => s.id)).toEqual(['local_mysql', 'prod_db2']);
  });

  it('a missing file gives a clear message', () => {
    expect(configError(() => loadConfig(join(tmpdir(), 'not-here-123.json'), env)).message).toMatch(
      /Config file not found/,
    );
  });
});
