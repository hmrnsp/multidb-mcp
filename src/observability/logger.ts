import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Secret } from '../config/secret.js';
import { redact } from './redact.js';

/**
 * Lightweight JSON Lines logger.
 *
 * - Writes to STDERR by default. stdout belongs to the MCP protocol and is never touched.
 * - Optionally also to a file (--log-file).
 * - Every value is sanitized: fields named password/secret/token are hidden,
 *   free text passes through redact(), and Secret objects only appear as "[secret]".
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
/** A log severity. */
export type LogLevel = (typeof LOG_LEVELS)[number];
/** Structured fields attached to a log record. */
export type LogFields = Record<string, unknown>;

/** A structured logger. Every value passes through redaction before it is written. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  level?: LogLevel;
  /** Path of an additional log file (JSON Lines). */
  filePath?: string | undefined;
  /** Main destination. Default: process.stderr. */
  write?: (line: string) => void;
  now?: () => Date;
}

const SECRET_KEY = /^(password|passwd|pwd|secret|token|api[_-]?key|authorization)$/i;
const MAX_STRING = 2_000;
const MAX_DEPTH = 4;

function truncate(text: string): string {
  return text.length > MAX_STRING
    ? `${text.slice(0, MAX_STRING)}...[+${text.length - MAX_STRING}]`
    : text;
}

/** Turn any value into a form that is safe for the JSON log. */
export function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (value === null || value === undefined) return value;
  if (value instanceof Secret) return '[secret]';
  if (typeof value === 'string') return truncate(redact(value));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: truncate(redact(value.message)),
    };
    const code = (value as NodeJS.ErrnoException).code;
    if (code !== undefined) out.code = code;
    if (value.stack) out.stack = redact(value.stack.split('\n').slice(0, 6).join('\n'));
    return out;
  }
  if (depth >= MAX_DEPTH) return '[...]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, '', depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, k, depth + 1);
    return out;
  }
  return typeof value === 'function' ? '[function]' : '[unknown]';
}

function fileWriter(path: string, fallback: (line: string) => void): (line: string) => void {
  let broken = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* handled when writing */
  }
  return (line) => {
    if (broken) return;
    try {
      appendFileSync(path, line);
    } catch (err) {
      broken = true;
      const reason = err instanceof Error ? err.message : String(err);
      fallback(`${JSON.stringify({ level: 'warn', msg: 'log file disabled', path, reason })}\n`);
    }
  };
}

/** Create a JSON Lines logger that writes to stderr and, optionally, to a file. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? 'info');
  const primary = options.write ?? ((line: string) => void process.stderr.write(line));
  const secondary = options.filePath ? fileWriter(options.filePath, primary) : undefined;
  const now = options.now ?? (() => new Date());

  const build = (bindings: LogFields): Logger => {
    const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
      if (LOG_LEVELS.indexOf(level) < threshold) return;
      const record = {
        ts: now().toISOString(),
        level,
        msg: redact(message),
        ...(sanitize(bindings) as LogFields),
        ...(fields ? (sanitize(fields) as LogFields) : {}),
      };
      const line = `${JSON.stringify(record)}\n`;
      primary(line);
      secondary?.(line);
    };
    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (extra) => build({ ...bindings, ...extra }),
    };
  };

  return build({});
}
