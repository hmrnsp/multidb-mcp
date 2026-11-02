// Small harness for the Db2 check and environment check scripts.
// No dependencies: only Node built-in modules.
//
// Every step is recorded as PASS / WARN / FAIL / SKIP with its duration, and the
// summary is written to .data/reports/<name>-<time>.json. A report NEVER contains
// a password; connection strings always go through redact().

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPORT_DIR = join(ROOT, '.data', 'reports');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const STATUS_STYLE = { PASS: '32', WARN: '33', FAIL: '31', SKIP: '90', INFO: '36' };

/** Load .env from the repo root (if present) using Node's built-in support. */
export function loadEnv() {
  const file = join(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
  return existsSync(file);
}

/**
 * Hide the password in a connection string.
 * - Keyword format (Db2/ODBC):  ...;PWD=hunter;   -> PWD=***;
 * - URL format:  postgres://user:hunter@host/db     -> postgres://user:***@host/db
 */
export function redact(value) {
  if (value === undefined || value === null) return '';
  // Same as src/observability/redact.ts.
  return String(value)
    .replace(/(^|[;\s])((?:PWD|PASSWORD)\s*=)[^;]*/gi, '$1$2***')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)\S*@/gi, '$1***@')
    .replace(/([?&]password=)[^&#\s]*/gi, '$1***');
}

/** Get HOSTNAME from a Db2 connection string, or the host from a URL. */
export function hostOf(conn) {
  if (!conn) return '';
  const kv = /\bHOSTNAME\s*=\s*([^;]+)/i.exec(conn);
  if (kv) return kv[1].trim();
  try {
    return new URL(conn).hostname;
  } catch {
    return '';
  }
}

export function isLocalHost(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
}

/** Turn a callback API (err, value) into a Promise. */
export function cb(fn) {
  return new Promise((resolve, reject) => {
    fn((err, value) => (err ? reject(err) : resolve(value)));
  });
}

/** Limit how long a promise may take; throws an error when it goes over. */
export function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Summarize a driver error (ibm_db, pg, mysql2) without leaking credentials. */
export function describeError(err) {
  if (!err || typeof err !== 'object') return { message: redact(String(err)) };
  const out = { message: redact(err.message ?? String(err)) };
  // ibm_db: state / sqlcode; pg: code (SQLSTATE); mysql2: code, errno, sqlState
  for (const key of ['state', 'sqlState', 'sqlcode', 'code', 'errno']) {
    if (err[key] !== undefined && err[key] !== null) out[key] = err[key];
  }
  const sqlstate = /SQLSTATE[=\s]+([0-9A-Z]{5})/i.exec(out.message);
  if (sqlstate && !out.sqlState) out.sqlState = sqlstate[1];
  return out;
}

/** The kind of value a driver returns, to map types in the formatter later. */
export function jsTypeOf(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
  if (value instanceof Date) return 'Date';
  if (Array.isArray(value)) return 'Array';
  return typeof value;
}

function short(detail) {
  if (detail === undefined || detail === null) return '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

export function createCheck(name, meta = {}) {
  const startedAt = new Date();
  const results = [];

  function record(status, title, ms, detail) {
    results.push({ status, title, ms, detail: detail ?? null });
    const timing = ms === null ? '' : paint('90', ` (${ms} ms)`);
    const tail = detail ? `\n       ${paint('90', short(detail))}` : '';
    console.log(`${paint(STATUS_STYLE[status], status.padEnd(4))}  ${title}${timing}${tail}`);
  }

  /**
   * Run one test step.
   * fn returns details (a small object) when it passes, or throws an error when it fails.
   * optional: a failure is recorded as WARN, not FAIL.
   */
  async function step(title, fn, { optional = false } = {}) {
    const t0 = performance.now();
    try {
      const detail = await fn();
      record('PASS', title, Math.round(performance.now() - t0), detail);
      return { ok: true, value: detail };
    } catch (err) {
      record(
        optional ? 'WARN' : 'FAIL',
        title,
        Math.round(performance.now() - t0),
        describeError(err),
      );
      return { ok: false, error: err };
    }
  }

  function skip(title, reason) {
    record('SKIP', title, null, reason);
  }

  function info(title, detail) {
    record('INFO', title, null, detail);
  }

  function finish(extra = {}) {
    const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0, INFO: 0 };
    for (const r of results) counts[r.status] += 1;

    const report = {
      check: name,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
      },
      ...meta,
      ...extra,
      counts,
      results,
    };

    mkdirSync(REPORT_DIR, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const file = join(REPORT_DIR, `${name}-${stamp}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

    console.log('');
    console.log(
      `Summary ${name}: ${paint('32', `${counts.PASS} PASS`)}, ${paint('33', `${counts.WARN} WARN`)}, ` +
        `${paint('31', `${counts.FAIL} FAIL`)}, ${counts.SKIP} SKIP`,
    );
    console.log(`Report: ${file}`);
    process.exitCode = counts.FAIL > 0 ? 1 : 0;
    return report;
  }

  return { step, skip, info, finish, results };
}

/** Make sure an env value exists; throw a clear error when it is empty. */
export function requireEnv(key) {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`Variable ${key} is empty. Fill it in the .env file (see .env.example).`);
  }
  return value.trim();
}
