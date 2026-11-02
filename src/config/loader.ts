import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type * as z from 'zod/v4';
import { hasLiteralSecret, interpolate } from './env.js';
import {
  ACCESS_LEVELS,
  ConfigFileSchema,
  type Access,
  type Driver,
  type Environment,
} from './schema.js';
import { Secret } from './secret.js';

/** Result limits for one connection. */
export interface Limits {
  maxRows: number;
  timeoutSec: number;
  maxChars: number;
}

/** Built-in limits used when neither "defaults" nor the connection sets them. */
export const BUILTIN_LIMITS: Readonly<Limits> = Object.freeze({
  maxRows: 200,
  timeoutSec: 30,
  maxChars: 40_000,
});

/**
 * Column-name patterns that are always masked. "maskColumns" in the config ADDS to this list
 * and never replaces it, so built-in protection cannot be lost through a misconfiguration.
 */
export const DEFAULT_MASK_COLUMNS: readonly string[] = Object.freeze([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'api_key',
  'nik',
  'card_number',
  'cvv',
]);

/** A validated connection entry with defaults applied and ${VAR} references resolved. */
export interface ResolvedSource {
  id: string;
  driver: Driver;
  env: Environment;
  description: string;
  /** Connection string after interpolation. Only adapters may call reveal(). */
  connection: Secret;
  /** Permissions from the config, ordered like ACCESS_LEVELS. Always contains "read". */
  access: Access[];
  /** true when access is only ["read"]: the adapter uses a read-only transaction. */
  readonly: boolean;
  limits: Limits;
  /** Schema whitelist; undefined means every schema the database user can see. */
  schemas: string[] | undefined;
  lazy: boolean;
  /** Folder of the config file: base for relative paths (e.g. SQLite files). */
  baseDir: string;
}

/** A validated configuration file. */
export interface ResolvedConfig {
  path: string;
  maskColumns: string[];
  sources: ResolvedSource[];
}

/** The configuration is invalid; `problems` lists each issue. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(
      problems.length > 0 ? `${message}\n${problems.map((p) => `  - ${p}`).join('\n')}` : message,
    );
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => {
    if (typeof key === 'number') return `${out}[${key}]`;
    const name = String(key);
    return out === '' ? name : `${out}.${name}`;
  }, '');
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const where = formatPath(issue.path);
    return where === '' ? issue.message : `${where}: ${issue.message}`;
  });
}

/** Parse and validate the contents of a config file. Separate from loadConfig so it is easy to test. */
export function parseConfig(
  text: string,
  options: { path: string; env: NodeJS.ProcessEnv },
): ResolvedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Config file is not valid JSON (${options.path}): ${reason}`);
  }

  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration (${options.path}):`,
      describeIssues(parsed.error.issues),
    );
  }

  const config = parsed.data;
  const problems: string[] = [];
  const sources: ResolvedSource[] = [];

  config.databases.forEach((entry, index) => {
    const where = `databases[${index}] (${entry.id})`;

    if (entry.env !== 'local' && hasLiteralSecret(entry.url)) {
      problems.push(
        `${where}: password is written directly in url. For env ${entry.env}, use \${VAR} and keep the value in .env`,
      );
      return;
    }

    const result = interpolate(entry.url, options.env);
    if (result.malformed) {
      problems.push(`${where}: invalid \${...} pattern in url. Use \${VARIABLE_NAME}`);
    }
    if (result.missing.length > 0) {
      problems.push(`${where}: environment variable is not set: ${result.missing.join(', ')}`);
    }
    if (result.malformed || result.missing.length > 0) return;

    sources.push({
      id: entry.id,
      driver: entry.driver,
      env: entry.env,
      description: entry.description,
      connection: new Secret(result.value),
      access: ACCESS_LEVELS.filter((level) => entry.access.includes(level)),
      readonly: entry.access.every((level) => level === 'read'),
      limits: {
        maxRows: entry.maxRows ?? config.defaults?.maxRows ?? BUILTIN_LIMITS.maxRows,
        timeoutSec: entry.timeoutSec ?? config.defaults?.timeoutSec ?? BUILTIN_LIMITS.timeoutSec,
        maxChars: entry.maxChars ?? config.defaults?.maxChars ?? BUILTIN_LIMITS.maxChars,
      },
      schemas: entry.schemas ? [...new Set(entry.schemas)] : undefined,
      lazy: entry.lazy ?? true,
      baseDir: dirname(resolve(options.path)),
    });
  });

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration (${options.path}):`, problems);
  }

  const maskColumns = [
    ...new Set(
      [...DEFAULT_MASK_COLUMNS, ...(config.maskColumns ?? [])].map((c) => c.toLowerCase()),
    ),
  ];

  return { path: options.path, maskColumns, sources };
}

/** Read the config file from disk. A relative path is resolved against the working directory. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const absolute = resolve(path);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === 'ENOENT' ? 'not found' : `cannot be read (${code ?? 'error'})`;
    throw new ConfigError(`Config file ${reason}: ${absolute}`);
  }
  return parseConfig(text, { path: absolute, env });
}
