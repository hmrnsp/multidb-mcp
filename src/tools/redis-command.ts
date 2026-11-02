import { DbError } from '../adapters/errors.js';
import type { KeyValueAdapter } from '../adapters/types.js';
import type { ColumnMatcher } from '../guard/masker.js';
import { checkRedisCommand, type RedisDecision } from '../guard/redis-policy.js';
import type { AuditTrace } from '../observability/audit.js';
import type { Logger } from '../observability/logger.js';
import { formatRedisReply } from '../output/redis-result.js';
import type { ConnectionRegistry } from '../registry/connection-registry.js';
import { redactForClient } from '../observability/redact.js';
import { withReconnect } from './reconnect.js';
import { errorReason, errorResult, fail, ok, type ToolResult } from './result.js';
import type { RedisCommandArgs } from './schemas.js';

/** Dependencies of the redis_command tool. */
export interface RedisToolDeps {
  registry: ConnectionRegistry;
  log: Logger;
  /** true when a Redis key or field name counts as sensitive. */
  isSensitiveKey: ColumnMatcher;
}

/** Extra Redis-only name patterns (besides maskColumns): session IDs and CSRF/OTP tokens are credentials. */
export const REDIS_SENSITIVE_PATTERNS: readonly string[] = ['session', 'sess', 'csrf', 'otp'];

/** Maximum COUNT for SCAN/HSCAN/SSCAN/ZSCAN. */
const SCAN_COUNT_LIMIT = 1_000;

/** Registration metadata of the redis_command tool. */
export const REDIS_COMMAND_TOOL = {
  name: 'redis_command',
  title: 'Run a Redis command',
  description:
    'Runs ONE Redis command on a Redis connection (driver redis in list_databases). ' +
    'Put the command name in command and its arguments in args, e.g. command "HGETALL", args ["user:1"]. ' +
    'To find keys use SCAN (KEYS is rejected). The allowed commands are set by the access column: "read-only" ' +
    'means read commands only (GET, HGETALL, LRANGE, SMEMBERS, ZRANGE, XRANGE, TYPE, TTL, SCAN, ...). ' +
    'FLUSHALL, FLUSHDB, CONFIG, EVAL, SELECT, MULTI, and blocking commands are always rejected. ' +
    'Results are limited to maxRows elements; values of keys/fields with sensitive names are masked.',
} as const;

type Prepared = { args: string[]; limited: boolean } | { rejected: string };

const upperOf = (value: string | undefined) => (value ?? '').toUpperCase();
const toInt = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return undefined;
  return Number.parseInt(value, 10);
};

/** Limit commands whose result can be as large as the key's contents, BEFORE they run. */
async function applySizeGuard(
  adapter: KeyValueAdapter,
  decision: Extract<RedisDecision, { allowed: true }>,
  maxRows: number,
  timeoutSec: number,
): Promise<Prepared> {
  const args = [...decision.args];
  const guard = decision.spec.guard;
  if (!guard) return { args, limited: false };
  const key = args[0] ?? '';
  const flags = new Set(args.map(upperOf));
  const measure = async (command: string) =>
    Number(await adapter.command([command, key], timeoutSec));

  const sizeCheck = async (command: string, hint: string): Promise<Prepared> => {
    const size = await measure(command);
    if (size > maxRows) {
      return {
        rejected: `${key} holds ${size} elements, over the limit of ${maxRows}. Use ${hint.replace('<key>', key)}.`,
      };
    }
    return { args, limited: false };
  };

  switch (guard.kind) {
    case 'size':
      if (flags.has('LIMIT')) return { args, limited: false };
      return sizeCheck(guard.measure, guard.hint);
    case 'range': {
      if (flags.has('BYSCORE') || flags.has('BYLEX')) {
        if (flags.has('LIMIT')) return { args, limited: false };
        return sizeCheck(guard.measure, 'add LIMIT 0 100');
      }
      const start = toInt(args[1]);
      const stop = toInt(args[2]);
      if (start === undefined || stop === undefined) return { args, limited: false };
      const length = await measure(guard.measure);
      const from = start < 0 ? Math.max(length + start, 0) : start;
      const to = stop < 0 ? length + stop : Math.min(stop, length - 1);
      if (to - from + 1 <= maxRows) return { args, limited: false };
      // Fetch maxRows + 1 elements; the formatter cuts to maxRows and adds a note.
      args[1] = String(from);
      args[2] = String(from + maxRows);
      return { args, limited: true };
    }
    case 'count': {
      const index = args.findIndex((a) => upperOf(a) === 'COUNT');
      if (index === -1) {
        args.push('COUNT', String(maxRows + 1));
        return { args, limited: false };
      }
      const count = toInt(args[index + 1]);
      if (count !== undefined && count > maxRows + 1) args[index + 1] = String(maxRows + 1);
      return { args, limited: count !== undefined && count > maxRows + 1 };
    }
    case 'scan': {
      const limit = Math.min(SCAN_COUNT_LIMIT, maxRows);
      const index = args.findIndex((a) => upperOf(a) === 'COUNT');
      const count = index === -1 ? undefined : toInt(args[index + 1]);
      if (index !== -1 && count !== undefined && count > limit) args[index + 1] = String(limit);
      return { args, limited: false };
    }
    case 'random': {
      const count = toInt(args[1]);
      if (count !== undefined && Math.abs(count) > maxRows) {
        args[1] = String(Math.sign(count) * maxRows);
        return { args, limited: true };
      }
      return { args, limited: false };
    }
  }
}

/**
 * Key name for the audit log. Session/token key names are credentials, so the part after the
 * last ":" is masked: laravel_session:abc123 -> laravel_session:***.
 */
export function auditKeyName(key: string, isSensitive: ColumnMatcher): string {
  if (!isSensitive(key)) return key;
  const cut = key.lastIndexOf(':');
  return cut === -1 ? '***' : `${key.slice(0, cut + 1)}***`;
}

/** Error messages for Redis (the generic errorResult uses SQL terminology). */
function redisErrorResult(err: unknown, db: string, timeoutSec: number | undefined): ToolResult {
  if (!(err instanceof DbError)) return errorResult(err, { db, timeoutSec });
  const message = redactForClient(err.message);
  switch (err.kind) {
    case 'timeout':
      return fail(
        `Redis command on ${db} exceeded the ${timeoutSec ?? '?'} second limit; the connection was dropped. ` +
          'Redis may still be finishing it. Avoid commands that process the whole contents of a large key.',
      );
    case 'syntax':
      return fail(`Invalid Redis command arguments: ${message}`);
    case 'unsupported':
      return fail(`The Redis server does not recognize this command: ${message}`);
    case 'permission':
      return fail(`The Redis user for ${db} lacks permission for this command: ${message}`);
    case 'readonly':
      return fail(`Redis server ${db} is a replica (read-only): ${message}`);
    case 'query':
      return fail(`Error Redis: ${message}`);
    default:
      return errorResult(err, { db, timeoutSec });
  }
}

/**
 * Handler of redis_command: guard, size limits, execute, mask, and format.
 * Rejected and failed calls come back as tool results with isError set; this function does not throw.
 */
export async function runRedisCommand(
  { registry, log, isSensitiveKey }: RedisToolDeps,
  input: RedisCommandArgs,
  trace: AuditTrace = {},
): Promise<ToolResult> {
  trace.command = input.command.trim().toUpperCase();
  const timeoutSec = registry.has(input.db)
    ? registry.source(input.db).limits.timeoutSec
    : undefined;
  try {
    const source = registry.source(input.db);
    if (source.driver !== 'redis') {
      return fail(
        `Connection ${input.db} is a SQL database; use list_tables, describe_table, or execute_sql.`,
      );
    }
    const decision = checkRedisCommand(
      input.command,
      (input.args ?? []).map(String),
      source.access,
    );
    if (!decision.allowed) {
      Object.assign(trace, { outcome: 'rejected', reason: decision.rule });
      log.warn('guard rejected Redis command', {
        db: input.db,
        env: source.env,
        rule: decision.rule,
      });
      return fail(`Rejected by the guard (${decision.rule}): ${decision.message}`);
    }

    Object.assign(trace, {
      command: decision.name,
      keys: decision.keys.map((key) => auditKeyName(key, isSensitiveKey)),
    });

    const { maxRows, maxChars } = source.limits;
    const startedAt = performance.now();
    const outcome = await withReconnect(
      { registry, log, db: input.db, safeToRetry: decision.spec.writes.length === 0, trace },
      async () => {
        const adapter = await registry.acquireKeyValue(input.db);
        const prepared = await applySizeGuard(adapter, decision, maxRows, source.limits.timeoutSec);
        if ('rejected' in prepared) return prepared;
        const reply = await adapter.command(
          [...decision.name.split(' '), ...prepared.args],
          source.limits.timeoutSec,
        );
        return { reply, limited: prepared.limited };
      },
    );
    if ('rejected' in outcome) {
      Object.assign(trace, { outcome: 'rejected', reason: 'redis_size' });
      return fail(`Rejected by the guard (redis_size): ${outcome.rejected}`);
    }
    const { reply } = outcome;
    const formatted = formatRedisReply(reply, {
      db: input.db,
      command: decision.name,
      keys: decision.keys,
      maxRows,
      maxChars,
      isSensitive: isSensitiveKey,
      limited: outcome.limited,
      durationMs: Math.round(performance.now() - startedAt),
    });
    log.info('redis_command finished', {
      db: input.db,
      command: decision.name,
      write: decision.spec.writes.length > 0,
      masked: formatted.masked,
    });
    trace.masked = formatted.masked;
    return ok(formatted.text);
  } catch (err) {
    log.info('redis_command failed', { db: input.db, error: err });
    trace.reason = errorReason(err);
    return redisErrorResult(err, input.db, timeoutSec);
  }
}
