import assert from "node:assert/strict";
import test from "node:test";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { mergeSuspenseTransferPair } = await import("../src/suspense-transfer-merge.js");

function mergeFixture() {
  const selected = [
    { line_item_id: "901", transaction_id: "81", amount_units: "-9700", value_units: "-9700",
      account_id: "30", reconciliation_state: "unreconciled", account_currency_id: "1", is_suspense: 1,
      TransactionDate: "2026-09-28", description: "CAPITAL ONE ONLINE PYMT", valuation_currency_id: "1",
      TransactionState: "posted", reversal_of_transaction_id: null, source_system: "statement",
      source_id: "capone-1", source_fingerprint: "a".repeat(64), is_open: 1 },
    { line_item_id: "903", transaction_id: "82", amount_units: "9700", value_units: "9700",
      account_id: "30", reconciliation_state: "unreconciled", account_currency_id: "1", is_suspense: 1,
      TransactionDate: "2026-09-26", description: "CAPITAL ONE PAYMENT", valuation_currency_id: "1",
      TransactionState: "posted", reversal_of_transaction_id: null, source_system: "statement",
      source_id: "checking-1", source_fingerprint: "b".repeat(64), is_open: 1 },
  ];
  const originalLines = [
    { line_item_id: "901", transaction_id: "81", account_id: "30", amount_units: "-9700",
      value_units: "-9700", account_currency_id: "1", AccountName: "Ask Accountant" },
    { line_item_id: "902", transaction_id: "81", account_id: "31", amount_units: "9700",
      value_units: "9700", account_currency_id: "1", AccountName: "CC CapOne x7334" },
    { line_item_id: "903", transaction_id: "82", account_id: "30", amount_units: "9700",
      value_units: "9700", account_currency_id: "1", AccountName: "Ask Accountant" },
    { line_item_id: "904", transaction_id: "82", account_id: "44", amount_units: "-9700",
      value_units: "-9700", account_currency_id: "1", AccountName: "Checking" },
  ];
  const mergedLines = [
    { line_item_id: "902", amount_units: "9700", value_units: "9700", account_id: "31",
      account_owner_person_id: "7", account_currency_id: "1", is_placeholder: 0 },
    { line_item_id: "904", amount_units: "-9700", value_units: "-9700", account_id: "44",
      account_owner_person_id: "7", account_currency_id: "1", is_placeholder: 0 },
  ];
  const writes = [];
  const responses = [
    [selected], [[]], [originalLines], [[]], [[]],
    [{ insertId: 1 }], [{ affectedRows: 0 }], [{ affectedRows: 1 }], [{ affectedRows: 1 }],
    [{ affectedRows: 2 }], [{ affectedRows: 1 }], [{ affectedRows: 1 }],
    [[{ transaction_id: "81", owner_person_id: "7", valuation_currency_id: "1", TransactionState: "posted" }]],
    [mergedLines], [[]],
  ];
  const connection = {
    async beginTransaction() { writes.push("BEGIN"); },
    async commit() { writes.push("COMMIT"); },
    async rollback() { writes.push("ROLLBACK"); },
    release() { writes.push("RELEASE"); },
    async query(sql) {
      writes.push(sql.replace(/\s+/gu, " ").trim());
      const response = responses.shift();
      assert.ok(response, `Unexpected connection query: ${sql}`);
      return response;
    },
  };
  const readResponses = [
    [[{ transaction_id: "81", TransactionDate: "2026-09-28", TransactionAtUtc: null,
      description: "CAPITAL ONE ONLINE PYMT", TransactionState: "posted", valuation_currency_id: "1" }]],
    [[
      { line_item_id: "902", amount_units: "9700", value_units: "9700", reconciliation_state: "unreconciled",
        reconciled_at: null, memo: null, account_id: "31", AccountName: "CC CapOne x7334",
        account_currency_id: "1", CurrencyAbbreviation: "USD", scale: "2" },
      { line_item_id: "904", amount_units: "-9700", value_units: "-9700", reconciliation_state: "cleared",
        reconciled_at: null, memo: null, account_id: "44", AccountName: "Checking",
        account_currency_id: "1", CurrencyAbbreviation: "USD", scale: "2" },
    ]],
    [[]], [[]],
    [[{ absorbed_transaction_id: "82", absorbed_transaction_date: "2026-09-26",
      absorbed_description: "CAPITAL ONE PAYMENT", absorbed_source_system: "statement",
      absorbed_source_id: "checking-1", absorbed_source_fingerprint: "b".repeat(64),
      created_at: "2026-11-17T12:00:00.000Z" }]],
  ];
  const pool = {
    async getConnection() { return connection; },
    async query(sql) {
      writes.push(`READ ${sql.replace(/\s+/gu, " ").trim()}`);
      const response = readResponses.shift();
      assert.ok(response, `Unexpected pool query: ${sql}`);
      return response;
    },
  };
  return { pool, writes, responses, readResponses };
}

test("merges exact opposite suspense imports into the user-selected transaction", async () => {
  const fixture = mergeFixture();
  const merged = await mergeSuspenseTransferPair({
    pool: fixture.pool, personId: 7, lineItemIds: [901, 903], retainedTransactionId: 81,
  });
  assert.equal(merged.retainedTransactionId, 81);
  assert.equal(merged.absorbedTransactionId, 82);
  assert.equal(merged.movedLineItemId, 904);
  assert.deepEqual(merged.transaction.lineItems.map((line) => line.id), [902, 904]);
  assert.equal(merged.transaction.lineItems[1].reconciliationState, "cleared");
  assert.equal(merged.transaction.mergedTransactions[0].absorbedTransactionId, 82);
  assert.equal(fixture.responses.length, 0);
  assert.equal(fixture.readResponses.length, 0);
  assert.ok(fixture.writes.some((sql) => sql.includes("UPDATE accounting_transaction_import_items")));
  assert.ok(fixture.writes.some((sql) => sql.includes("DELETE FROM transactions")));
  assert.deepEqual(fixture.writes.filter((entry) => ["BEGIN", "COMMIT", "ROLLBACK", "RELEASE"].includes(entry)),
    ["BEGIN", "COMMIT", "RELEASE"]);
});
