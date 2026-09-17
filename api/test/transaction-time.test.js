import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTransactionAt, transactionAtForDatabase, transactionAtFromDatabase,
} from "../src/transaction-time.js";

test("a transaction's optional source instant stays separate from its ledger date", () => {
  assert.equal(normalizeTransactionAt(null), null);
  assert.equal(transactionAtForDatabase(null), null);
  assert.equal(transactionAtFromDatabase(null), null);
  const instant = normalizeTransactionAt("2026-09-01T23:59:59.12Z");
  assert.equal(instant, "2026-09-01T23:59:59.120Z");
  assert.equal(transactionAtForDatabase(instant), "2026-09-01 23:59:59.120");
  assert.equal(transactionAtFromDatabase("2026-09-01 23:59:59.120"), instant);
  assert.throws(() => normalizeTransactionAt("2026-09-01T23:59:59-04:00"),
    (error) => error.code === "INVALID_TRANSACTION_AT");
  assert.throws(() => normalizeTransactionAt("2026-09-31T23:59:59Z"),
    (error) => error.code === "INVALID_TRANSACTION_AT");
});
