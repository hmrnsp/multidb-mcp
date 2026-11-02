import type { Access } from '../config/schema.js';

/**
 * Redis guard: the list of commands that are ALLOWED (allowlist). A command that is not listed here
 * is always rejected, so a new or unknown command can never slip through silently.
 *
 * Write permissions for Redis:
 *   insert = create a new key/element, update = change a value or TTL, delete = remove.
 * A command that can both create and overwrite (SET, HSET, INCR, ...) needs insert + update.
 */

type WriteAccess = Exclude<Access, 'read'>;

/** Position of the keys among the arguments (without the command name). step 2 for MSET k v k v. */
interface KeyPositions {
  first: number;
  /** -1 = up to the last argument. */
  last: number;
  step: number;
}

/** How to limit a command whose result can be as large as the key's contents (O(N)). */
export type SizeGuard =
  /** Reject when the key's size (measured with a size command) exceeds maxRows. */
  | { kind: 'size'; measure: 'HLEN' | 'SCARD' | 'ZCARD'; hint: string }
  /** Index-based LRANGE/ZRANGE: the range is narrowed to maxRows + 1 elements. */
  | { kind: 'range'; measure: 'LLEN' | 'ZCARD' }
  /** XRANGE/XREVRANGE: add or limit COUNT. */
  | { kind: 'count' }
  /** SCAN/HSCAN/SSCAN/ZSCAN: limit COUNT. */
  | { kind: 'scan' }
  /** SRANDMEMBER/ZRANDMEMBER/HRANDFIELD: limit the count. */
  | { kind: 'random' };

/** What the guard knows about one allowed Redis command. */
export interface RedisCommandSpec {
  /** Write permissions required; empty = a read command. */
  writes: readonly WriteAccess[];
  keys: KeyPositions | undefined;
  guard?: SizeGuard;
}

const ONE: KeyPositions = { first: 0, last: 0, step: 1 };
const ALL: KeyPositions = { first: 0, last: -1, step: 1 };
const PAIRS: KeyPositions = { first: 0, last: -1, step: 2 };
const TWO: KeyPositions = { first: 0, last: 1, step: 1 };

const read = (keys: KeyPositions | undefined, guard?: SizeGuard): RedisCommandSpec => ({
  writes: [],
  keys,
  ...(guard ? { guard } : {}),
});
const write = (
  writes: readonly WriteAccess[],
  keys: KeyPositions | undefined,
): RedisCommandSpec => ({
  writes,
  keys,
});

const UPSERT: readonly WriteAccess[] = ['insert', 'update'];

/** Allowlist of Redis commands. A command that is not listed here is always rejected. */
export const REDIS_COMMANDS: Readonly<Record<string, RedisCommandSpec>> = {
  // --- read: general ---------------------------------------------------------------------
  PING: read(undefined),
  TIME: read(undefined),
  DBSIZE: read(undefined),
  INFO: read(undefined),
  RANDOMKEY: read(undefined),
  SCAN: read(undefined, { kind: 'scan' }),
  EXISTS: read(ALL),
  TYPE: read(ONE),
  TTL: read(ONE),
  PTTL: read(ONE),
  EXPIRETIME: read(ONE),
  PEXPIRETIME: read(ONE),
  'MEMORY USAGE': read(ONE),
  'OBJECT ENCODING': read(ONE),
  'OBJECT IDLETIME': read(ONE),
  'OBJECT FREQ': read(ONE),
  // --- read: string ----------------------------------------------------------------------
  GET: read(ONE),
  MGET: read(ALL),
  GETRANGE: read(ONE),
  STRLEN: read(ONE),
  GETBIT: read(ONE),
  BITCOUNT: read(ONE),
  BITPOS: read(ONE),
  LCS: read(TWO),
  // --- read: hash ------------------------------------------------------------------------
  HGET: read(ONE),
  HMGET: read(ONE),
  HEXISTS: read(ONE),
  HSTRLEN: read(ONE),
  HLEN: read(ONE),
  HTTL: read(ONE),
  HSCAN: read(ONE, { kind: 'scan' }),
  HRANDFIELD: read(ONE, { kind: 'random' }),
  HGETALL: read(ONE, {
    kind: 'size',
    measure: 'HLEN',
    hint: 'HSCAN <key> 0 COUNT 100, or HGET/HMGET for specific fields',
  }),
  HKEYS: read(ONE, { kind: 'size', measure: 'HLEN', hint: 'HSCAN <key> 0 COUNT 100' }),
  HVALS: read(ONE, { kind: 'size', measure: 'HLEN', hint: 'HSCAN <key> 0 COUNT 100' }),
  // --- read: list ------------------------------------------------------------------------
  LLEN: read(ONE),
  LINDEX: read(ONE),
  LPOS: read(ONE),
  LRANGE: read(ONE, { kind: 'range', measure: 'LLEN' }),
  // --- read: set -------------------------------------------------------------------------
  SCARD: read(ONE),
  SISMEMBER: read(ONE),
  SMISMEMBER: read(ONE),
  SSCAN: read(ONE, { kind: 'scan' }),
  SRANDMEMBER: read(ONE, { kind: 'random' }),
  SMEMBERS: read(ONE, { kind: 'size', measure: 'SCARD', hint: 'SSCAN <key> 0 COUNT 100' }),
  // --- read: sorted set ------------------------------------------------------------------
  ZCARD: read(ONE),
  ZSCORE: read(ONE),
  ZMSCORE: read(ONE),
  ZCOUNT: read(ONE),
  ZLEXCOUNT: read(ONE),
  ZRANK: read(ONE),
  ZREVRANK: read(ONE),
  ZSCAN: read(ONE, { kind: 'scan' }),
  ZRANDMEMBER: read(ONE, { kind: 'random' }),
  ZRANGE: read(ONE, { kind: 'range', measure: 'ZCARD' }),
  ZREVRANGE: read(ONE, { kind: 'range', measure: 'ZCARD' }),
  ZRANGEBYSCORE: read(ONE, { kind: 'size', measure: 'ZCARD', hint: 'add LIMIT 0 100' }),
  ZREVRANGEBYSCORE: read(ONE, { kind: 'size', measure: 'ZCARD', hint: 'add LIMIT 0 100' }),
  ZRANGEBYLEX: read(ONE, { kind: 'size', measure: 'ZCARD', hint: 'add LIMIT 0 100' }),
  ZREVRANGEBYLEX: read(ONE, { kind: 'size', measure: 'ZCARD', hint: 'add LIMIT 0 100' }),
  // --- read: stream, HyperLogLog, geo ----------------------------------------------------
  XLEN: read(ONE),
  XRANGE: read(ONE, { kind: 'count' }),
  XREVRANGE: read(ONE, { kind: 'count' }),
  PFCOUNT: read(ALL),
  GEOPOS: read(ONE),
  GEODIST: read(ONE),
  GEOHASH: read(ONE),
  GEOSEARCH: read(ONE),

  // --- write: create or overwrite ---------------------------------------------------------
  SET: write(UPSERT, ONE),
  MSET: write(UPSERT, PAIRS),
  SETEX: write(UPSERT, ONE),
  PSETEX: write(UPSERT, ONE),
  APPEND: write(UPSERT, ONE),
  SETRANGE: write(UPSERT, ONE),
  SETBIT: write(UPSERT, ONE),
  GETSET: write(UPSERT, ONE),
  INCR: write(UPSERT, ONE),
  DECR: write(UPSERT, ONE),
  INCRBY: write(UPSERT, ONE),
  DECRBY: write(UPSERT, ONE),
  INCRBYFLOAT: write(UPSERT, ONE),
  HSET: write(UPSERT, ONE),
  HMSET: write(UPSERT, ONE),
  HINCRBY: write(UPSERT, ONE),
  HINCRBYFLOAT: write(UPSERT, ONE),
  ZADD: write(UPSERT, ONE),
  ZINCRBY: write(UPSERT, ONE),
  GEOADD: write(UPSERT, ONE),
  // --- write: create only -----------------------------------------------------------------
  SETNX: write(['insert'], ONE),
  MSETNX: write(['insert'], PAIRS),
  HSETNX: write(['insert'], ONE),
  LPUSH: write(['insert'], ONE),
  RPUSH: write(['insert'], ONE),
  LPUSHX: write(['insert'], ONE),
  RPUSHX: write(['insert'], ONE),
  LINSERT: write(['insert'], ONE),
  SADD: write(['insert'], ONE),
  XADD: write(['insert'], ONE),
  PFADD: write(['insert'], ONE),
  COPY: write(['insert'], TWO),
  // --- write: modify what already exists ---------------------------------------------------
  LSET: write(['update'], ONE),
  EXPIRE: write(['update'], ONE),
  PEXPIRE: write(['update'], ONE),
  EXPIREAT: write(['update'], ONE),
  PEXPIREAT: write(['update'], ONE),
  PERSIST: write(['update'], ONE),
  HEXPIRE: write(['update'], ONE),
  HPERSIST: write(['update'], ONE),
  RENAMENX: write(['update'], TWO),
  // RENAME overwrites the destination key if it already exists.
  RENAME: write(['update', 'delete'], TWO),
  // --- write: move (delete from the source, add to the destination) -----------------------
  LMOVE: write(['insert', 'delete'], TWO),
  RPOPLPUSH: write(['insert', 'delete'], TWO),
  SMOVE: write(['insert', 'delete'], TWO),
  // --- write: delete ----------------------------------------------------------------------
  DEL: write(['delete'], ALL),
  UNLINK: write(['delete'], ALL),
  GETDEL: write(['delete'], ONE),
  HDEL: write(['delete'], ONE),
  LPOP: write(['delete'], ONE),
  RPOP: write(['delete'], ONE),
  LREM: write(['delete'], ONE),
  LTRIM: write(['delete'], ONE),
  SREM: write(['delete'], ONE),
  SPOP: write(['delete'], ONE),
  ZREM: write(['delete'], ONE),
  ZPOPMIN: write(['delete'], ONE),
  ZPOPMAX: write(['delete'], ONE),
  ZREMRANGEBYSCORE: write(['delete'], ONE),
  ZREMRANGEBYRANK: write(['delete'], ONE),
  ZREMRANGEBYLEX: write(['delete'], ONE),
  XDEL: write(['delete'], ONE),
  XTRIM: write(['delete'], ONE),
};

/** Rejection reason for dangerous commands that are often tried; anything else: "not supported". */
const DENIED_REASONS: Readonly<Record<string, string>> = {
  FLUSHALL: 'deletes everything in Redis',
  FLUSHDB: 'deletes everything in the database',
  KEYS: 'blocks Redis while it scans every key; use SCAN 0 MATCH <pattern> COUNT 100',
  EVAL: 'a Lua script can run any command and the guard cannot inspect it',
  EVALSHA: 'a Lua script can run any command and the guard cannot inspect it',
  EVAL_RO: 'the guard cannot inspect a Lua script',
  EVALSHA_RO: 'the guard cannot inspect a Lua script',
  FCALL: 'the guard cannot inspect a Redis function',
  FCALL_RO: 'the guard cannot inspect a Redis function',
  SCRIPT: 'manages Lua scripts',
  FUNCTION: 'manages Redis functions',
  CONFIG: 'changes the server configuration',
  ACL: 'manages users and permissions',
  MODULE: 'loads native code into the server',
  DEBUG: 'server debug command',
  SHUTDOWN: 'shuts the server down',
  SAVE: 'persistence administration command',
  BGSAVE: 'persistence administration command',
  BGREWRITEAOF: 'persistence administration command',
  REPLICAOF: 'changes replication',
  SLAVEOF: 'changes replication',
  FAILOVER: 'changes replication',
  CLUSTER: 'cluster administration command',
  MIGRATE: 'moves data to another server',
  RESTORE: 'inserts raw data produced by DUMP',
  CLIENT: "manages other clients' connections",
  MONITOR: 'streams every server command indefinitely',
  SELECT: 'the database number is set in the connection url',
  SWAPDB: 'swaps the contents of two databases',
  MOVE: 'moves a key to another database',
  MULTI: 'transactions are managed per command',
  EXEC: 'transactions are managed per command',
  WATCH: 'transactions are managed per command',
  SUBSCRIBE: 'waits for messages indefinitely',
  PSUBSCRIBE: 'waits for messages indefinitely',
  SSUBSCRIBE: 'waits for messages indefinitely',
  PUBLISH: 'sends a message to other applications',
  SPUBLISH: 'sends a message to other applications',
  BLPOP: 'waits (blocking)',
  BRPOP: 'waits (blocking)',
  BLMOVE: 'waits (blocking)',
  BLMPOP: 'waits (blocking)',
  BRPOPLPUSH: 'waits (blocking)',
  BZPOPMIN: 'waits (blocking)',
  BZPOPMAX: 'waits (blocking)',
  BZMPOP: 'waits (blocking)',
  WAIT: 'waits (blocking)',
  XREAD: 'can wait (blocking); use XRANGE',
  XREADGROUP: 'changes consumer group state; use XRANGE',
  SORT: 'can write its result to another key (STORE)',
};

/** Commands with subcommands: the full name has two words (e.g. MEMORY USAGE). */
const WITH_SUBCOMMAND = new Set(['MEMORY', 'OBJECT']);

/** The Redis guard's verdict: allowed with the parsed command, or rejected with a rule and a message. */
export type RedisDecision =
  | { allowed: true; name: string; spec: RedisCommandSpec; keys: string[]; args: string[] }
  | { allowed: false; rule: 'redis_denied' | 'redis_unsupported' | 'access'; message: string };

/**
 * Check one Redis command for a connection with `access` permissions.
 * `args` are the arguments after the command name. For a command with a subcommand, the subcommand
 * is moved into the name (MEMORY USAGE key -> name "MEMORY USAGE", args [key]).
 */
export function checkRedisCommand(
  command: string,
  args: readonly string[],
  access: readonly Access[],
): RedisDecision {
  const upper = command.trim().toUpperCase();
  let name = upper;
  let rest = [...args];
  if (WITH_SUBCOMMAND.has(upper) && rest.length > 0) {
    name = `${upper} ${rest[0]!.toUpperCase()}`;
    rest = rest.slice(1);
  }

  const denied = DENIED_REASONS[upper];
  if (denied) {
    return {
      allowed: false,
      rule: 'redis_denied',
      message: `${upper} is not allowed: ${denied}.`,
    };
  }
  const spec = REDIS_COMMANDS[name];
  if (!spec) {
    return {
      allowed: false,
      rule: 'redis_unsupported',
      message: `Command ${name} is not supported through multidb-mcp. Common read commands: GET, MGET, HGET, HGETALL, LRANGE, SMEMBERS, ZRANGE, XRANGE, TYPE, TTL, SCAN.`,
    };
  }

  let writes = spec.writes;
  // SET ... NX only creates; SET ... XX only modifies. Same for ZADD.
  if (name === 'SET' || name === 'ZADD') {
    const flags = new Set(rest.map((a) => a.toUpperCase()));
    if (flags.has('NX') && !flags.has('XX')) writes = ['insert'];
    else if (flags.has('XX') && !flags.has('NX')) writes = ['update'];
  }
  const missing = writes.filter((level) => !access.includes(level));
  if (missing.length > 0) {
    return {
      allowed: false,
      rule: 'access',
      message: `This connection only allows ${access.join(', ')}; command ${name} needs permission ${missing.join(', ')}.`,
    };
  }

  return { allowed: true, name, spec, keys: keysOf(spec, rest), args: rest };
}

function keysOf(spec: RedisCommandSpec, args: readonly string[]): string[] {
  const positions = spec.keys;
  if (!positions) return [];
  const last = positions.last === -1 ? args.length - 1 : Math.min(positions.last, args.length - 1);
  const keys: string[] = [];
  for (let i = positions.first; i <= last; i += positions.step) keys.push(args[i]!);
  return keys;
}
