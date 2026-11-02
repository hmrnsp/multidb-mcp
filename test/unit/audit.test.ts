import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuditLog, localDate, localIso } from '../../src/observability/audit.js';

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'multidb-audit-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const read = (dir: string, day: string) =>
  readFileSync(join(dir, `audit-${day}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('local time', () => {
  it('localIso uses the local date and the time zone offset', () => {
    const date = new Date('2026-11-03T01:12:44Z');
    const iso = localIso(date);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(iso.slice(0, 10)).toBe(localDate(date));
    expect(new Date(iso).getTime()).toBe(date.getTime());
  });
});

describe('audit log', () => {
  it('one JSON line per call; SQL is redacted and truncated', () => {
    const dir = tempDir();
    const now = new Date('2026-11-03T09:00:00');
    const audit = createAuditLog({ dir, keepDays: 90, now: () => now, onError: () => undefined });
    audit.record({
      tool: 'execute_sql',
      db: 'prod_db2',
      env: 'production',
      outcome: 'ok',
      sql: `SELECT 'postgres://u:hunter@h/db' ${'x'.repeat(5_000)}`,
      paramCount: 1,
      rows: 1,
      durationMs: 84,
    });
    audit.record({
      tool: 'execute_sql',
      db: 'prod_db2',
      outcome: 'rejected',
      reason: 'readonly',
      durationMs: 0,
    });
    const [first, second] = read(dir, '2026-11-03');
    expect(first).toMatchObject({ tool: 'execute_sql', db: 'prod_db2', paramCount: 1, rows: 1 });
    expect(first?.ts).toBe(localIso(now));
    // Field order follows the entry; sql does not move to the end of the line.
    expect(Object.keys(first ?? {})).toEqual([
      'ts',
      'tool',
      'db',
      'env',
      'outcome',
      'sql',
      'paramCount',
      'rows',
      'durationMs',
    ]);
    expect(String(first?.sql)).toContain('u:***@h');
    expect(String(first?.sql)).not.toContain('hunter');
    expect(String(first?.sql)).toMatch(/\.\.\.\[\+\d+\]$/);
    expect(second).toEqual({
      ts: localIso(now),
      tool: 'execute_sql',
      db: 'prod_db2',
      outcome: 'rejected',
      reason: 'readonly',
      durationMs: 0,
    });
  });

  it('a new file every day; files older than keepDays are deleted', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'audit-2026-07-01.jsonl'), '{}\n');
    writeFileSync(join(dir, 'audit-2026-10-20.jsonl'), '{}\n');
    writeFileSync(join(dir, 'notes.txt'), 'not an audit file');
    let now = new Date('2026-11-03T23:59:00');
    const audit = createAuditLog({ dir, keepDays: 30, now: () => now, onError: () => undefined });
    audit.record({ tool: 'list_databases', outcome: 'ok', durationMs: 1 });
    now = new Date('2026-11-04T00:01:00');
    audit.record({ tool: 'list_databases', outcome: 'ok', durationMs: 1 });
    expect(readdirSync(dir).sort()).toEqual([
      'audit-2026-10-20.jsonl',
      'audit-2026-11-03.jsonl',
      'audit-2026-11-04.jsonl',
      'notes.txt',
    ]);
  });

  it('keepDays 0: no file is deleted', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'audit-2020-01-01.jsonl'), '{}\n');
    const audit = createAuditLog({ dir, keepDays: 0, onError: () => undefined });
    audit.record({ tool: 'list_databases', outcome: 'ok', durationMs: 1 });
    expect(readdirSync(dir)).toContain('audit-2020-01-01.jsonl');
  });

  it('write failure: auditing is switched off, logged once, and the tool keeps working', () => {
    const dir = tempDir();
    const blocked = join(dir, 'not-a-folder');
    writeFileSync(blocked, 'plain file');
    const errors: string[] = [];
    const audit = createAuditLog({
      dir: blocked,
      keepDays: 90,
      onError: (message) => errors.push(message),
    });
    expect(() => {
      audit.record({ tool: 'list_databases', outcome: 'ok', durationMs: 1 });
      audit.record({ tool: 'list_databases', outcome: 'ok', durationMs: 1 });
    }).not.toThrow();
    expect(errors).toEqual(['audit log disabled: write failed']);
  });
});
