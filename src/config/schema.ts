import * as z from 'zod/v4';

/** Supported database drivers. */
export const DRIVERS = ['postgres', 'mysql', 'mariadb', 'db2', 'sqlite', 'redis'] as const;
/** Environments a connection can be labeled with. */
export const ENVIRONMENTS = ['local', 'staging', 'production'] as const;

/**
 * Per-connection permissions. "read" (SELECT, WITH, VALUES, SHOW, DESCRIBE, EXPLAIN) is required;
 * every other level unlocks one kind of write. This order is also the display order.
 */
export const ACCESS_LEVELS = ['read', 'insert', 'update', 'delete', 'ddl', 'call'] as const;

/** A supported database driver. */
export type Driver = (typeof DRIVERS)[number];
/** The environment a connection is labeled with. */
export type Environment = (typeof ENVIRONMENTS)[number];
/** A permission level a connection can grant. */
export type Access = (typeof ACCESS_LEVELS)[number];
/** Drivers that speak SQL (everything except Redis). */
export type SqlDriver = Exclude<Driver, 'redis'>;

/** Permission levels that make no sense for a driver (rejected at startup so they cannot mislead). */
const ACCESS_NOT_APPLICABLE: Partial<Record<Driver, readonly Access[]>> = {
  sqlite: ['call'],
  redis: ['ddl', 'call'],
};

/** Connection id: lowercase letters, digits, underscore; must start with a letter. Used as the enum value in tools. */
export const SOURCE_ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

const maxRows = z.int().min(1).max(10_000);
const timeoutSec = z.int().min(1).max(600);
const maxChars = z.int().min(1_000).max(500_000);

/** One entry in "databases". strictObject: a mistyped field (e.g. "readOnly") is rejected, not ignored. */
export const SourceSchema = z.strictObject({
  id: z
    .string()
    .regex(
      SOURCE_ID_PATTERN,
      'must be lowercase letters, digits, or _, start with a letter, and be at most 63 characters',
    ),
  driver: z.enum(DRIVERS),
  env: z.enum(ENVIRONMENTS),
  description: z.string().trim().min(5, 'at least 5 characters').max(300, 'at most 300 characters'),
  /** Whole connection string. Alternative to the separate fields below. */
  url: z.string().trim().min(1, 'must not be empty').optional(),
  /** Separate connection fields, an alternative to `url`. Text fields may use ${VAR}. */
  host: z.string().trim().min(1, 'must not be empty').max(253, 'at most 253 characters').optional(),
  port: z.int().min(1).max(65_535).optional(),
  /** Database name (a number for Redis). */
  database: z
    .union([
      z.string().trim().min(1, 'must not be empty').max(128, 'at most 128 characters'),
      z.int().min(0),
    ])
    .optional(),
  user: z.string().trim().min(1, 'must not be empty').max(128, 'at most 128 characters').optional(),
  password: z.string().min(1, 'must not be empty').max(1024, 'at most 1024 characters').optional(),
  /** Path of the database file (SQLite only). */
  file: z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .max(1024, 'at most 1024 characters')
    .optional(),
  access: z
    .array(
      z.enum(ACCESS_LEVELS, {
        error: `unknown value; choose from: ${ACCESS_LEVELS.join(', ')}`,
      }),
      {
        error: (issue) =>
          issue.input === undefined
            ? 'required, e.g. ["read"] for read-only or ["read", "insert", "update", "delete"]'
            : 'must be a list, e.g. ["read"]',
      },
    )
    .refine((list) => list.includes('read'), {
      message: '"read" is required; a connection that may write but not read is not supported',
    })
    .refine((list) => new Set(list).size === list.length, {
      message: 'a value is listed twice',
    }),
  // Legacy field: rejected with a message that names its replacement instead of being silently ignored.
  readonly: z
    .never({
      error:
        'the readonly field was replaced by access. Remove readonly and write "access": ["read"] for read-only, or add insert/update/delete/ddl/call to allow writes',
    })
    .optional(),
  maxRows: maxRows.optional(),
  timeoutSec: timeoutSec.optional(),
  maxChars: maxChars.optional(),
  schemas: z.array(z.string().trim().min(1).max(128)).min(1).optional(),
  lazy: z.boolean().optional(),
});

/** Schema of the optional "defaults" object. */
export const DefaultsSchema = z.strictObject({
  maxRows: maxRows.optional(),
  timeoutSec: timeoutSec.optional(),
  maxChars: maxChars.optional(),
});

/** Schema of the whole databases.json file. */
export const ConfigFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    defaults: DefaultsSchema.optional(),
    maskColumns: z.array(z.string().trim().min(1).max(64)).optional(),
    databases: z
      .array(SourceSchema)
      .min(1, 'at least one connection')
      .max(50, 'at most 50 connections'),
  })
  .superRefine((config, ctx) => {
    const seen = new Map<string, number>();
    config.databases.forEach((source, index) => {
      const first = seen.get(source.id);
      if (first === undefined) {
        seen.set(source.id, index);
      } else {
        ctx.addIssue({
          code: 'custom',
          path: ['databases', index, 'id'],
          message: `id "${source.id}" is already used by databases[${first}]`,
        });
      }
      const separate = (['host', 'port', 'database', 'user', 'password', 'file'] as const).filter(
        (field) => source[field] !== undefined,
      );
      if (source.url !== undefined && separate.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['databases', index, 'url'],
          message: `give either url or separate fields, not both (also found: ${separate.join(', ')})`,
        });
      } else if (source.url === undefined && source.driver === 'sqlite') {
        if (source.file === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['databases', index, 'file'],
            message: 'required for sqlite when url is not given, e.g. "./app.sqlite"',
          });
        }
        for (const field of separate.filter((f) => f !== 'file')) {
          ctx.addIssue({
            code: 'custom',
            path: ['databases', index, field],
            message: `not used for sqlite; use "file"`,
          });
        }
      } else if (source.url === undefined) {
        if (source.host === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['databases', index, 'host'],
            message: 'required when url is not given',
          });
        }
        if (source.file !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['databases', index, 'file'],
            message: 'only used for sqlite',
          });
        }
        if (source.driver === 'redis' && typeof source.database === 'string') {
          if (!/^\d+$/.test(source.database) && !source.database.includes('${')) {
            ctx.addIssue({
              code: 'custom',
              path: ['databases', index, 'database'],
              message: 'for redis this is the database number, e.g. 0',
            });
          }
        }
      }
      if (source.driver === 'sqlite' && source.schemas) {
        ctx.addIssue({
          code: 'custom',
          path: ['databases', index, 'schemas'],
          message:
            'not used for sqlite (a SQLite file only has the main schema); remove this field',
        });
      }
      if (source.driver === 'redis' && source.schemas) {
        ctx.addIssue({
          code: 'custom',
          path: ['databases', index, 'schemas'],
          message:
            'not used for redis; the database number is set in the url (redis://host:6379/0)',
        });
      }
      const notApplicable = (ACCESS_NOT_APPLICABLE[source.driver] ?? []).filter((level) =>
        source.access.includes(level),
      );
      if (notApplicable.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['databases', index, 'access'],
          message: `${notApplicable.join(', ')} does not apply to ${source.driver}; remove it from the list`,
        });
      }
    });
  });

/** A parsed databases.json file. */
export type ConfigFile = z.infer<typeof ConfigFileSchema>;
/** One parsed entry of "databases". */
export type SourceEntry = z.infer<typeof SourceSchema>;
