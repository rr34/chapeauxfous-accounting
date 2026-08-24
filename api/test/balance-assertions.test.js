import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { listBalanceAssertions } = await import("../src/balance-assertions.js");

test("a balance assertion reports the exact known-minus-ledger difference", async () => {
  const pool = {
    async query(_sql, params) {
      assert.deepEqual(params, [7]);
      return [[{
        account_balance_assertion_id: 12,
        account_id: 34,
        balance_date: "2026-08-23",
        known_balance_units: "123456789012345",
        calculated_balance_units: "123456789012300",
        AccountName: "Checking",
        account_currency_id: 1,
        CurrencyAbbreviation: "USD",
        scale: 2,
      }]];
    },
  };

  const [assertion] = await listBalanceAssertions(pool, 7);
  assert.equal(assertion.differenceUnits, "45");
  assert.equal(assertion.matches, false);
  assert.equal(assertion.currencyCode, "USD");
});
