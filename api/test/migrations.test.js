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
  assert.deepEqual(migrations.map((migration) => migration.version), [1, 2]);
  assert.ok(migrations.every((migration) => splitMariaDbStatements(migration.sql, migration.label).length > 0));
});
