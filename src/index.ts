/**
 * multidb-mcp entry point (started by Claude Code through .mcp.json).
 *
 * IMPORTANT RULE: stdout is reserved for the MCP protocol (JSON-RPC).
 * All diagnostics go to stderr; ESLint forbids console.* inside src/.
 */
import { existsSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ADAPTER_FACTORIES } from './adapters/index.js';
import { CliError, HELP_TEXT, parseCliArgs } from './cli.js';
import { ConfigError, loadConfig } from './config/loader.js';
import { SERVER_NAME, SERVER_VERSION } from './meta.js';
import { createAuditLog, NO_AUDIT } from './observability/audit.js';
import { createLogger } from './observability/logger.js';
import { ConnectionRegistry } from './registry/connection-registry.js';
import { createMcpServer, toolsFor } from './server.js';

function writeStderr(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

function main(): void {
  let command;
  try {
    command = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    writeStderr(`${SERVER_NAME}: ${err.message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  if (command.kind === 'help') {
    writeStderr(HELP_TEXT);
    return;
  }
  if (command.kind === 'version') {
    writeStderr(`${SERVER_NAME} ${SERVER_VERSION}`);
    return;
  }

  const { options } = command;
  const log = createLogger({ level: options.logLevel, filePath: options.logFile });

  let config;
  try {
    if (options.envFile) {
      if (!existsSync(options.envFile)) {
        throw new ConfigError(`Env file not found: ${options.envFile}`);
      }
      process.loadEnvFile(options.envFile);
    }
    config = loadConfig(options.configPath);
  } catch (err) {
    const problems = err instanceof ConfigError ? err.problems : [];
    log.error('server failed to start: invalid configuration', { error: err, problems });
    // Plain-text version so it is easy to read when the server is run by hand.
    writeStderr(`\n${SERVER_NAME}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const registry = new ConnectionRegistry(
    config.sources,
    ADAPTER_FACTORIES,
    log.child({ component: 'registry' }),
  );

  const auditDir = options.auditDir;
  const audit = auditDir
    ? createAuditLog({
        dir: auditDir,
        keepDays: options.auditKeepDays,
        onError: (message, fields) => log.warn(message, fields),
      })
    : NO_AUDIT;

  const handle = serveStdio(() =>
    createMcpServer({
      registry,
      log: log.child({ component: 'mcp' }),
      maskColumns: config.maskColumns,
      audit,
    }),
  );

  log.info('server ready', {
    version: SERVER_VERSION,
    config: config.path,
    connections: registry.ids(),
    tools: toolsFor(registry),
    audit: auditDir ?? 'off',
  });
  void registry.connectEager();

  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('server stopping', { reason });
    // Safety net: do not let the process hang if a connection is stuck.
    setTimeout(() => process.exit(process.exitCode ?? 0), 8_000).unref();
    try {
      await handle.close();
    } catch (err) {
      log.warn('failed to close the stdio transport', { error: err });
    }
    await registry.closeAll();
    process.exit(process.exitCode ?? 0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  // Claude Code closes stdin when the session ends or the server is stopped.
  process.stdin.once('end', () => void shutdown('stdin closed'));
  process.stdin.once('close', () => void shutdown('stdin closed'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { error: reason });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught error; server stopping', { error: err });
    process.exitCode = 1;
    void shutdown('uncaughtException');
  });
}

main();
