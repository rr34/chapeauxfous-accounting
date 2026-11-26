import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, databaseName } from "../src/db.js";
import { verifyAllPostedTransactions } from "../src/accounting.js";
import { invoiceMinorToLedgerUnits } from "../src/invoice-payments.js";
import { accountingStorageTables } from "../src/schema-description.js";
import { readMigrationLedger } from "./migrations.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = readMigrationLedger(path.resolve(here, "../../db/migrations.sql"));
const expectedVersion = migrations.at(-1)?.version ?? 0;

try {
  const [versions] = await pool.query("SELECT schema_version, last_migration FROM accounting_schema_metadata WHERE singleton = 1");
  if (versions.length !== 1 || Number(versions[0].schema_version) !== expectedVersion) {
    throw new Error(`Expected schema version ${expectedVersion}; found ${versions[0]?.schema_version ?? "none"}`);
  }
  const requiredTables = accountingStorageTables;
  const [tables] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${requiredTables.map(() => "?").join(",")})`,
    [databaseName, ...requiredTables],
  );
  const presentTables = new Set(tables.map((row) => row.TABLE_NAME));
  const missingTables = requiredTables.filter((table) => !presentTables.has(table));
  if (missingTables.length) throw new Error(`Required accounting tables are missing: ${missingTables.join(", ")}`);
  const [storageComments] = await pool.query(
    `SELECT COUNT(DISTINCT t.TABLE_NAME) AS table_count,
            COUNT(DISTINCT CASE WHEN t.TABLE_COMMENT = '' THEN t.TABLE_NAME END) AS missing_table_comments,
            SUM(c.COLUMN_COMMENT = '') AS missing_column_comments
       FROM information_schema.TABLES t
       JOIN information_schema.COLUMNS c
         ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
        AND t.TABLE_NAME IN (${requiredTables.map(() => "?").join(",")})`,
    [databaseName, ...requiredTables],
  );
  const comments = storageComments[0];
  if (Number(comments.table_count) !== requiredTables.length || Number(comments.missing_table_comments) !== 0
    || Number(comments.missing_column_comments) !== 0) {
    throw new Error(`Accounting storage comments are incomplete: expected ${requiredTables.length} tables; found ${comments.table_count}; `
      + `${comments.missing_table_comments} table comments and ${comments.missing_column_comments} column comments are missing.`);
  }
  if (expectedVersion >= 30) {
    const [invalid] = await pool.query(`SELECT i.invoice_id FROM accounting_invoices i
      JOIN accounts ar ON ar.account_id = i.receivable_account_id
      JOIN currencies c ON c.currency_id = ar.account_currency_id
      LEFT JOIN accounting_invoice_lines l ON l.invoice_id = i.invoice_id
      LEFT JOIN accounts a ON a.account_id = l.account_id
      WHERE ar.owner_person_id <> i.owner_person_id OR ar.AccountType <> 'asset' OR ar.is_suspense = 1
        OR ar.is_placeholder = 1 OR ar.archived_at IS NOT NULL OR c.CurrencyAbbreviation <> i.currency
        OR c.currency_type <> 'iso_4217'
        OR (l.invoice_line_id IS NOT NULL AND (a.owner_person_id <> i.owner_person_id
          OR a.account_currency_id <> ar.account_currency_id OR a.account_id = ar.account_id
          OR a.is_placeholder = 1 OR a.archived_at IS NOT NULL)) LIMIT 1`);
    if (invalid.length) throw new Error("Invoice account assignments failed owner, currency, or account-role verification.");
  }
  if (expectedVersion >= 32) {
    const [invalid] = await pool.query(`SELECT p.payment_id FROM accounting_invoice_payments p
      JOIN accounting_invoices i ON i.invoice_id = p.invoice_id
      JOIN line_items l ON l.line_item_id = p.line_item_id
      JOIN transactions t ON t.transaction_id = l.transaction_id
      WHERE t.owner_person_id <> i.owner_person_id OR t.TransactionState <> 'posted'
        OR l.account_id <> i.receivable_account_id OR l.amount_units >= 0
        OR p.amount_minor = 0 OR i.stripe_invoice_id IS NOT NULL LIMIT 1`);
    const [unbalanced] = await pool.query(`SELECT i.invoice_id FROM accounting_invoices i
      JOIN accounting_invoice_payments p ON p.invoice_id = i.invoice_id
      GROUP BY i.invoice_id, i.amount_minor, i.amount_paid_minor, i.amount_remaining_minor, i.invoice_status
      HAVING SUM(p.amount_minor) <> i.amount_paid_minor OR i.amount_remaining_minor IS NULL
        OR i.amount_paid_minor + i.amount_remaining_minor <> i.amount_minor
        OR (i.amount_remaining_minor = 0 AND i.invoice_status <> 'paid')
        OR (i.amount_remaining_minor > 0 AND i.invoice_status <> 'open') LIMIT 1`);
    if (invalid.length || unbalanced.length) throw new Error("Invoice payment allocations failed ledger or balance verification.");
    const [credits] = await pool.query(`SELECT i.currency, c.scale, l.amount_units, SUM(p.amount_minor) AS applied_minor
      FROM accounting_invoice_payments p
      JOIN accounting_invoices i ON i.invoice_id = p.invoice_id
      JOIN line_items l ON l.line_item_id = p.line_item_id
      JOIN accounts a ON a.account_id = l.account_id
      JOIN currencies c ON c.currency_id = a.account_currency_id
      GROUP BY l.line_item_id, i.currency, c.scale, l.amount_units`);
    if (credits.some((line) => invoiceMinorToLedgerUnits(line.applied_minor, line.currency, line.scale) > -BigInt(line.amount_units))) {
      throw new Error("An invoice payment allocation exceeds its ledger credit.");
    }
  }
  const report = await verifyAllPostedTransactions(pool);
  if (!report.valid) throw new Error(`Ledger verification failed: ${JSON.stringify(report.failures)}`);
  console.log(`Schema version ${expectedVersion} verified; ${report.checked} posted transactions balance.`);
} finally {
  await pool.end();
}
