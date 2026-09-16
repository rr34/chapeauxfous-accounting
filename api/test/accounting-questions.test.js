import test from "node:test";
import assert from "node:assert/strict";

import {
  accountingQuestionTagKeys,
  accountingQuestionTags,
  listAccountingQuestionsPage,
  normalizeAccountingQuestion,
  resolveAccountingQuestion,
} from "../src/accounting-questions.js";

function questionPool() {
  const state = {
    accounts: [
      { account_id: 10, owner_person_id: 7, AccountName: "Checking", parent_account_id: null,
        account_currency_id: 1, is_placeholder: 0, archived_at: null },
      { account_id: 20, owner_person_id: 7, AccountName: "Ask Accountant", parent_account_id: null,
        account_currency_id: 1, is_placeholder: 0, archived_at: null },
      { account_id: 30, owner_person_id: 7, AccountName: "Consulting Income", parent_account_id: null,
        account_currency_id: 1, is_placeholder: 0, archived_at: null },
      { account_id: 40, owner_person_id: 7, AccountName: "BTC Expense", parent_account_id: null,
        account_currency_id: 2, is_placeholder: 0, archived_at: null },
    ],
    currencies: [
      { currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
      { currency_id: 2, CurrencyAbbreviation: "BTC", scale: 8 },
    ],
    transaction: { transaction_id: 5, owner_person_id: 7, TransactionDate: "2026-08-31",
      description: "Balance-derived adjustment", TransactionState: "posted", valuation_currency_id: 1 },
    lines: [
      { line_item_id: 100, transaction_id: 5, amount_units: "1250", value_units: "1250",
        memo: "Statement residual", account_id: 10, reconciliation_state: "reconciled", reconciled_at: "2026-08-31" },
      { line_item_id: 101, transaction_id: 5, amount_units: "-1250", value_units: "-1250",
        memo: "Unclassified", account_id: 20, reconciliation_state: "unreconciled", reconciled_at: null },
    ],
    tags: [
      { tag_id: 1, owner_person_id: 7, tag_key: accountingQuestionTagKeys.status, tag_value: "open" },
      { tag_id: 2, owner_person_id: 7, tag_key: accountingQuestionTagKeys.audience, tag_value: "accountant" },
      { tag_id: 3, owner_person_id: 7, tag_key: accountingQuestionTagKeys.prompt,
        tag_value: "What caused this deposit?" },
    ],
    joins: [{ line_item_id: 101, tag_id: 1 }, { line_item_id: 101, tag_id: 2 }, { line_item_id: 101, tag_id: 3 }],
    nextTagId: 4,
  };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params = []) {
      if (sql.includes("SELECT li.line_item_id") && sql.includes("status_join")) {
        const status = params[3];
        const cursor = Number(params[4]);
        const limit = Number(params.at(-1));
        const ids = state.lines.filter((line) => line.line_item_id > cursor
          && state.joins.some((join) => join.line_item_id === line.line_item_id
            && state.tags.some((tag) => tag.tag_id === join.tag_id
              && tag.tag_key === accountingQuestionTagKeys.status && tag.tag_value === status)))
          .map((line) => ({ line_item_id: line.line_item_id })).slice(0, limit);
        return [ids];
      }
      if (sql.includes("t.description AS transaction_description")) {
        const ids = params.slice(2).map(Number);
        const rows = [];
        for (const line of state.lines.filter((item) => ids.includes(item.line_item_id))) {
          const account = state.accounts.find((item) => item.account_id === line.account_id);
          const currency = state.currencies.find((item) => item.currency_id === account.account_currency_id);
          const joinedTags = state.joins.filter((join) => join.line_item_id === line.line_item_id)
            .map((join) => state.tags.find((tag) => tag.tag_id === join.tag_id));
          for (const tag of joinedTags.length ? joinedTags : [null]) rows.push({ ...line, ...state.transaction,
            transaction_description: state.transaction.description, ...account, ...currency,
            tag_key: tag?.tag_key ?? null, tag_value: tag?.tag_value ?? null });
        }
        return [rows];
      }
      if (sql === "SELECT account_id, AccountName, parent_account_id FROM accounts WHERE owner_person_id = ? ORDER BY account_id") {
        return [state.accounts];
      }
      if (sql.includes("SELECT li.line_item_id, li.transaction_id, li.account_id") && sql.includes("FOR UPDATE")) {
        const [lineId, personId] = params.map(Number);
        const line = state.lines.find((item) => item.line_item_id === lineId);
        const account = state.accounts.find((item) => item.account_id === line?.account_id);
        return [line && state.transaction.owner_person_id === personId ? [{ ...line,
          account_currency_id: account.account_currency_id, TransactionState: state.transaction.TransactionState }] : []];
      }
      if (sql.includes("SELECT tag.tag_value")) {
        const [lineId, personId, key] = params;
        return [state.joins.filter((join) => join.line_item_id === Number(lineId)).map((join) =>
          state.tags.find((tag) => tag.tag_id === join.tag_id)).filter((tag) =>
          tag.owner_person_id === Number(personId) && tag.tag_key === key).map((tag) => ({ tag_value: tag.tag_value }))];
      }
      if (sql.includes("SELECT account_id, account_currency_id, is_placeholder, archived_at")) {
        const [accountId, personId] = params.map(Number);
        return [state.accounts.filter((account) => account.account_id === accountId
          && account.owner_person_id === personId)];
      }
      if (sql.startsWith("UPDATE line_items SET account_id")) {
        const [accountId, lineId] = params.map(Number);
        state.lines.find((line) => line.line_item_id === lineId).account_id = accountId;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("UPDATE transactions SET UpdatedAt")) return [{ affectedRows: 1 }];
      if (sql.startsWith("DELETE tagged FROM lineitems_tags_join")) {
        const [lineId, personId, key] = params;
        const tagIds = new Set(state.tags.filter((tag) => tag.owner_person_id === Number(personId)
          && tag.tag_key === key).map((tag) => tag.tag_id));
        state.joins = state.joins.filter((join) => join.line_item_id !== Number(lineId) || !tagIds.has(join.tag_id));
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("INSERT INTO tags")) {
        const [personId, key, value] = params;
        let tag = state.tags.find((item) => item.owner_person_id === Number(personId)
          && item.tag_key === key && item.tag_value === value);
        if (!tag) {
          tag = { tag_id: state.nextTagId++, owner_person_id: Number(personId), tag_key: key, tag_value: value };
          state.tags.push(tag);
        }
        return [{ insertId: tag.tag_id }];
      }
      if (sql.startsWith("INSERT INTO lineitems_tags_join")) {
        state.joins.push({ line_item_id: Number(params[0]), tag_id: Number(params[1]) });
        return [{ insertId: 0 }];
      }
      if (sql.includes("SELECT transaction_id, owner_person_id, valuation_currency_id")) {
        const [transactionId, personId] = params.map(Number);
        return [[state.transaction].filter((transaction) => transaction.transaction_id === transactionId
          && transaction.owner_person_id === personId)];
      }
      if (sql.includes("account_owner_person_id") && sql.includes("FROM line_items li")) {
        return [state.lines.map((line) => {
          const account = state.accounts.find((item) => item.account_id === line.account_id);
          return { ...line, account_owner_person_id: account.owner_person_id,
            account_currency_id: account.account_currency_id, is_placeholder: account.is_placeholder };
        })];
      }
      if (sql.includes("FROM xrates") && sql.includes("xrate_type = 'transaction'")) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return { state, pool: {
    async getConnection() { return connection; },
    async query(sql, params) { return connection.query(sql, params); },
  } };
}

test("question tags normalize a flexible audience and preserve the prompt", () => {
  assert.deepEqual(normalizeAccountingQuestion({ audience: " Tax Advisor ", prompt: " Need receipt? " }), {
    audience: "tax advisor", prompt: "Need receipt?",
  });
  assert.deepEqual(accountingQuestionTags({ audience: "human", prompt: "What is this?" }), [
    { key: accountingQuestionTagKeys.status, value: "open" },
    { key: accountingQuestionTagKeys.audience, value: "human" },
    { key: accountingQuestionTagKeys.prompt, value: "What is this?" },
  ]);
});

test("open questions are listed as posted suspense lines", async () => {
  const { pool } = questionPool();
  const page = await listAccountingQuestionsPage(pool, 7, { status: "open", limit: 100 });
  assert.equal(page.nextCursor, null);
  assert.equal(page.questions.length, 1);
  assert.equal(page.questions[0].lineItemId, 101);
  assert.equal(page.questions[0].accountFullName, "Ask Accountant");
});

test("resolving a question reclassifies only the suspense line and is idempotent", async () => {
  const { state, pool } = questionPool();
  const first = await resolveAccountingQuestion({ pool, personId: 7, lineItemId: 101,
    targetAccountId: 30, resolution: "Matched receipt" });
  assert.equal(first.changed, true);
  assert.equal(first.question.status, "resolved");
  assert.equal(first.question.targetAccountId, 30);
  assert.equal(state.lines[0].account_id, 10);
  assert.equal(state.lines[1].account_id, 30);
  assert.equal(state.lines[1].amount_units, "-1250");
  assert.equal(state.lines[1].value_units, "-1250");

  const second = await resolveAccountingQuestion({ pool, personId: 7, lineItemId: 101,
    targetAccountId: 30, resolution: "Matched receipt" });
  assert.equal(second.changed, false);
  await assert.rejects(resolveAccountingQuestion({ pool, personId: 7, lineItemId: 101,
    targetAccountId: 40 }), (error) => error.code === "ACCOUNTING_QUESTION_RESOLUTION_CONFLICT");
});

test("an unresolved suspense line cannot be reassigned across currencies", async () => {
  const { pool } = questionPool();
  await assert.rejects(resolveAccountingQuestion({ pool, personId: 7, lineItemId: 101,
    targetAccountId: 40 }), (error) => error.code === "QUESTION_TARGET_CURRENCY_MISMATCH");
});
