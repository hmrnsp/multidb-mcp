import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Secret } from '../../src/config/secret.js';
import { createLogger, sanitize } from '../../src/observability/logger.js';

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = [];
  const log = createLogger({
    level,
    write: (line) => lines.push(line),
    now: () => new Date('2026-11-01T00:00:00Z'),
  });
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { log, lines, records };
}

describe('logger', () => {
  it('writes JSON Lines with time, level, message, and fields', () => {
    const { log, lines, records } = capture();
    log.info('server ready', { connections: ['a', 'b'] });
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(records()[0]).toEqual({
      ts: '2026-11-01T00:00:00.000Z',
      level: 'info',
      msg: 'server ready',
      connections: ['a', 'b'],
    });
  });

  it('respects the minimum level', () => {
    const { log, records } = capture('warn');
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(records().map((r) => r.msg)).toEqual(['c', 'd']);
  });

  it('child adds fixed fields', () => {
    const { log, records } = capture();
    log.child({ component: 'registry' }).child({ db: 'prod_db2' }).info('x');
    expect(records()[0]).toMatchObject({ component: 'registry', db: 'prod_db2' });
  });

  it('never prints credentials', () => {
    const { log, lines } = capture();
    log.error('failed to connect to postgres://u:hunter1@h/db', {
      password: 'hunter2',
      token: 'hunter3',
      connection: new Secret('DATABASE=X;PWD=hunter4;'),
      detail: 'UID=a;PWD=hunter5;',
      error: new Error('auth failed: mysql://root:hunter6@db/app'),
      nested: { deep: { apiKey: 'hunter7' } },
    });
    const text = lines.join('');
    for (let i = 1; i <= 7; i += 1) expect(text).not.toContain(`hunter${i}`);
  });

  it('sanitize: special types', () => {
    expect(sanitize(10n)).toBe('10');
    expect(sanitize(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(sanitize('x'.repeat(2_100))).toMatch(/\.\.\.\[\+100\]$/);
    expect(sanitize({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({
      a: { b: { c: { d: '[...]' } } },
    });
  });

  it('also writes to a file when asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'multidb-log-'));
    try {
      const file = join(dir, 'sub', 'mcp.log');
      const log = createLogger({ filePath: file, write: () => undefined });
      log.info('ke file');
      expect(readFileSync(file, 'utf8')).toMatch(/"msg":"ke file"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
