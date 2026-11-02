/**
 * ${VAR} interpolation and detection of literal passwords in connection strings.
 */

const VAR_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ONLY_VAR = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** Result of {@link interpolate}. */
export interface InterpolationResult {
  value: string;
  /** Variables that are referenced but missing or empty in the environment. */
  missing: string[];
  /** An invalid "${" pattern exists, e.g. "${PG URL}" or "${PG_URL". */
  malformed: boolean;
}

/** Replace every ${VAR} with its value from env. An empty variable counts as missing (fail fast). */
export function interpolate(template: string, env: NodeJS.ProcessEnv): InterpolationResult {
  const missing = new Set<string>();
  const value = template.replace(VAR_REFERENCE, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved.trim() === '') {
      missing.add(name);
      return '';
    }
    return resolved;
  });
  const malformed = template.replace(VAR_REFERENCE, '').includes('${');
  return { value, missing: [...missing], malformed };
}

/** Variable names a template references, in order and unique. */
export function referencedVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VAR_REFERENCE)].map((m) => m[1] ?? ''))].filter(
    (name) => name !== '',
  );
}

function isLiteral(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && !ONLY_VAR.test(trimmed);
}

/**
 * true if a connection string template contains a password written directly,
 * not through ${VAR}. Detects three forms:
 *   - Db2/ODBC keyword:  ...;PWD=secret;  or  PASSWORD=secret
 *   - URL:               postgres://user:secret@host/db
 *   - URL parameter:     ...?password=secret
 * A template that is a single variable (e.g. "${PROD_PG_URL}") is considered safe.
 */
export function hasLiteralSecret(template: string): boolean {
  const text = template.trim();
  if (ONLY_VAR.test(text)) return false;

  for (const match of text.matchAll(/(?:^|[;\s])(?:PWD|PASSWORD)\s*=\s*([^;]*)/gi)) {
    if (isLiteral(match[1] ?? '')) return true;
  }

  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(text)?.[1];
  if (userinfo !== undefined) {
    const colon = userinfo.indexOf(':');
    if (colon >= 0 && isLiteral(userinfo.slice(colon + 1))) return true;
  }

  for (const match of text.matchAll(/[?&]password=([^&#]*)/gi)) {
    if (isLiteral(match[1] ?? '')) return true;
  }

  return false;
}
