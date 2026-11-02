import type { Driver } from '../config/schema.js';
import { Db2Adapter } from './db2/db2-adapter.js';
import { loadDb2PoolFactory } from './db2/db2-driver.js';
import { MysqlAdapter } from './mysql/mysql-adapter.js';
import { loadMysqlPoolFactory } from './mysql/mysql-driver.js';
import { loadPgPoolFactory } from './postgres/pg-driver.js';
import { PostgresAdapter } from './postgres/postgres-adapter.js';
import { RedisAdapter } from './redis/redis-adapter.js';
import { loadRedisClientFactory } from './redis/redis-driver.js';
import { SqliteAdapter } from './sqlite/sqlite-adapter.js';
import { loadSqliteFactory } from './sqlite/sqlite-driver.js';
import type { AdapterFactory } from './types.js';

/**
 * Adapter factory per driver:
 *   postgres         -> available
 *   mysql, mariadb   -> available
 *   db2              -> available (needs libxml2.so.2, see the Dockerfile)
 *   sqlite           -> available (built-in node:sqlite)
 *   redis            -> available (redis_command tool)
 * A connection whose driver is missing here still appears in list_databases
 * with the status "adapter not available".
 */
export const ADAPTER_FACTORIES: Readonly<Partial<Record<Driver, AdapterFactory>>> = Object.freeze({
  postgres: (source, log) =>
    new PostgresAdapter(source, log, { loadPoolFactory: loadPgPoolFactory }),
  mysql: (source, log) =>
    new MysqlAdapter(source, log, { flavor: 'mysql', loadPoolFactory: loadMysqlPoolFactory }),
  mariadb: (source, log) =>
    new MysqlAdapter(source, log, { flavor: 'mariadb', loadPoolFactory: loadMysqlPoolFactory }),
  db2: (source, log) => new Db2Adapter(source, log, { loadPoolFactory: loadDb2PoolFactory }),
  sqlite: (source, log) => new SqliteAdapter(source, log, { loadFactory: loadSqliteFactory }),
  redis: (source, log) =>
    new RedisAdapter(source, log, { loadClientFactory: loadRedisClientFactory }),
});
