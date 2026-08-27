import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { createTransaction, deleteAccount, listAccountLedger, updateAccount, validateTransaction } = await import("../src/accounting.js");

test("an account ledger groups split accounts and calculates its running balance", async () => {
  const pool = {
    async query(sql, params) {
      if (sql.includes("FROM accounts a")) {
        assert.deepEqual(params, [7, 2, 2]);
        return [[{
          account_id: 3, AccountName: "Checking", description: null, is_placeholder: 0,
          parent_account_id: 1, AccountType: "asset", account_currency_id: 1,
          CurrencyAbbreviation: "USD", scale: 2, balance_units: "200", archived_at: null,
        }]];
      }
      if (sql.includes("FROM line_items li")) {
        assert.deepEqual(params, [3, 7]);
        const split = (lineItemId, amountUnits, accountId, accountName, memo = null) => ({
          split_line_item_id: lineItemId, split_amount_units: amountUnits, split_memo: memo,
          split_account_id: accountId, split_account_name: accountName,
          split_currency_id: 1, split_currency_code: "USD", split_scale: 2,
        });
        return [[
          { line_item_id: 20, amount_units: "320", memo: null, transaction_id: 10,
            TransactionDate: "2026-08-01", description: "Deposit", ...split(20, "320", 3, "Checking") },
          { line_item_id: 20, amount_units: "320", memo: null, transaction_id: 10,
            TransactionDate: "2026-08-01", description: "Deposit", ...split(22, "-320", 8, "Income") },
          { line_item_id: 21, amount_units: "-120", memo: "Lunch", transaction_id: 11,
            TransactionDate: "2026-08-02", description: "Card purchase", ...split(21, "-120", 3, "Checking", "Lunch") },
          { line_item_id: 21, amount_units: "-120", memo: "Lunch", transaction_id: 11,
            TransactionDate: "2026-08-02", description: "Card purchase", ...split(23, "100", 9, "Food") },
          { line_item_id: 21, amount_units: "-120", memo: "Lunch", transaction_id: 11,
            TransactionDate: "2026-08-02", description: "Card purchase", ...split(24, "20", 10, "Tax") },
        ]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await listAccountLedger(pool, 7, 3);
  assert.equal(result.account.name, "Checking");
  assert.deepEqual(result.entries, [
    { lineItemId: 20, transactionId: 10, date: "2026-08-01", description: "Deposit", memo: null,
      splitAccountNames: ["Income"], splits: [
        { lineItemId: 20, accountId: 3, accountName: "Checking", memo: null, amountUnits: "320",
          currencyId: 1, currencyCode: "USD", scale: 2 },
        { lineItemId: 22, accountId: 8, accountName: "Income", memo: null, amountUnits: "-320",
          currencyId: 1, currencyCode: "USD", scale: 2 },
      ], debitUnits: "320", creditUnits: null, runningBalanceUnits: "320" },
    { lineItemId: 21, transactionId: 11, date: "2026-08-02", description: "Card purchase", memo: "Lunch",
      splitAccountNames: ["Food", "Tax"], splits: [
        { lineItemId: 21, accountId: 3, accountName: "Checking", memo: "Lunch", amountUnits: "-120",
          currencyId: 1, currencyCode: "USD", scale: 2 },
        { lineItemId: 23, accountId: 9, accountName: "Food", memo: null, amountUnits: "100",
          currencyId: 1, currencyCode: "USD", scale: 2 },
        { lineItemId: 24, accountId: 10, accountName: "Tax", memo: null, amountUnits: "20",
          currencyId: 1, currencyCode: "USD", scale: 2 },
      ], debitUnits: null, creditUnits: "120", runningBalanceUnits: "200" },
  ]);
});

test("transaction creation rejects impossible dates before opening a transaction", async () => {
  let opened = false;
  await assert.rejects(
    createTransaction({ personId: 7, transactionDate: "2026-02-30", valuationCurrencyId: 1,
      lineItems: [{}, {}] }, async () => { opened = true; }),
    (error) => error.code === "INVALID_TRANSACTION_DATE",
  );
  assert.equal(opened, false);
});

test("transaction source identity must be complete", async () => {
  await assert.rejects(
    createTransaction({ personId: 7, transactionDate: "2026-02-28", valuationCurrencyId: 1,
      sourceSystem: "bank", lineItems: [{}, {}] }, async () => assert.fail("transaction should not open")),
    (error) => error.code === "INCOMPLETE_SOURCE_IDENTITY",
  );
});

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

test("an owner can edit ordinary account fields", async () => {
  const statements = [];
  const runInTransaction = async (work) => work({
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith("UPDATE accounts")) return [{ affectedRows: 1 }];
      if (sql.includes("AccountName") && sql.includes("FROM accounts")) {
        return [[{
          account_id: 3, AccountName: "Equity", description: null, is_placeholder: 0,
          parent_account_id: null, AccountType: "equity", account_currency_id: 1,
        }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  const result = await updateAccount({
    personId: 7,
    accountId: 3,
    name: "Owner Equity",
    description: "Capital and retained earnings",
    placeholder: false,
    parentAccountId: null,
    type: "equity",
    currencyId: 1,
  }, runInTransaction);
  assert.deepEqual(result, { updated: true, accountId: 3 });
  const update = statements.at(-1);
  assert.match(update.sql, /^UPDATE accounts/);
  assert.deepEqual(update.params, ["Owner Equity", "Capital and retained earnings", false, null, "equity", 1, 3, 7]);
});

test("an account currency cannot change after transactions reference it", async () => {
  const runInTransaction = async (work) => work({
    async query(sql) {
      if (sql.includes("AccountName") && sql.includes("FROM accounts")) {
        return [[{
          account_id: 3, AccountName: "Equity", description: null, is_placeholder: 0,
          parent_account_id: null, AccountType: "equity", account_currency_id: 1,
        }]];
      }
      if (sql.includes("FROM line_items")) return [[{ line_item_id: 9 }]];
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  await assert.rejects(
    updateAccount({
      personId: 7, accountId: 3, name: "Equity", description: null, placeholder: false,
      parentAccountId: null, type: "equity", currencyId: 2,
    }, runInTransaction),
    (error) => error.code === "ACCOUNT_CURRENCY_IN_USE" && error.status === 409,
  );
});

function deletionTransaction({ account = { account_id: 3, AccountName: "Equity" }, children = [], lineItems = [], assertions = [] } = {}) {
  const statements = [];
  const runInTransaction = async (work) => work({
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith("DELETE FROM accounts")) return [{ affectedRows: 1 }];
      if (sql.includes("FROM accounts") && sql.includes("owner_person_id")) {
        return [account ? [account] : []];
      }
      if (sql.includes("FROM accounts") && sql.includes("parent_account_id")) return [children];
      if (sql.includes("FROM line_items")) return [lineItems];
      if (sql.includes("FROM account_balance_assertions")) return [assertions];
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  return { statements, runInTransaction };
}

test("an empty leaf account can be permanently deleted by its owner", async () => {
  const transaction = deletionTransaction();
  const result = await deleteAccount({ personId: 7, accountId: 3 }, transaction.runInTransaction);
  assert.deepEqual(result, { deleted: true, accountId: 3, name: "Equity" });
  assert.equal(transaction.statements.at(-1).sql.startsWith("DELETE FROM accounts"), true);
  assert.deepEqual(transaction.statements.at(-1).params, [3, 7]);
});

test("account deletion does not reveal or delete another user's account", async () => {
  const transaction = deletionTransaction({ account: null });
  await assert.rejects(
    deleteAccount({ personId: 7, accountId: 3 }, transaction.runInTransaction),
    (error) => error.code === "ACCOUNT_NOT_FOUND" && error.status === 404,
  );
  assert.equal(transaction.statements.some(({ sql }) => sql.startsWith("DELETE FROM accounts")), false);
});

test("account deletion reports application-level blockers before deleting", async () => {
  for (const [fixture, code] of [
    [{ children: [{ account_id: 4 }] }, "ACCOUNT_HAS_CHILDREN"],
    [{ lineItems: [{ line_item_id: 9 }] }, "ACCOUNT_HAS_TRANSACTIONS"],
    [{ assertions: [{ account_balance_assertion_id: 12 }] }, "ACCOUNT_HAS_BALANCE_ASSERTIONS"],
  ]) {
    const transaction = deletionTransaction(fixture);
    await assert.rejects(
      deleteAccount({ personId: 7, accountId: 3 }, transaction.runInTransaction),
      (error) => error.code === code && error.status === 409,
    );
    assert.equal(transaction.statements.some(({ sql }) => sql.startsWith("DELETE FROM accounts")), false);
  }
});
