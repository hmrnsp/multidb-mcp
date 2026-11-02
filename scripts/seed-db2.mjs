#!/usr/bin/env node
// Load sample data into the LOCAL Db2 (docker compose container).
//
//   npm run seed:db2
//
// Safeguard: only uses DB2_LOCAL_CONN and refuses to run when HOSTNAME is not
// localhost/127.0.0.1. This script is safe to run repeatedly (idempotent).

import { createRequire } from 'node:module';
import {
  cb,
  describeError,
  hostOf,
  isLocalHost,
  loadEnv,
  redact,
  requireEnv,
} from './lib/harness.mjs';

const require = createRequire(import.meta.url);

const DDL = [
  'CREATE SCHEMA APP',
  `CREATE TABLE APP.CUSTOMERS (
     ID            INTEGER NOT NULL GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1),
     NAME          VARCHAR(100) NOT NULL,
     EMAIL         VARCHAR(150) NOT NULL,
     NIK           CHAR(16),
     PASSWORD_HASH VARCHAR(100),
     CREATED_AT    TIMESTAMP NOT NULL DEFAULT CURRENT TIMESTAMP,
     PRIMARY KEY (ID),
     CONSTRAINT UQ_CUSTOMERS_EMAIL UNIQUE (EMAIL)
   )`,
  `CREATE TABLE APP.ORDERS (
     ID          INTEGER NOT NULL GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1),
     CUSTOMER_ID INTEGER NOT NULL,
     TOTAL       DECIMAL(12, 2) NOT NULL,
     STATUS      VARCHAR(20) NOT NULL,
     CREATED_AT  TIMESTAMP NOT NULL DEFAULT CURRENT TIMESTAMP,
     PRIMARY KEY (ID),
     CONSTRAINT FK_ORDERS_CUSTOMER FOREIGN KEY (CUSTOMER_ID) REFERENCES APP.CUSTOMERS (ID)
   )`,
  'CREATE INDEX APP.IDX_ORDERS_CUSTOMER ON APP.ORDERS (CUSTOMER_ID)',
  `CREATE VIEW APP.V_ORDER_SUMMARY AS
     SELECT C.ID AS CUSTOMER_ID, C.NAME, COUNT(O.ID) AS ORDER_COUNT, SUM(O.TOTAL) AS TOTAL_SPENT
     FROM APP.CUSTOMERS C
     LEFT JOIN APP.ORDERS O ON O.CUSTOMER_ID = C.ID
     GROUP BY C.ID, C.NAME`,
];

const STATUSES = ['pending', 'paid', 'shipped', 'cancelled'];

/** SQLSTATE 42710 = the object already exists. Treated as safe when the seed is repeated. */
function isAlreadyExists(err) {
  const d = describeError(err);
  return d.sqlState === '42710' || d.state === '42710' || /SQL0601N/.test(d.message);
}

async function main() {
  loadEnv();
  const conn = requireEnv('DB2_LOCAL_CONN');
  const host = hostOf(conn);
  if (!isLocalHost(host)) {
    throw new Error(
      `The seed is only for a local Db2. HOSTNAME is currently "${host}", not localhost/127.0.0.1. Aborted.`,
    );
  }

  const ibmdb = require('ibm_db');
  console.log(`Connecting to ${redact(conn)}`);
  const db = await cb((done) => ibmdb.open(conn, done));

  try {
    for (const sql of DDL) {
      const label = sql.trim().split(/\s+/).slice(0, 3).join(' ');
      try {
        await cb((done) => db.query(sql, [], done));
        console.log(`  created    ${label}`);
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        console.log(`  exists     ${label}`);
      }
    }

    const [{ N: existing }] = await cb((done) =>
      db.query('SELECT COUNT(*) AS N FROM APP.ORDERS', [], done),
    );
    if (Number(existing) > 0) {
      console.log(`Data already exists (${existing} orders). Nothing was added.`);
      return;
    }

    await cb((done) => db.beginTransaction(done));
    try {
      const insCustomer = await cb((done) =>
        db.prepare(
          'INSERT INTO APP.CUSTOMERS (NAME, EMAIL, NIK, PASSWORD_HASH) VALUES (?, ?, ?, ?)',
          done,
        ),
      );
      for (let i = 1; i <= 50; i += 1) {
        await cb((done) =>
          insCustomer.executeNonQuery(
            [
              `Customer ${i}`,
              `customer${i}@example.test`,
              String(i).padStart(16, '0'),
              `hash-${i}`,
            ],
            done,
          ),
        );
      }
      insCustomer.closeSync?.();

      const insOrder = await cb((done) =>
        db.prepare('INSERT INTO APP.ORDERS (CUSTOMER_ID, TOTAL, STATUS) VALUES (?, ?, ?)', done),
      );
      for (let i = 1; i <= 1000; i += 1) {
        await cb((done) =>
          insOrder.executeNonQuery([(i % 50) + 1, (i * 1.5).toFixed(2), STATUSES[i % 4]], done),
        );
      }
      insOrder.closeSync?.();

      await cb((done) => db.commitTransaction(done));
    } catch (err) {
      await cb((done) => db.rollbackTransaction(done)).catch(() => {});
      throw err;
    }

    const [{ C: customers }] = await cb((done) =>
      db.query('SELECT COUNT(*) AS C FROM APP.CUSTOMERS', [], done),
    );
    const [{ O: orders }] = await cb((done) =>
      db.query('SELECT COUNT(*) AS O FROM APP.ORDERS', [], done),
    );
    console.log(`Done: ${customers} customers, ${orders} orders.`);
  } finally {
    await cb((done) => db.close(done)).catch(() => {});
  }
}

main().catch((err) => {
  console.error('Db2 seed failed:', describeError(err));
  process.exitCode = 1;
});
