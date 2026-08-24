import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, databaseName } from "../src/db.js";
import { pendingMigrations, readMigrationLedger, splitMariaDbStatements } from "./migrations.mjs";

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
      console.log(`Applying ${migration.label}...`);
      for (const statement of splitMariaDbStatements(migration.sql, migration.label)) await connection.query(statement);
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

