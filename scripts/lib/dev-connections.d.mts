/** URL of a local development container, or '' when its password variable is not set. */
export function devUrl(
  kind: 'postgres' | 'mysql' | 'mariadb' | 'redis',
  role?: 'rw' | 'ro',
): string;
/** ibm_db connection string of the local Db2 container, or '' when DB2_LOCAL_PASSWORD is not set. */
export function devDb2Conn(): string;
