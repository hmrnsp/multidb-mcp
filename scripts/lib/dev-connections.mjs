// Connection strings of the LOCAL development containers (docker-compose.yml), built from the
// passwords in .env. Used by the integration tests and the seed/check scripts, so .env only
// holds passwords: the hosts, ports, and users below are the ones docker-compose.yml defines.
//
// Every function returns '' when its password variable is not set, so a test can skip itself.

const HOST = '127.0.0.1';

/** Where each local container listens, who may connect, and which variables hold the passwords. */
const DEV = {
  postgres: {
    scheme: 'postgres',
    port: 55432,
    database: 'app',
    users: { rw: 'dev', ro: 'mcp_ro' },
    passwords: { rw: 'PG_LOCAL_PASSWORD', ro: 'PG_LOCAL_RO_PASSWORD' },
  },
  mysql: {
    scheme: 'mysql',
    port: 53306,
    database: 'app',
    users: { rw: 'dev', ro: 'mcp_ro' },
    passwords: { rw: 'MYSQL_LOCAL_PASSWORD', ro: 'MYSQL_LOCAL_RO_PASSWORD' },
  },
  mariadb: {
    scheme: 'mysql',
    port: 53307,
    database: 'app',
    users: { rw: 'dev', ro: 'mcp_ro' },
    passwords: { rw: 'MARIADB_LOCAL_PASSWORD', ro: 'MARIADB_LOCAL_RO_PASSWORD' },
  },
  redis: {
    scheme: 'redis',
    port: 56379,
    database: '0',
    users: { rw: 'default', ro: 'mcp_ro' },
    passwords: { rw: 'REDIS_LOCAL_PASSWORD', ro: 'REDIS_LOCAL_RO_PASSWORD' },
  },
};

const read = (name) => process.env[name]?.trim() ?? '';

/** URL of a local container, for the read-write user (`rw`) or the read-only user (`ro`). */
export function devUrl(kind, role = 'rw') {
  const entry = DEV[kind];
  const password = read(entry.passwords[role]);
  if (password === '') return '';
  const user = encodeURIComponent(entry.users[role]);
  return `${entry.scheme}://${user}:${encodeURIComponent(password)}@${HOST}:${entry.port}/${entry.database}`;
}

/** ibm_db connection string of the local Db2 container. */
export function devDb2Conn() {
  const password = read('DB2_LOCAL_PASSWORD');
  if (password === '') return '';
  return `DATABASE=APPDB;HOSTNAME=${HOST};PORT=55000;PROTOCOL=TCPIP;UID=db2inst1;PWD=${password};`;
}

/**
 * ibm_db connection string of a shared development Db2, from DB2_DEV_HOST, DB2_DEV_PORT,
 * DB2_DEV_DATABASE, DB2_DEV_USER, and DB2_DEV_PASSWORD. Returns '' unless all of them are set.
 */
export function sharedDb2Conn() {
  const host = read('DB2_DEV_HOST');
  const port = read('DB2_DEV_PORT') || '50000';
  const database = read('DB2_DEV_DATABASE');
  const user = read('DB2_DEV_USER');
  const password = read('DB2_DEV_PASSWORD');
  if ([host, database, user, password].includes('')) return '';
  return `DATABASE=${database};HOSTNAME=${host};PORT=${port};PROTOCOL=TCPIP;UID=${user};PWD=${password};`;
}
