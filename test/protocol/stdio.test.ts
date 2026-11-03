/**
 * Protocol test: runs dist/index.js as a separate process over stdio,
 * exactly as Claude Code runs it.
 *
 *   npm run test:protocol     (builds first automatically)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = resolve('dist/index.js');
const SECRET = 'hunter-protocol-test';
const SERVER_ENV = {
  TEST_PG_URL: `postgres://dev:${SECRET}@127.0.0.1:1/app`,
  TEST_DB2_CONN: `DATABASE=TESTDB;HOSTNAME=db2.test.internal;PORT=1;UID=mcp_ro;PWD=${SECRET};`,
};

let dir = '';
let configPath = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'multidb-protocol-'));
  configPath = join(dir, 'databases.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      databases: [
        {
          id: 'test_pg',
          driver: 'postgres',
          env: 'local',
          access: ['read', 'insert', 'update', 'delete', 'ddl', 'call'],
          description: 'PostgreSQL for the protocol test',
          url: '${TEST_PG_URL}',
        },
        {
          id: 'test_db2',
          driver: 'db2',
          env: 'production',
          access: ['read'],
          description: 'Db2 for the protocol test',
          url: '${TEST_DB2_CONN}',
        },
      ],
    }),
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) =>
      typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : '',
    )
    .join('\n');
}

describe('MCP protocol over stdio', () => {
  let client: Client | undefined;

  beforeAll(async () => {
    client = new Client({ name: 'protocol-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER, '--config', configPath, '--log-level', 'warn'],
        env: { ...getDefaultEnvironment(), ...SERVER_ENV },
        stderr: 'ignore',
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
  });

  it('advertises the 4 SQL tools with the right annotations', async () => {
    const { tools } = await client!.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'describe_table',
      'execute_sql',
      'list_databases',
      'list_tables',
    ]);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('list_tables')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('execute_sql')?.annotations?.readOnlyHint).toBe(false);
    // The db parameter is an enum of the connection IDs in the config.
    expect(JSON.stringify(byName.get('execute_sql')?.inputSchema)).toContain('test_db2');
  });

  it('invalid input is rejected by the schema (unknown db)', async () => {
    const result = await client!.callTool({
      name: 'execute_sql',
      arguments: { db: 'does_not_exist', sql: 'SELECT 1' },
    });
    expect(result.isError).toBe(true);
  });

  it('a failed connection: a clear message without credentials', async () => {
    const result = await client!.callTool({
      name: 'execute_sql',
      arguments: { db: 'test_pg', sql: 'SELECT 1' },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result.content);
    expect(text).toContain('Cannot connect to test_pg');
    expect(text).not.toContain(SECRET);
  });

  it('the guard rejects writes on production before the connection is opened', async () => {
    const result = await client!.callTool({
      name: 'execute_sql',
      arguments: { db: 'test_db2', sql: 'DELETE FROM CORE.ORDERS' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toContain('Rejected by the guard (readonly)');
  });

  it('the guard rejects multiple statements', async () => {
    const result = await client!.callTool({
      name: 'execute_sql',
      arguments: { db: 'test_pg', sql: 'SELECT 1; DROP TABLE x' },
    });
    expect(textOf(result.content)).toContain('Rejected by the guard (multi_statement)');
  });

  it('list_databases returns the connection list without credentials', async () => {
    const result = await client!.callTool({ name: 'list_databases', arguments: {} });
    expect(result.isError).not.toBe(true);
    const text = textOf(result.content);
    expect(text).toContain('test_pg | postgres | local | read + insert, update, delete, ddl, call');
    expect(text).toContain('test_db2 | db2 | production | read-only');
    for (const leak of [SECRET, 'db2.test.internal', '127.0.0.1', 'mcp_ro']) {
      expect(text).not.toContain(leak);
    }
  });

  it('the server instructions reach the client (when the client API supports it)', () => {
    const getInstructions = (client as unknown as { getInstructions?: () => string | undefined })
      .getInstructions;
    if (typeof getInstructions !== 'function') return;
    expect(getInstructions.call(client)).toContain('list_databases');
  });
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the server directly. When waitFor is given, close stdin once that text appears on stderr. */
function runServer(args: string[], env: NodeJS.ProcessEnv, waitFor?: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SERVER, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the server did not stop within 15 seconds. stderr:\n${stderr}`));
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (waitFor && stderr.includes(waitFor)) child.stdin.end();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    if (!waitFor) child.stdin.end();
  });
}

describe('process lifecycle', () => {
  it('stdin closed: stops cleanly (code 0), stdout empty, log without credentials', async () => {
    const result = await runServer(['--config', configPath], SERVER_ENV, '"server ready"');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('"server stopping"');
    expect(result.stderr).not.toContain(SECRET);
  });

  it('config file missing: code 1, a clear message on stderr, stdout empty', async () => {
    const result = await runServer(['--config', join(dir, 'missing.json')], {});
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Config file not found');
  });

  it('--dotenv file missing: a message from the server itself, not from Node.js', async () => {
    const result = await runServer(
      ['--config', configPath, '--dotenv', join(dir, 'missing.env')],
      SERVER_ENV,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Env file not found');
    expect(result.stdout).toBe('');
  });

  it('missing environment variable: code 1 and its name is mentioned', async () => {
    const result = await runServer(['--config', configPath], {
      TEST_PG_URL: '',
      TEST_DB2_CONN: '',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('TEST_PG_URL');
    expect(result.stdout).toBe('');
  });

  it('--version and a wrong argument do not write to stdout', async () => {
    const version = await runServer(['--version'], {});
    expect(version.code).toBe(0);
    expect(version.stdout).toBe('');
    expect(version.stderr).toMatch(/multidb-mcp \d+\.\d+\.\d+/);

    const bad = await runServer(['--no-such-option'], {});
    expect(bad.code).toBe(2);
    expect(bad.stdout).toBe('');
  });
});

describe('no credentials in the log, the audit log, or tool results', () => {
  it('every tool is called against failing connections; the password appears nowhere', async () => {
    const leakDir = mkdtempSync(join(tmpdir(), 'multidb-leak-'));
    try {
      const leakConfig = join(leakDir, 'databases.json');
      const auditDir = join(leakDir, 'audit');
      const logFile = join(leakDir, 'server.log');
      writeFileSync(
        leakConfig,
        JSON.stringify({
          databases: [
            {
              id: 'test_pg',
              driver: 'postgres',
              env: 'staging',
              access: ['read'],
              description: 'leak test pg',
              url: '${TEST_PG_URL}',
            },
            {
              id: 'test_mysql',
              driver: 'mysql',
              env: 'staging',
              access: ['read'],
              description: 'leak test mysql',
              host: '127.0.0.1',
              port: 1,
              database: 'app',
              user: 'dev',
              password: '${TEST_MYSQL_PASSWORD}',
            },
            {
              id: 'test_db2',
              driver: 'db2',
              env: 'production',
              access: ['read'],
              description: 'leak test db2',
              url: '${TEST_DB2_CONN}',
            },
            {
              id: 'test_redis',
              driver: 'redis',
              env: 'production',
              access: ['read'],
              description: 'leak test redis',
              url: '${TEST_REDIS_URL}',
            },
          ],
        }),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          SERVER,
          '--config',
          leakConfig,
          '--log-level',
          'debug',
          '--log-file',
          logFile,
          '--audit-dir',
          auditDir,
        ],
        env: {
          ...getDefaultEnvironment(),
          ...SERVER_ENV,
          TEST_MYSQL_PASSWORD: SECRET,
          TEST_REDIS_URL: `redis://default:${SECRET}@127.0.0.1:1/0`,
        },
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const client = new Client({ name: 'leak-test', version: '1.0.0' });
      await client.connect(transport);
      const texts: string[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        texts.push(textOf(result.content));
      };
      try {
        await call('list_databases', {});
        for (const db of ['test_pg', 'test_mysql', 'test_db2']) {
          await call('list_tables', { db });
          await call('describe_table', { db, table: 'orders' });
          await call('execute_sql', { db, sql: 'SELECT 1' });
        }
        await call('redis_command', { db: 'test_redis', command: 'PING' });
        await call('list_databases', {});
      } finally {
        await client.close();
      }

      const audit = readdirSync(auditDir)
        .map((name) => readFileSync(join(auditDir, name), 'utf8'))
        .join('');
      const log = readFileSync(logFile, 'utf8');
      expect(texts.join('\n')).toContain('Cannot connect to test_redis');
      expect(audit.trim().split('\n')).toHaveLength(12);
      expect(log).toContain('connection failed');
      for (const [where, content] of [
        ['tool results', texts.join('\n')],
        ['stderr', stderr],
        ['file log', log],
        ['audit log', audit],
      ] as const) {
        expect(content, where).not.toContain(SECRET);
      }
      // The tool results do not mention the internal office host either.
      expect(texts.join('\n')).not.toContain('db2.test.internal');
    } finally {
      rmSync(leakDir, { recursive: true, force: true });
    }
  });
});
