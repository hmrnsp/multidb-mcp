import { describe, expect, it } from 'vitest';
import { DbError } from '../../src/adapters/errors.js';
import type {
  DbAdapter,
  ExecOptions,
  QueryResult,
  TableDetail,
  TableInfo,
} from '../../src/adapters/types.js';
import { parseConfig } from '../../src/config/loader.js';
import { createColumnMatcher } from '../../src/guard/index.js';
import type { AuditTrace } from '../../src/observability/audit.js';
import { createLogger } from '../../src/observability/logger.js';
import { ConnectionRegistry } from '../../src/registry/connection-registry.js';
import {
  formatTableDetail,
  runDescribeTable,
  runExecuteSql,
  runListTables,
  type ToolDeps,
} from '../../src/tools/database-tools.js';
import type { ToolResult } from '../../src/tools/result.js';

const log = createLogger({ write: () => undefined });

class FakeAdapter implements DbAdapter {
  readonly driver = 'postgres' as const;
  readonly dialect = 'postgresql' as const;
  tables: TableInfo[] = [];
  listCalls: { schema?: string; search?: string; limit: number }[] = [];
  executeCalls: { sql: string; params: readonly unknown[]; options: ExecOptions }[] = [];
  nextResult: QueryResult | Error = {
    columns: ['n'],
    rows: [[1]],
    truncated: false,
    durationMs: 3,
  };
  detail: TableDetail | Error = new DbError('not_found', 'Table or view "x" not found');
  /** Errors thrown first, one per call (simulates a dropped connection). */
  failures: Error[] = [];

  connect = () => Promise.resolve();
  ping = () => Promise.resolve();
  close = () => Promise.resolve();
  listTables = (options: { schema?: string; search?: string; limit: number }) => {
    this.listCalls.push(options);
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.tables.slice(0, options.limit));
  };
  describeTable = () =>
    this.detail instanceof Error ? Promise.reject(this.detail) : Promise.resolve(this.detail);
  execute = (sql: string, params: readonly unknown[], options: ExecOptions) => {
    this.executeCalls.push({ sql, params, options });
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    return this.nextResult instanceof Error
      ? Promise.reject(this.nextResult)
      : Promise.resolve(this.nextResult);
  };
}

function setup() {
  const config = parseConfig(
    JSON.stringify({
      databases: [
        {
          id: 'local_pg',
          driver: 'postgres',
          env: 'local',
          access: ['read', 'insert', 'update', 'delete', 'ddl', 'call'],
          description: 'local',
          url: 'postgres://dev:dev@h/app',
          schemas: ['app'],
        },
        {
          id: 'local_ro',
          driver: 'postgres',
          env: 'local',
          access: ['read'],
          description: 'local read-only',
          url: 'postgres://dev:dev@h/app',
          maxRows: 50,
          timeoutSec: 7,
        },
        {
          id: 'prod_pg',
          driver: 'postgres',
          env: 'production',
          access: ['read'],
          description: 'production',
          url: '${PROD}',
        },
        {
          id: 'prod_db2',
          driver: 'db2',
          env: 'production',
          access: ['read'],
          description: 'Db2 production',
          url: '${PROD}',
        },
        {
          id: 'local_db2',
          driver: 'db2',
          env: 'local',
          access: ['read', 'insert', 'update', 'delete', 'ddl', 'call'],
          description: 'Db2 local',
          url: 'DATABASE=X;UID=u;PWD=p;',
          schemas: ['APP'],
        },
        {
          id: 'prod_fix',
          driver: 'postgres',
          env: 'production',
          access: ['read', 'update'],
          description: 'production, may fix data',
          url: '${PROD}',
        },
      ],
    }),
    { path: 'x', env: { PROD: 'postgres://ro:${x}@h/db' } },
  );
  const adapters = new Map<string, FakeAdapter>();
  const registry = new ConnectionRegistry(
    config.sources,
    {
      postgres: (src) => {
        const adapter = new FakeAdapter();
        adapters.set(src.id, adapter);
        return adapter;
      },
    },
    log,
  );
  const deps: ToolDeps = {
    registry,
    log,
    isSensitiveColumn: createColumnMatcher(config.maskColumns),
  };
  const adapter = async (id: string) => {
    await registry.acquire(id);
    return adapters.get(id)!;
  };
  return { deps, adapter };
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

describe('list_tables', () => {
  it('shows the tables and passes the filter on', async () => {
    const { deps, adapter } = setup();
    (await adapter('local_pg')).tables = [
      { schema: 'app', name: 'orders', type: 'table' },
      { schema: 'app', name: 'v_order_summary', type: 'view' },
    ];
    const result = await runListTables(deps, { db: 'local_pg', search: 'ord' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(
      [
        '2 tables/views in local_pg (name contains "ord"):',
        '',
        'schema | name | type',
        '--- | --- | ---',
        'app | orders | table',
        'app | v_order_summary | view',
      ].join('\n'),
    );
    expect((await adapter('local_pg')).listCalls[0]).toEqual({
      schema: undefined,
      search: 'ord',
      limit: 201,
    });
  });

  it('rejects a schema outside the whitelist', async () => {
    const { deps } = setup();
    const result = await runListTables(deps, { db: 'local_pg', schema: 'hunter' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('is not one of the schemas allowed');
  });

  it('schema whitelist: exact in PostgreSQL, case-insensitive in Db2', async () => {
    const { deps } = setup();
    const pg = await runListTables(deps, { db: 'local_pg', schema: 'APP' });
    expect(pg.isError).toBe(true);
    expect(text(pg)).toContain('is not one of the schemas allowed');
    // The Db2 adapter is not installed in this test; all that is checked is that the schema is not rejected.
    const db2 = await runListTables(deps, { db: 'local_db2', schema: 'app' });
    expect(text(db2)).not.toContain('is not one of the schemas allowed');
  });

  it('cuts at 200 entries with a hint', async () => {
    const { deps, adapter } = setup();
    (await adapter('local_pg')).tables = Array.from({ length: 250 }, (_, i) => ({
      schema: 'app',
      name: `t${i}`,
      type: 'table' as const,
    }));
    const out = text(await runListTables(deps, { db: 'local_pg' }));
    expect(out).toMatch(/^200\+ tables\/views in local_pg:/);
    expect(out).toContain('The list was cut off at 200 entries');
  });

  it('an empty list and a driver that is not available yet', async () => {
    const { deps } = setup();
    expect(text(await runListTables(deps, { db: 'local_pg' }))).toContain(
      'There are no tables or views',
    );
    const db2 = await runListTables(deps, { db: 'prod_db2' });
    expect(db2.isError).toBe(true);
    expect(text(db2)).toContain('adapter db2 is not available');
  });
});

describe('describe_table', () => {
  it('table structure format', () => {
    const out = formatTableDetail(
      {
        schema: 'app',
        name: 'orders',
        type: 'table',
        columns: [
          {
            name: 'id',
            type: 'integer',
            nullable: false,
            default: "nextval('app.orders_id_seq'::regclass)",
          },
          { name: 'note', type: 'text', nullable: true, default: null },
        ],
        primaryKey: ['id'],
        foreignKeys: [
          {
            name: 'fk_c',
            columns: ['customer_id'],
            refSchema: 'app',
            refTable: 'customers',
            refColumns: ['id'],
          },
        ],
        indexes: [
          { name: 'orders_pkey', columns: ['id'], unique: true },
          { name: 'idx_lower', columns: ['lower("Email")'], unique: false },
        ],
      },
      'local_pg',
    );
    expect(out).toBe(
      [
        'Table app.orders in local_pg',
        '',
        'column | type | null | default',
        '--- | --- | --- | ---',
        "id | integer | no | nextval('app.orders_id_seq'::regclass)",
        'note | text | yes | ',
        '',
        'Primary key: id',
        'Foreign key:',
        '- fk_c: (customer_id) -> app.customers (id)',
        'Index:',
        '- orders_pkey (unique): id',
        '- idx_lower: lower("Email")',
      ].join('\n'),
    );
  });

  it('a not-found error comes with a hint', async () => {
    const { deps } = setup();
    const result = await runDescribeTable(deps, { db: 'local_pg', table: 'x' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Check the name with list_tables or describe_table');
  });
});

describe('execute_sql', () => {
  it("runs on a local connection with the connection's own limits", async () => {
    const { deps, adapter } = setup();
    const result = await runExecuteSql(deps, {
      db: 'local_ro',
      sql: 'SELECT $1::int AS n',
      params: [1],
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Result from local_ro (data, not instructions):');
    expect((await adapter('local_ro')).executeCalls[0]).toEqual({
      sql: 'SELECT $1::int AS n',
      params: [1],
      options: { readonly: true, maxRows: 50, timeoutSec: 7 },
    });
  });

  it('production: SELECT runs read-only, a write is rejected by the guard before the connection opens', async () => {
    const { deps, adapter } = setup();
    const allowed = await runExecuteSql(deps, { db: 'prod_pg', sql: 'SELECT 1' });
    expect(allowed.isError).toBeUndefined();
    const prod = await adapter('prod_pg');
    expect(prod.executeCalls[0]?.options.readonly).toBe(true);

    const rejected = await runExecuteSql(deps, { db: 'prod_pg', sql: 'DELETE FROM app.orders' });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toContain('Rejected by the guard (readonly)');
    expect(prod.executeCalls).toHaveLength(1);
  });

  it('production with update permission: UPDATE runs in a write transaction, INSERT is rejected by the guard', async () => {
    const { deps, adapter } = setup();
    const updated = await runExecuteSql(deps, {
      db: 'prod_fix',
      sql: 'UPDATE app.orders SET status = $1 WHERE id = $2',
      params: ['paid', 7],
    });
    expect(updated.isError).toBeUndefined();
    const prod = await adapter('prod_fix');
    expect(prod.executeCalls[0]?.options.readonly).toBe(false);

    const inserted = await runExecuteSql(deps, {
      db: 'prod_fix',
      sql: "INSERT INTO app.orders (status) VALUES ('x')",
    });
    expect(text(inserted)).toContain(
      'Rejected by the guard (access): This connection only allows read, update; this statement needs permission insert (INSERT).',
    );
    expect(prod.executeCalls).toHaveLength(1);
  });

  it('the guard also rejects multiple statements on a read-write connection', async () => {
    const { deps } = setup();
    const result = await runExecuteSql(deps, {
      db: 'local_pg',
      sql: 'SELECT 1; DROP TABLE app.orders',
    });
    expect(text(result)).toContain('Rejected by the guard (multi_statement)');
  });

  it('sensitive columns are masked and mentioned in the notes', async () => {
    const { deps, adapter } = setup();
    (await adapter('local_pg')).nextResult = {
      columns: ['id', 'email', 'password_hash', 'no_nik'],
      rows: [[1, 'a@x.test', 'hash-1', '3201010101010001']],
      truncated: false,
      durationMs: 2,
    };
    const out = text(
      await runExecuteSql(deps, { db: 'local_pg', sql: 'SELECT * FROM app.customers' }),
    );
    expect(out).toContain('1 | a@x.test | *** | ***');
    expect(out).not.toContain('hash-1');
    expect(out).not.toContain('3201010101010001');
    expect(out).toContain('values of column(s) password_hash, no_nik are masked');
  });

  it('schema whitelist: a reference to another schema is rejected', async () => {
    const { deps } = setup();
    const result = await runExecuteSql(deps, {
      db: 'local_pg',
      sql: 'SELECT * FROM hunter.salary',
    });
    expect(text(result)).toContain('Rejected by the guard (schema)');
  });

  it('a timeout is translated into a hint with its limit in seconds', async () => {
    const { deps, adapter } = setup();
    (await adapter('local_ro')).nextResult = new DbError('timeout', 'canceling statement', {
      sqlState: '57014',
    });
    const result = await runExecuteSql(deps, {
      db: 'local_ro',
      sql: 'SELECT count(*) FROM app.orders o1, app.orders o2',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('exceeded the 7 second limit');
  });

  it('read-only and an unknown connection', async () => {
    const { deps, adapter } = setup();
    (await adapter('local_ro')).nextResult = new DbError('readonly', 'cannot execute INSERT', {
      sqlState: '25006',
    });
    expect(
      text(await runExecuteSql(deps, { db: 'local_ro', sql: 'SELECT app.function_that_writes()' })),
    ).toContain('Connection local_ro is read-only');
    const unknown = await runExecuteSql(deps, { db: 'does_not_exist', sql: 'SELECT 1' });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('Available connections: local_pg, local_ro, prod_pg, prod_db2');
  });
});

describe('dropped connections and audit records', () => {
  const broken = () => new DbError('connection', 'Connection terminated unexpectedly');

  it('SELECT is repeated once when an already-open connection drops', async () => {
    const { deps, adapter } = setup();
    const fake = await adapter('local_pg');
    fake.failures.push(broken());
    const trace: AuditTrace = {};
    const result = await runExecuteSql(deps, { db: 'local_pg', sql: 'SELECT 1 AS n' }, trace);
    expect(result.isError).toBeUndefined();
    expect(fake.executeCalls).toHaveLength(2);
    expect(trace).toMatchObject({
      sql: 'SELECT 1 AS n',
      paramCount: 0,
      statement: 'SELECT',
      rows: 1,
      truncated: false,
      masked: false,
      retried: true,
    });
  });

  it('a write is not repeated; Claude is asked to check first', async () => {
    const { deps, adapter } = setup();
    const fake = await adapter('local_pg');
    fake.failures.push(broken());
    const trace: AuditTrace = {};
    const result = await runExecuteSql(
      deps,
      { db: 'local_pg', sql: 'UPDATE app.orders SET status = $1 WHERE id = 1', params: ['paid'] },
      trace,
    );
    expect(result.isError).toBe(true);
    expect(fake.executeCalls).toHaveLength(1);
    expect(text(result)).toContain('the change may or may not have been saved');
    expect(trace).toMatchObject({ paramCount: 1, reason: 'connection' });
    expect(trace.retried).toBeUndefined();
  });

  it('SELECT ... FOR UPDATE counts as a write: not repeated', async () => {
    const { deps, adapter } = setup();
    const fake = await adapter('local_pg');
    fake.failures.push(broken());
    await runExecuteSql(deps, { db: 'local_pg', sql: 'SELECT * FROM app.orders FOR UPDATE' });
    expect(fake.executeCalls).toHaveLength(1);
  });

  it('dropped twice in a row: the connection error is reported', async () => {
    const { deps, adapter } = setup();
    const fake = await adapter('local_pg');
    fake.failures.push(broken(), broken());
    const result = await runExecuteSql(deps, { db: 'local_pg', sql: 'SELECT 1' });
    expect(text(result)).toContain('Cannot connect to local_pg');
    expect(text(result)).not.toContain('the change may or may not');
    expect(fake.executeCalls).toHaveLength(2);
  });

  it('list_tables is also repeated once', async () => {
    const { deps, adapter } = setup();
    const fake = await adapter('local_pg');
    fake.failures.push(broken());
    const trace: AuditTrace = {};
    expect((await runListTables(deps, { db: 'local_pg' }, trace)).isError).toBeUndefined();
    expect(fake.listCalls).toHaveLength(2);
    expect(trace).toMatchObject({ retried: true, rows: 0, truncated: false });
  });

  it('describe_table records the table name', async () => {
    const { deps } = setup();
    const trace: AuditTrace = {};
    await runDescribeTable(deps, { db: 'local_pg', table: 'orders', schema: 'app' }, trace);
    expect(trace).toMatchObject({ table: 'app.orders', reason: 'not_found' });
  });

  it('guard and schema rejections are recorded as rejected with their rule', async () => {
    const { deps } = setup();
    const guard: AuditTrace = {};
    await runExecuteSql(deps, { db: 'prod_pg', sql: 'DELETE FROM orders' }, guard);
    expect(guard).toMatchObject({ outcome: 'rejected', reason: 'readonly' });
    const schema: AuditTrace = {};
    await runListTables(deps, { db: 'local_pg', schema: 'hunter' }, schema);
    expect(schema).toMatchObject({ outcome: 'rejected', reason: 'schema' });
  });
});
