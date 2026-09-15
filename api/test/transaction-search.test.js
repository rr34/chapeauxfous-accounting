import test from "node:test";
import assert from "node:assert/strict";
import { searchTransactionsPage } from "../src/transaction-search.js";
import { transactionSearchItemSchema } from "../src/mcp-contracts.js";

const accounts = [
  { account_id: 1, AccountName: "Assets", description: "Asset accounts", parent_account_id: null,
    account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
  { account_id: 2, AccountName: "Checking", description: "Household checking", parent_account_id: 1,
    account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
  { account_id: 3, AccountName: "Expenses", description: "Expense accounts", parent_account_id: null,
    account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
  { account_id: 4, AccountName: "Food", description: "Groceries", parent_account_id: 3,
    account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
  { account_id: 5, AccountName: "Cash", description: null, parent_account_id: 1,
    account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
  { account_id: 6, AccountName: "Income", description: null, parent_account_id: null,
    account_currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
];

function row({ transactionId, date, description, transactionSourceId, lineId, amountUnits, memo,
  lineSourceId, accountId, tag = null, importSource = null }) {
  const account = accounts.find((item) => item.account_id === accountId);
  return {
    transaction_id: transactionId,
    TransactionDate: date,
    transaction_description: description,
    TransactionState: "posted",
    valuation_currency_id: 1,
    valuation_currency_code: "USD",
    valuation_scale: 2,
    transaction_source_system: "gnucash",
    transaction_source_id: transactionSourceId,
    line_item_id: lineId,
    amount_units: amountUnits,
    value_units: amountUnits,
    line_memo: memo,
    line_source_id: lineSourceId,
    reconciliation_state: "unreconciled",
    reconciled_at: null,
    account_id: accountId,
    AccountName: account.AccountName,
    account_currency_id: account.account_currency_id,
    account_currency_code: account.CurrencyAbbreviation,
    account_scale: account.scale,
    tag_key: tag?.key ?? null,
    tag_value: tag?.value ?? null,
    import_job_id: importSource?.jobId ?? null,
    import_external_id: importSource?.externalId ?? null,
    import_item_status: importSource?.status ?? null,
    import_errors_json: importSource?.errors == null ? null : JSON.stringify(importSource.errors),
    import_source_system: importSource?.sourceSystem ?? null,
    source_file_name: importSource?.fileName ?? null,
  };
}

const importSource = {
  jobId: "11111111-1111-4111-8111-111111111111",
  externalId: "grocery-external",
  status: "committed",
  errors: [{ code: "IMPORT_NOTE", message: "Reviewed import note" }],
  sourceSystem: "gnucash_csv",
  fileName: "checking-2026.csv",
};

const transactionRows = [
  row({ transactionId: 10, date: "2026-01-10", description: "Corner Market", transactionSourceId: "txn-10",
    lineId: 101, amountUnits: "-12500", memo: "Weekly shop", lineSourceId: "check-1001", accountId: 2,
    tag: { key: "payee", value: "Corner Market" }, importSource }),
  row({ transactionId: 10, date: "2026-01-10", description: "Corner Market", transactionSourceId: "txn-10",
    lineId: 102, amountUnits: "12500", memo: null, lineSourceId: "split-102", accountId: 4,
    importSource }),
  row({ transactionId: 11, date: "2026-01-11", description: "Cash transfer", transactionSourceId: "txn-11",
    lineId: 111, amountUnits: "12504", memo: null, lineSourceId: "split-111", accountId: 2 }),
  row({ transactionId: 11, date: "2026-01-11", description: "Cash transfer", transactionSourceId: "txn-11",
    lineId: 112, amountUnits: "-12504", memo: null, lineSourceId: "split-112", accountId: 5 }),
  row({ transactionId: 12, date: "2026-02-01", description: "Salary", transactionSourceId: "txn-12",
    lineId: 121, amountUnits: "500000", memo: "February payroll", lineSourceId: "split-121", accountId: 2 }),
  row({ transactionId: 12, date: "2026-02-01", description: "Salary", transactionSourceId: "txn-12",
    lineId: 122, amountUnits: "-500000", memo: null, lineSourceId: "split-122", accountId: 6 }),
];

function fakePool() {
  return {
    async query(sql, params) {
      assert.deepEqual(params, [7]);
      if (sql.includes("FROM accounts a")) return [accounts];
      if (sql.includes("FROM transactions t")) return [transactionRows];
      assert.fail(`Unexpected query: ${sql}`);
    },
  };
}

test("transaction search combines text, descendant account, counter-account, identifiers, source, and issues", async () => {
  const scoped = await searchTransactionsPage(fakePool(), 7, {
    text: "weekly",
    accountId: 1,
    counterAccountId: 3,
    externalId: "GROCERY-EXTERNAL",
    reference: "CHECK-1001",
    source: "checking-2026.csv",
    hasIssues: true,
  });
  assert.equal(scoped.totalMatches, 1);
  assert.equal(scoped.transactions[0].id, 10);
  assert.equal(scoped.transactions[0].lineItems[0].accountFullName, "Assets:Checking");
  assert.equal(scoped.transactions[0].lineItems[0].amountDecimal, "-125.00");
  assert.deepEqual(scoped.transactions[0].matchedLineItemIds, [101, 102]);
  assert.equal(scoped.transactions[0].hasIssues, true);
  assert.deepEqual(scoped.transactions[0].issueCodes, ["IMPORT_NOTE"]);
  assert.equal(scoped.transactions[0].importSources[0].sourceFileName, "checking-2026.csv");
  assert.equal(transactionSearchItemSchema.safeParse(scoped.transactions[0]).success, true);

  const accountDescription = await searchTransactionsPage(fakePool(), 7, { text: "groceries" });
  assert.deepEqual(accountDescription.transactions.map((transaction) => transaction.id), [10]);
  assert.deepEqual(accountDescription.transactions[0].matchedFields, ["lineItems.accountDescription"]);

  const rootOnly = await searchTransactionsPage(fakePool(), 7, {
    accountId: 1, includeAccountDescendants: false,
  });
  assert.equal(rootOnly.totalMatches, 0);

  const exactIdentity = await searchTransactionsPage(fakePool(), 7, {
    transactionId: 12, currencyCode: "usd",
  });
  assert.deepEqual(exactIdentity.transactions.map((transaction) => transaction.id), [12]);
});

test("transaction search compares decimal amount magnitudes exactly with tolerance, range, and sign", async () => {
  const near = await searchTransactionsPage(fakePool(), 7, {
    accountId: 2,
    amount: "125.00",
    amountTolerance: "0.05",
    amountSign: "either",
    sortBy: "amount",
    sortDirection: "asc",
  });
  assert.deepEqual(near.transactions.map((transaction) => transaction.id), [10, 11]);

  const range = await searchTransactionsPage(fakePool(), 7, {
    accountId: 1,
    minimumAmount: "125.03",
    maximumAmount: "125.05",
    amountSign: "positive",
  });
  assert.deepEqual(range.transactions.map((transaction) => transaction.id), [11]);

  const negative = await searchTransactionsPage(fakePool(), 7, {
    accountId: 2,
    amount: "125",
    amountSign: "negative",
  });
  assert.deepEqual(negative.transactions.map((transaction) => transaction.id), [10]);

  await assert.rejects(() => searchTransactionsPage(fakePool(), 7, {
    amount: "125", minimumAmount: "100",
  }), (error) => error.code === "INVALID_AMOUNT_FILTER");
  await assert.rejects(() => searchTransactionsPage(fakePool(), 7, {
    minimumAmount: "200", maximumAmount: "100",
  }), (error) => error.code === "INVALID_AMOUNT_FILTER");
});

test("transaction search applies exact and ranged dates and filter-bound stable pagination", async () => {
  const exactDate = await searchTransactionsPage(fakePool(), 7, { date: "2026-01-11" });
  assert.deepEqual(exactDate.transactions.map((transaction) => transaction.id), [11]);

  const range = await searchTransactionsPage(fakePool(), 7, {
    dateFrom: "2026-01-10", dateTo: "2026-01-11", sortBy: "date", sortDirection: "asc", limit: 1,
  });
  assert.deepEqual(range.transactions.map((transaction) => transaction.id), [10]);
  assert.equal(range.totalMatches, 2);
  assert.ok(range.nextCursor);

  const secondPage = await searchTransactionsPage(fakePool(), 7, {
    dateFrom: "2026-01-10", dateTo: "2026-01-11", sortBy: "date", sortDirection: "asc", limit: 1,
    cursor: range.nextCursor,
  });
  assert.deepEqual(secondPage.transactions.map((transaction) => transaction.id), [11]);
  assert.equal(secondPage.nextCursor, null);

  await assert.rejects(() => searchTransactionsPage(fakePool(), 7, {
    dateFrom: "2026-01-10", dateTo: "2026-01-12", sortBy: "date", sortDirection: "asc", limit: 1,
    cursor: range.nextCursor,
  }), (error) => error.code === "INVALID_CURSOR");
});
