# Security policy

multidb-mcp sits between an AI assistant and real databases, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose
**Report a vulnerability**. Include:

- what you found and which version (`node dist/index.js --version`),
- steps or a configuration that reproduces it,
- what an attacker (or a misled model) could do with it.

Do not include real credentials or production data.

You can expect an acknowledgement within a few days. Fixes for confirmed issues are released as soon as
practical, and the report is credited in the changelog unless you prefer otherwise.

## What counts as a vulnerability

Examples of in-scope problems:

- A statement or Redis command that the guard should reject but that reaches the database (a guard bypass).
- A write that happens on a connection whose `access` does not allow it.
- A credential, host name, or secret that appears in a tool result, log, or audit log.
- Output that lets table contents or masked values escape in a way the documentation says they cannot.

Out of scope:

- Anything a database user with the same privileges could do directly. multidb-mcp reduces risk but does
  not replace database privileges; see "Security model" in the [README](README.md#security-model).
- Weaknesses in a database server, a driver, or the MCP client themselves (please report those upstream).
- The development passwords in `docker-compose.yml` and `.env.example`, which are for local containers only.

## Supported versions

Only the latest release receives security fixes while the project is below 1.0.
