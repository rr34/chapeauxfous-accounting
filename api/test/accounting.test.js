import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { validateTransaction } = await import("../src/accounting.js");

function fakeConnection({ lines, rates }) {
  return {
    async query(sql) {
      if (sql.includes("FROM transactions")) {
        return [[{ transaction_id: 44, owner_person_id: 7, valuation_currency_id: 3, TransactionState: "draft" }]];
      }
      if (sql.includes("FROM line_items li")) return [lines];
      if (sql.includes("FROM xrates")) return [rates];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test("BTC purchased with PEN balances without USD", async () => {
  const result = await validateTransaction(fakeConnection({
    lines: [
      { line_item_id: 1, amount_units: "1000000", account_id: 10, account_owner_person_id: 7, account_currency_id: 2 },
      { line_item_id: 2, amount_units: "-150000", account_id: 11, account_owner_person_id: 7, account_currency_id: 3 },
    ],
    rates: [
      { xrate_id: 1, from_units: "1000000", from_currency_id: 2, to_units: "150000", to_currency_id: 3 },
    ],
  }), 44, 7);
  assert.equal(result.valid, true);
  assert.deepEqual(result.foreignCurrencyIds, [2]);
});

test("posting fails when a foreign commodity has no transaction rate", async () => {
  await assert.rejects(
    validateTransaction(fakeConnection({
      lines: [
        { line_item_id: 1, amount_units: "1000000", account_id: 10, account_owner_person_id: 7, account_currency_id: 2 },
        { line_item_id: 2, amount_units: "-150000", account_id: 11, account_owner_person_id: 7, account_currency_id: 3 },
      ],
      rates: [],
    }), 44, 7),
    (error) => error.code === "MISSING_RATE",
  );
});

test("posting fails when a line item uses a placeholder account", async () => {
  await assert.rejects(
    validateTransaction(fakeConnection({
      lines: [
        { line_item_id: 1, amount_units: "100", account_id: 10, account_owner_person_id: 7, account_currency_id: 3, is_placeholder: 1 },
        { line_item_id: 2, amount_units: "-100", account_id: 11, account_owner_person_id: 7, account_currency_id: 3, is_placeholder: 0 },
      ],
      rates: [],
    }), 44, 7),
    (error) => error.code === "PLACEHOLDER_ACCOUNT",
  );
});
