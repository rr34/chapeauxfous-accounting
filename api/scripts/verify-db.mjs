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
        ('people2_people','accounting_profiles','accounts','transactions','line_items','tags','lineitems_tags_join','xrates',
         'account_balance_assertions')`,
    [databaseName],
  );
  if (tables.length !== 9) throw new Error("Required accounting tables are missing");
  const report = await verifyAllPostedTransactions(pool);
  if (!report.valid) throw new Error(`Ledger verification failed: ${JSON.stringify(report.failures)}`);
  console.log(`Schema version ${expectedVersion} verified; ${report.checked} posted transactions balance.`);
} finally {
  await pool.end();
}
