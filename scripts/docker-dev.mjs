#!/usr/bin/env node
// Run a command in the dev container (Debian 12, where the Db2 driver works) with the source from the host.
//
//   npm run docker:build:dev                 (once, and whenever package.json changes)
//   npm run docker:dev -- npm run check:db2
//   npm run docker:dev -- npm run test:db2
//
// node_modules stays with the image (the native driver is built for Debian 12); only the
// source, tests, scripts, and config files are mounted. The host network is used so the container
// can reach databases on 127.0.0.1 and on your office network/VPN.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'multidb-mcp-dev';

const READ_ONLY = [
  // package.json is mounted too so npm scripts match the host; dependencies stay with the image.
  'package.json',
  'src',
  'test',
  'scripts',
  'docker',
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
  'vitest.integration.config.ts',
  'vitest.protocol.config.ts',
  'vitest.db2.config.ts',
  'databases.dev.json',
  '.env',
];
// The checks write their reports to .data/reports.
const WRITABLE = ['.data'];
mkdirSync(join(ROOT, '.data', 'reports'), { recursive: true });

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error('Usage: npm run docker:dev -- <command>   (example: npm run check:db2)');
  process.exit(2);
}

const args = ['run', '--rm', '--init', '--network', 'host', '-w', '/app'];
if (process.stdin.isTTY) args.push('-it');
// Run as the host user so files written (check reports) do not end up owned by root.
if (typeof process.getuid === 'function') {
  args.push('--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp');
}
for (const [list, mode] of [
  [READ_ONLY, 'ro'],
  [WRITABLE, 'rw'],
]) {
  for (const path of list) {
    if (existsSync(join(ROOT, path))) args.push('-v', `${join(ROOT, path)}:/app/${path}:${mode}`);
  }
}
args.push(IMAGE, ...command);

const result = spawnSync('docker', args, { stdio: 'inherit' });
if (result.error) {
  console.error(`Failed to run docker: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
