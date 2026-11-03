/**
 * URL of a local development container (127.0.0.1 only) for the read-write (`rw`) or the read-only
 * (`ro`) user. '' until the read-write password variable is set.
 */
export function devUrl(
  kind: 'postgres' | 'mysql' | 'mariadb' | 'redis',
  role?: 'rw' | 'ro',
): string;
/** ibm_db connection string of the local Db2 container, or '' when DB2_LOCAL_PASSWORD is not set. */
export function devDb2Conn(): string;
