import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const {
  commitTransactionImportPlan,
  getTransactionImportPlan,
  normalizeTransactionImport,
  previewTransactionImport,
} = await import("../src/transaction-import.js");
const {
  TRANSACTION_IMPORT_MAX_LINE_ITEMS,
  TRANSACTION_IMPORT_MAX_TRANSACTIONS,
} = await import("../src/transaction-import-limits.js");

function memoryPool() {
  const state = {
    currencies: [
      { currency_id: 1, owner_person_id: null, CurrencyAbbreviation: "USD", scale: 2 },
      { currency_id: 2, owner_person_id: 7, CurrencyAbbreviation: "VTSAX", scale: 3 },
    ],
    accounts: [
      { account_id: 10, AccountName: "Assets", parent_account_id: null, account_currency_id: 1, is_placeholder: 1, archived_at: null },
      { account_id: 11, AccountName: "Checking", parent_account_id: 10, AccountType: "asset",
        account_currency_id: 1, is_placeholder: 0, archived_at: null },
      { account_id: 12, AccountName: "Investments", parent_account_id: 10, account_currency_id: 1, is_placeholder: 1, archived_at: null },
      { account_id: 13, AccountName: "VTSAX", parent_account_id: 12, account_currency_id: 2, is_placeholder: 0, archived_at: null },
      { account_id: 20, AccountName: "Expenses", parent_account_id: null, account_currency_id: 1, is_placeholder: 1, archived_at: null },
      { account_id: 21, AccountName: "Food", parent_account_id: 20, account_currency_id: 1, is_placeholder: 0, archived_at: null },
    ],
    transactions: [],
    lineItems: [],
    rates: [],
    referenceRates: [],
    tags: [],
    tagJoins: [],
    balanceAssertions: [],
    plans: new Map(),
    nextTransactionId: 100,
    nextLineItemId: 1000,
    nextRateId: 2000,
    nextTagId: 3000,
    commits: 0,
    rollbacks: 0,
  };
  return {
    state,
    async getConnection() {
      const snapshot = structuredClone({
        transactions: state.transactions, lineItems: state.lineItems, rates: state.rates,
        tags: state.tags, tagJoins: state.tagJoins,
        plans: [...state.plans], nextTransactionId: state.nextTransactionId,
        nextLineItemId: state.nextLineItemId, nextRateId: state.nextRateId, nextTagId: state.nextTagId,
      });
      return {
        async beginTransaction() {},
        async commit() { state.commits += 1; },
        async rollback() {
          state.rollbacks += 1;
          state.transactions = snapshot.transactions;
          state.lineItems = snapshot.lineItems;
          state.rates = snapshot.rates;
          state.tags = snapshot.tags;
          state.tagJoins = snapshot.tagJoins;
          state.plans = new Map(snapshot.plans);
          state.nextTransactionId = snapshot.nextTransactionId;
          state.nextLineItemId = snapshot.nextLineItemId;
          state.nextRateId = snapshot.nextRateId;
          state.nextTagId = snapshot.nextTagId;
        },
        release() {},
        async query(sql, params = []) {
          if (sql.startsWith("DELETE FROM accounting_import_plans")) return [{ affectedRows: 0 }];
          if (sql.includes("SELECT account_id, AccountName, parent_account_id")) {
            const [ownerPersonId] = params;
            if (Number(ownerPersonId) !== 7) return [[]];
            return [state.accounts.map((account) => ({ account_id: account.account_id,
              AccountName: account.AccountName, parent_account_id: account.parent_account_id }))];
          }
          if (sql.includes("opening.known_balance_units")) {
            const [openingDate, closingDate, _openingAssertionDate, _closingAssertionDate,
              ownerPersonId, ...accountIds] = params;
            if (Number(ownerPersonId) !== 7) return [[]];
            return [state.accounts.filter((account) => accountIds.map(Number).includes(Number(account.account_id)))
              .map((account) => {
                const currency = state.currencies.find((item) =>
                  Number(item.currency_id) === Number(account.account_currency_id));
                const opening = state.balanceAssertions.find((item) => Number(item.account_id) === Number(account.account_id)
                  && item.balance_date === openingDate);
                const closing = state.balanceAssertions.find((item) => Number(item.account_id) === Number(account.account_id)
                  && item.balance_date === closingDate);
                const postingUnits = (date) => state.lineItems.reduce((sum, line) => {
                  if (Number(line.account_id) !== Number(account.account_id)) return sum;
                  const transaction = state.transactions.find((item) =>
                    Number(item.transaction_id) === Number(line.transaction_id));
                  return transaction?.TransactionState === "posted" && transaction.TransactionDate <= date
                    ? sum + BigInt(line.amount_units) : sum;
                }, 0n).toString();
                return { ...account, CurrencyAbbreviation: currency.CurrencyAbbreviation, scale: currency.scale,
                  opening_assertion_id: opening?.account_balance_assertion_id ?? null,
                  closing_assertion_id: closing?.account_balance_assertion_id ?? null,
                  opening_known_balance_units: opening?.known_balance_units ?? null,
                  closing_known_balance_units: closing?.known_balance_units ?? null,
                  opening_posting_units: postingUnits(openingDate), closing_posting_units: postingUnits(closingDate) };
              })];
          }
          if (sql.includes("FROM accounts a") && sql.includes("JOIN currencies c")) {
            assert.match(sql, /a\.AccountType/);
            return [state.accounts.map((account) => ({
              ...account,
              CurrencyAbbreviation: state.currencies.find((currency) =>
                Number(currency.currency_id) === Number(account.account_currency_id)).CurrencyAbbreviation,
              scale: state.currencies.find((currency) =>
                Number(currency.currency_id) === Number(account.account_currency_id)).scale,
            }))];
          }
          if (sql.includes("FROM currencies")) return [state.currencies];
          if (sql.includes("FROM transactions t") && sql.includes("LEFT JOIN line_items")) {
            const [ownerPersonId, sourceSystem, ...externalIds] = params;
            return [state.transactions.filter((transaction) =>
              Number(transaction.owner_person_id) === Number(ownerPersonId)
              && transaction.source_system === sourceSystem
              && externalIds.includes(transaction.source_id)).map((transaction) => ({
              transaction_id: transaction.transaction_id,
              source_id: transaction.source_id,
              source_fingerprint: transaction.source_fingerprint,
              line_item_count: state.lineItems.filter((line) =>
                Number(line.transaction_id) === Number(transaction.transaction_id)).length,
            }))];
          }
          if (sql.includes("INSERT INTO accounting_import_plans")) {
            const [planId, ownerPersonId, sourceSystem, payloadSha256, previewSha256,
              payloadJson, summaryJson, expiresAt] = params;
            state.plans.set(planId, { import_plan_id: planId, owner_person_id: ownerPersonId,
              import_kind: "transactions", plan_status: "ready", source_system: sourceSystem,
              payload_sha256: payloadSha256, preview_sha256: previewSha256,
              payload_json: payloadJson, summary_json: summaryJson, expires_at: expiresAt,
              committed_at: null, result_json: null, is_expired: 0 });
            return [{ insertId: 0 }];
          }
          if (sql.includes("FROM accounting_import_plans")) {
            const [planId, ownerPersonId] = params;
            const plan = state.plans.get(planId);
            return [[plan && Number(plan.owner_person_id) === Number(ownerPersonId) ? plan : undefined].filter(Boolean)];
          }
          if (sql.includes("INSERT INTO transactions")) {
            const [ownerPersonId, description, valuationCurrencyId, transactionDate, transactionAt,
              sourceSystem, sourceId, sourceFingerprint] = params;
            const row = { transaction_id: state.nextTransactionId++, owner_person_id: ownerPersonId,
              description, valuation_currency_id: valuationCurrencyId, TransactionState: "draft",
              TransactionDate: transactionDate, TransactionAtUtc: transactionAt,
              source_system: sourceSystem, source_id: sourceId,
              source_fingerprint: sourceFingerprint };
            state.transactions.push(row);
            return [{ insertId: row.transaction_id }];
          }
          if (sql.includes("INSERT INTO line_items")) {
            const [transactionId, amountUnits, valueUnits, memo, accountId, sourceId, reconciliationState] = params;
            const row = { line_item_id: state.nextLineItemId++, transaction_id: transactionId,
              amount_units: amountUnits, value_units: valueUnits, memo, account_id: accountId, source_id: sourceId,
              reconciliation_state: reconciliationState };
            state.lineItems.push(row);
            return [{ insertId: row.line_item_id }];
          }
          if (sql.includes("INSERT INTO xrates")) {
            const [ownerPersonId, transactionId, fromUnits, fromCurrencyId, toUnits, toCurrencyId] = params;
            const row = { xrate_id: state.nextRateId++, owner_person_id: ownerPersonId,
              transaction_id: transactionId, xrate_type: "transaction", from_units: fromUnits,
              from_currency_id: fromCurrencyId, to_units: toUnits, to_currency_id: toCurrencyId };
            state.rates.push(row);
            return [{ insertId: row.xrate_id }];
          }
          if (sql.includes("INSERT INTO tags")) {
            const [ownerPersonId, key, value] = params;
            let tag = state.tags.find((item) => Number(item.owner_person_id) === Number(ownerPersonId)
              && item.tag_key === key && item.tag_value === value);
            if (!tag) {
              tag = { tag_id: state.nextTagId++, owner_person_id: ownerPersonId, tag_key: key, tag_value: value };
              state.tags.push(tag);
            }
            return [{ insertId: tag.tag_id }];
          }
          if (sql.includes("INSERT INTO lineitems_tags_join")) {
            state.tagJoins.push({ tagged_line_item_id: Number(params[0]), tag_id: Number(params[1]) });
            return [{ insertId: 0 }];
          }
          if (sql.includes("FROM transactions WHERE transaction_id")) {
            const [transactionId, ownerPersonId] = params;
            return [state.transactions.filter((transaction) =>
              Number(transaction.transaction_id) === Number(transactionId)
              && Number(transaction.owner_person_id) === Number(ownerPersonId))];
          }
          if (sql.includes("FROM line_items li") && sql.includes("JOIN accounts a")) {
            const [transactionId] = params;
            return [state.lineItems.filter((line) => Number(line.transaction_id) === Number(transactionId)).map((line) => {
              const account = state.accounts.find((candidate) => Number(candidate.account_id) === Number(line.account_id));
              return { ...line, account_owner_person_id: 7, account_currency_id: account.account_currency_id,
                is_placeholder: account.is_placeholder };
            })];
          }
          if (sql.includes("FROM xrates") && sql.includes("xrate_type = 'transaction'")) {
            const [transactionId, ownerPersonId] = params;
            return [state.rates.filter((rate) => Number(rate.transaction_id) === Number(transactionId)
              && Number(rate.owner_person_id) === Number(ownerPersonId))];
          }
          if (sql.includes("FROM xrates") && sql.includes("xrate_type = 'reference'")) {
            const [ownerPersonId, left, right] = params;
            return [state.referenceRates.filter((rate) => Number(rate.owner_person_id) === Number(ownerPersonId)
              && ((Number(rate.from_currency_id) === Number(left) && Number(rate.to_currency_id) === Number(right))
                || (Number(rate.from_currency_id) === Number(right) && Number(rate.to_currency_id) === Number(left))))];
          }
          if (sql.includes("UPDATE transactions SET TransactionState")) {
            const [transactionId, ownerPersonId] = params;
            const transaction = state.transactions.find((candidate) =>
              Number(candidate.transaction_id) === Number(transactionId)
              && Number(candidate.owner_person_id) === Number(ownerPersonId));
            transaction.TransactionState = "posted";
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("UPDATE accounting_import_plans")) {
            const committing = sql.includes("plan_status = 'committed'");
            const [resultJson, planId, ownerPersonId] = committing ? params : [null, ...params];
            const plan = state.plans.get(planId);
            if (plan && Number(plan.owner_person_id) === Number(ownerPersonId)) {
              plan.plan_status = committing ? "committed" : "invalidated";
              plan.committed_at = committing ? "now" : null;
              plan.invalidation_code = committing ? null
                : (sql.match(/invalidation_code = '([^']+)'/)?.[1] ?? "DATABASE_STATE_CHANGED");
              plan.result_json = resultJson;
            }
            return [{ affectedRows: plan ? 1 : 0 }];
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },
  };
}

function importedTransactions() {
  return [
    {
      externalId: "source-tx-1",
      transactionDate: "2026-01-02",
      description: "Lunch",
      valuationCurrencyCode: "USD",
      lineItems: [
        { externalId: "1", accountFullName: "Assets:Checking", amountDecimal: "-12.34" },
        { externalId: "2", accountFullName: "Expenses:Food", amountDecimal: "12.34" },
      ],
    },
    {
      externalId: "source-tx-2",
      transactionDate: "2026-02-03",
      description: "Buy fund units",
      valuationCurrencyCode: "USD",
      lineItems: [
        { externalId: "1", accountFullName: "Assets:Investments:VTSAX",
          amountDecimal: "1.234", valueDecimal: "100.00" },
        { externalId: "2", accountFullName: "Assets:Checking", amountDecimal: "-100.00" },
      ],
    },
  ];
}

function generatedTransaction(index, lineItemCount = 2) {
  return {
    externalId: `generated-${index}`,
    transactionDate: "2026-01-01",
    valuationCurrencyCode: "USD",
    lineItems: Array.from({ length: lineItemCount }, (_, lineIndex) => ({
      externalId: `${index}-${lineIndex}`,
      accountFullName: lineIndex % 2 === 0 ? "Assets:Checking" : "Expenses:Food",
      amountDecimal: lineIndex % 2 === 0 ? "-1.00" : "1.00",
    })),
  };
}

test("transaction normalization accepts 1,000-transaction statement batches and rejects larger batches", () => {
  assert.equal(TRANSACTION_IMPORT_MAX_TRANSACTIONS, 1000);
  assert.equal(TRANSACTION_IMPORT_MAX_LINE_ITEMS, 10000);
  const transactions = Array.from(
    { length: TRANSACTION_IMPORT_MAX_TRANSACTIONS },
    (_, index) => generatedTransaction(index),
  );
  const normalized = normalizeTransactionImport({ sourceSystem: "large_statement", transactions });
  assert.equal(normalized.transactions.length, 1000);
  assert.equal(normalized.submittedLineItemCount, 2000);

  assert.throws(
    () => normalizeTransactionImport({
      sourceSystem: "too_large",
      transactions: [...transactions, generatedTransaction(1000)],
    }),
    (error) => error.code === "TOO_MANY_TRANSACTIONS" && /At most 1000 transactions/.test(error.message),
  );
});

test("transaction normalization enforces the aggregate line-item limit", () => {
  const transactions = Array.from({ length: 1000 }, (_, index) => generatedTransaction(index, 11));
  assert.throws(
    () => normalizeTransactionImport({ sourceSystem: "too_many_lines", transactions }),
    (error) => error.code === "TOO_MANY_LINE_ITEMS" && /At most 10000 line items/.test(error.message),
  );
});

test("a 1,000-transaction statement is preserved as one durable atomic plan", async () => {
  const pool = memoryPool();
  const transactions = Array.from(
    { length: TRANSACTION_IMPORT_MAX_TRANSACTIONS },
    (_, index) => generatedTransaction(index),
  );
  const preview = await previewTransactionImport({
    pool,
    personId: 7,
    sourceSystem: "large_statement",
    transactions,
  });
  assert.equal(preview.readyToCommit, true);
  assert.equal(preview.wouldCreateTransactionCount, 1000);
  assert.equal(preview.wouldCreateLineItemCount, 2000);
  assert.equal(preview.transactions.length, 1000);
  assert.equal(pool.state.transactions.length, 0);

  const committed = await commitTransactionImportPlan({
    pool,
    personId: 7,
    importPlanId: preview.importPlanId,
  });
  assert.equal(committed.createdTransactionCount, 1000);
  assert.equal(committed.createdLineItemCount, 2000);
  assert.equal(pool.state.transactions.length, 1000);
  assert.equal(pool.state.lineItems.length, 2000);
  assert.equal(pool.state.transactions.every((transaction) => transaction.TransactionState === "posted"), true);
});

test("transaction preview plans complete nested transactions and commit is repeat-safe", async () => {
  const pool = memoryPool();
  const transactions = importedTransactions();
  const preview = await previewTransactionImport({ pool, personId: 7, sourceSystem: "source_app", transactions });
  assert.equal(preview.readyToCommit, true);
  assert.equal(preview.wouldCreateTransactionCount, 2);
  assert.equal(preview.wouldCreateLineItemCount, 4);
  assert.equal(preview.rejectedTransactionCount, 0);
  assert.deepEqual(preview.transactionSummary.byValuationCurrency, { USD: 2 });
  assert.deepEqual(preview.lineItemSummary.byTopLevelBranch, { Assets: 3, Expenses: 1 });
  assert.equal(pool.state.transactions.length, 0);

  const readyPlan = await getTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.equal(readyPlan.status, "ready");
  assert.equal(readyPlan.previewDigest, preview.previewDigest);
  assert.deepEqual(readyPlan.summary, preview.summary);

  await assert.rejects(
    commitTransactionImportPlan({ pool, personId: 8, importPlanId: preview.importPlanId }),
    (error) => error.code === "IMPORT_PLAN_NOT_FOUND",
  );

  const committed = await commitTransactionImportPlan({
    pool, personId: 7, importPlanId: preview.importPlanId,
  });
  assert.equal(committed.createdTransactionCount, 2);
  assert.equal(committed.createdLineItemCount, 4);
  assert.equal(committed.alreadyCommitted, false);
  assert.equal(pool.state.transactions.every((transaction) => transaction.TransactionState === "posted"), true);
  assert.deepEqual(pool.state.rates, []);
  assert.deepEqual(pool.state.lineItems.map((line) => line.value_units), ["-1234", "1234", "10000", "-10000"]);

  const committedPlan = await getTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.equal(committedPlan.status, "committed");
  assert.equal(committedPlan.alreadyCommitted, true);
  assert.equal(committedPlan.commitResult.createdTransactionCount, 2);

  const repeated = await commitTransactionImportPlan({
    pool, personId: 7, importPlanId: preview.importPlanId,
  });
  assert.equal(repeated.createdTransactionCount, 2);
  assert.equal(repeated.alreadyCommitted, true);
  assert.equal(pool.state.transactions.length, 2);

  const retryPreview = await previewTransactionImport({
    pool, personId: 7, sourceSystem: "source_app", transactions,
  });
  assert.equal(retryPreview.wouldCreateTransactionCount, 0);
  assert.equal(retryPreview.wouldReuseTransactionCount, 2);
});

test("transaction import preserves distinct per-line exchange rates", async () => {
  const pool = memoryPool();
  const transactions = [{
    externalId: "different-line-rates",
    transactionDate: "2026-01-09",
    valuationCurrencyCode: "USD",
    lineItems: [
      { externalId: "1", accountFullName: "Assets:Investments:VTSAX",
        amountDecimal: "1.000", valueDecimal: "100.00" },
      { externalId: "2", accountFullName: "Assets:Investments:VTSAX",
        amountDecimal: "-0.500", valueDecimal: "-60.00" },
      { externalId: "3", accountFullName: "Assets:Checking", amountDecimal: "-40.00" },
    ],
  }];

  const preview = await previewTransactionImport({ pool, personId: 7, sourceSystem: "source_app", transactions });
  assert.equal(preview.readyToCommit, true);
  assert.equal(preview.rejectedTransactionCount, 0);

  await commitTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.deepEqual(pool.state.lineItems.map((line) => line.value_units), ["10000", "-6000", "-4000"]);
  assert.deepEqual(pool.state.rates, []);
});

test("transaction import rounds USD values while retaining exact BTC quantities", async () => {
  const pool = memoryPool();
  pool.state.currencies.push({ currency_id: 3, owner_person_id: 7,
    CurrencyAbbreviation: "BTC", scale: 8 });
  pool.state.accounts.push({ account_id: 30, AccountName: "Bitcoin", parent_account_id: 10,
    account_currency_id: 3, is_placeholder: 0, archived_at: null });
  const transaction = {
    externalId: "crypto-send", transactionDate: "2026-07-20", valuationCurrencyCode: "USD",
    lineItems: [
      { accountFullName: "Assets:Bitcoin", amountDecimal: "-0.12060432", valueDecimal: "-7818.78377" },
      { accountFullName: "Assets:Checking", amountDecimal: "7818.78" },
    ],
  };
  const preview = await previewTransactionImport({ pool, personId: 7,
    sourceSystem: "coinbase", transactions: [transaction] });
  assert.equal(preview.rejectedTransactionCount, 0);
  assert.equal(preview.readyToCommit, true);
  await commitTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.equal(pool.state.lineItems[0].amount_units, "-12060432");
  assert.equal(pool.state.lineItems[0].value_units, "-781878");
  const invalid = await previewTransactionImport({ pool, personId: 7,
    sourceSystem: "coinbase", transactions: [{ ...transaction, externalId: "too-precise",
      lineItems: [{ ...transaction.lineItems[0], amountDecimal: "-0.120604321" }, transaction.lineItems[1]] }] });
  assert.equal(invalid.rejectedTransactionCount, 1);
  assert.equal(invalid.transactions[0].errors.some((error) =>
    error.code === "INVALID_DECIMAL_AMOUNT" && error.details.field === "amount_decimal"), true);
});

test("reference rates override source prices and Accounting derives the cash-conversion fee", async () => {
  const pool = memoryPool();
  pool.state.currencies.push({ currency_id: 3, owner_person_id: 7,
    CurrencyAbbreviation: "BTC", scale: 8 });
  pool.state.accounts.push(
    { account_id: 30, AccountName: "Bitcoin", parent_account_id: 10,
      account_currency_id: 3, is_placeholder: 0, archived_at: null },
    { account_id: 31, AccountName: "Conversion Fees", parent_account_id: 20, AccountType: "expense",
      account_currency_id: 1, is_placeholder: 0, archived_at: null },
  );
  pool.state.referenceRates.push(
    { xrate_id: 1, owner_person_id: 7, ValidAt: "2026-09-01 00:00:00",
      from_currency_id: 3, to_currency_id: 1, from_units: "100000000", to_units: "10000000" },
    { xrate_id: 2, owner_person_id: 7, ValidAt: "2026-09-02 00:00:00",
      from_currency_id: 1, to_currency_id: 3, from_units: "8000000", to_units: "100000000" },
  );
  const transaction = {
    externalId: "btc-sale", transactionDate: "2026-09-01", transactionAt: "2026-09-01T23:00:00Z",
    valuationCurrencyCode: "USD", feeAccountFullName: "Expenses:Conversion Fees",
    lineItems: [
      { accountFullName: "Assets:Bitcoin", amountDecimal: "-0.01", valueDecimal: "999.99999" },
      { accountFullName: "Assets:Checking", amountDecimal: "790.00", valueDecimal: "790.00" },
    ],
  };
  const preview = await previewTransactionImport({ pool, personId: 7,
    sourceSystem: "coinbase", transactions: [transaction] });
  assert.equal(preview.readyToCommit, true);
  assert.equal(preview.wouldCreateLineItemCount, 3);
  await commitTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.equal(pool.state.transactions[0].TransactionDate, "2026-09-01");
  assert.equal(pool.state.transactions[0].TransactionAtUtc, "2026-09-01 23:00:00.000");
  assert.deepEqual(pool.state.lineItems.map((line) => [line.amount_units, line.value_units]), [
    ["-1000000", "-80000"], ["79000", "79000"], ["1000", "1000"],
  ]);
  const missingFee = await previewTransactionImport({ pool, personId: 7,
    sourceSystem: "coinbase", transactions: [{ ...transaction, externalId: "missing-fee",
      feeAccountFullName: null }] });
  assert.equal(missingFee.rejectedTransactionCount, 1);
  assert.equal(missingFee.transactions[0].errors.some((error) => error.code === "FEE_ACCOUNT_REQUIRED"), true);

  const changing = await previewTransactionImport({ pool, personId: 7,
    sourceSystem: "coinbase", transactions: [{ ...transaction, externalId: "btc-sale-rate-changed" }] });
  assert.equal(changing.readyToCommit, true);
  pool.state.referenceRates.push({ xrate_id: 3, owner_person_id: 7,
    ValidAt: "2026-09-01 23:00:00", from_currency_id: 3, to_currency_id: 1,
    from_units: "100000000", to_units: "9000000" });
  await assert.rejects(
    commitTransactionImportPlan({ pool, personId: 7, importPlanId: changing.importPlanId }),
    (error) => error.code === "IMPORT_PLAN_VALUATION_CHANGED",
  );
  assert.equal(pool.state.transactions.length, 1);
  assert.equal(pool.state.plans.get(changing.importPlanId).invalidation_code, "VALUATION_CHANGED");

  const oneSided = await previewTransactionImport({ pool, personId: 7,
    sourceSystem: "coinbase", transactions: [{ ...transaction, externalId: "one-sided",
      lineItems: [{ ...transaction.lineItems[0], valueDecimal: "0" }] }] });
  assert.equal(oneSided.rejectedTransactionCount, 1);
  assert.equal(oneSided.transactions[0].errors.some((error) => error.code === "TOO_FEW_LINE_ITEMS"), true);

  const { transactionAt: _sourceTime, ...dateOnlyTransaction } = transaction;
  const dateOnly = await previewTransactionImport({ pool, personId: 7,
    sourceSystem: "coinbase", transactions: [{ ...dateOnlyTransaction, externalId: "date-only",
      lineItems: [transaction.lineItems[0], { ...transaction.lineItems[1], amountDecimal: "990.00",
        valueDecimal: "990.00" }] }] });
  assert.equal(dateOnly.readyToCommit, true);
  await commitTransactionImportPlan({ pool, personId: 7, importPlanId: dateOnly.importPlanId });
  assert.equal(pool.state.transactions[1].TransactionAtUtc, null);
  assert.deepEqual(pool.state.lineItems.slice(3).map((line) => line.value_units),
    ["-100000", "99000", "1000"]);
});

test("transaction import preserves both sides of a crypto transfer and its asset-denominated fee", async () => {
  const pool = memoryPool();
  pool.state.currencies.push({ currency_id: 3, owner_person_id: 7,
    CurrencyAbbreviation: "BTC", scale: 8 });
  pool.state.accounts.push(
    { account_id: 30, AccountName: "Coinbase BTC", parent_account_id: 10,
      account_currency_id: 3, is_placeholder: 0, archived_at: null },
    { account_id: 31, AccountName: "Offline BTC", parent_account_id: 10,
      account_currency_id: 3, is_placeholder: 0, archived_at: null },
    { account_id: 32, AccountName: "Bitcoin Network Fees", parent_account_id: 20,
      account_currency_id: 3, is_placeholder: 0, archived_at: null },
  );
  const preview = await previewTransactionImport({
    pool, personId: 7, sourceSystem: "coinbase_wallet_reconciliation", transactions: [{
      externalId: "coinbase:cb-91+bitcoin:tx-abc",
      transactionDate: "2026-08-18",
      description: "Coinbase to offline wallet",
      valuationCurrencyCode: "USD",
      lineItems: [
        { externalId: "coinbase:cb-91", accountFullName: "Assets:Coinbase BTC",
          amountDecimal: "-0.01010000", valueDecimal: "-606.00" },
        { externalId: "bitcoin:tx-abc", accountFullName: "Assets:Offline BTC",
          amountDecimal: "0.01000000", valueDecimal: "600.00" },
        { externalId: "bitcoin:tx-abc:fee", accountFullName: "Expenses:Bitcoin Network Fees",
          amountDecimal: "0.00010000", valueDecimal: "6.00" },
      ],
    }],
  });
  assert.equal(preview.readyToCommit, true);
  assert.equal(preview.rejectedTransactionCount, 0);

  await commitTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.deepEqual(pool.state.lineItems.map((line) => line.amount_units),
    ["-1010000", "1000000", "10000"]);
  assert.deepEqual(pool.state.lineItems.map((line) => line.value_units),
    ["-60600", "60000", "600"]);
  assert.deepEqual(pool.state.lineItems.map((line) => line.source_id),
    ["coinbase:cb-91", "bitcoin:tx-abc", "bitcoin:tx-abc:fee"]);
});

test("reconciliation-bound import refuses a plan until native account movements match known balances", async () => {
  const setupPool = (offlineClosingUnits) => {
    const pool = memoryPool();
    pool.state.currencies.push({ currency_id: 3, owner_person_id: 7,
      CurrencyAbbreviation: "BTC", scale: 8 });
    pool.state.accounts.push(
      { account_id: 30, AccountName: "Coinbase BTC", parent_account_id: 10,
        account_currency_id: 3, is_placeholder: 0, archived_at: null, AccountType: "asset" },
      { account_id: 31, AccountName: "Offline BTC", parent_account_id: 10,
        account_currency_id: 3, is_placeholder: 0, archived_at: null, AccountType: "asset" },
      { account_id: 32, AccountName: "Bitcoin Network Fees", parent_account_id: 20,
        account_currency_id: 3, is_placeholder: 0, archived_at: null, AccountType: "expense" },
    );
    pool.state.balanceAssertions.push(
      { account_balance_assertion_id: 1, account_id: 30, balance_date: "2026-08-01",
        known_balance_units: "200000000" },
      { account_balance_assertion_id: 2, account_id: 30, balance_date: "2026-08-31",
        known_balance_units: "198990000" },
      { account_balance_assertion_id: 3, account_id: 31, balance_date: "2026-08-01",
        known_balance_units: "50000000" },
      { account_balance_assertion_id: 4, account_id: 31, balance_date: "2026-08-31",
        known_balance_units: offlineClosingUnits },
    );
    return pool;
  };
  const transaction = {
    externalId: "coinbase:cb-91+bitcoin:tx-abc", transactionDate: "2026-08-18",
    description: "Coinbase to offline wallet", valuationCurrencyCode: "USD",
    lineItems: [
      { externalId: "coinbase:cb-91", accountFullName: "Assets:Coinbase BTC",
        amountDecimal: "-0.01010000", valueDecimal: "-606.00" },
      { externalId: "bitcoin:tx-abc", accountFullName: "Assets:Offline BTC",
        amountDecimal: "0.01000000", valueDecimal: "600.00" },
      { externalId: "bitcoin:tx-abc:fee", accountFullName: "Expenses:Bitcoin Network Fees",
        amountDecimal: "0.00010000", valueDecimal: "6.00" },
    ],
  };
  const reconciliation = { accountIds: [30, 31], openingBalanceDate: "2026-08-01",
    closingBalanceDate: "2026-08-31" };

  const mismatchPool = setupPool("51100000");
  const mismatch = await previewTransactionImport({ pool: mismatchPool, personId: 7,
    sourceSystem: "coinbase_wallet_reconciliation", transactions: [transaction], reconciliation });
  assert.equal(mismatch.readyToCommit, false);
  assert.equal(mismatch.importPlanId, null);
  assert.equal(mismatch.reconciliationValidation.passed, false);
  assert.equal(mismatch.reconciliationValidation.accounts[1].residualUnits, "100000");
  assert.equal(mismatchPool.state.plans.size, 0);

  const matchingPool = setupPool("51000000");
  const matching = await previewTransactionImport({ pool: matchingPool, personId: 7,
    sourceSystem: "coinbase_wallet_reconciliation", transactions: [transaction], reconciliation });
  assert.equal(matching.readyToCommit, true);
  assert.equal(matching.reconciliationValidation.passed, true);
  const committed = await commitTransactionImportPlan({ pool: matchingPool, personId: 7,
    importPlanId: matching.importPlanId });
  assert.equal(committed.reconciliationValidation.passed, true);
});

test("reconciliation-bound commit invalidates when a known balance changes after preview", async () => {
  const pool = memoryPool();
  pool.state.balanceAssertions.push(
    { account_balance_assertion_id: 1, account_id: 11, balance_date: "2026-08-01",
      known_balance_units: "10000" },
    { account_balance_assertion_id: 2, account_id: 11, balance_date: "2026-08-31",
      known_balance_units: "9000" },
  );
  const reconciliation = { accountIds: [11], openingBalanceDate: "2026-08-01",
    closingBalanceDate: "2026-08-31" };
  const transactions = [{ externalId: "checking-1", transactionDate: "2026-08-15",
    description: "Statement purchase", valuationCurrencyCode: "USD", lineItems: [
      { externalId: "bank-row-1", accountFullName: "Assets:Checking", amountDecimal: "-10.00" },
      { externalId: "merchant-row-1", accountFullName: "Expenses:Food", amountDecimal: "10.00" },
    ] }];
  const preview = await previewTransactionImport({ pool, personId: 7, sourceSystem: "statement",
    transactions, reconciliation });
  assert.equal(preview.readyToCommit, true);
  pool.state.balanceAssertions.find((item) => item.account_balance_assertion_id === 2).known_balance_units = "8000";
  await assert.rejects(commitTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId }),
    (error) => error.code === "IMPORT_PLAN_NO_LONGER_RECONCILES");
  assert.equal(pool.state.plans.get(preview.importPlanId).plan_status, "invalidated");
  assert.equal(pool.state.transactions.length, 0);
});

test("transaction import accepts a zero-value commodity quantity adjustment", async () => {
  const pool = memoryPool();
  const preview = await previewTransactionImport({
    pool, personId: 7, sourceSystem: "source_app", transactions: [{
      externalId: "stock-split", transactionDate: "2023-10-11", description: "150x Stock Split",
      valuationCurrencyCode: "USD", lineItems: [
        { externalId: "shares", accountFullName: "Assets:Investments:VTSAX",
          amountDecimal: "14274.200", valueDecimal: "0.00" },
      ],
    }],
  });

  assert.equal(preview.readyToCommit, true);
  assert.equal(preview.rejectedTransactionCount, 0);
  await commitTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.deepEqual(pool.state.lineItems.map((line) => line.value_units), ["0"]);
  assert.deepEqual(pool.state.rates, []);
});

test("transaction commit persists plan invalidation after an integrity failure", async () => {
  const pool = memoryPool();
  const preview = await previewTransactionImport({
    pool, personId: 7, sourceSystem: "source_app", transactions: importedTransactions(),
  });
  pool.state.plans.get(preview.importPlanId).payload_json += " ";

  await assert.rejects(
    commitTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId }),
    (error) => error.code === "IMPORT_PLAN_INTEGRITY_FAILURE",
  );
  const status = await getTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.equal(status.status, "invalidated");
  assert.equal(status.invalidationCode, "PAYLOAD_INTEGRITY_FAILURE");
  assert.equal(pool.state.transactions.length, 0);
});

test("transaction dry run lists every unknown path and does not create a commit plan", async () => {
  const pool = memoryPool();
  const transactions = [{
    externalId: "bad-1",
    transactionDate: "2026-03-01",
    valuationCurrencyCode: "USD",
    lineItems: [
      { accountFullName: "Assets:Missing", amountDecimal: "-1.00" },
      { accountFullName: "Expenses:Missing", amountDecimal: "1.00" },
    ],
  }];
  const preview = await previewTransactionImport({ pool, personId: 7, sourceSystem: "any_source", transactions });
  assert.equal(preview.readyToCommit, false);
  assert.equal(preview.rejectedTransactionCount, 1);
  assert.deepEqual(preview.unknownAccountPaths, ["Assets:Missing", "Expenses:Missing"]);
  assert.equal(preview.importPlanId, null);
  assert.equal(pool.state.plans.size, 0);
});

test("transaction dry run lists an exact account path that is ambiguous", async () => {
  const pool = memoryPool();
  pool.state.accounts.push({ account_id: 22, AccountName: "Checking", parent_account_id: 10,
    account_currency_id: 1, is_placeholder: 0, archived_at: null });
  const preview = await previewTransactionImport({
    pool,
    personId: 7,
    sourceSystem: "any_source",
    transactions: [{
      externalId: "ambiguous-1",
      transactionDate: "2026-03-02",
      valuationCurrencyCode: "USD",
      lineItems: [
        { accountFullName: "Assets:Checking", amountDecimal: "-1.00" },
        { accountFullName: "Expenses:Food", amountDecimal: "1.00" },
      ],
    }],
  });
  assert.equal(preview.readyToCommit, false);
  assert.deepEqual(preview.ambiguousAccountPaths, ["Assets:Checking"]);
  assert.equal(preview.transactions[0].errors[0].code, "AMBIGUOUS_ACCOUNT_PATH");
});

test("identical generic external transaction IDs are deduplicated while conflicting ones are rejected", async () => {
  const pool = memoryPool();
  const [transaction] = importedTransactions();
  const identical = await previewTransactionImport({
    pool, personId: 7, sourceSystem: "generic", transactions: [transaction, structuredClone(transaction)],
  });
  assert.equal(identical.submittedTransactionCount, 2);
  assert.equal(identical.uniqueTransactionCount, 1);
  assert.equal(identical.duplicateInputTransactionCount, 1);
  assert.equal(identical.readyToCommit, true);

  const changed = structuredClone(transaction);
  changed.description = "Different content";
  const conflicting = await previewTransactionImport({
    pool, personId: 7, sourceSystem: "generic-2", transactions: [transaction, changed],
  });
  assert.equal(conflicting.readyToCommit, false);
  assert.equal(conflicting.rejectedTransactionCount, 1);
  assert.equal(conflicting.transactions[0].errors[0].code, "CONFLICTING_DUPLICATE_EXTERNAL_ID");
});

test("transaction import normalizes and summarizes durable question metadata on a suspense line", async () => {
  const normalized = normalizeTransactionImport({
    sourceSystem: "statement",
    transactions: [{
      externalId: "balance-derived-1", transactionDate: "2026-08-31",
      description: "Balance-derived adjustment", valuationCurrencyCode: "USD",
      lineItems: [
        { accountFullName: "Assets:Checking", amountDecimal: "12.50", reconciliationState: "cleared" },
        { accountFullName: "Expenses:Food", amountDecimal: "-12.50", question: {
          audience: " Accountant ", prompt: " Which account does this belong to? ",
        } },
      ],
    }],
  });
  assert.deepEqual(normalized.transactions[0].lineItems[1].question, {
    audience: "accountant", prompt: "Which account does this belong to?",
  });
  const pool = memoryPool();
  const preview = await previewTransactionImport({
    pool, personId: 7, sourceSystem: "statement",
    transactions: normalized.transactions,
  });
  assert.deepEqual(preview.questionSummary, {
    openQuestionCount: 1,
    byAudience: { accountant: 1 },
    bySuspenseAccount: { "Expenses:Food": 1 },
  });
  await commitTransactionImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  const suspenseLine = pool.state.lineItems.find((line) => line.account_id === 21);
  assert.equal(pool.state.lineItems.find((line) => line.account_id === 11).reconciliation_state, "cleared");
  assert.equal(suspenseLine.reconciliation_state, "unreconciled");
  const questionTags = pool.state.tagJoins.filter((join) => join.tagged_line_item_id === suspenseLine.line_item_id)
    .map((join) => pool.state.tags.find((tag) => tag.tag_id === join.tag_id))
    .map((tag) => [tag.tag_key, tag.tag_value]);
  assert.deepEqual(questionTags, [
    ["accounting.question.status", "open"],
    ["accounting.question.audience", "accountant"],
    ["accounting.question.prompt", "Which account does this belong to?"],
  ]);
});
