import { isIP } from 'node:net';
import { hasLiteralSecret, interpolate } from './env.js';
import type { Driver, SourceEntry } from './schema.js';

/** Default port of each network database, used when a connection gives `host` but no `port`. */
const DEFAULT_PORT: Partial<Record<Driver, number>> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  db2: 50000,
  redis: 6379,
};

/** A whole value that is exactly one ${VAR} reference. */
const FIELD_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** A DNS host name: dot-separated labels of letters, digits, and hyphens. */
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** Control characters (including CR, LF, and NUL) never belong in a connection value. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Outcome of {@link buildConnection}: the connection string, or the problems that prevent one. */
export type ConnectionResult = { value: string; problems?: never } | { problems: string[] };

/**
 * true for a host name, an IPv4 address, or an IPv6 address (without brackets).
 * Anything else, such as "h/db?x=1" or "user@h", could change the meaning of the URL built from it.
 */
export function isValidHost(host: string): boolean {
  return isIP(host) !== 0 || HOSTNAME.test(host);
}

/**
 * Turn a config entry into the connection string its adapter expects.
 *
 * An entry gives either `url`, or separate fields (`host`, `port`, `database`, `user`, `password`; `file`
 * for SQLite). Every text field may reference environment variables as `${VAR}`.
 *
 * Security rules, enforced here so that every adapter receives a trustworthy string:
 * - A password must never be written in the config file: it has to be a `${VAR}` reference (or `${VAR}`
 *   parts inside `url`), whatever the `env` label says.
 * - With separate fields, `host` must be a valid host name or IP address (it cannot smuggle in a path,
 *   query, or second host), and the user, password, and database are URL-encoded.
 * - Control characters are refused in every field.
 * - Messages name fields and variables but never print a value.
 */
export function buildConnection(
  entry: SourceEntry,
  env: NodeJS.ProcessEnv,
  where: string,
): ConnectionResult {
  const problems: string[] = [];

  const resolve = (field: string, template: string | undefined): string | undefined => {
    if (template === undefined) return undefined;
    const result = interpolate(template, env);
    if (result.malformed) {
      problems.push(`${where}: invalid \${...} pattern in ${field}. Use \${VARIABLE_NAME}`);
    }
    if (result.missing.length > 0) {
      problems.push(
        `${where}: environment variable is not set (used in ${field}): ${result.missing.join(', ')}`,
      );
    }
    if (CONTROL_CHARACTER.test(result.value)) {
      problems.push(`${where}: ${field} contains a control character, which is not allowed`);
    }
    return result.value;
  };

  const literalPassword = (where_: string): string =>
    `${where_}: the password is written directly in the config. Use "password": "\${VAR}" ` +
    `(or \${VAR} inside url) and keep the value in the env file, for every env`;

  if (entry.url !== undefined) {
    if (hasLiteralSecret(entry.url)) return { problems: [literalPassword(where)] };
    const value = resolve('url', entry.url);
    return problems.length > 0 ? { problems } : { value: value ?? '' };
  }

  if (entry.password !== undefined && !FIELD_REFERENCE.test(entry.password.trim())) {
    return { problems: [literalPassword(where)] };
  }

  if (entry.driver === 'sqlite') {
    const file = resolve('file', entry.file);
    return problems.length > 0 ? { problems } : { value: `sqlite:${file ?? ''}` };
  }

  const host = resolve('host', entry.host);
  const user = resolve('user', entry.user);
  const password = resolve('password', entry.password);
  const database = resolve(
    'database',
    entry.database === undefined ? undefined : String(entry.database),
  );
  if (problems.length > 0) return { problems };

  const port = entry.port ?? DEFAULT_PORT[entry.driver];
  if (host === undefined || port === undefined) {
    return { problems: [`${where}: host is required when url is not given`] };
  }
  if (!isValidHost(host)) {
    return {
      problems: [
        `${where}: host must be a host name or an IP address (no path, "@", "?", "#", spaces, or ":port"); ` +
          'give the port in the "port" field',
      ],
    };
  }

  if (entry.driver === 'db2') {
    const parts: [string, string | number | undefined][] = [
      ['DATABASE', database],
      ['HOSTNAME', host],
      ['PORT', port],
      ['PROTOCOL', 'TCPIP'],
      ['UID', user],
      ['PWD', password],
    ];
    const bad = parts.find(([, v]) => typeof v === 'string' && v.includes(';'));
    if (bad) {
      return {
        problems: [
          `${where}: ${bad[0]} contains ";", which a Db2 connection string cannot hold; use a "url" with the full connection string instead`,
        ],
      };
    }
    return {
      value: parts
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}=${String(v)};`)
        .join(''),
    };
  }

  const scheme =
    entry.driver === 'postgres' ? 'postgres' : entry.driver === 'redis' ? 'redis' : 'mysql';
  const enc = encodeURIComponent;
  const auth =
    user === undefined && password === undefined
      ? ''
      : `${user === undefined ? '' : enc(user)}${password === undefined ? '' : `:${enc(password)}`}@`;
  const hostPart = isIP(host) === 6 ? `[${host}]` : host;
  return {
    value: `${scheme}://${auth}${hostPart}:${port}${database === undefined ? '' : `/${enc(database)}`}`,
  };
}
