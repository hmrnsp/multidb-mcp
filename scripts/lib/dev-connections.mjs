// Connection strings of the LOCAL development containers (docker-compose.yml), built from the
// passwords in .env. Used by the integration tests and the seed/check scripts, so .env only holds
// the passwords that the MCP server itself reads (see databases.dev.json): the hosts, ports, and
// users below are the ones docker-compose.yml defines.
//
// Every function returns '' when the read-write password variable is not set, so a test can skip
// itself on a machine that has not set up the development containers.
//
// Everything built here points at 127.0.0.1 only; these helpers never address a remote server.

const HOST = '127.0.0.1';

/**
 * Password of the read-only test user `mcp_ro`. It is a test fixture, not a secret: the seeds
 * (docker/seed/*.sql) and the Redis ACL in docker-compose.yml create the user with exactly this
 * value, and the containers only listen on 127.0.0.1. The MCP server never uses it.
 */
const READ_ONLY_PASSWORD = 'mcp_ro';

/** Where each local container listens, who may connect, and which variable holds the password. */
const DEV = {
  postgres: {
    scheme: 'postgres',
    port: 55432,
    database: 'app',
    users: { rw: 'dev', ro: 'mcp_ro' },
    passwordVariable: 'PG_LOCAL_PASSWORD',
  },
  mysql: {
    scheme: 'mysql',
    port: 53306,
    database: 'app',
    users: { rw: 'dev', ro: 'mcp_ro' },
    passwordVariable: 'MYSQL_LOCAL_PASSWORD',
  },
  mariadb: {
    scheme: 'mysql',
    port: 53307,
    database: 'app',
    users: { rw: 'dev', ro: 'mcp_ro' },
    passwordVariable: 'MARIADB_LOCAL_PASSWORD',
  },
  redis: {
    scheme: 'redis',
    port: 56379,
    database: '0',
    users: { rw: 'default', ro: 'mcp_ro' },
    passwordVariable: 'REDIS_LOCAL_PASSWORD',
  },
};

const read = (name) => process.env[name]?.trim() ?? '';

/**
 * URL of a local container, for the read-write user (`rw`) or the read-only user (`ro`).
 * Both are '' until the read-write password is set, which is how a machine without the
 * development setup skips the integration tests.
 */
export function devUrl(kind, role = 'rw') {
  const entry = DEV[kind];
  const password = read(entry.passwordVariable);
  if (password === '') return '';
  const secret = role === 'ro' ? READ_ONLY_PASSWORD : password;
  const user = encodeURIComponent(entry.users[role]);
  return `${entry.scheme}://${user}:${encodeURIComponent(secret)}@${HOST}:${entry.port}/${entry.database}`;
}

/** ibm_db connection string of the local Db2 container. */
export function devDb2Conn() {
  const password = read('DB2_LOCAL_PASSWORD');
  if (password === '') return '';
  return `DATABASE=APPDB;HOSTNAME=${HOST};PORT=55000;PROTOCOL=TCPIP;UID=db2inst1;PWD=${password};`;
}
