import test from "node:test";
import assert from "node:assert/strict";
import { getStatementReconciliationContext } from "../src/statement-reconciliation.js";

test("statement reconciliation turns balance anchors into remaining native movements", async () => {
  const pool = {
    async query(sql, values) {
      if (sql.includes("SELECT account_id, AccountName, parent_account_id")) {
        assert.deepEqual(values, [7]);
        return [[
          { account_id: 1, AccountName: "Assets", parent_account_id: null },
          { account_id: 10, AccountName: "Coinbase BTC", parent_account_id: 1 },
          { account_id: 11, AccountName: "Offline BTC", parent_account_id: 1 },
        ]];
      }
      assert.deepEqual(values, ["2026-08-01", "2026-08-31", "2026-08-01", "2026-08-31", 7, 10, 11]);
      return [[
        { account_id: 10, AccountName: "Coinbase BTC", AccountType: "asset", account_currency_id: 2,
          is_placeholder: 0, archived_at: null, CurrencyAbbreviation: "BTC", scale: 8,
          opening_assertion_id: 101, closing_assertion_id: 102,
          opening_known_balance_units: "200000000", closing_known_balance_units: "189900000",
          opening_posting_units: "200000000", closing_posting_units: "190000000" },
        { account_id: 11, AccountName: "Offline BTC", AccountType: "asset", account_currency_id: 2,
          is_placeholder: 0, archived_at: null, CurrencyAbbreviation: "BTC", scale: 8,
          opening_assertion_id: 103, closing_assertion_id: 104,
          opening_known_balance_units: "50000000", closing_known_balance_units: "60000000",
          opening_posting_units: "50000000", closing_posting_units: "50000000" },
      ]];
    },
  };

  const result = await getStatementReconciliationContext({
    pool, personId: 7, accountIds: [10, 11],
    openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });

  assert.equal(result.grounded, true);
  assert.equal(result.interval.includedTransactionDates, ">2026-08-01 and <=2026-08-31");
  assert.equal(result.accounts[0].accountFullName, "Assets:Coinbase BTC");
  assert.equal(result.accounts[0].requiredNormalMovementUnits, "-10100000");
  assert.equal(result.accounts[0].postedLineItemMovementUnits, "-10000000");
  assert.equal(result.accounts[0].remainingLineItemMovementUnits, "-100000");
  assert.equal(result.accounts[1].remainingLineItemMovementUnits, "10000000");
  assert.deepEqual(result.evidenceRefs, ["accounting://accounts/10", "accounting://balance-assertions/101",
    "accounting://balance-assertions/102", "accounting://accounts/11",
    "accounting://balance-assertions/103", "accounting://balance-assertions/104"]);
  assert.match(result.workflow.rules.join(" "), /do not require amounts to be equal/i);
  assert.match(result.workflow.rules.join(" "), /spread or margin/i);
});

test("statement reconciliation reports missing anchors instead of inventing movement", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT account_id, AccountName, parent_account_id")) {
        return [[{ account_id: 10, AccountName: "Wallet", parent_account_id: null }]];
      }
      return [[{ account_id: 10, AccountName: "Wallet", AccountType: "asset", account_currency_id: 2,
        is_placeholder: 0, archived_at: null, CurrencyAbbreviation: "BTC", scale: 8,
        opening_assertion_id: 101, closing_assertion_id: null,
        opening_known_balance_units: "1", closing_known_balance_units: null,
        opening_posting_units: "1", closing_posting_units: "1" }]];
    },
  };
  const result = await getStatementReconciliationContext({
    pool, personId: 7, accountIds: [10], openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });
  assert.equal(result.grounded, false);
  assert.equal(result.accounts[0].remainingLineItemMovementUnits, null);
  assert.deepEqual(result.missingAssertions, [{ accountId: 10, balanceDate: "2026-08-31" }]);
});
