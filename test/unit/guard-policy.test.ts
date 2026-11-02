import { describe, expect, it } from 'vitest';
import type { SqlDialect } from '../../src/adapters/types.js';
import { checkSql, type GuardContext } from '../../src/guard/policy.js';

/** 'allow' or the name of the guard rule expected to reject. */
type Expectation = string;

function run(context: GuardContext, cases: [string, Expectation][]) {
  for (const [sql, expected] of cases) {
    const decision = checkSql(sql, context);
    const actual = decision.allowed ? 'allow' : decision.rule;
    it(`${expected === 'allow' ? 'allow' : `reject (${expected})`}: ${sql.replace(/\s+/g, ' ').slice(0, 90)}`, () => {
      expect(actual).toBe(expected);
    });
  }
}

const FULL: GuardContext['access'] = ['read', 'insert', 'update', 'delete', 'ddl', 'call'];

const ro = (dialect: SqlDialect, schemas?: string[]): GuardContext => ({
  dialect,
  access: ['read'],
  env: 'production',
  schemas,
});
const rw = (dialect: SqlDialect, env: GuardContext['env'] = 'local'): GuardContext => ({
  dialect,
  access: FULL,
  env,
});
const only = (
  dialect: SqlDialect,
  access: GuardContext['access'],
  env: GuardContext['env'] = 'production',
): GuardContext => ({ dialect, access, env });

describe('guard PostgreSQL, read-only', () => {
  run(ro('postgresql', ['app']), [
    // Legitimate read queries
    ['SELECT 1', 'allow'],
    ["select * from app.orders where status = 'paid'", 'allow'],
    ['SELECT * FROM orders WHERE id = $1', 'allow'],
    ['WITH t AS (SELECT 1 AS n) SELECT * FROM t', 'allow'],
    [
      'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT * FROM r',
      'allow',
    ],
    [
      'WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT * FROM a, b',
      'allow',
    ],
    ['(SELECT 1) UNION ALL (SELECT 2)', 'allow'],
    ['VALUES (1), (2)', 'allow'],
    ['TABLE app.orders', 'allow'],
    ['SHOW search_path', 'allow'],
    ['EXPLAIN SELECT * FROM app.orders', 'allow'],
    ['EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1', 'allow'],
    ['EXPLAIN ANALYZE VERBOSE SELECT 1', 'allow'],
    ['SELECT 1;', 'allow'],
    ['  SELECT 1 ;  ;  ', 'allow'],
    // Keywords inside a string, comment, or quoted identifier are not commands
    ["SELECT 'DELETE FROM app.orders; DROP TABLE x' AS text", 'allow'],
    ['SELECT 1 -- DROP TABLE app.orders', 'allow'],
    ['SELECT /* ; DELETE FROM app.orders */ 1', 'allow'],
    ['SELECT $$ DROP TABLE x; $$ AS s', 'allow'],
    ['SELECT $tag$ ; DELETE FROM x $tag$ AS s', 'allow'],
    ["SELECT E'it\\'s; DROP TABLE x' AS s", 'allow'],
    ['SELECT "update", "delete" FROM app.orders', 'allow'],
    ['SELECT t.update FROM app.orders t', 'allow'],
    ["SELECT replace(status, 'a', 'b') FROM app.orders", 'allow'],
    ["SELECT data ? 'key' FROM app.orders", 'allow'],
    ['SELECT * FROM generate_series(1, 3) AS g(n)', 'allow'],
    ['SELECT * FROM pg_catalog.pg_tables', 'allow'],
    ['SELECT table_name FROM information_schema.tables', 'allow'],
    ["SELECT current_setting('search_path')", 'allow'],

    // Structure and statement count
    ['', 'empty'],
    [' ; ; ', 'empty'],
    ['-- comment only', 'empty'],
    ['SELECT 1; SELECT 2', 'multi_statement'],
    ['SELECT 1; DROP TABLE app.orders', 'multi_statement'],
    ['SELECT 1 /* /* */ ; DELETE FROM app.orders; /* */', 'multi_statement'],

    // Write commands
    ['INSERT INTO app.orders VALUES (1)', 'readonly'],
    ['UPDATE app.orders SET status = $1', 'readonly'],
    ['DELETE FROM app.orders', 'readonly'],
    ['MERGE INTO app.orders o USING app.x x ON o.id = x.id WHEN MATCHED THEN DELETE', 'readonly'],
    ['CREATE TABLE app.x (a int)', 'readonly'],
    ['TRUNCATE app.orders', 'readonly'],
    ['VACUUM app.orders', 'readonly'],
    ['CALL app.proc()', 'readonly'],
    ['EXPLAIN ANALYZE DELETE FROM app.orders', 'readonly'],
    ['WITH d AS (DELETE FROM app.orders RETURNING *) SELECT * FROM d', 'readonly_write'],
    [
      'WITH u AS (UPDATE app.orders SET status = $1 RETURNING id) SELECT count(*) FROM u',
      'readonly_write',
    ],
    ['SELECT * FROM app.orders FOR UPDATE', 'lock'],
    ['SELECT * FROM app.orders FOR NO KEY UPDATE SKIP LOCKED', 'lock'],
    ['SELECT * FROM app.orders FOR SHARE', 'lock'],
    ['SELECT * INTO app.copy FROM app.orders', 'select_into'],

    // Dangerous functions
    ['SELECT pg_sleep(30)', 'denied_function'],
    ['SELECT pg_catalog.pg_sleep(1)', 'denied_function'],
    ['SELECT "pg_sleep"(1)', 'denied_function'],
    ["SELECT set_config('statement_timeout', '0', false)", 'denied_function'],
    ["SELECT query_to_xml('select * from hunter.t', true, true, '')", 'denied_function'],
    ["SELECT table_to_xml('hunter.t', true, true, '')", 'denied_function'],
    ["SELECT * FROM dblink('host=x', 'select 1') AS t(a int)", 'denied_function'],
    ["SELECT pg_read_file('/etc/passwd')", 'denied_function'],
    ["SELECT pg_ls_dir('/')", 'denied_function'],
    ['SELECT pg_terminate_backend(123)', 'denied_function'],
    [
      "SELECT * FROM crosstab('select * from hunter.salary') AS t(a text, b int)",
      'denied_function',
    ],
    [
      "SELECT * FROM connectby('hunter.tree', 'id', 'parent', '1', 0) AS t(id int)",
      'denied_function',
    ],
    ["SELECT pg_file_write('/tmp/x', 'content', false)", 'denied_function'],
    ["SELECT pg_notify('channel', 'message')", 'denied_function'],

    // Transactions, sessions, dynamic SQL, other statements
    ['BEGIN', 'transaction_control'],
    ['COMMIT', 'transaction_control'],
    ['ROLLBACK', 'transaction_control'],
    ['START TRANSACTION READ WRITE', 'transaction_control'],
    ['SET statement_timeout = 0', 'session_command'],
    ['SET ROLE postgres', 'session_command'],
    ['SET SESSION AUTHORIZATION postgres', 'session_command'],
    ['RESET ALL', 'session_command'],
    ['DISCARD ALL', 'session_command'],
    ['DO $$ BEGIN DELETE FROM app.orders; END $$', 'dynamic_sql'],
    ['EXECUTE stmt(1)', 'dynamic_sql'],
    ['PREPARE p AS DELETE FROM app.orders', 'dynamic_sql'],
    ["COPY app.orders TO '/tmp/x.csv'", 'unsupported'],
    ["COPY app.orders TO PROGRAM 'curl http://x'", 'unsupported'],
    ['GRANT SELECT ON app.orders TO public', 'denied_statement'],
    ['LISTEN channel', 'unsupported'],

    // Whitelist schema
    ['SELECT * FROM hunter.salary', 'schema'],
    ['SELECT * FROM "hunter"."salary"', 'schema'],
    ['SELECT * FROM app.orders o JOIN hunter.salary g ON g.id = o.id', 'schema'],
    ['SELECT * FROM app.orders, hunter.salary', 'schema'],
    ['SELECT * FROM (SELECT * FROM hunter.salary) x', 'schema'],
    ['SELECT * FROM app.orders WHERE id IN (SELECT id FROM hunter.salary)', 'schema'],
    ['SELECT * FROM "App".orders', 'schema'],

    // Cannot be analyzed: rejected on a read-only connection
    ["SELECT 'not closed", 'parse'],
    ['SELECT /* not closed', 'parse'],
    ['SELECT $$ not closed', 'parse'],
    ['SELECT "not closed', 'parse'],
  ]);
});

describe('PostgreSQL guard, read-write (local)', () => {
  run(rw('postgresql'), [
    ['INSERT INTO app.orders (customer_id, total, status) VALUES ($1, $2, $3)', 'allow'],
    ['UPDATE app.orders SET status = $1 WHERE id = $2', 'allow'],
    ['DELETE FROM app.orders WHERE id = $1', 'allow'],
    ['CREATE TABLE app.x (a int)', 'allow'],
    ['CREATE INDEX idx ON app.x (a)', 'allow'],
    ['WITH d AS (DELETE FROM app.orders WHERE id = 1 RETURNING *) SELECT * FROM d', 'allow'],
    ['SELECT * FROM app.orders FOR UPDATE', 'allow'],
    ['CALL app.proc()', 'allow'],
    ['DROP DATABASE app', 'denied_statement'],
    ['DROP SCHEMA app CASCADE', 'denied_statement'],
    ["CREATE USER x PASSWORD 'y'", 'denied_statement'],
    ['ALTER ROLE x SUPERUSER', 'denied_statement'],
    ["ALTER SYSTEM SET log_statement = 'all'", 'denied_statement'],
    ['GRANT ALL ON app.orders TO x', 'denied_statement'],
    ['REVOKE ALL ON app.orders FROM x', 'denied_statement'],
    ['BEGIN', 'transaction_control'],
    ['SELECT pg_sleep(1)', 'denied_function'],
    ['INSERT INTO app.x SELECT 1; DELETE FROM app.x', 'multi_statement'],
    ["SELECT 'not closed", 'allow'],
  ]);
});

describe('PostgreSQL guard, read-write (staging): SQL that cannot be analyzed is still rejected', () => {
  run(rw('postgresql', 'staging'), [
    ["SELECT 'not closed", 'parse'],
    ['UPDATE app.orders SET status = $1', 'allow'],
  ]);
});

describe('guard MySQL, read-only', () => {
  run(ro('mysql', ['app']), [
    ['SELECT * FROM `orders` WHERE id = ?', 'allow'],
    ['SELECT * FROM APP.orders', 'allow'],
    ['SELECT 1 # comment ; DROP TABLE x', 'allow'],
    ['SELECT 1 -- comment ; DROP TABLE x', 'allow'],
    ['SELECT 1--1', 'allow'],
    ['SELECT "double-quoted string; DROP TABLE x"', 'allow'],
    ["SELECT 'it\\'s; DROP TABLE x'", 'allow'],
    ["SELECT REPLACE('a', 'a', 'b'), INSERT('abc', 1, 1, 'x')", 'allow'],
    ['SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1', 'allow'],
    ['SELECT @@version, @x', 'allow'],
    ['SHOW TABLES', 'allow'],
    ['DESCRIBE orders', 'allow'],
    ['EXPLAIN SELECT * FROM orders', 'allow'],
    ['EXPLAIN FORMAT=JSON SELECT * FROM orders', 'allow'],
    ['SELECT * FROM information_schema.TABLES', 'allow'],

    ['SELECT * FROM orders INTO OUTFILE "/tmp/x"', 'denied_statement'],
    ["SELECT 1--1 INTO OUTFILE '/tmp/x'", 'denied_statement'],
    // NO_BACKSLASH_ESCAPES: code can "hide" in a string under one interpretation; every interpretation must pass.
    ["SELECT 'x\\' INTO OUTFILE '/tmp/y' -- '", 'denied_statement'],
    ['SELECT * FROM orders LOCK IN SHARE MODE', 'lock'],
    ['SELECT * FROM orders FOR UPDATE', 'lock'],
    ['SELECT SLEEP(10)', 'denied_function'],
    ["SELECT BENCHMARK(100000000, MD5('x'))", 'denied_function'],
    ["SELECT LOAD_FILE('/etc/passwd')", 'denied_function'],
    ["SELECT GET_LOCK('x', 10)", 'denied_function'],
    ['/*! DROP TABLE orders */ SELECT 1', 'executable_comment'],
    ['SELECT 1 /*!50000 , SLEEP(10) */', 'executable_comment'],
    ['REPLACE INTO orders VALUES (1)', 'readonly'],
    ['SELECT * INTO @x FROM orders', 'select_into'],
    ["LOAD DATA INFILE '/tmp/x' INTO TABLE orders", 'unsupported'],
    ['HANDLER orders OPEN', 'dynamic_sql'],
    ['USE mysql', 'session_command'],
    ['SELECT * FROM mysql.user', 'schema'],
    ['SELECT * FROM `mysql`.`user`', 'schema'],
    ['SELECT * FROM performance_schema.events_statements_history', 'schema'],
    ['SELECT 1; SELECT 2', 'multi_statement'],
  ]);
});

describe('guard MariaDB, read-only', () => {
  run(ro('mariadb'), [
    ['SELECT * FROM orders', 'allow'],
    ['SELECT 1 /*M!100000 , SLEEP(10) */', 'executable_comment'],
    ['SELECT * FROM orders INTO DUMPFILE "/tmp/x"', 'denied_statement'],
  ]);
});

describe('guard Db2, read-only', () => {
  run(ro('db2', ['CORE']), [
    ['SELECT * FROM CORE.ORDERS FETCH FIRST 10 ROWS ONLY', 'allow'],
    ['select * from core.orders where id = ?', 'allow'],
    ['SELECT 1 FROM SYSIBM.SYSDUMMY1', 'allow'],
    ['SELECT TABNAME FROM SYSCAT.TABLES WHERE TABSCHEMA = ?', 'allow'],
    ['SELECT * FROM CORE.ORDERS WITH UR', 'allow'],
    ['VALUES 1', 'allow'],
    ['WITH T AS (SELECT 1 AS N FROM SYSIBM.SYSDUMMY1) SELECT N FROM T', 'allow'],

    ['SELECT * FROM "core".ORDERS', 'schema'],
    ['SELECT * FROM PAYROLL.SALARY', 'schema'],
    ['SELECT * FROM FINAL TABLE (INSERT INTO CORE.T VALUES (1))', 'readonly_write'],
    ['SELECT * FROM CORE.ORDERS WITH RS USE AND KEEP UPDATE LOCKS', 'lock'],
    ['SELECT * FROM CORE.ORDERS FOR UPDATE', 'lock'],
    [
      "CALL SYSPROC.ADMIN_CMD('EXPORT TO /tmp/x OF DEL SELECT * FROM CORE.ORDERS')",
      'denied_function',
    ],
    ['CALL CORE.HITUNG_ULANG()', 'readonly'],
    ['EXPLAIN PLAN FOR SELECT * FROM CORE.ORDERS', 'unsupported'],
    ["EXECUTE IMMEDIATE 'DELETE FROM CORE.ORDERS'", 'dynamic_sql'],
    ['SET CURRENT SCHEMA PAYROLL', 'session_command'],
  ]);
});

describe('Db2 guard, read-write (local)', () => {
  run(rw('db2'), [
    ['INSERT INTO APP.ORDERS (CUSTOMER_ID, TOTAL, STATUS) VALUES (?, ?, ?)', 'allow'],
    ["CALL SYSPROC.ADMIN_CMD('REORG TABLE APP.ORDERS')", 'denied_function'],
  ]);
});

describe('guard: partial write permissions (production, read + update + delete)', () => {
  run(only('postgresql', ['read', 'update', 'delete']), [
    ['SELECT * FROM orders', 'allow'],
    ["UPDATE orders SET status = 'paid' WHERE id = $1", 'allow'],
    ['DELETE FROM orders WHERE id = $1', 'allow'],
    ['WITH d AS (DELETE FROM orders WHERE id = 1 RETURNING *) SELECT * FROM d', 'allow'],
    ['SELECT * FROM orders WHERE id = 1 FOR UPDATE', 'allow'],
    ['INSERT INTO orders (id) VALUES (1)', 'access'],
    ['INSERT INTO orders (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1', 'access'],
    ['MERGE INTO orders o USING x ON o.id = x.id WHEN MATCHED THEN DELETE', 'access'],
    ['TRUNCATE orders', 'access'],
    ['CREATE TABLE x (a int)', 'access'],
    ['DROP TABLE orders', 'access'],
    ['CALL app.proc()', 'access'],
    ['SELECT * INTO new_table FROM orders', 'access'],
    // Always rejected, whatever the permissions.
    ['GRANT SELECT ON orders TO public', 'denied_statement'],
    ['DROP DATABASE app', 'denied_statement'],
    ['BEGIN', 'transaction_control'],
    ['SELECT pg_sleep(5)', 'denied_function'],
  ]);
});

describe('guard: insert permission only (MySQL)', () => {
  run(only('mysql', ['read', 'insert']), [
    ["INSERT INTO orders (status) VALUES ('new')", 'allow'],
    ['INSERT INTO orders (id) VALUES (1) ON DUPLICATE KEY UPDATE status = 1', 'access'],
    ['REPLACE INTO orders (id) VALUES (1)', 'access'],
    ['UPDATE orders SET status = 1', 'access'],
    ['SELECT * FROM orders LOCK IN SHARE MODE', 'access'],
    ['SELECT REPLACE(status, "a", "b") FROM orders', 'allow'],
  ]);
});

describe('guard: ddl and call permissions (Db2)', () => {
  run(only('db2', ['read', 'ddl', 'call'], 'staging'), [
    ['CREATE TABLE APP.X (A INT)', 'allow'],
    ['CALL APP.HITUNG()', 'allow'],
    ['TRUNCATE TABLE APP.ORDERS IMMEDIATE', 'access'],
    ['DELETE FROM APP.ORDERS', 'access'],
    ['SELECT * FROM FINAL TABLE (INSERT INTO APP.ORDERS (A) VALUES (1))', 'access'],
  ]);
});

describe('guard: SQL that cannot be analyzed', () => {
  it('local with every write permission: allowed with a warning', () => {
    const decision = checkSql("SELECT 'not closed", rw('postgresql'));
    expect(decision.allowed).toBe(true);
  });
  it('local with partial write permissions: rejected, because the content is unknown', () => {
    const decision = checkSql(
      "SELECT 'not closed",
      only('postgresql', ['read', 'insert'], 'local'),
    );
    expect(decision.allowed ? 'allow' : decision.rule).toBe('parse');
  });
});

describe('permission rejection message', () => {
  it('names the connection permissions and the missing permission with the reason', () => {
    const decision = checkSql(
      'INSERT INTO orders (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1',
      only('postgresql', ['read', 'update']),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toBe(
        'This connection only allows read, update; this statement needs permission insert (INSERT).',
      );
    }
  });
});

describe('SQLite guard, read-only', () => {
  run(ro('sqlite'), [
    ['SELECT * FROM orders', 'allow'],
    ['SELECT * FROM [order details] WHERE [id] = ?', 'allow'],
    ['SELECT * FROM `orders`', 'allow'],
    ["SELECT * FROM pragma_table_info('orders')", 'allow'],
    // A word inside [ ] or ` ` is a name, not a command.
    ['SELECT [delete] FROM orders', 'allow'],
    ['SELECT * FROM [x; DROP TABLE orders]', 'allow'],
    ['INSERT INTO orders (id) VALUES (1)', 'readonly'],
    ['SELECT * FROM [not closed', 'parse'],
  ]);
});

describe('SQLite guard, every write permission', () => {
  run(rw('sqlite'), [
    ['INSERT OR REPLACE INTO orders (id) VALUES (1)', 'allow'],
    ['INSERT INTO orders (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 2', 'allow'],
    ['DELETE FROM orders WHERE id = 1 RETURNING id', 'allow'],
    ['VACUUM', 'allow'],
    ['CREATE TABLE x (a)', 'allow'],
    // Always rejected: opening another file, changing settings, writing a file, loading native code.
    ["ATTACH DATABASE '/etc/hunter.db' AS r", 'unsupported'],
    ['DETACH DATABASE r', 'unsupported'],
    ['PRAGMA writable_schema = ON', 'session_command'],
    ['PRAGMA table_info(orders)', 'session_command'],
    ["VACUUM INTO '/tmp/copy.db'", 'denied_statement'],
    ["SELECT load_extension('/tmp/x.so')", 'denied_function'],
    ["SELECT writefile('/tmp/x', 'content')", 'denied_function'],
    ["SELECT readfile('/etc/passwd')", 'denied_function'],
    ['BEGIN IMMEDIATE', 'transaction_control'],
  ]);
});

describe('SQLite guard: insert permission only', () => {
  run(only('sqlite', ['read', 'insert'], 'local'), [
    ["INSERT INTO orders (status) VALUES ('new')", 'allow'],
    ['INSERT OR REPLACE INTO orders (id) VALUES (1)', 'access'],
    ['REPLACE INTO orders (id) VALUES (1)', 'access'],
  ]);
});

describe('guard result', () => {
  it('returns statement information for the log', () => {
    const decision = checkSql('WITH x AS (SELECT 1) SELECT * FROM x', ro('postgresql'));
    expect(decision.allowed).toBe(true);
    expect(decision.allowed ? decision.statement?.head : '').toBe('SELECT');
  });

  it('a warning when SQL cannot be analyzed on a read-write local connection', () => {
    const decision = checkSql("SELECT 'x", rw('postgresql'));
    expect(decision.allowed).toBe(true);
    expect(decision.allowed ? decision.warnings[0] : '').toMatch(/could not analyze/);
  });

  it('the rejection message gives a reason that can be acted on', () => {
    const decision = checkSql('SELECT * FROM hunter.salary', ro('postgresql', ['app']));
    expect(decision.allowed ? '' : decision.message).toBe(
      'hunter.salary is in schema hunter, outside the schemas allowed for this connection (app).',
    );
  });
});
