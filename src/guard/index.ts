import type { SqlDialect } from '../adapters/types.js';
import type { SqlDriver } from '../config/schema.js';

export { checkSql, type GuardContext, type GuardDecision, type GuardRule } from './policy.js';
export { createColumnMatcher, maskResult, type ColumnMatcher } from './masker.js';

/** SQL dialect for each driver (MySQL and MariaDB are distinguished because their comment rules differ). */
export const DIALECT_OF: Readonly<Record<SqlDriver, SqlDialect>> = Object.freeze({
  postgres: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  db2: 'db2',
  sqlite: 'sqlite',
});
