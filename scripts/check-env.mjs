#!/usr/bin/env node
// Check that the development machine is ready for multidb-mcp.
//
//   npm run check:env
//
// Changes nothing and never prints the contents of .env (only the names of the variables that are filled in).

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { createCheck, ROOT } from './lib/harness.mjs';

const require = createRequire(import.meta.url);
const check = createCheck('check-env');

// docker.exe can be called directly without a shell, including on Windows.
function run(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// npm on Windows is npm.cmd, so it needs a shell; the command is fixed (no user input).
function npmVersion() {
  const agent = /\bnpm\/(\S+)/.exec(process.env.npm_config_user_agent ?? '');
  if (agent) return agent[1];
  return execSync('npm --version', {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function portState(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (state) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1500, () => finish('no response'));
    socket.once('connect', () => finish('something is listening'));
    socket.once('error', () => finish('free'));
  });
}

const major = Number(process.versions.node.split('.')[0]);

await check.step('Node.js version (24 LTS recommended)', () => {
  if (major < 22) throw new Error(`Node ${process.version} is too old. Install Node 24 LTS (x64).`);
  if (major !== 24) {
    return `Node ${process.version} works, but the project is pinned to Node 24 LTS (.node-version)`;
  }
  return process.version;
});

await check.step('Platform & architecture', () => {
  const desc = `${process.platform} ${process.arch}`;
  if (process.arch !== 'x64') {
    throw new Error(
      `${desc}: ibm_db is most stable on x64. Make sure an x64 build of Node.js is installed.`,
    );
  }
  return desc;
});

await check.step('npm is available', () => npmVersion());

await check.step('Dependencies are installed (node_modules)', () => {
  if (!existsSync(join(ROOT, 'node_modules'))) throw new Error('Run: npm install');
  return 'ada';
});

await check.step('The ibm_db native module loads', () => {
  const ibmdb = require('ibm_db');
  let version = '?';
  try {
    version = require('ibm_db/package.json').version;
  } catch {
    /* ignore */
  }
  const clidriver = join(ROOT, 'node_modules', 'ibm_db', 'installer', 'clidriver');
  return {
    version,
    clidriver: existsSync(clidriver)
      ? 'installed'
      : 'not found at the default location (check IBM_DB_HOME)',
    queryTimeoutConst: typeof ibmdb.SQL_ATTR_QUERY_TIMEOUT === 'number',
  };
});

for (const mod of ['pg', 'pg-cursor', 'mysql2']) {
  await check.step(`The ${mod} driver loads`, () => {
    require(mod);
    return 'ok';
  });
}

await check.step(
  'Docker Engine is running',
  () => run('docker', ['version', '--format', '{{.Server.Version}}']),
  {
    optional: true,
  },
);

await check.step(
  'Docker Compose is available',
  () => run('docker', ['compose', 'version', '--short']),
  {
    optional: true,
  },
);

await check.step('File .env', () => {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) throw new Error('Not found. Create it with: cp .env.example .env');
  const filled = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line))
    .filter((m) => m && m[2].trim() !== '')
    .map((m) => m[1]);
  return { filledVariables: filled };
});

const ports = { postgres: 55432, mysql: 53306, mariadb: 53307, db2: 55000, redis: 56379 };
const states = {};
for (const [name, port] of Object.entries(ports)) states[`${name}:${port}`] = await portState(port);
check.info(
  'Local ports (normally "free" before db:up and "something is listening" afterwards)',
  states,
);

check.finish();
