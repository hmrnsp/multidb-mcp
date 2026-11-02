import { DbError } from '../adapters/errors.js';
import { redactForClient } from '../observability/redact.js';
import { SourceUnavailableError, UnknownSourceError } from '../registry/connection-registry.js';

/**
 * Tool result in the form the MCP SDK accepts.
 * Deliberately a type alias (not an interface) so it stays compatible with the SDK's CallToolResult type.
 */
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** A successful tool result. */
export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A failed tool result (isError is set). */
export function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Short reason for the audit log: the kind of database error or another category. */
export function errorReason(err: unknown): string {
  if (err instanceof UnknownSourceError) return 'unknown_db';
  if (err instanceof SourceUnavailableError) return 'unavailable';
  if (err instanceof DbError) return err.kind;
  return 'internal';
}

/** Context used to word an error message. */
export interface ErrorContext {
  db: string;
  timeoutSec?: number;
}

/**
 * Turn any error into a message that helps Claude fix its next step,
 * with no stack trace and no credentials.
 */
export function errorResult(err: unknown, context: ErrorContext): ToolResult {
  if (err instanceof UnknownSourceError || err instanceof SourceUnavailableError) {
    return fail(err.message);
  }
  if (err instanceof DbError) {
    const message = redactForClient(err.message);
    const code = err.sqlState ? ` (SQLSTATE ${err.sqlState})` : '';
    switch (err.kind) {
      case 'timeout':
        return fail(
          `Query on ${context.db} exceeded the ${context.timeoutSec ?? '?'} second limit and was cancelled. ` +
            'Narrow it with WHERE, use an indexed column, or add LIMIT.',
        );
      case 'connection':
        return fail(
          `Cannot connect to ${context.db}: ${message}. ` +
            'Make sure the database is running, the VPN/tunnel is active, and the credentials in the env file are correct.',
        );
      case 'readonly':
        return fail(
          `Connection ${context.db} is read-only; only read queries (SELECT) are allowed.${code}`,
        );
      case 'permission':
        return fail(
          `The database user for ${context.db} lacks permission for this operation${code}: ${message}`,
        );
      case 'syntax':
        return fail(`SQL syntax error${code}: ${message}`);
      case 'not_found':
        return fail(`${message}${code}. Check the name with list_tables or describe_table.`);
      case 'ambiguous':
        return fail(message);
      case 'unsupported':
        return fail(`This cannot be run through multidb-mcp${code}: ${message}`);
      case 'query':
        return fail(`Database error${code}: ${message}`);
    }
  }
  const message = redactForClient(err instanceof Error ? err.message : String(err));
  return fail(`Unexpected error: ${message}`);
}
