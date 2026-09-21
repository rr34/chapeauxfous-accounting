import test from "node:test";
import assert from "node:assert/strict";
import { analyzeStatementObservations } from "../src/statement-analysis.js";

function analysisPool({ remainingCoinbase = "-1010000", existingRows = [], balanceAssertions = [] } = {}) {
  return {
    async query(sql, values = []) {
      if (sql.includes("SELECT account_id, AccountName, parent_account_id")) {
        return [[
          { account_id: 1, AccountName: "Assets", parent_account_id: null },
          { account_id: 10, AccountName: "Coinbase BTC", parent_account_id: 1 },
          { account_id: 11, AccountName: "Offline BTC", parent_account_id: 1 },
        ]];
      }
      if (sql.includes("opening.known_balance_units")) {
        const rows = [
          { account_id: 10, AccountName: "Coinbase BTC", AccountType: "asset", account_currency_id: 2,
            is_placeholder: 0, archived_at: null, CurrencyAbbreviation: "BTC", scale: 8,
            opening_assertion_id: 101, closing_assertion_id: 102,
            opening_known_balance_units: "2000000", closing_known_balance_units: "990000",
            opening_posting_units: "2000000",
            closing_posting_units: (2000000n + (-1010000n - BigInt(remainingCoinbase))).toString() },
          { account_id: 11, AccountName: "Offline BTC", AccountType: "asset", account_currency_id: 2,
            is_placeholder: 0, archived_at: null, CurrencyAbbreviation: "BTC", scale: 8,
            opening_assertion_id: 103, closing_assertion_id: 104,
            opening_known_balance_units: "0", closing_known_balance_units: "1000000",
            opening_posting_units: "0", closing_posting_units: "0" },
        ];
        const requestedIds = new Set(values.slice(5).map(Number));
        return [rows.filter((row) => requestedIds.has(Number(row.account_id)))];
      }
      if (sql.includes("FROM account_balance_assertions aba")) return [balanceAssertions];
      if (sql.includes("FROM line_items li") && sql.includes("TransactionState <> 'voided'")) return [existingRows];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

const pairedObservations = [
  { sourceDocumentId: "coinbase-august", sourceRecordId: "row-7", accountId: 10,
    transactionDate: "2026-08-18", occurredAt: "2026-08-18T14:32:00Z",
    amountDecimal: "-0.01010000", description: "Send bitcoin", reference: "tx-abc" },
  { sourceDocumentId: "wallet-august", sourceRecordId: "row-2", accountId: 11,
    transactionDate: "2026-08-18", occurredAt: "2026-08-18T14:35:00Z",
    amountDecimal: "0.01000000", description: "Received bitcoin", reference: "tx-abc" },
];

test("statement analysis compiles transfer candidates and proves balance coverage", async () => {
  const result = await analyzeStatementObservations({ pool: analysisPool(), personId: 7,
    observations: pairedObservations, openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31" });
  assert.equal(result.transferCandidates.length, 1);
  assert.equal(result.transferCandidates[0].classification, "strong_transfer_candidate");
  assert.equal(result.transferCandidates[0].possibleFeeUnits, "10000");
  assert.deepEqual(result.ambiguousTransferObservationIds, []);
  assert.deepEqual(result.coverage.map((item) => item.residualAfterProposedUnits), ["0", "0"]);
  assert.equal(result.readyForTransactionAssembly, true);
});

test("only a stable matching source reference is automatically excluded as an existing duplicate", async () => {
  const existingRows = [{ transaction_id: 81, TransactionDate: "2026-08-18",
    TransactionState: "posted", transaction_description: "Send bitcoin",
    transaction_source_system: "coinbase_wallet_reconciliation", transaction_source_id: "joined-transfer",
    line_item_id: 501, amount_units: "-1010000", line_memo: null,
    line_source_id: "tx-abc", account_id: 10 }];
  const result = await analyzeStatementObservations({
    pool: analysisPool({ remainingCoinbase: "0", existingRows }), personId: 7,
    observations: [pairedObservations[0]], openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });
  assert.equal(result.duplicateAnalysis.ledgerCandidates[0].candidates[0].classification,
    "exact_source_duplicate");
  assert.deepEqual(result.duplicateAnalysis.ambiguousExactLedgerObservationIds, []);
  assert.equal(result.proposedNewObservationIds.length, 0);
  assert.equal(result.coverage[0].balanced, true);
});

test("same-account amount within two days is marked as a probable duplicate", async () => {
  const existingRows = [{ transaction_id: 82, TransactionDate: "2026-08-18",
    TransactionState: "posted", transaction_description: "Another merchant",
    transaction_source_system: "manual", transaction_source_id: "unrelated",
    line_item_id: 502, amount_units: "-1010000", line_memo: null,
    line_source_id: "different-id", account_id: 10 }];
  const result = await analyzeStatementObservations({
    pool: analysisPool({ existingRows }), personId: 7,
    observations: [pairedObservations[0]], openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });
  assert.equal(result.duplicateAnalysis.ledgerCandidates[0].candidates[0].classification, "probable_duplicate");
  assert.equal(result.duplicateAnalysis.unresolvedCandidateCount, 1);
  assert.equal(result.readyForTransactionAssembly, true);
});

test("statement rows are ready to assemble when known balances are absent or do not match", async () => {
  const pool = analysisPool({ remainingCoinbase: "0" });
  const originalQuery = pool.query;
  pool.query = async (sql, values) => {
    const [rows] = await originalQuery(sql, values);
    if (sql.includes("opening.known_balance_units")) return [rows.map((row) => ({
      ...row, opening_assertion_id: null, closing_assertion_id: null,
      opening_known_balance_units: null, closing_known_balance_units: null,
    }))];
    return [rows];
  };
  const missing = await analyzeStatementObservations({ pool, personId: 7,
    observations: [pairedObservations[0]], openingBalanceDate: "2026-08-01",
    closingBalanceDate: "2026-08-31" });
  assert.equal(missing.coverage[0].balanced, false);
  assert.equal(missing.readyForTransactionAssembly, true);

  const mismatch = await analyzeStatementObservations({ pool: analysisPool({ remainingCoinbase: "0" }),
    personId: 7, observations: [pairedObservations[0]], openingBalanceDate: "2026-08-01",
    closingBalanceDate: "2026-08-31" });
  assert.equal(mismatch.coverage[0].balanced, true);
  assert.equal(mismatch.importDecisions[0].decision, "exclude");
  assert.equal(mismatch.readyForTransactionAssembly, true);
});

test("known balance and nearby ledger evidence select the duplicate that closes the residual", async () => {
  const observations = [
    { sourceDocumentId: "bank-august", sourceRecordId: "row-1", accountId: 10,
      transactionDate: "2026-08-10", amountDecimal: "-0.01000000", description: "Transfer", reference: null },
    { sourceDocumentId: "bank-august", sourceRecordId: "row-2", accountId: 10,
      transactionDate: "2026-08-12", amountDecimal: "-0.00010000", description: "Fee", reference: null },
  ];
  const existingRows = [{ transaction_id: 90, TransactionDate: "2026-08-09",
    TransactionState: "posted", transaction_description: "Transfer already entered",
    transaction_source_system: "manual", transaction_source_id: null,
    line_item_id: 590, amount_units: "-1000000", line_memo: null,
    line_source_id: null, account_id: 10 }];
  const result = await analyzeStatementObservations({
    pool: analysisPool({ remainingCoinbase: "-10000", existingRows }), personId: 7,
    observations, openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });
  assert.deepEqual(result.importDecisions.map((item) => item.decision), ["exclude", "include"]);
  assert.equal(result.importDecisions[0].confidence, "probable");
  assert.equal(result.coverage[0].residualAfterProposedUnits, "0");
});

test("equally plausible balance-closing exclusions remain visible and included for user review", async () => {
  const observations = ["row-1", "row-2"].map((sourceRecordId, index) => ({
    sourceDocumentId: "bank-august", sourceRecordId, accountId: 10,
    transactionDate: `2026-08-${10 + index}`, amountDecimal: "-0.01000000",
    description: "Transfer", reference: null,
  }));
  const result = await analyzeStatementObservations({
    pool: analysisPool({ remainingCoinbase: "-1000000" }), personId: 7,
    observations, openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });
  assert.deepEqual(result.importDecisions.map((item) => item.decision), ["include", "include"]);
  assert.deepEqual(result.importDecisions.map((item) => item.confidence), ["ambiguous", "ambiguous"]);
  assert.equal(result.coverage[0].balanced, false);
});

test("balances found in the current statement guide deduplication before they are saved", async () => {
  const pool = analysisPool();
  const originalQuery = pool.query;
  pool.query = async (sql, values) => {
    const [rows] = await originalQuery(sql, values);
    if (sql.includes("opening.known_balance_units")) return [rows.map((row) => ({
      ...row, opening_assertion_id: null, closing_assertion_id: null,
      opening_known_balance_units: null, closing_known_balance_units: null,
    }))];
    return [rows];
  };
  const result = await analyzeStatementObservations({
    pool, personId: 7, observations: [pairedObservations[0]],
    openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
    knownBalanceAssertions: [
      { accountId: 10, balanceDate: "2026-08-01", knownBalanceUnits: "2000000" },
      { accountId: 10, balanceDate: "2026-08-31", knownBalanceUnits: "990000" },
    ],
  });
  assert.equal(result.reconciliation.grounded, true);
  assert.equal(result.coverage[0].balanced, true);
  assert.equal(result.importDecisions[0].decision, "include");
});

test("known-balance solving can exclude a unique combination of statement rows", async () => {
  const amounts = ["-0.00600000", "-0.00400000", "-0.00100000"];
  const observations = amounts.map((amountDecimal, index) => ({
    sourceDocumentId: "bank-combination", sourceRecordId: `row-${index + 1}`, accountId: 10,
    transactionDate: `2026-08-${10 + index}`, amountDecimal, description: `Row ${index + 1}`, reference: null,
  }));
  const result = await analyzeStatementObservations({
    pool: analysisPool({ remainingCoinbase: "-100000" }), personId: 7,
    observations, openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });
  assert.deepEqual(result.importDecisions.map((item) => item.decision), ["exclude", "exclude", "include"]);
  assert.equal(result.coverage[0].balanced, true);
});

test("a matching known-balance checkpoint excludes all imported rows on or before its date", async () => {
  const observations = ["2026-08-14", "2026-08-15", "2026-08-16"].map((transactionDate, index) => ({
    sourceDocumentId: "overlap-statement", sourceRecordId: `row-${index + 1}`, accountId: 10,
    transactionDate, amountDecimal: ["-0.00100000", "-0.00200000", "-0.00300000"][index],
    description: `Imported row ${index + 1}`, reference: null,
  }));
  const checkpoint = {
    account_balance_assertion_id: 70, account_id: 10, balance_date: "2026-08-15",
    known_balance_units: "5000000", calculated_balance_units: "5000000",
    AccountName: "Coinbase BTC", AccountType: "asset", account_currency_id: 2,
    CurrencyAbbreviation: "BTC", scale: 8,
  };
  const result = await analyzeStatementObservations({
    pool: analysisPool({ remainingCoinbase: "-300000", balanceAssertions: [checkpoint] }), personId: 7,
    observations, openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });
  assert.deepEqual(result.balanceCheckpoints.map((item) => item.date), ["2026-08-15"]);
  assert.deepEqual(result.importDecisions.map((item) => item.decision), ["exclude", "exclude", "include"]);
  assert.deepEqual(result.importDecisions.map((item) => item.confidence),
    ["verified_checkpoint", "verified_checkpoint", "tentative"]);
  assert.equal(result.coverage[0].balanced, true);
});

test("a known balance that does not match the recorded balance is not an import checkpoint", async () => {
  const mismatch = {
    account_balance_assertion_id: 71, account_id: 10, balance_date: "2026-08-31",
    known_balance_units: "5000000", calculated_balance_units: "4999999",
    AccountName: "Coinbase BTC", AccountType: "asset", account_currency_id: 2,
    CurrencyAbbreviation: "BTC", scale: 8,
  };
  const result = await analyzeStatementObservations({
    pool: analysisPool({ balanceAssertions: [mismatch] }), personId: 7,
    observations: [pairedObservations[0]], openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });
  assert.deepEqual(result.balanceCheckpoints, []);
  assert.equal(result.importDecisions[0].decision, "include");
});
