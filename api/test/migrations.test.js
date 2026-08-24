import test from "node:test";
import assert from "node:assert/strict";
import { readMigrationLedger, parseMigrationLedger, pendingMigrations, splitMariaDbStatements } from "../scripts/migrations.mjs";

test("migration ledger is newest-first and applied oldest-first", () => {
  const source = `-- migration 0002: second\nSELECT 2;\n-- end migration 0002\n-- migration 0001: first\nSELECT 1;\n-- end migration 0001`;
  const migrations = parseMigrationLedger(source);
  assert.deepEqual(migrations.map((migration) => migration.version), [1, 2]);
  assert.deepEqual(pendingMigrations(migrations, 1).map((migration) => migration.version), [2]);
});

test("SQL splitter ignores semicolons inside strings", () => {
  assert.deepEqual(splitMariaDbStatements("INSERT INTO x VALUES ('a;b'); SELECT 1;"), [
    "INSERT INTO x VALUES ('a;b');", "SELECT 1;",
  ]);
});

test("the repository migration ledger is valid and contiguous", () => {
  const migrations = readMigrationLedger(new URL("../../db/migrations.sql", import.meta.url));
  assert.deepEqual(migrations.map((migration) => migration.version), [1, 2, 3, 4, 5]);
  assert.ok(migrations.every((migration) => splitMariaDbStatements(migration.sql, migration.label).length > 0));
  const currencyMigration = migrations.find((migration) => migration.version === 3);
  assert.match(currencyMigration.sql, /VARCHAR\(50\)/);
  assert.match(currencyMigration.sql, /\('BTC satoshi', 0\)/);
  const seededCodes = [...currencyMigration.sql.matchAll(/\('([^']+)', \d+\)/g)].map((match) => match[1]);
  assert.equal(seededCodes.length, 167);
  assert.equal(new Set(seededCodes).size, seededCodes.length);
  const assertionMigration = migrations.find((migration) => migration.version === 4);
  assert.match(assertionMigration.sql, /CREATE TABLE IF NOT EXISTS account_balance_assertions/);
  assert.match(assertionMigration.sql, /UNIQUE KEY account_balance_assertions_account_date_UQ \(account_id, balance_date\)/);
  assert.match(migrations.at(-1).sql, /MODIFY AccountType ENUM\('asset','liability','income','expense','equity'\) NOT NULL;/);
  assert.match(migrations.at(-1).sql, /DROP TABLE IF EXISTS accounting_profiles/);
});
