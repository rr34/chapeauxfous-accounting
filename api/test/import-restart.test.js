import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { commitImportRestart, previewImportRestart } = await import("../src/import-restart.js");

function restartPool() {
  const state = {
    job: { import_job_id: "job-original", source_system: "gemini", source_file_name: "gemini.csv",
      expected_record_count: 3, job_status: "review_ready", created_at: "2026-01-01", updated_at: "2026-01-02" },
    items: [
      { transaction_external_id: "created", canonical_sha256: "a".repeat(64), item_status: "committed",
        ledger_transaction_id: 10, source_record_count: 2, updated_at: "2026-01-02" },
      { transaction_external_id: "reused", canonical_sha256: "b".repeat(64), item_status: "reused",
        ledger_transaction_id: 20, source_record_count: 1, updated_at: "2026-01-02" },
    ],
    transactions: [{ transaction_id: 10, TransactionDate: "2026-01-01", description: "created",
      valuation_currency_id: 1, TransactionState: "posted", reversal_of_transaction_id: null,
      source_system: "gemini", source_id: "created", source_fingerprint: "c".repeat(64) }],
    lines: [
      { line_item_id: 100, transaction_id: 10, amount_units: "-100", value_units: "-100", memo: null,
        account_id: 1, reconciliation_state: "unreconciled", reconciled_at: null, source_id: "1" },
      { line_item_id: 101, transaction_id: 10, amount_units: "100", value_units: "100", memo: null,
        account_id: 2, reconciliation_state: "unreconciled", reconciled_at: null, source_id: "2" },
    ],
    rates: [],
    tags: [{ tagged_line_item_id: 101, tag_id: 8, transaction_id: 10 }],
    plans: new Map(),
    targetIds: new Set(),
    reopenedItem: { import_job_id: "job-other", transaction_external_id: "also-created", ledger_transaction_id: 10 },
    reopenedJobs: new Set(),
  };
  return { state, async getConnection() { return {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params = []) {
      if (sql.startsWith("DELETE FROM accounting_import_plans")) return [{ affectedRows: 0 }];
      if (sql.includes("INSERT INTO accounting_import_plans")) {
        const [id, owner, sourceSystem, payloadHash, previewHash, payload, summary, expiresAt] = params;
        state.plans.set(id, { import_plan_id: id, owner_person_id: owner, import_kind: "import_restart",
          plan_status: "ready", source_system: sourceSystem, payload_sha256: payloadHash,
          preview_sha256: previewHash, payload_json: payload, summary_json: summary, expires_at: expiresAt,
          committed_at: null, result_json: null, is_expired: 0 });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM accounting_import_plans") && sql.includes("import_restart")) {
        const plan = state.plans.get(params[0]);
        return [[plan && Number(plan.owner_person_id) === Number(params[1]) ? plan : undefined].filter(Boolean)];
      }
      if (sql.includes("SELECT import_job_id") && sql.includes("FROM accounting_transaction_import_jobs")
        && sql.includes("WHERE import_job_id")) {
        return [[state.job].filter(Boolean)];
      }
      if (sql.includes("FROM accounting_transaction_import_items") && sql.includes("ORDER BY transaction_external_id")) {
        return [state.items.map((item) => ({ ...item }))];
      }
      if (sql.includes("SELECT t.transaction_id, t.TransactionDate")) return [state.transactions.map((row) => ({ ...row }))];
      if (sql.includes("SELECT li.line_item_id")) return [state.lines.map((row) => ({ ...row }))];
      if (sql.includes("SELECT x.xrate_id")) return [state.rates.map((row) => ({ ...row }))];
      if (sql.includes("SELECT j.tagged_line_item_id")) return [state.tags.map((row) => ({ ...row }))];
      if (sql.startsWith("DROP TEMPORARY TABLE")) { state.targetIds.clear(); return [{ affectedRows: 0 }]; }
      if (sql.startsWith("CREATE TEMPORARY TABLE")) return [{ affectedRows: 0 }];
      if (sql.startsWith("INSERT INTO import_restart_targets")) {
        params.forEach((id) => state.targetIds.add(Number(id))); return [{ affectedRows: params.length }];
      }
      if (sql.includes("SELECT t.transaction_id FROM transactions t")) return [[]];
      if (sql.startsWith("DELETE FROM accounting_transaction_import_jobs")) {
        const affectedRows = state.job ? 1 : 0; state.job = null; return [{ affectedRows }];
      }
      if (sql.includes("SELECT i.import_job_id, i.transaction_external_id")) return [[{ ...state.reopenedItem }]];
      if (sql.includes("UPDATE accounting_transaction_import_items SET item_status = 'exception'")) {
        state.reopenedItem.ledger_transaction_id = null; return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE accounting_transaction_import_jobs SET job_status = 'receiving'")) {
        state.reopenedJobs.add(String(params[0])); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("DELETE j FROM lineitems_tags_join")) {
        const affectedRows = state.tags.length; state.tags = []; return [{ affectedRows }];
      }
      if (sql.startsWith("DELETE li FROM line_items")) {
        const affectedRows = state.lines.length; state.lines = []; return [{ affectedRows }];
      }
      if (sql.startsWith("DELETE x FROM xrates")) {
        const affectedRows = state.rates.length; state.rates = []; return [{ affectedRows }];
      }
      if (sql.startsWith("UPDATE transactions t JOIN")) return [{ affectedRows: 0 }];
      if (sql.startsWith("DELETE t FROM transactions")) {
        const affectedRows = state.transactions.length; state.transactions = []; return [{ affectedRows }];
      }
      if (sql.includes("UPDATE accounting_import_plans SET plan_status = 'committed'")) {
        const [result, id] = params; const plan = state.plans.get(id);
        plan.plan_status = "committed"; plan.result_json = result; return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  }; } };
}

test("restarting an import removes only its created transactions and preserves reused ones", async () => {
  const pool = restartPool();
  const preview = await previewImportRestart({ pool, personId: 7, importJobId: "job-original" });
  assert.equal(preview.summary.createdTransactionCount, 1);
  assert.equal(preview.summary.preservedReusedTransactionCount, 1);
  assert.equal(preview.summary.lineItemCount, 2);

  await assert.rejects(commitImportRestart({ pool, personId: 7, restartPlanId: preview.restartPlanId,
    previewDigest: `sha256:${"0".repeat(64)}` }), (error) => error.code === "IMPORT_RESTART_PREVIEW_MISMATCH");

  const result = await commitImportRestart({ pool, personId: 7, restartPlanId: preview.restartPlanId,
    previewDigest: preview.previewDigest });
  assert.deepEqual(result.deleted, { importJobCount: 1, transactionCount: 1, lineItemCount: 2,
    exchangeRateCount: 0, tagAssignmentCount: 1 });
  assert.deepEqual(result.preserved, { reusedTransactionCount: 1 });
  assert.equal(result.reopenedImportJobs, 1);
  assert.equal(pool.state.transactions.length, 0);
  assert.equal(pool.state.reopenedJobs.has("job-other"), true);
});
