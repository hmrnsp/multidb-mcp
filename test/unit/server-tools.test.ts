import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/loader.js';
import type { AuditEntry } from '../../src/observability/audit.js';
import { createLogger } from '../../src/observability/logger.js';
import { ConnectionRegistry } from '../../src/registry/connection-registry.js';
import { createMcpServer, toolsFor } from '../../src/server.js';
import { auditKeyName } from '../../src/tools/redis-command.js';

function registryOf(drivers: string[]) {
  const config = parseConfig(
    JSON.stringify({
      databases: drivers.map((driver, i) => ({
        id: `db${i}`,
        driver,
        env: 'local',
        access: ['read'],
        description: 'tool registration test',
        url: driver === 'redis' ? '${REDIS_URL}' : '${PG_URL}',
      })),
    }),
    {
      path: 'databases.json',
      env: { REDIS_URL: 'redis://127.0.0.1:6379/0', PG_URL: 'postgres://u:p@h/db' },
    },
  );
  return new ConnectionRegistry(config.sources, {}, createLogger({ write: () => undefined }));
}

describe('toolsFor', () => {
  it('only registers tools for the connection kinds present in the config', () => {
    expect(toolsFor(registryOf(['postgres']))).toEqual([
      'list_databases',
      'list_tables',
      'describe_table',
      'execute_sql',
    ]);
    expect(toolsFor(registryOf(['redis']))).toEqual(['list_databases', 'redis_command']);
    expect(toolsFor(registryOf(['postgres', 'redis']))).toHaveLength(5);
  });
});

describe('audit per tool call', () => {
  it('every tool is recorded once with env, outcome, and guard rule', async () => {
    const registry = registryOf(['postgres', 'redis']);
    const entries: AuditEntry[] = [];
    const server = createMcpServer({
      registry,
      log: createLogger({ write: () => undefined }),
      maskColumns: [],
      audit: { record: (entry) => entries.push(entry) },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      await client.callTool({ name: 'list_databases', arguments: {} });
      await client.callTool({
        name: 'execute_sql',
        arguments: { db: 'db0', sql: 'DELETE FROM orders', params: [] },
      });
      await client.callTool({ name: 'execute_sql', arguments: { db: 'db0', sql: 'SELECT 1' } });
      await client.callTool({
        name: 'redis_command',
        arguments: { db: 'db1', command: 'FLUSHALL' },
      });
    } finally {
      await client.close();
      await server.close();
    }
    expect(entries.map(({ durationMs: _ms, ...rest }) => rest)).toEqual([
      { tool: 'list_databases', db: undefined, env: undefined, outcome: 'ok' },
      {
        tool: 'execute_sql',
        db: 'db0',
        env: 'local',
        sql: 'DELETE FROM orders',
        paramCount: 0,
        outcome: 'rejected',
        reason: 'readonly',
      },
      {
        tool: 'execute_sql',
        db: 'db0',
        env: 'local',
        sql: 'SELECT 1',
        paramCount: 0,
        statement: 'SELECT',
        outcome: 'error',
        reason: 'unavailable',
      },
      {
        tool: 'redis_command',
        db: 'db1',
        env: 'local',
        command: 'FLUSHALL',
        outcome: 'rejected',
        reason: 'redis_denied',
      },
    ]);
    expect(entries.every((e) => Number.isInteger(e.durationMs))).toBe(true);
  });
});

describe('auditKeyName', () => {
  it('sensitive key names are masked after the last colon', () => {
    const sensitive = (name: string) => /session|token/i.test(name);
    expect(auditKeyName('laravel_session:abc123', sensitive)).toBe('laravel_session:***');
    expect(auditKeyName('api_token', sensitive)).toBe('***');
    expect(auditKeyName('user:5', sensitive)).toBe('user:5');
  });
});
