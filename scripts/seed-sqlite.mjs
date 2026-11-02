#!/usr/bin/env node
// Create a sample SQLite database for development: .data/app.sqlite (recreated every time).
//
//   npm run seed:sqlite

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(ROOT, '.data', 'app.sqlite');

mkdirSync(dirname(target), { recursive: true });
for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(target + suffix, { force: true });

const db = new DatabaseSync(target);
db.exec(readFileSync(join(ROOT, 'docker', 'seed', 'sqlite.sql'), 'utf8'));
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
console.log(`Done: ${count('customers')} customers, ${count('orders')} orders -> .data/app.sqlite`);
db.close();
