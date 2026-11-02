# Contributing to multidb-mcp

Thank you for considering a contribution. This project gives an AI assistant access to real
databases, so changes are reviewed with security in mind. This guide explains how to get set up and
what a good change looks like.

## Ground rules

- **Safety first.** A change must not make the guard more permissive by accident. When in doubt,
  reject the statement ("fail closed").
- **No secrets, ever.** Do not commit credentials, real hostnames, or customer data, not even in
  tests or issue reports. Test fixtures use obvious fakes such as `hunter`.
- **stdout belongs to the MCP protocol.** Never use `console.*` in `src/`; ESLint enforces it.
  Diagnostics go to stderr through the logger.
- Be kind and constructive in issues and reviews.

## Getting set up

You need Node.js 24 LTS, npm, and Docker (for the integration tests).

```bash
git clone https://github.com/hmrnsp/multidb-mcp.git
cd multidb-mcp
npm install
cp .env.example .env
npm run build
```

If `npm install` is very slow at `ibm_db`, set
`IBM_DB_INSTALLER_URL=https://github.com/ibmdb/db2drivers/raw/main/clidriver/v12.1.4` first.

## Running the checks

Run these before you open a pull request. CI runs the first four.

```bash
npm run typecheck
npm run lint
npx prettier --check .
npm test                    # unit tests, no database needed

npm run db:up               # PostgreSQL, MySQL, MariaDB, and Redis in Docker
npm run seed:sqlite
npm run seed:redis
npm run test:integration    # adapters against real databases
npm run test:protocol       # builds, then drives the server over stdio with a real MCP client
```

Db2 tests need the Db2 Community Edition container and run inside a Debian 12 image because IBM's
driver needs `libxml2.so.2` (see the README):

```bash
npm run db:up:db2
npm run docker:build:dev
npm run docker:dev -- node scripts/seed-db2.mjs
npm run docker:dev -- npm run test:db2
```

Stop the containers with `npm run db:down` when you are done.

## Code conventions

- TypeScript (strict, ESM), formatted by Prettier (`npx prettier --write .`) and checked by
  type-aware ESLint rules.
- Write comments and documentation in English. Public symbols get a short JSDoc comment that says
  what they are for, not how they are implemented.
- Keep comments for the _why_: a constraint, a surprising behavior, a trade-off. Do not restate the code.
- Messages shown to the model (tool results, errors) are plain English, short, and say what to do next.
- Dependencies are kept to a minimum on purpose. Please discuss a new runtime dependency in an issue first.

## Tests

- Every behavior change comes with a test. Prefer a unit test (fakes for drivers, no database); add an
  integration test when the real driver's behavior matters.
- **Guard changes need tests for both outcomes:** a statement that must be rejected _and_ a similar,
  legitimate one that must be allowed. See `test/unit/guard-policy.test.ts`.
- Anything that handles credentials needs a test that the secret does not appear in the output. The
  protocol test (`test/protocol/stdio.test.ts`) plants a password and checks tool results, stderr, the
  log file, and the audit log.

## Adding support for a database

1. Add the driver name to `DRIVERS` in `src/config/schema.ts`, and decide which `access` levels make
   no sense for it (`ACCESS_NOT_APPLICABLE`).
2. Create `src/adapters/<name>/` implementing `DbAdapter` (or `KeyValueAdapter`), and register it in
   `src/adapters/index.ts`. Keep the driver behind a small interface (see `driver-types.ts` in the
   other adapters) so the adapter can be unit-tested with a fake.
3. For a SQL database, add a dialect to the guard (`src/guard/`): lexer rules, the statement analyzer,
   deny-lists, and system schemas.
4. Translate driver errors into `DbError` kinds so the tools can give helpful, credential-free messages.
5. Add unit tests, an integration test, a service in `docker-compose.yml` with seed data, and a section
   in the README.

## Commits and pull requests

- Keep a pull request focused on one change, and describe _why_ it is needed.
- Write commit messages in the imperative mood ("Add Redis allowlist entry for OBJECT FREQ").
- Update the README and `CHANGELOG.md` when behavior visible to users changes.
- Mention in the description how you tested the change, including which databases you ran against.

## Reporting bugs and security issues

Open an issue for bugs and feature requests. For a **security vulnerability**, do not open a public
issue; follow [SECURITY.md](SECURITY.md).
