import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.js';

/**
 * Audit log: one JSON line per tool call, in <dir>/audit-YYYY-MM-DD.jsonl.
 *
 * - Date and time use the local time zone; a new file is created every day.
 * - Files older than keepDays are deleted when the new day's file is opened (0 = never).
 * - It never stores params values, result rows, or Redis values: only the SQL text
 *   (passed through redact) or the Redis command name with its keys.
 * - A write failure does not fail the tool: auditing is switched off and the reason is logged once.
 */

export type AuditOutcome = 'ok' | 'rejected' | 'error';

/** One audit record: what was called, on which connection, and how it ended. */
export interface AuditEntry {
  tool: string;
  db?: string | undefined;
  env?: string | undefined;
  outcome: AuditOutcome;
  /** The guard rule that rejected the call, or the kind of error. */
  reason?: string | undefined;
  sql?: string | undefined;
  paramCount?: number | undefined;
  statement?: string | undefined;
  /** The table opened by describe_table. */
  table?: string | undefined;
  command?: string | undefined;
  keys?: string[] | undefined;
  rows?: number | undefined;
  truncated?: boolean | undefined;
  affectedRows?: number | undefined;
  masked?: boolean | undefined;
  /** true when the operation was repeated once after the connection dropped. */
  retried?: boolean | undefined;
  durationMs: number;
}

/** Details filled in by the tool while it runs; the rest is filled in by the wrapper in server.ts. */
export type AuditTrace = Partial<Omit<AuditEntry, 'tool' | 'db' | 'env' | 'durationMs'>>;

/** Writes audit records. */
export interface AuditLog {
  record(entry: AuditEntry): void;
}

/** An audit log that records nothing. */
export const NO_AUDIT: AuditLog = { record: () => undefined };

/** Options for {@link createAuditLog}. */
export interface AuditOptions {
  dir: string;
  /** Keep files for this many days; 0 = never delete. */
  keepDays: number;
  now?: () => Date;
  onError: (message: string, fields: Record<string, unknown>) => void;
}

const FILE_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_SQL = 4_000;
const DAY_MS = 86_400_000;

const pad = (value: number) => String(value).padStart(2, '0');

/** Format a date as YYYY-MM-DD in the local time zone. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ISO 8601 with the local time zone offset, e.g. 2026-11-03T09:12:44+08:00. */
export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${localDate(date)}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Create an audit log that appends to daily files and deletes old ones. */
export function createAuditLog(options: AuditOptions): AuditLog {
  const now = options.now ?? (() => new Date());
  let currentDay = '';
  let broken = false;

  const prune = (at: Date) => {
    if (options.keepDays <= 0) return;
    const cutoff = localDate(new Date(at.getTime() - options.keepDays * DAY_MS));
    try {
      for (const name of readdirSync(options.dir)) {
        const day = FILE_PATTERN.exec(name)?.[1];
        if (day !== undefined && day < cutoff) unlinkSync(join(options.dir, name));
      }
    } catch (err) {
      options.onError('failed to delete old audit logs', { dir: options.dir, error: err });
    }
  };

  return {
    record(entry) {
      if (broken) return;
      const at = now();
      const day = localDate(at);
      try {
        if (day !== currentDay) {
          mkdirSync(options.dir, { recursive: true });
          currentDay = day;
          prune(at);
        }
        const record: AuditEntry & { ts: string } = { ts: localIso(at), ...entry };
        if (entry.sql !== undefined) {
          record.sql = redact(
            entry.sql.length > MAX_SQL
              ? `${entry.sql.slice(0, MAX_SQL)}...[+${entry.sql.length - MAX_SQL}]`
              : entry.sql,
          );
        }
        appendFileSync(join(options.dir, `audit-${day}.jsonl`), `${JSON.stringify(record)}\n`, {
          mode: 0o600,
        });
      } catch (err) {
        broken = true;
        options.onError('audit log disabled: write failed', { dir: options.dir, error: err });
      }
    },
  };
}
