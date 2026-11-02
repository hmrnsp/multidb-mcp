# multidb-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude Code guarded
access to **PostgreSQL, MySQL/MariaDB, IBM Db2 LUW, SQLite, and Redis** through one small set of tools.

Every connection declares what it may do (`read`, `insert`, `update`, `delete`, `ddl`, `call`) in a
config file. A SQL guard checks each request **before** it reaches the database, results are
truncated and masked, and every tool call is written to an audit log.

> [!IMPORTANT]
> The guard is the first layer of defense, not the only one. Always connect with a database user
> that has only the privileges the connection needs. See [Security model](#security-model).

[Bahasa Indonesia](README.id.md)

## Contents

- [Features](#features)
- [Tools](#tools)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Permissions (`access`)](#permissions-access)
- [The SQL guard](#the-sql-guard)
- [Per-database notes](#per-database-notes)
- [Running with Docker](#running-with-docker)
- [Using it in an application project](#using-it-in-an-application-project)
- [Audit log and reconnecting](#audit-log-and-reconnecting)
- [Security model](#security-model)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Features

- **One config, many databases.** PostgreSQL, MySQL, MariaDB, Db2 LUW, SQLite, and Redis.
- **Explicit permissions per connection**, the same rules for every environment, including production.
- **A SQL guard** built on a dependency-free, dialect-aware lexer: one statement per call, permission
  checks, a deny-list of dangerous functions and statements, and a schema whitelist.
- **Redis allowlist** of safe commands, with limits on commands that could stall the server.
- **Limits and masking:** a row limit, a timeout, an output size limit, and masking of sensitive
  columns, keys, and fields.
- **No credentials in output:** passwords and hosts are redacted from errors, logs, and tool results,
  and checked by a leak test.
- **Audit log** with one JSON line per tool call, rotated daily.
- **Reconnects** after a dropped connection (reads are retried once; writes never are).
- **Adding a database kind** means writing one adapter; tools and the guard do not change.

## Tools

The server only registers the tools that the configured connections need.

| Tool             | Purpose                                                                 | Registered when    |
| ---------------- | ----------------------------------------------------------------------- | ------------------ |
| `list_databases` | List connections: id, driver, env, permissions, limits, status, purpose | always             |
| `list_tables`    | List tables and views, with an optional schema and name search          | a SQL connection   |
| `describe_table` | Columns, primary key, foreign keys, and indexes of one table            | a SQL connection   |
| `execute_sql`    | Run **one** SQL statement; parameters are bound, never concatenated     | a SQL connection   |
| `redis_command`  | Run **one** Redis command, e.g. `HGETALL user:42` or `SCAN 0 MATCH ...` | a Redis connection |

The `db` parameter of every tool is an enum of the connection ids from your config, so the model
cannot invent a connection name. Table contents are returned labeled as data, not instructions.

## Quick start

Requirements: **Node.js 24 LTS** and a database to connect to. Docker is needed to run Db2 (see
[Running with Docker](#running-with-docker)) and for the development databases.

```bash
git clone https://github.com/hmrnsp/multidb-mcp.git
cd multidb-mcp
npm install
npm run build
```

Create `databases.json` next to your project (see [Configuration](#configuration)) and a separate
env file for the credentials, then register the server in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "multidb": {
      "command": "node",
      "args": [
        "/absolute/path/to/multidb-mcp/dist/index.js",
        "--config",
        "databases.json",
        "--dotenv",
        ".env.multidb"
      ]
    }
  }
}
```

Open the project in Claude Code, approve the `multidb` server, and run `/mcp`: the server should be
**connected**. Then ask, for example, _"which databases are available?"_

To try it without any setup of your own, use the development databases of this repository:

```bash
cp .env.example .env
npm run db:up          # PostgreSQL, MySQL, MariaDB, Redis in Docker
npm run seed:sqlite    # a sample SQLite file in .data/
npm run seed:redis     # sample cache/session/queue keys
npm run build
```

The `.mcp.json` of this repository already starts the server with `databases.dev.json`.

## Configuration

A project needs three files:

| File             | Contents                                      | Commit it?       |
| ---------------- | --------------------------------------------- | ---------------- |
| `.mcp.json`      | How Claude Code starts the server             | yes              |
| `databases.json` | The list of connections                       | yes (no secrets) |
| `.env.multidb`   | Credentials, referenced from `databases.json` | **never**        |

```json
{
  "defaults": { "maxRows": 200, "timeoutSec": 30, "maxChars": 40000 },
  "maskColumns": ["salary", "account_no"],
  "databases": [
    {
      "id": "local_mysql",
      "driver": "mysql",
      "env": "local",
      "access": ["read", "insert", "update", "delete", "ddl"],
      "description": "Laravel application database for development",
      "url": "${LOCAL_MYSQL_URL}"
    },
    {
      "id": "prod_db2",
      "driver": "db2",
      "env": "production",
      "access": ["read"],
      "description": "Core transaction data, for reports only",
      "url": "${PROD_DB2_CONN}",
      "maxRows": 500,
      "schemas": ["CORE", "REPORT"]
    }
  ]
}
```

Complete examples live in [`templates/`](templates).

| Field                                 | Required | Default       | Meaning                                                                    |
| ------------------------------------- | -------- | ------------- | -------------------------------------------------------------------------- |
| `id`                                  | yes      |               | Unique id (lower-case letters, digits, `_`); becomes the `db` enum value   |
| `driver`                              | yes      |               | `postgres`, `mysql`, `mariadb`, `db2`, `sqlite`, or `redis`                |
| `env`                                 | yes      |               | `local`, `staging`, or `production`                                        |
| `access`                              | yes      |               | Permissions, see [below](#permissions-access)                              |
| `description`                         | yes      |               | What the connection is for; the model uses it to pick a connection         |
| `url`                                 | yes      |               | Connection string; secrets must come from `${VAR}`                         |
| `maxRows` / `timeoutSec` / `maxChars` | no       | from defaults | Limits for this connection                                                 |
| `schemas`                             | no       | all           | Schema whitelist for list, describe, and queries (not for SQLite or Redis) |
| `lazy`                                | no       | `true`        | Open the connection on first use                                           |

`maskColumns` **adds** to the built-in patterns (`password`, `token`, `secret`, `nik`, `card_number`,
and others); it never replaces them.

Rules enforced when the server starts (it refuses to start otherwise, naming the problem):

- Unknown fields are rejected, so a typo such as `readOnly` cannot silently do nothing.
- A `${VAR}` that is missing or empty is an error; every missing variable is reported at once.
- A literal password in `url` is rejected for `staging` and `production`.
- `access` must be present and contain `read`; unknown or repeated values are rejected.

Command line: `--config <file>`, `--dotenv <file>` (not `--env-file`, which Node.js intercepts),
`--log-level`, `--log-file`, `--audit-dir`, `--audit-keep-days`, `--no-audit`. Run with `--help`.

Passwords inside a URL must be URL-encoded. The simplest approach is to keep the whole connection
string in one variable: `"url": "${PROD_PG_URL}"`.

## Permissions (`access`)

Every connection **must** list its permissions. They are the same for every environment; there is no
hidden default.

```json
{ "id": "reports_db2", "env": "production", "access": ["read"] }
{ "id": "prod_pg",     "env": "production", "access": ["read", "update", "delete"] }
{ "id": "local_pg",    "env": "local",      "access": ["read", "insert", "update", "delete", "ddl", "call"] }
```

| Value    | Allows                                                                        |
| -------- | ----------------------------------------------------------------------------- |
| `read`   | SELECT, WITH…SELECT, VALUES, SHOW, DESCRIBE, EXPLAIN. **Required**            |
| `insert` | INSERT                                                                        |
| `update` | UPDATE, including `FOR UPDATE` / `LOCK IN SHARE MODE`                         |
| `delete` | DELETE                                                                        |
| `ddl`    | CREATE, ALTER, DROP, VACUUM, `SELECT … INTO` (PostgreSQL creates a new table) |
| `call`   | CALL (stored procedures). Not applicable to SQLite                            |

The guard looks for write words in the **whole** statement, so one statement can need several permissions:

| Statement                                                            | Permissions needed             |
| -------------------------------------------------------------------- | ------------------------------ |
| `INSERT … ON CONFLICT DO UPDATE`, `INSERT … ON DUPLICATE KEY UPDATE` | `insert` + `update`            |
| `MERGE`                                                              | `insert` + `update` + `delete` |
| `REPLACE` (MySQL)                                                    | `insert` + `delete`            |
| `TRUNCATE`                                                           | `ddl` + `delete`               |
| `WITH d AS (DELETE …) SELECT …`, `FINAL TABLE (INSERT …)`            | `delete` / `insert`            |

- A `["read"]` connection also uses a read-only transaction in the database (PostgreSQL, MySQL,
  MariaDB, SQLite). Connections that may write use a normal transaction; the guard enforces which
  statement kinds are allowed, and the database user's privileges remain the last layer.
- `list_databases` shows each connection's permissions, and the server instructions ask Claude to
  explain a change and get your approval before writing to production.
- The old `readonly` field is rejected at startup with a message explaining the replacement.

## The SQL guard

Queries rejected by the guard never touch the database.

| Rule                                                                                                                                | Read-only (`["read"]`) | With write permissions                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| More than one statement                                                                                                             | Rejected               | Rejected                                                                  |
| SELECT, WITH…SELECT, VALUES, SHOW, DESCRIBE, EXPLAIN                                                                                | Allowed                | Allowed                                                                   |
| INSERT, UPDATE, DELETE, MERGE, DDL, CALL                                                                                            | Rejected               | According to `access`                                                     |
| Hidden write words (a deleting CTE, `FINAL TABLE (INSERT …)`)                                                                       | Rejected               | According to `access`                                                     |
| `FOR UPDATE`, `LOCK IN SHARE MODE`, `USE AND KEEP … LOCKS`                                                                          | Rejected               | Needs `update`                                                            |
| `SELECT … INTO`                                                                                                                     | Rejected               | Needs `ddl`                                                               |
| GRANT, REVOKE, CREATE/ALTER/DROP USER/ROLE, DROP DATABASE/SCHEMA, ALTER SYSTEM                                                      | Rejected               | Rejected                                                                  |
| BEGIN/COMMIT/ROLLBACK, SET/RESET/USE                                                                                                | Rejected               | Rejected                                                                  |
| DO, EXECUTE, PREPARE, HANDLER, COPY, LOAD DATA, `INTO OUTFILE`                                                                      | Rejected               | Rejected                                                                  |
| Dangerous functions (`pg_sleep`, `set_config`, `pg_read_file`, `dblink`, `crosstab`, `*_to_xml`, `SLEEP`, `LOAD_FILE`, `ADMIN_CMD`) | Rejected               | Rejected                                                                  |
| MySQL executable comments `/*! … */`                                                                                                | Rejected               | Rejected                                                                  |
| A schema-qualified table outside `schemas` (system catalogs stay readable)                                                          | Rejected               | Rejected                                                                  |
| SQL that cannot be analyzed (an unterminated string or comment)                                                                     | Rejected               | Allowed with a warning, only for `env: local` with every write permission |

How it works:

- The guard uses a dependency-free SQL lexer per dialect. A keyword inside a string, a comment, or a
  quoted identifier is not treated as a command.
- Where the lexer could read the text differently from the server, it picks the reading that sees
  **more** code: block comments do not nest, the `--` rule follows MySQL exactly, and strings with
  backslashes are checked in two modes.
- A table name without a schema is limited by the connection's `search_path` (PostgreSQL) or default
  schema, not by the guard.

### Column masking

The values of columns whose names match `maskColumns` are replaced with `***`. Matching is per name
segment: `no_nik` and `password_hash` are masked, `technique` is not.

Masking works on the result's column names, so an alias (`SELECT password AS x`) can get past it. For
data that is truly secret, use a database user without access to that column, or expose a VIEW.

## Per-database notes

### PostgreSQL

- Every query runs in its own transaction: `BEGIN [READ ONLY]`, then `statement_timeout` and
  `search_path` (when `schemas` is set), then a cursor that stops at `maxRows + 1`, then `ROLLBACK`
  (read-only) or `COMMIT` (write permissions).
- A connection with write permissions runs `DISCARD ALL` after each query, so a session `SET` does not
  carry over to the next query.
- `date`, `timestamp`, `time`, and `interval` come back as text exactly as the database sends them,
  with no time zone conversion. `bigint` and `numeric` are text too, so no precision is lost.

### MySQL and MariaDB

- One adapter for both (`mysql2`). The `driver` in the config must match the server: on connect the
  adapter checks `VERSION()` and refuses a `mysql` connection that is really MariaDB, or the reverse,
  because the guard's lexer rules and the timeout mechanism differ.
- Each query sets a session timeout (`max_execution_time` in ms for MySQL, `max_statement_time` in
  seconds for MariaDB), starts `START TRANSACTION [READ ONLY]`, reads `maxRows + 1` rows, then ends
  with `ROLLBACK` or `COMMIT`.
- MySQL's `max_execution_time` only covers SELECT, so a watchdog sends `KILL QUERY` from a separate
  connection one second after the limit (for example for a slow UPDATE).
- When a read result exceeds `maxRows`, the connection is dropped and the query is `KILL`ed: closing
  the socket alone does not stop the query on the server. On a connection that may write, the
  remaining rows are still read (and discarded) so a statement such as MariaDB's `DELETE … RETURNING`
  completes before `COMMIT`.
- A connection that may write is reset (`COM_RESET_CONNECTION`) after each query, the equivalent of
  PostgreSQL's `DISCARD ALL`.
- Queries with `params` run as prepared statements (values are bound on the server and the statement
  is closed again afterwards).
- When `schemas` is set, the default database in the connection string must be one of them.
- Only the `ssl` and `charset` URL parameters are accepted (so `?multipleStatements=true` is refused),
  and `LOAD DATA LOCAL INFILE` is disabled at the protocol level.
- `BIGINT` and `DECIMAL` come back as text, and so do `DATE`, `DATETIME`, and `TIMESTAMP`.

### IBM Db2 LUW

- Db2 for i and Db2 for z/OS need a DB2 Connect license and are **not** supported (`SQL1598N`).
- **The server must run in the Docker image on most modern Linux distributions.** IBM's CLI driver
  needs `libxml2.so.2`, which distributions such as Ubuntu 26.04 no longer ship. See
  [Running with Docker](#running-with-docker).
- Each query: `prepare`, `SQL_ATTR_QUERY_TIMEOUT`, read `maxRows + 1` rows, then `ROLLBACK` or
  `COMMIT`. Closing the result set closes the server-side cursor.
- **Db2 does not enforce read-only transactions** (the CLI read-only access mode is ignored; this was
  tested). A `["read"]` connection is protected by the guard, an always-executed `ROLLBACK`, and a
  database user that only has SELECT. For a read-only production connection a SELECT-only user is a
  must; for one with write permissions, grant the database user no more than `access` allows.
- When `schemas` is set, the adapter appends `CurrentSchema=<first schema>` to the connection string.
- Unquoted names are stored upper-case. `list_tables`, `describe_table`, and the `schema` parameter
  accept lower-case: `orders` means `ORDERS`.
- **DECIMAL:** `ibm_db` always reads DECIMAL as a double. A value below 10^(15 − scale) is restored
  exactly as text with the column's scale (`1.50`), including `SUM()` results. Larger values, and all
  DECFLOAT values, may be inexact; the result then carries a note suggesting
  `CAST(column AS VARCHAR(40))`.
- On a query timeout `ibm_db` drops the SQL0952N message (an empty error). The adapter recognizes it
  from the elapsed time and reports a timeout.

### SQLite

- No extra dependency: it uses Node's built-in `node:sqlite`.
- `url` looks like `sqlite:<file path>`. A relative path is resolved from the **folder of the config
  file**, e.g. `"url": "sqlite:./database/database.sqlite"`. An absolute path works too.
- The file must already exist; the adapter never creates a database. A `["read"]` connection opens
  the file read-only, so **SQLite itself refuses writes**.
- `node:sqlite` is synchronous: a running query cannot be stopped from inside, even with
  `worker.terminate()` (tested). So each SQLite connection runs in its **own child process**. A
  timeout kills that process; the operating system releases the file lock, SQLite rolls back the
  unfinished transaction, and the connection reopens on the next query.
- Always rejected: `ATTACH`/`DETACH`, `PRAGMA`, `VACUUM INTO`, `load_extension`, `readfile`, and
  `writefile`. To inspect a table use `describe_table` or `SELECT * FROM pragma_table_info('orders')`.
- `schemas` is not used (a SQLite file has only the `main` schema).
- SQLite is a file, not a server. To reach a file on another machine, run multidb-mcp there over SSH.
  Do not write to a SQLite file over a network share (SQLite's documentation warns of corruption).

### Redis (`redis_command`)

Redis has no SQL, so a `driver: "redis"` connection is served by its own tool:

```json
{ "db": "cache_prod", "command": "HGETALL", "args": ["user:42"] }
{ "db": "cache_prod", "command": "SCAN",    "args": ["0", "MATCH", "laravel_cache:*", "COUNT", "100"] }
```

- `url`: `redis://user:password@host:6379/0` (`rediss://` for TLS). The database number is part of the
  url; a `SELECT` from the model is rejected.
- **`access` for Redis:** `read` = read commands; `insert` = create a new key or element (LPUSH, SADD,
  XADD, SETNX); `update` = change a value or TTL (EXPIRE, LSET); `delete` = remove (DEL, HDEL, LPOP,
  ZREM). A command that can both create and overwrite (SET, HSET, INCR, ZADD) needs `insert` +
  `update`; `SET … NX` needs only `insert`, `SET … XX` only `update`. `ddl` and `call` do not apply.
- **Allowlist:** only commands the guard knows can run. Always rejected, whatever the permissions:
  `FLUSHALL`, `FLUSHDB`, `KEYS` (use `SCAN`), `EVAL`/`FCALL`, `CONFIG`, `ACL`, `MODULE`, `SHUTDOWN`,
  `SELECT`, `MULTI`/`EXEC`, blocking commands (`BLPOP`, `SUBSCRIBE`, `XREAD`), `MONITOR`, `PUBLISH`, `SORT`.
- **Heavy commands are limited before they run,** because Redis runs commands one at a time and one
  huge command can stall every application: `HGETALL`/`HKEYS`/`HVALS`/`SMEMBERS` are rejected when the
  key holds more than `maxRows` elements (with a hint to use `HSCAN`/`SSCAN`); `LRANGE`/`ZRANGE` are
  narrowed to `maxRows`; `XRANGE` gets a `COUNT`; the `COUNT` of `SCAN` is capped.
- **Masking:** the value of a key whose name contains `session`, `sess`, `csrf`, `otp`, `token`,
  `password`, `secret` (and your `maskColumns`) is replaced with `***`, and so are hash/stream fields
  with sensitive names. Sensitive key names are hidden from `SCAN` results, because a session id is a
  credential; such a key can still be deleted when the user names it.
- A timeout only disconnects the client; Redis cannot cancel a running command, so the limits above
  are the main protection.
- **In production use a least-privilege ACL user.** Read-only:
  `ACL SETUSER mcp on >PASSWORD ~* &* +@read +@connection -@dangerous`. May only delete cache entries:
  `ACL SETUSER mcp_cache on >PASSWORD ~laravel_cache:* +@read +del +unlink -@dangerous`.

## Running with Docker

IBM's Db2 CLI driver (used by `ibm_db`) needs `libxml2.so.2`, which distributions such as Ubuntu 26.04
no longer provide. The Docker image is based on Debian 12 and removes the problem without installing
anything on the host. A server started directly with `node` still works for every other database; only
its Db2 connections report a failed status with a message that suggests Docker.

```bash
npm run docker:build        # runtime image: multidb-mcp:<version> and multidb-mcp:latest
npm run docker:build:dev    # dev image for the Db2 tests (rebuild when dependencies change)

# a local Db2 (the first start takes 5-10 minutes and needs about 4 GB of RAM)
npm run db:up:db2
npm run docker:dev -- node scripts/seed-db2.mjs
npm run docker:dev -- npm run check:db2
npm run docker:dev -- npm run test:db2
```

To let Claude Code run the image, use [`templates/mcp.docker.example.json`](templates/mcp.docker.example.json):

```bash
docker run -i --rm --init --pull=never --network host -e TZ=Europe/Berlin \
  -v "$PWD/databases.json:/work/databases.json:ro" \
  -v "$PWD/.env.multidb:/work/.env.multidb:ro" \
  -v "$PWD/.multidb:/work/.multidb" \
  multidb-mcp:latest --config /work/databases.json --dotenv /work/.env.multidb
```

- The image never contains an env file; config and credentials are mounted read-only.
- `--network host` lets the container reach databases on `127.0.0.1` and on your VPN. `--pull=never`
  prevents Docker from pulling an image of the same name from a registry if yours is not built yet.
- The container runs in UTC; pass `-e TZ=<your zone>` so audit files are split by your local date.
- For SQLite, mount the **folder** of the database file (SQLite needs it for its `-wal`, `-shm`, and
  `-journal` files) at the same relative path under `/work`.
- `docker:dev` mounts the source into a dev container; the runtime image needs a rebuild after code changes.
- The Db2 driver is downloaded from IBM's mirror on GitHub at build time (version pinned in the
  `Dockerfile`), because IBM's own download server is very slow.

## Using it in an application project

1. Copy `templates/databases.example.json` to `databases.json` in the project root and adjust it.
2. Keep credentials in a separate file such as `.env.multidb`, and **add it to `.gitignore`**.
3. Copy `templates/mcp.example.json` (plain `node`) or `templates/mcp.docker.example.json` (Docker, needed for
   Db2 on newer distributions) to `.mcp.json`. The path to `dist/index.js` must be absolute.
4. Append `templates/CLAUDE.md.example` to the project's `CLAUDE.md` and merge
   `templates/settings.example.json` into `.claude/settings.json` (it makes Claude Code ask before
   `execute_sql` and `redis_command`).
5. Add `.multidb/` (the audit log) to `.gitignore`.

Claude Code permissions apply per tool, not per connection, which is why production protection is
enforced by the guard and not only by those permissions.

## Audit log and reconnecting

Every tool call is appended as one JSON line to `.multidb/audit-YYYY-MM-DD.jsonl` (next to
`databases.json`):

```json
{"ts":"2026-11-03T09:12:44+08:00","tool":"execute_sql","db":"prod_db2","env":"production","sql":"SELECT ... FROM CORE.ORDERS WHERE ID = ?","paramCount":1,"statement":"SELECT","rows":1,"truncated":false,"masked":false,"outcome":"ok","durationMs":84}
{"ts":"2026-11-03T09:13:02+08:00","tool":"execute_sql","db":"prod_db2","env":"production","sql":"DELETE FROM CORE.ORDERS","paramCount":0,"outcome":"rejected","reason":"readonly","durationMs":0}
{"ts":"2026-11-03T09:14:10+08:00","tool":"redis_command","db":"prod_redis","env":"production","command":"DEL","keys":["laravel_session:***"],"masked":false,"outcome":"ok","durationMs":2}
```

- `outcome` is `ok`, `rejected` (a guard rule; `reason` names it), or `error` (`reason` is the kind of error).
- It **never** stores `params` values, result rows, Redis values, or passwords. SQL text is redacted, and
  sensitive Redis key names are masked after the last colon.
- A new file starts every (local) day; files older than 90 days are deleted. Options:
  `--audit-dir <folder>`, `--audit-keep-days <n>` (`0` keeps everything), `--no-audit`.
- If the folder cannot be written, the server keeps running and logs `audit log disabled: write failed`
  once. With Docker, create the folder first and mount it **without** `:ro`.

When a connection that was already open drops (a database restart, a firewall closing an idle
connection), reads (`list_tables`, `describe_table`, `SELECT`, Redis read commands) are repeated once
on a fresh connection. **Writes are never repeated**; Claude is told the change may or may not have
been saved and must check first. Failing to open the very first connection is not retried. The Db2
pool closes connections that have been idle for 30 seconds.

## Security model

multidb-mcp reduces risk; it does not replace database permissions.

- **Use a dedicated database user per connection** with only the privileges `access` grants: `SELECT`
  only for `["read"]`, and an ACL user for Redis. Do not use an application or DBA account.
- Everything the database user can read can end up in the model's context. Prefer VIEWs that leave
  out secret columns, and grant minimal privileges; masking is an extra layer, not the main control.
- Reach production over a VPN or an SSH tunnel; do not expose database ports publicly. SSH tunnels are
  not built in.
- Table contents are data: the server's instructions tell the model to ignore commands found in results.
- Credentials are wrapped so they print as `[secret]`, and errors, logs, and tool results are redacted
  (host, port, and user names too, for text sent to the model). A protocol test checks that a password
  planted in the environment appears in no tool result, stderr, log file, or audit log.
- The development passwords in `docker-compose.yml` and `.env.example` are for local containers
  bound to `127.0.0.1` only. Never reuse them.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test                    # unit tests, no database needed

npm run db:up               # PostgreSQL, MySQL, MariaDB, Redis in Docker
npm run seed:sqlite         # .data/app.sqlite
npm run seed:redis          # sample keys in Redis database 0
npm run test:integration    # adapters against the real databases
npm run test:protocol       # build, then drive the server over stdio with a real MCP client

npm run db:up:db2           # Db2 Community Edition (heavy)
npm run docker:build:dev
npm run docker:dev -- npm run test:db2

npm run check:env           # check this machine for development readiness
npm run db:down
```

npm 11 blocks dependency install scripts by default; `ibm_db` is approved in the `allowScripts` field
of `package.json`, pinned to its version. After upgrading `ibm_db`, approve it again with
`npm install-scripts approve ibm_db`.

```
src/
├─ index.ts, cli.ts, server.ts, instructions.ts   # entry point, options, tool registration
├─ config/                  # zod schema, ${VAR} interpolation, loader, Secret
├─ registry/                # connection registry (lazy connect, status per connection)
├─ adapters/                # DbAdapter / KeyValueAdapter contract and one folder per database
├─ guard/                   # SQL lexer, analyzer, policy, masking, Redis allowlist
├─ tools/                   # the MCP tools, their input schemas, and reconnect logic
├─ output/                  # compact text tables and result formatting
└─ observability/           # JSON logger, audit log, redaction
test/{unit,integration,db2,protocol}
docker/seed/                # seed SQL for the development databases
scripts/                    # seeds, Db2 check, environment check, dev-container runner
templates/                  # example .mcp.json, databases.json, CLAUDE.md, settings.json
```

The server speaks MCP over stdio, so **stdout is reserved for the protocol**: a single `console.log`
would corrupt the connection. ESLint forbids `console.*` in `src/`; diagnostics go to stderr.

Adding a database kind means implementing `DbAdapter` (or `KeyValueAdapter`), registering it in
`src/adapters/index.ts`, and adding a dialect to the guard if it speaks SQL. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting

| Symptom                                        | Likely cause                                                   | Fix                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `libxml2.so.2: cannot open shared object file` | A newer distribution (Ubuntu 26.04) only ships `libxml2.so.16` | Run the server through the Docker image; run Db2 tests with `npm run docker:dev`                      |
| `npm install` is very slow at `ibm_db`         | IBM's download server is slow                                  | Set `IBM_DB_INSTALLER_URL=https://github.com/ibmdb/db2drivers/raw/main/clidriver/v12.1.4` first       |
| `/mcp` shows **failed**                        | Invalid config or a missing variable                           | Run `node dist/index.js --config databases.json --dotenv .env.multidb`; the error is on stderr        |
| `SQLite file app.sqlite not found`             | Wrong path in `url`, or the folder is not mounted (Docker)     | Relative paths start at the config file's folder; with Docker mount the database folder under `/work` |
| `database is locked` (SQLite)                  | An application is writing to the same file                     | Retry; raise `timeoutSec` if it happens often                                                         |
| `WRONGPASS` from Redis                         | Wrong user or password in the url                              | Check the variable; URL-encode special characters in the password                                     |
| `NOPERM` from Redis                            | The Redis ACL user lacks the command or key                    | Expected for a read-only user; to allow writes, extend the ACL and `access`                           |
| `Unable to find image 'multidb-mcp:latest'`    | The image is not built (`--pull=never` stops a download)       | `npm run docker:build`                                                                                |
| `SQL30081N`                                    | Db2 host, port, or firewall unreachable                        | Check `PORT` (local: 55000), the VPN, and that the `db2` container finished its setup                 |
| `SQL1598N`                                     | The server is Db2 for i or z/OS                                | Not supported (needs a DB2 Connect license)                                                           |
| Port already in use                            | Ports 55432/53306/53307/55000/56379 are taken                  | Change the left-hand port in `docker-compose.yml` and in `.env`                                       |
| Container `db2` keeps restarting               | Not enough Docker memory                                       | Give Docker 4 GB of RAM or more                                                                       |
| Seeds did not change                           | Database seeds only run when the volume is empty               | `docker compose down -v`, then `npm run db:up` (this deletes the container data)                      |
| `audit log disabled: write failed`             | The audit folder is not writable (common with Docker)          | Create `.multidb` first and mount it without `:ro`, or use `--audit-dir` / `--no-audit`               |

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; it explains the
workflow, the tests to run, and the rules for changes that touch the guard.

## License

[MIT](LICENSE)
