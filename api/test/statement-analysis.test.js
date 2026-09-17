import test from "node:test";
import assert from "node:assert/strict";
import { analyzeStatementObservations } from "../src/statement-analysis.js";

function analysisPool({ remainingCoinbase = "-1010000", existingRows = [] } = {}) {
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

test("same-account amount and date candidates remain unresolved without matching source identity", async () => {
  const existingRows = [{ transaction_id: 82, TransactionDate: "2026-08-18",
    TransactionState: "posted", transaction_description: "Another merchant",
    transaction_source_system: "manual", transaction_source_id: "unrelated",
    line_item_id: 502, amount_units: "-1010000", line_memo: null,
    line_source_id: "different-id", account_id: 10 }];
  const result = await analyzeStatementObservations({
    pool: analysisPool({ existingRows }), personId: 7,
    observations: [pairedObservations[0]], openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31",
  });
  assert.equal(result.duplicateAnalysis.ledgerCandidates[0].candidates[0].classification, "possible_duplicate");
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
  assert.equal(mismatch.coverage[0].balanced, false);
  assert.equal(mismatch.readyForTransactionAssembly, true);
});
