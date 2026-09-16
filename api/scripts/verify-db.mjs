import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, databaseName } from "../src/db.js";
import { verifyAllPostedTransactions } from "../src/accounting.js";
import { readMigrationLedger } from "./migrations.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = readMigrationLedger(path.resolve(here, "../../db/migrations.sql"));
const expectedVersion = migrations.at(-1)?.version ?? 0;

try {
  const [versions] = await pool.query("SELECT schema_version, last_migration FROM accounting_schema_metadata WHERE singleton = 1");
  if (versions.length !== 1 || Number(versions[0].schema_version) !== expectedVersion) {
    throw new Error(`Expected schema version ${expectedVersion}; found ${versions[0]?.schema_version ?? "none"}`);
  }
  const [tables] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN
        ('people2_people','accounts','transactions','line_items','tags','lineitems_tags_join','xrates',
         'account_balance_assertions','accounting_import_plans','api_tokens')`,
    [databaseName],
  );
  if (tables.length !== 10) throw new Error("Required accounting tables are missing");
  const [storageComments] = await pool.query(
    `SELECT COUNT(DISTINCT t.TABLE_NAME) AS table_count,
            SUM(t.TABLE_COMMENT = '') AS missing_table_comments,
            SUM(c.COLUMN_COMMENT = '') AS missing_column_comments
       FROM information_schema.TABLES t
       JOIN information_schema.COLUMNS c
         ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'`,
    [databaseName],
  );
  const comments = storageComments[0];
  if (Number(comments.table_count) !== 15 || Number(comments.missing_table_comments) !== 0
    || Number(comments.missing_column_comments) !== 0) {
    throw new Error("Accounting storage comments are incomplete");
  }
  const report = await verifyAllPostedTransactions(pool);
  if (!report.valid) throw new Error(`Ledger verification failed: ${JSON.stringify(report.failures)}`);
  console.log(`Schema version ${expectedVersion} verified; ${report.checked} posted transactions balance.`);
} finally {
  await pool.end();
}
