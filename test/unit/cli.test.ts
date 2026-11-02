import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError, parseCliArgs } from '../../src/cli.js';

const cwd = resolve('/project/app');

describe('parseCliArgs', () => {
  it('default values', () => {
    expect(parseCliArgs([], cwd)).toEqual({
      kind: 'run',
      options: {
        configPath: resolve(cwd, 'databases.json'),
        envFile: undefined,
        logLevel: 'info',
        logFile: undefined,
        auditDir: resolve(cwd, '.multidb'),
        auditKeepDays: 90,
      },
    });
  });

  it('relative paths are resolved against the working directory', () => {
    const result = parseCliArgs(
      [
        '--config',
        'cfg/db.json',
        '--dotenv',
        '.env',
        '--log-file',
        'logs/mcp.log',
        '--log-level',
        'debug',
      ],
      cwd,
    );
    expect(result).toEqual({
      kind: 'run',
      options: {
        configPath: resolve(cwd, 'cfg/db.json'),
        envFile: resolve(cwd, '.env'),
        logLevel: 'debug',
        logFile: resolve(cwd, 'logs/mcp.log'),
        auditDir: resolve(cwd, 'cfg/.multidb'),
        auditKeepDays: 90,
      },
    });
  });

  it('audit log: own folder, retention, or switched off', () => {
    const options = (argv: string[]) => {
      const result = parseCliArgs(argv, cwd);
      if (result.kind !== 'run') throw new Error('not a run command');
      return result.options;
    };
    expect(options(['--audit-dir', '/var/log/mcp', '--audit-keep-days', '0'])).toMatchObject({
      auditDir: '/var/log/mcp',
      auditKeepDays: 0,
    });
    expect(options(['--no-audit']).auditDir).toBeUndefined();
    expect(() => parseCliArgs(['--audit-keep-days', '-1'], cwd)).toThrow(/audit-keep-days/);
    expect(() => parseCliArgs(['--audit-keep-days', '7d'], cwd)).toThrow(/audit-keep-days/);
    expect(() => parseCliArgs(['--no-audit', '--audit-dir', 'x'], cwd)).toThrow(
      /cannot be used together/,
    );
  });

  it('short options, help, and version', () => {
    const result = parseCliArgs(['-c', 'x.json'], cwd);
    expect(result.kind === 'run' ? result.options.configPath : '').toBe(resolve(cwd, 'x.json'));
    expect(parseCliArgs(['--help'], cwd)).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-v'], cwd)).toEqual({ kind: 'version' });
  });

  it('rejects unknown options and an invalid log level', () => {
    expect(() => parseCliArgs(['--no-such-option', 'x'], cwd)).toThrow(CliError);
    expect(() => parseCliArgs(['--log-level', 'verbose'], cwd)).toThrow(/log-level/);
    expect(() => parseCliArgs(['positional'], cwd)).toThrow(CliError);
  });
});
