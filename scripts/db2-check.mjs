#!/usr/bin/env node
// Db2 check: proves that ibm_db works on this machine and verifies the assumptions
// behind the Db2 adapter.
//
//   npm run docker:dev -- npm run check:db2   -> the local Db2 container, every check including
//                                                write+rollback and the query timeout
//
// Options:  --max-rows 100   --timeout-sec 2
//
// What is verified:
//   1. the ibm_db native module loads         6. row-by-row fetch + stopping at maxRows
//   2. a connection opens                      7. query timeout (SQL_ATTR_QUERY_TIMEOUT)
//   3. parameterized query (?)                 8. transaction + ROLLBACK
//   4. SYSCAT catalog: tables, columns, PK/FK  9. mapping data types to JavaScript
//   5. identifier upper-case rule

import { createRequire } from 'node:module';
import { devDb2Conn } from './lib/dev-connections.mjs';
import { parseArgs } from 'node:util';
import {
  cb,
  createCheck,
  describeError,
  hostOf,
  isLocalHost,
  jsTypeOf,
  loadEnv,
  redact,
  requireEnv,
  withDeadline,
} from './lib/harness.mjs';

const require = createRequire(import.meta.url);

const { values: args } = parseArgs({
  options: {
    'max-rows': { type: 'string', default: '100' },
    'timeout-sec': { type: 'string', default: '2' },
  },
});

const MAX_ROWS = Math.max(1, Number.parseInt(args['max-rows'], 10) || 100);
const TIMEOUT_SEC = Math.max(1, Number.parseInt(args['timeout-sec'], 10) || 2);

const check = createCheck('db2-local', {
  maxRows: MAX_ROWS,
  timeoutSec: TIMEOUT_SEC,
});

// ---------------------------------------------------------------------------------------------
// ibm_db helpers (callback style wrapped in a Promise so it works across ibm_db versions)
// ---------------------------------------------------------------------------------------------

const query = (db, sql, params = []) => cb((done) => db.query(sql, params, done));
const prepare = (db, sql) => cb((done) => db.prepare(sql, done));
const execute = (stmt, params = []) => cb((done) => stmt.execute(params, done));
const fetchRow = (result, mode) => cb((done) => result.fetch({ fetchMode: mode }, done));

/** Db2 CLI timeout: SQLSTATE HYT00 (ODBC) or SQL0952N / SQLSTATE 57014 (cancelled). */
function timeoutEvidence(err) {
  const d = describeError(err);
  const states = [d.state, d.sqlState].filter(Boolean).map(String);
  const isTimeout =
    states.some((s) => s === 'HYT00' || s === '57014') ||
    /SQL0952N|HYT00|57014|timeout/i.test(d.message);
  return { isTimeout, error: d };
}

function closeQuietly(obj) {
  try {
    obj?.closeSync?.();
  } catch {
    /* ignore */
  }
}

async function main() {
  loadEnv();
  let ibmdb;
  let db;
  let currentSchema = '';

  // 1. Native module -----------------------------------------------------------------------
  const loaded = await check.step('Load the ibm_db native module', () => {
    ibmdb = require('ibm_db');
    let version = 'unknown';
    try {
      version = require('ibm_db/package.json').version;
    } catch {
      /* package.json may not be exported */
    }
    return {
      version,
      hasQueryTimeoutConst: typeof ibmdb.SQL_ATTR_QUERY_TIMEOUT === 'number',
      fetchArray: ibmdb.FETCH_ARRAY,
    };
  });
  if (!loaded.ok) return check.finish({ fatal: 'ibm_db could not be loaded' });

  // 2. Connection string & connection ------------------------------------------------------
  let conn = '';
  const config = await check.step('Read DB2_LOCAL_PASSWORD from .env', () => {
    requireEnv('DB2_LOCAL_PASSWORD');
    conn = devDb2Conn();
    const host = hostOf(conn);
    if (!isLocalHost(host)) {
      throw new Error(`The local target must point to 127.0.0.1/localhost, not "${host}".`);
    }
    return { connection: redact(conn), host };
  });
  if (!config.ok) return check.finish({ fatal: 'DB2_LOCAL_PASSWORD is not set' });

  const opened = await check.step('Open a connection', async () => {
    db = await withDeadline(
      cb((done) => ibmdb.open(conn, done)),
      30_000,
      'open',
    );
    return 'connected';
  });
  if (!opened.ok) return check.finish({ fatal: 'connection failed' });

  try {
    // 3. Server info & parameterized query --------------------------------------------------
    await check.step('Session info (CURRENT SERVER/SCHEMA/USER)', async () => {
      const [row] = await query(
        db,
        'SELECT CURRENT SERVER AS DB_NAME, CURRENT SCHEMA AS SCHEMA_NAME, CURRENT USER AS USER_NAME FROM SYSIBM.SYSDUMMY1',
      );
      currentSchema = String(row.SCHEMA_NAME).trim();
      return {
        database: String(row.DB_NAME).trim(),
        schema: currentSchema,
        user: String(row.USER_NAME).trim(),
      };
    });

    await check.step(
      'Db2 server version',
      async () => {
        const [row] = await query(
          db,
          'SELECT SERVICE_LEVEL AS V FROM TABLE(SYSPROC.ENV_GET_INST_INFO()) AS I',
        );
        return { version: String(row.V).trim() };
      },
      { optional: true },
    );

    await check.step('Parameterized query (? placeholder)', async () => {
      const [row] = await query(
        db,
        'SELECT CAST(? AS INTEGER) + 1 AS N FROM SYSIBM.SYSDUMMY1',
        [41],
      );
      if (Number(row.N) !== 42) throw new Error(`Unexpected result: ${row.N}`);
      return { result: row.N, type: jsTypeOf(row.N) };
    });

    // 4. SYSCAT catalog ----------------------------------------------------------------------
    const schema = 'APP';
    let sampleTable = '';

    await check.step(`Catalog: tables & views in schema ${schema}`, async () => {
      const rows = await query(
        db,
        `SELECT TABNAME, TYPE FROM SYSCAT.TABLES
         WHERE TABSCHEMA = ? AND TYPE IN ('T', 'V')
         ORDER BY CASE WHEN TABNAME = 'ORDERS' THEN 0 ELSE 1 END, TABNAME
         FETCH FIRST 200 ROWS ONLY`,
        [schema],
      );
      if (rows.length === 0)
        throw new Error(
          `There are no tables in schema ${schema}. Run the seed: npm run docker:dev -- node scripts/seed-db2.mjs.`,
        );
      const table = rows.find((r) => String(r.TYPE).trim() === 'T') ?? rows[0];
      sampleTable = String(table.TABNAME).trim();
      return {
        tables: rows.filter((r) => String(r.TYPE).trim() === 'T').length,
        views: rows.filter((r) => String(r.TYPE).trim() === 'V').length,
        names: rows.map((r) => String(r.TABNAME).trim()),
      };
    });

    if (sampleTable) {
      await check.step(`Catalog: columns, PK, FK, indexes (${sampleTable})`, async () => {
        const columns = await query(
          db,
          `SELECT COLNAME, TYPENAME, LENGTH, SCALE, NULLS, "DEFAULT" AS DEFAULT_VALUE
           FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY COLNO`,
          [schema, sampleTable],
        );
        const pk = await query(
          db,
          `SELECT K.COLNAME FROM SYSCAT.KEYCOLUSE K
           JOIN SYSCAT.TABCONST C
             ON C.CONSTNAME = K.CONSTNAME AND C.TABSCHEMA = K.TABSCHEMA AND C.TABNAME = K.TABNAME
           WHERE C.TYPE = 'P' AND K.TABSCHEMA = ? AND K.TABNAME = ?
           ORDER BY K.COLSEQ`,
          [schema, sampleTable],
        );
        const fk = await query(
          db,
          `SELECT CONSTNAME, REFTABSCHEMA, REFTABNAME, FK_COLNAMES, PK_COLNAMES
           FROM SYSCAT.REFERENCES WHERE TABSCHEMA = ? AND TABNAME = ?`,
          [schema, sampleTable],
        );
        const indexes = await query(
          db,
          'SELECT INDNAME, COLNAMES, UNIQUERULE FROM SYSCAT.INDEXES WHERE TABSCHEMA = ? AND TABNAME = ?',
          [schema, sampleTable],
        );
        if (columns.length === 0) throw new Error('SYSCAT.COLUMNS is empty for the sample table');
        if (pk.length !== 1 || fk.length !== 1 || indexes.length < 2) {
          throw new Error(
            `Seed mismatch: pk=${pk.length}, fk=${fk.length}, index=${indexes.length}`,
          );
        }
        return {
          columns: columns.length,
          primaryKey: pk.length,
          foreignKeys: fk.length,
          indexes: indexes.length,
          // Example FK_COLNAMES / COLNAMES format (contains spaces & +/- prefixes) for the adapter parser.
          fkColnames: fk[0]?.FK_COLNAMES,
          indexColnames: indexes.map((i) => i.COLNAMES),
        };
      });
    } else {
      check.skip('Catalog: columns, PK, FK, indexes', 'no sample table');
    }

    // 5. Upper-case identifiers ---------------------------------------------------------------
    await check.step('Unquoted identifiers are stored in UPPER CASE', async () => {
      const count = async (s) =>
        Number(
          (await query(db, 'SELECT COUNT(*) AS N FROM SYSCAT.TABLES WHERE TABSCHEMA = ?', [s]))[0]
            .N,
        );
      const upper = await count(schema);
      const lower = await count(schema.toLowerCase());
      if (upper === 0) throw new Error('No upper-case schema found');
      return {
        upper,
        lower,
        conclusion: lower === 0 ? 'the adapter must normalize to upper case' : 'check manually',
      };
    });

    // 6. Row-by-row fetch + stopping at maxRows ----------------------------------------------
    await check.step(`Row-by-row fetch, stopping at maxRows+1 (${MAX_ROWS + 1})`, async () => {
      const t0 = performance.now();
      const stmt = await prepare(
        db,
        'SELECT TABSCHEMA, TABNAME, COLNAME, TYPENAME FROM SYSCAT.COLUMNS',
      );
      let result;
      try {
        result = await execute(stmt);
        const columnNames = result.getColumnNamesSync?.() ?? [];
        let metadataKeys = [];
        try {
          const meta = result.getColumnMetadataSync?.();
          metadataKeys = meta && meta[0] ? Object.keys(meta[0]) : [];
        } catch {
          /* not available in this version */
        }
        let fetched = 0;
        let firstRowIsArray = null;
        while (fetched < MAX_ROWS + 1) {
          const row = await fetchRow(result, ibmdb.FETCH_ARRAY);
          if (row === null || row === undefined) break;
          if (firstRowIsArray === null) firstRowIsArray = Array.isArray(row);
          fetched += 1;
        }
        const truncated = fetched > MAX_ROWS;
        if (!truncated)
          throw new Error(`Only ${fetched} rows; the catalog is too small to test truncation`);
        return {
          fetched,
          truncated,
          firstRowIsArray,
          columnNames,
          metadataKeys,
          ms: Math.round(performance.now() - t0),
        };
      } finally {
        closeQuietly(result);
        closeQuietly(stmt);
      }
    });

    // 7. Query timeout -------------------------------------------------------------------------
    if (typeof ibmdb.SQL_ATTR_QUERY_TIMEOUT !== 'number') {
      check.info(
        'Query timeout',
        'the SQL_ATTR_QUERY_TIMEOUT constant does not exist in this ibm_db version',
      );
    } else {
      await check.step(
        `A query timeout of ${TIMEOUT_SEC} seconds cancels a heavy query`,
        async () => {
          // A 3-way Cartesian product over the catalog: deliberately heavy.
          const stmt = await prepare(
            db,
            'SELECT COUNT(*) AS N FROM SYSCAT.COLUMNS A, SYSCAT.COLUMNS B, SYSCAT.COLUMNS C',
          );
          stmt.setAttrSync(ibmdb.SQL_ATTR_QUERY_TIMEOUT, TIMEOUT_SEC);
          const watchdogMs = (TIMEOUT_SEC + 30) * 1000;
          const t0 = performance.now();
          let result;
          let phase = 'execute';
          try {
            result = await withDeadline(execute(stmt), watchdogMs, 'watchdog');
            phase = 'fetch';
            const row = await withDeadline(
              fetchRow(result, ibmdb.FETCH_ARRAY),
              watchdogMs,
              'watchdog',
            );
            throw new Error(
              `TIMEOUT DOES NOT WORK: the query finished in ${Math.round(performance.now() - t0)} ms (result ${JSON.stringify(row)})`,
            );
          } catch (err) {
            const elapsedMs = Math.round(performance.now() - t0);
            if (/watchdog/.test(String(err.message))) {
              throw new Error(
                `TIMEOUT DOES NOT WORK: the query is still running after ${elapsedMs} ms`,
              );
            }
            if (/TIMEOUT DOES NOT WORK/.test(String(err.message))) throw err;
            const evidence = timeoutEvidence(err);
            // ibm_db 4.x drops the SQL0952N message on a timeout: an empty error, sqlcode 0. When that
            // empty error appears right after the time limit, it is still proof that the timeout works.
            const silent = !describeError(err).message && elapsedMs >= TIMEOUT_SEC * 1000 - 250;
            if (silent) evidence.isTimeout = true;
            if (!evidence.isTimeout) {
              throw new Error(
                `The query failed, but not because of the timeout: ${evidence.error.message}`,
              );
            }
            if (elapsedMs > (TIMEOUT_SEC + 10) * 1000) {
              throw new Error(
                `The timeout fired, but late (${elapsedMs} ms for a limit of ${TIMEOUT_SEC} s)`,
              );
            }
            // This error code is what the adapter maps to the DB_TIMEOUT category.
            return {
              cancelled: true,
              phase,
              elapsedMs,
              error: evidence.error,
              ...(silent
                ? {
                    note: 'ibm_db does not include the SQL0952N message; the adapter recognizes it from the elapsed time',
                  }
                : {}),
            };
          } finally {
            closeQuietly(result);
            closeQuietly(stmt);
          }
        },
      );
    }

    // 8. Transaction + ROLLBACK ----------------------------------------------------------------
    await check.step(
      'INSERT inside a transaction, then ROLLBACK (the data returns to how it was)',
      async () => {
        const countOrders = async () =>
          Number((await query(db, 'SELECT COUNT(*) AS N FROM APP.ORDERS'))[0].N);
        const before = await countOrders();
        await cb((done) => db.beginTransaction(done));
        let inside;
        try {
          await query(
            db,
            "INSERT INTO APP.ORDERS (CUSTOMER_ID, TOTAL, STATUS) VALUES (1, 1.00, 'check')",
          );
          inside = await countOrders();
        } finally {
          await cb((done) => db.rollbackTransaction(done));
        }
        const after = await countOrders();
        if (inside !== before + 1 || after !== before) {
          throw new Error(`Rollback mismatch: before=${before}, inside=${inside}, after=${after}`);
        }
        return { before, inside, after };
      },
    );

    // 9. Data type mapping ------------------------------------------------------------------------
    const typeSql = (withBlob) => `SELECT
        CAST(12345.67 AS DECIMAL(12, 2))       AS DEC_VAL,
        CAST(9007199254740993 AS BIGINT)       AS BIGINT_VAL,
        CAST(42 AS INTEGER)                    AS INT_VAL,
        CAST(1.5 AS DOUBLE)                    AS DOUBLE_VAL,
        CURRENT DATE                           AS DATE_VAL,
        CURRENT TIMESTAMP                      AS TS_VAL,
        CAST('text' AS VARCHAR(10))            AS VARCHAR_VAL,
        CAST('ab' AS CHAR(5))                  AS CHAR_VAL,
        CAST(NULL AS VARCHAR(10))              AS NULL_VAL
        ${withBlob ? ", BLOB(X'DEADBEEF')     AS BLOB_VAL" : ''}
      FROM SYSIBM.SYSDUMMY1`;

    await check.step('Db2 -> JavaScript data type mapping', async () => {
      let row;
      let blobTested = true;
      try {
        [row] = await query(db, typeSql(true));
      } catch {
        blobTested = false;
        [row] = await query(db, typeSql(false));
      }
      const types = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          { type: jsTypeOf(v), value: Buffer.isBuffer(v) ? v.toString('hex') : v },
        ]),
      );
      const bigint = row.BIGINT_VAL;
      return {
        types,
        blobTested,
        bigintPreserved: String(bigint) === '9007199254740993',
        charPadded: typeof row.CHAR_VAL === 'string' && row.CHAR_VAL.length === 5,
      };
    });
  } catch (err) {
    check.info('Unexpected error', describeError(err));
  } finally {
    if (db) {
      await check.step(
        'Close the connection',
        async () => {
          await withDeadline(
            cb((done) => db.close(done)),
            15_000,
            'close',
          );
          return 'closed';
        },
        { optional: true },
      );
    }
  }

  check.finish();
  // Make sure the process stops even if a query is still hanging on the driver side.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}

main().catch((err) => {
  console.error('Db2 check stopped:', describeError(err));
  process.exitCode = 1;
});
