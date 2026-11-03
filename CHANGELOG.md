# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may contain breaking changes).

## [Unreleased]

### Added

- Connections can be written with separate `host`, `port`, `database`, `user`, and `password` fields (and
  `file` for SQLite) instead of one `url`. Only the password needs to be in the env file, and it is
  URL-encoded automatically. `url` is still supported.
- With separate fields, `host` is validated (a host name or an IP address) so it cannot change the meaning of the
  connection URL, and control characters are refused in every field.
- A test that loads `databases.dev.json` and opens every development connection.
- `templates/env.multidb.example`, the env file that goes with `templates/databases.example.json`.

### Removed

- `npm run check:db2:dev` and the `DB2_DEV_*` variables (a read-only probe of a shared Db2). Register that Db2 in
  `databases.json` and use it through the server instead. `npm run check:db2` for the local Db2 container remains.

### Changed

- **Breaking:** a password written directly in the config is now rejected in **every** env (it used to be allowed
  for `env: local`), and also inside `url`. Use a `${VAR}` reference and keep the value in the env file.
- The development config (`databases.dev.json`, `.env.example`) uses separate fields; only passwords are in `.env`.
- The `*_LOCAL_RO_PASSWORD` variables are gone: the read-only `mcp_ro` test user is a fixed fixture that the server never uses.
- `.env` now holds only passwords: the `*_LOCAL_URL`, `*_LOCAL_RO_URL`, `DB2_LOCAL_CONN`, and `DB2_DEV_CONN` variables are gone.
  The integration tests and scripts build their URLs from those passwords (`scripts/lib/dev-connections.mjs`).

## [0.9.0] - 2026-11-02

### Added

- Audit log: one JSON line per tool call in `.multidb/audit-YYYY-MM-DD.jsonl`, rotated daily, with
  `--audit-dir`, `--audit-keep-days`, and `--no-audit`. Parameter values, result rows, Redis values,
  and passwords are never stored.
- Reads are repeated once when an already-open connection drops; writes are never repeated.
- A protocol test that plants a password and checks that it appears in no tool result, stderr, log
  file, or audit log.
- English documentation, `CONTRIBUTING.md`, `SECURITY.md`, an MIT license, and CI.

### Changed

- The Db2 pool closes connections that have been idle for 30 seconds.
- All code comments, documentation, and messages shown to the model are in English.
- `npm run spike:db2` and `spike:db2:dev` are now `npm run check:db2` and `check:db2:dev`. Reports are
  written to `.data/reports/`.

### Removed

- The Phase-0 spike scripts for PostgreSQL and MySQL (covered by the integration tests).

## [0.8.0] - 2026-11-02

### Added

- Redis adapter and the `redis_command` tool, with a command allowlist, limits on heavy commands, and
  masking of sensitive keys and fields.
- Tools are registered only for the connection kinds present in the config.

## [0.7.0] - 2026-11-01

### Added

- SQLite adapter (Node's built-in `node:sqlite`, one child process per connection so a timeout can kill a
  running query).

## [0.6.0] - 2026-11-01

### Changed

- **Breaking:** the `readonly` field is replaced by a required `access` list (`read`, `insert`,
  `update`, `delete`, `ddl`, `call`) that works the same in every environment.

## [0.5.0] - 2026-11-01

### Added

- IBM Db2 LUW adapter and a Debian 12 Docker image (the Db2 CLI driver needs `libxml2.so.2`).

## [0.4.0] - 2026-11-01

### Added

- Initial version: the server, configuration loader, connection registry, SQL guard, masking, and the
  PostgreSQL and MySQL/MariaDB adapters.
