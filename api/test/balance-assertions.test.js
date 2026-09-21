import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { listBalanceAssertions, listMatchingBalanceCheckpoints } = await import("../src/balance-assertions.js");

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
        AccountType: "asset",
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

test("credit-normal balance assertions compare against credits minus debits", async () => {
  const pool = {
    async query(_sql, params) {
      assert.deepEqual(params, [7]);
      return [["liability", "income", "equity"].map((accountType, index) => ({
        account_balance_assertion_id: index + 1,
        account_id: index + 10,
        balance_date: "2026-08-24",
        known_balance_units: index === 2 ? "325" : "300",
        calculated_balance_units: "-300",
        AccountName: accountType,
        AccountType: accountType,
        account_currency_id: 1,
        CurrencyAbbreviation: "USD",
        scale: 2,
      }))];
    },
  };

  const assertions = await listBalanceAssertions(pool, 7);
  assert.deepEqual(assertions.map(({ calculatedBalanceUnits, differenceUnits, matches }) => ({
    calculatedBalanceUnits, differenceUnits, matches,
  })), [
    { calculatedBalanceUnits: "300", differenceUnits: "0", matches: true },
    { calculatedBalanceUnits: "300", differenceUnits: "0", matches: true },
    { calculatedBalanceUnits: "300", differenceUnits: "25", matches: false },
  ]);
});

test("matching checkpoints select the latest assertion whose known and recorded balances agree", async () => {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /aba\.account_id IN \(\?\)/);
      assert.deepEqual(params, [7, 34, "2026-08-31"]);
      return [[
        { account_balance_assertion_id: 13, account_id: 34, balance_date: "2026-08-20",
          known_balance_units: "200", calculated_balance_units: "199", AccountName: "Checking",
          AccountType: "asset", account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
        { account_balance_assertion_id: 12, account_id: 34, balance_date: "2026-08-15",
          known_balance_units: "150", calculated_balance_units: "150", AccountName: "Checking",
          AccountType: "asset", account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
        { account_balance_assertion_id: 11, account_id: 34, balance_date: "2026-08-10",
          known_balance_units: "100", calculated_balance_units: "100", AccountName: "Checking",
          AccountType: "asset", account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
      ]];
    },
  };
  const checkpoints = await listMatchingBalanceCheckpoints(pool, 7, [34], "2026-08-31");
  assert.deepEqual(checkpoints.map(({ id, date }) => ({ id, date })), [{ id: 12, date: "2026-08-15" }]);
});
