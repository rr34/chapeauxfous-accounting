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
  assert.deepEqual(migrations.map((migration) => migration.version), [1, 2, 3, 4, 5, 6, 7, 8]);
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
  const accountDefaultsMigration = migrations.find((migration) => migration.version === 5);
  assert.match(accountDefaultsMigration.sql, /MODIFY AccountType ENUM\('asset','liability','income','expense','equity'\) NOT NULL;/);
  assert.match(accountDefaultsMigration.sql, /DROP TABLE IF EXISTS accounting_profiles/);
  const apiTokenMigration = migrations.find((migration) => migration.version === 6);
  assert.match(apiTokenMigration.sql, /CREATE TABLE IF NOT EXISTS api_tokens/);
  assert.match(apiTokenMigration.sql, /token_hash BINARY\(32\) NOT NULL/);
  const accountMetadataMigration = migrations.find((migration) => migration.version === 7);
  assert.match(accountMetadataMigration.sql, /ADD COLUMN IF NOT EXISTS description TEXT NULL/);
  assert.match(accountMetadataMigration.sql, /ADD COLUMN IF NOT EXISTS is_placeholder TINYINT\(1\) NOT NULL DEFAULT 0/);
  const ownedCurrenciesMigration = migrations.find((migration) => migration.version === 8);
  assert.match(ownedCurrenciesMigration.sql, /ADD COLUMN IF NOT EXISTS owner_person_id INT NULL/);
  assert.match(ownedCurrenciesMigration.sql, /ENUM\('iso_4217','crypto','security','commodity','custom'\)/);
  assert.match(ownedCurrenciesMigration.sql, /ADD COLUMN scope_owner_person_id INT NOT NULL DEFAULT 0/);
  assert.doesNotMatch(ownedCurrenciesMigration.sql, /GENERATED ALWAYS/);
  assert.match(ownedCurrenciesMigration.sql, /UNIQUE KEY currencies_scope_code_UQ/);
  assert.match(ownedCurrenciesMigration.sql, /FOREIGN KEY \(owner_person_id\) REFERENCES people2_people \(person_id\)/);
});
