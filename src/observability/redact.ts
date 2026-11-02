/**
 * Hide passwords in free text: driver error messages, connection strings, logs.
 *
 *   ...;PWD=secret;                  -> ...;PWD=***;
 *   postgres://user:secret@host/db   -> postgres://user:***@host/db
 *   ...?password=secret              -> ...?password=***
 *
 * When in doubt (for example several URLs in one sentence), it is better to mask
 * too much than too little.
 */
export function redact(value: string | null | undefined): string {
  if (value === undefined || value === null) return '';
  return (
    value
      // Keyword format: only at the start of the text or after ";"/whitespace, so it does not
      // swallow a URL query string such as "?a=1&password=x&ssl=true".
      .replace(/(^|[;\s])((?:PWD|PASSWORD)\s*=)[^;]*/gi, '$1$2***')
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)\S*@/gi, '$1***@')
      .replace(/([?&]password=)[^&#\s]*/gi, '$1***')
  );
}

/**
 * For text sent to Claude (tool results): besides passwords, also hide the
 * host, port, and user name. Logs keep using redact() so they stay useful for debugging.
 */
export function redactForClient(value: string | null | undefined): string {
  return (
    redact(value)
      // Node network error: "connect ECONNREFUSED 10.0.0.5:5432 - Local (0.0.0.0:0)"
      .replace(
        /\b((?:connect|getaddrinfo|read|write)\s+E[A-Z_]+)\s+[^\s,;)]+(?:\s+-\s+Local\s+\([^)]*\))?/g,
        '$1 <host>',
      )
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]+/gi, '$1<host>')
      .replace(/(^|[;\s])((?:HOSTNAME|HOST|SERVER|PORT|UID|USER)\s*=)[^;\s]*/gi, '$1$2***')
      // PostgreSQL: for user "dev"; MySQL: for user 'dev'@'172.18.0.1'
      .replace(/\bfor user\s+(["'`])[^"'`]*\1(?:@(["'`])[^"'`]*\2)?/gi, "for user '***'")
  );
}
