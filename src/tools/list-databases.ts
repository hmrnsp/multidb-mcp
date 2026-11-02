import type { Access } from '../config/schema.js';
import { renderTable } from '../output/text-table.js';
import type { ConnectionRegistry, SourceStatus } from '../registry/connection-registry.js';

/** Registration metadata of the list_databases tool. */
export const LIST_DATABASES_TOOL = {
  name: 'list_databases',
  title: 'List database connections',
  description:
    'Lists every configured database connection: id, driver, env (local/staging/production), ' +
    'access (read-only, or read plus the write kinds that are allowed), result limits, status, and a description of its purpose. ' +
    'Does not show hosts or credentials. Call this tool first when the user does not ' +
    'name the database they mean, then pick a connection by its description or ask the user.',
} as const;

/** "read-only" or "read + insert, update, delete". */
export function describeAccess(access: readonly Access[]): string {
  const writes = access.filter((a) => a !== 'read');
  return writes.length === 0 ? 'read-only' : `read + ${writes.join(', ')}`;
}

/** Describe a connection status in one short phrase. */
export function describeStatus(status: SourceStatus): string {
  switch (status.state) {
    case 'idle':
      return 'ready (not connected yet)';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'error':
      return `failed to connect: ${status.message}`;
    case 'unavailable':
      return status.reason;
  }
}

/** Result text of the list_databases tool. Pure (no SDK) so it is easy to test. */
export function buildListDatabasesText(registry: ConnectionRegistry): string {
  const summaries = registry.summaries();
  const rows = summaries.map((s) => [
    s.id,
    s.driver,
    s.env,
    describeAccess(s.access),
    `${s.limits.maxRows} rows, ${s.limits.timeoutSec} s`,
    s.schemas ? s.schemas.join(', ') : s.driver === 'redis' ? '-' : 'all',
    describeStatus(s.status),
    s.description,
  ]);

  const lines = [
    `${summaries.length} database connections. Use the "id" column value as the db parameter of the other tools.`,
    '',
    renderTable(
      ['id', 'driver', 'env', 'access', 'limits', 'schema', 'status', 'description'],
      rows,
    ),
    '',
    'Notes:',
    '- The access column lists the statement kinds allowed per connection; anything else is rejected.',
    '- Before writing to a production connection, explain the change and ask the user for approval.',
  ];
  if (summaries.some((s) => s.driver === 'redis')) {
    lines.push(
      '- Redis connections use the redis_command tool; other connections use list_tables, describe_table, and execute_sql.',
    );
  }
  return lines.join('\n');
}
