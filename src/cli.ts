import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LOG_LEVELS, type LogLevel } from './observability/logger.js';

/** Options for running the server, parsed from the command line. */
export interface CliOptions {
  /** Absolute path to databases.json. */
  configPath: string;
  /** Absolute path to the .env file (optional). */
  envFile: string | undefined;
  logLevel: LogLevel;
  /** Absolute path of an additional log file (optional). */
  logFile: string | undefined;
  /** Audit log folder (absolute), or undefined with --no-audit. */
  auditDir: string | undefined;
  /** Delete audit files older than this many days; 0 = never. */
  auditKeepDays: number;
}

/** How many days of audit files are kept by default. */
export const DEFAULT_AUDIT_KEEP_DAYS = 90;

/** What the command line asks for: run the server, print help, or print the version. */
export type CliCommand =
  { kind: 'run'; options: CliOptions } | { kind: 'help' } | { kind: 'version' };

/** A command-line usage error (unknown option, invalid value). */
export class CliError extends Error {
  override readonly name = 'CliError';
}

/** The text printed by --help. */
export const HELP_TEXT = `multidb-mcp: MCP server multi-database (PostgreSQL, MySQL/MariaDB, Db2, SQLite, Redis)

Usage:
  node dist/index.js --config <databases.json> [--dotenv <.env>] [options]

Options:
  -c, --config <path>      Connection config file (default: ./databases.json)
      --dotenv <path>      .env file with the variables referenced by \${VAR} in the config
                           (not --env-file: Node.js intercepts that name itself)
      --log-level <level>  debug | info | warn | error (default: info)
      --log-file <path>    Also write logs to this file (JSON Lines)
      --audit-dir <path>   Audit log folder (default: .multidb next to the config file)
      --audit-keep-days <n>  Delete audit files older than n days (default: 90; 0 = keep all)
      --no-audit           Do not write an audit log
  -h, --help               Show this help
  -v, --version            Show the version

The server talks over stdin/stdout (MCP protocol). All logs go to stderr.
Relative paths are resolved against the working directory the server is started from.
`;

/**
 * Parse command-line arguments.
 *
 * @param argv Arguments without the node binary and script name.
 * @param cwd Directory against which relative paths are resolved.
 * @throws {CliError} On an unknown option or an invalid value.
 */
export function parseCliArgs(argv: readonly string[], cwd: string = process.cwd()): CliCommand {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        config: { type: 'string', short: 'c' },
        dotenv: { type: 'string' },
        'log-level': { type: 'string' },
        'log-file': { type: 'string' },
        'audit-dir': { type: 'string' },
        'audit-keep-days': { type: 'string' },
        'no-audit': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  if (values.help === true) return { kind: 'help' };
  if (values.version === true) return { kind: 'version' };

  const level = (values['log-level'] as string | undefined) ?? 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new CliError(`--log-level must be one of: ${LOG_LEVELS.join(', ')}`);
  }

  const optionalPath = (value: string | boolean | undefined): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? resolve(cwd, value) : undefined;

  const keepDaysText = (values['audit-keep-days'] as string | undefined) ?? '';
  const auditKeepDays =
    keepDaysText === '' ? DEFAULT_AUDIT_KEEP_DAYS : Number.parseInt(keepDaysText, 10);
  if (!/^\d*$/.test(keepDaysText) || !Number.isSafeInteger(auditKeepDays)) {
    throw new CliError('--audit-keep-days must be an integer, 0 or greater');
  }
  if (values['no-audit'] === true && values['audit-dir'] !== undefined) {
    throw new CliError('--no-audit and --audit-dir cannot be used together');
  }

  const configPath = optionalPath(values.config) ?? resolve(cwd, 'databases.json');
  return {
    kind: 'run',
    options: {
      configPath,
      envFile: optionalPath(values['dotenv']),
      logLevel: level as LogLevel,
      logFile: optionalPath(values['log-file']),
      auditDir:
        values['no-audit'] === true
          ? undefined
          : (optionalPath(values['audit-dir']) ?? resolve(dirname(configPath), '.multidb')),
      auditKeepDays,
    },
  };
}
