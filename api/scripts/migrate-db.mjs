import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, databaseName } from "../src/db.js";
import { pendingMigrations, readMigrationLedger, splitMariaDbStatements } from "./migrations.mjs";
import { migrateInvoiceLines } from "./migrate-invoice-lines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ledgerFilename = path.resolve(here, "../../db/migrations.sql");
const metadataTable = "accounting_schema_metadata";
const lockName = `cf-accounting:migrations:${databaseName}`;

async function currentVersion(connection) {
  const [tables] = await connection.query(
    `SELECT COUNT(*) AS count FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'`,
    [databaseName, metadataTable],
  );
  if (Number(tables[0].count) === 0) return 0;
  const [rows] = await connection.query(`SELECT singleton, schema_version FROM ${metadataTable}`);
  if (rows.length !== 1 || Number(rows[0].singleton) !== 1) throw new Error("Invalid accounting schema metadata");
  return Number(rows[0].schema_version);
}

async function assertCoreBaseline(connection) {
  const required = ["accounts", "currencies", "line_items", "lineitems_tags_join", "tags", "transactions", "xrates"];
  const [rows] = await connection.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${required.map(() => "?").join(",")})`,
    [databaseName, ...required],
  );
  const present = new Set(rows.map((row) => row.TABLE_NAME));
  const missing = required.filter((table) => !present.has(table));
  if (missing.length) throw new Error(`Import db/schema.sql before migrating; missing tables: ${missing.join(", ")}`);
}

async function assertInvoiceAccountBackfill(connection) {
  const [unsupported] = await connection.query("SELECT DISTINCT currency FROM accounting_invoices WHERE currency <> 'USD'");
  if (unsupported.length) {
    throw new Error(`Invoice backfill requires USD invoices. Choose accounts for these currencies first: ${unsupported.map(({ currency }) => currency).join(", ")}.`);
  }
  const [owners] = await connection.query(`SELECT DISTINCT invoice.owner_person_id,
    (SELECT COUNT(*) FROM accounts a JOIN currencies c ON c.currency_id = a.account_currency_id
      WHERE a.owner_person_id = invoice.owner_person_id AND a.is_suspense = 1 AND a.is_placeholder = 0
        AND a.archived_at IS NULL AND c.CurrencyAbbreviation = 'USD' AND c.currency_type = 'iso_4217') AS suspense_count,
    (SELECT COUNT(*) FROM accounts a JOIN currencies c ON c.currency_id = a.account_currency_id
      WHERE a.owner_person_id = invoice.owner_person_id AND a.AccountName = 'Accounts Receivable'
        AND a.AccountType = 'asset' AND a.is_suspense = 0 AND a.is_placeholder = 0
        AND a.archived_at IS NULL AND c.CurrencyAbbreviation = 'USD' AND c.currency_type = 'iso_4217') AS receivable_count
    FROM accounting_invoices invoice`);
  for (const owner of owners) {
    if (Number(owner.suspense_count) !== 1 || Number(owner.receivable_count) > 1) {
      throw new Error(`Invoice owner ${owner.owner_person_id} must have exactly one active USD suspense account and at most one active USD Accounts Receivable asset account.`);
    }
  }
}

async function main() {
  const migrations = readMigrationLedger(ledgerFilename);
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    if (Number(lockRows[0].acquired) !== 1) throw new Error("Could not acquire migration lock");
    locked = true;
    let version = await currentVersion(connection);
    const pending = pendingMigrations(migrations, version);
    if (!pending.length) {
      console.log(`Database already at schema version ${version}.`);
      return;
    }
    if (process.env.ACCOUNTING_MIGRATION_BACKUP_CONFIRMED !== "1") {
      throw new Error("Confirm a recoverable backup, then set ACCOUNTING_MIGRATION_BACKUP_CONFIRMED=1.");
    }
    if (version === 0) await assertCoreBaseline(connection);
    for (const migration of pending) {
      if (migration.version === 30) await assertInvoiceAccountBackfill(connection);
      console.log(`Applying ${migration.label}...`);
      for (const statement of splitMariaDbStatements(migration.sql, migration.label)) {
        if (migration.version === 33 && statement === "DROP TABLE IF EXISTS accounting_invoice_lines;") {
          await migrateInvoiceLines(connection);
        }
        await connection.query(statement);
      }
      const [result] = await connection.query(
        `UPDATE ${metadataTable}
            SET schema_version = ?, last_migration = ?, updated_at = CURRENT_TIMESTAMP(6)
          WHERE singleton = 1 AND schema_version = ?`,
        [migration.version, migration.label, version],
      );
      if (Number(result.affectedRows) !== 1) throw new Error(`Could not advance schema from ${version}`);
      version = migration.version;
    }
    console.log(`Database migrated to schema version ${version}.`);
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    connection.release();
    await pool.end();
  }
}

await main();

