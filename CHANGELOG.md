# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may contain breaking changes).

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
