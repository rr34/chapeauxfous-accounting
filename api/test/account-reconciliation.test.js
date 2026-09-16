import test from "node:test";
import assert from "node:assert/strict";

import { reconcileAccountThroughDate } from "../src/account-reconciliation.js";

function reconciliationPool({ known = "1500", amounts = ["1000", "500"] } = {}) {
  const state = { states: amounts.map(() => "cleared") };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql) {
      if (sql.includes("FROM account_balance_assertions")) return [[{
        account_balance_assertion_id: 91, known_balance_units: known, AccountName: "Checking",
        AccountType: "asset", account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2,
      }]];
      if (sql.includes("SELECT li.line_item_id")) return [amounts.map((amount, index) => ({
        line_item_id: index + 1, amount_units: amount, reconciliation_state: state.states[index], reconciled_at: null,
      }))];
      if (sql.startsWith("UPDATE line_items li")) {
        const affectedRows = state.states.filter((value) => value !== "reconciled").length;
        state.states = state.states.map(() => "reconciled");
        return [{ affectedRows }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return { state, pool: { async getConnection() { return connection; } } };
}

test("an exact known balance reconciles only that account's posted lines", async () => {
  const { state, pool } = reconciliationPool();
  const result = await reconcileAccountThroughDate({
    pool, personId: 7, accountId: 2, balanceDate: "2026-08-31",
  });
  assert.equal(result.matches, true);
  assert.equal(result.newlyReconciledLineCount, 2);
  assert.deepEqual(state.states, ["reconciled", "reconciled"]);
});

test("a mismatched known balance leaves reconciliation state untouched", async () => {
  const { state, pool } = reconciliationPool({ known: "1600" });
  await assert.rejects(reconcileAccountThroughDate({
    pool, personId: 7, accountId: 2, balanceDate: "2026-08-31",
  }), (error) => error.code === "ACCOUNT_BALANCE_NOT_RECONCILED"
    && error.details.differenceUnits === "100");
  assert.deepEqual(state.states, ["cleared", "cleared"]);
});
