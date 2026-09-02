import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { commitTransactionDeletion, getTransactionDeletionPlan, previewTransactionDeletion,
  refreshTransactionDeletionPlan } =
  await import("../src/transaction-delete.js");

function deletionPool() {
  const state = {
    transactions: [
      { transaction_id: 10, TransactionDate: "2026-01-01", description: "one", valuation_currency_id: 1,
        TransactionState: "posted", reversal_of_transaction_id: null, source_system: "test", source_id: "one",
        source_fingerprint: "a".repeat(64) },
      { transaction_id: 11, TransactionDate: "2026-01-02", description: "two", valuation_currency_id: 1,
        TransactionState: "posted", reversal_of_transaction_id: null, source_system: "test", source_id: "two",
        source_fingerprint: "b".repeat(64) },
    ],
    lines: [
      { line_item_id: 100, transaction_id: 10, amount_units: "-100", memo: null, account_id: 1,
        reconciliation_state: "unreconciled", reconciled_at: null, source_id: "1" },
      { line_item_id: 101, transaction_id: 10, amount_units: "100", memo: null, account_id: 2,
        reconciliation_state: "unreconciled", reconciled_at: null, source_id: "2" },
      { line_item_id: 102, transaction_id: 11, amount_units: "-200", memo: null, account_id: 1,
        reconciliation_state: "unreconciled", reconciled_at: null, source_id: "1" },
      { line_item_id: 103, transaction_id: 11, amount_units: "150", memo: null, account_id: 2,
        reconciliation_state: "unreconciled", reconciled_at: null, source_id: "2" },
      { line_item_id: 104, transaction_id: 11, amount_units: "50", memo: null, account_id: 3,
        reconciliation_state: "unreconciled", reconciled_at: null, source_id: "3" },
    ],
    rates: [{ xrate_id: 20, transaction_id: 11, xrate_type: "transaction", ValidAt: null,
      from_units: "1", from_currency_id: 2, to_units: "2", to_currency_id: 1 }],
    tags: [{ tagged_line_item_id: 104, tag_id: 7, transaction_id: 11 }],
    accounts: [
      { account_id: 1, AccountName: "Bank", description: null, is_placeholder: 0, parent_account_id: null,
        AccountType: "asset", account_currency_id: 1, archived_at: null, source_system: null, source_id: null },
      { account_id: 2, AccountName: "Food", description: null, is_placeholder: 0, parent_account_id: null,
        AccountType: "expense", account_currency_id: 1, archived_at: null, source_system: null, source_id: null },
      { account_id: 3, AccountName: "Tax", description: null, is_placeholder: 0, parent_account_id: null,
        AccountType: "expense", account_currency_id: 1, archived_at: null, source_system: null, source_id: null },
    ],
    assertions: [{ account_balance_assertion_id: 30, account_id: 1, balance_date: "2026-01-03",
      known_balance_units: "0" }],
    importJobs: new Map([["job-committed", "committed"], ["job-preview", "review_ready"]]),
    importItems: [
      { import_job_id: "job-committed", transaction_external_id: "one", ledger_transaction_id: 10,
        item_status: "committed", errors_json: null },
      { import_job_id: "job-preview", transaction_external_id: "two", ledger_transaction_id: 11,
        item_status: "reused", errors_json: null },
    ],
    importRequests: [
      { import_job_id: "job-committed", request_kind: "chunk", request_id: "request-1",
        payload_sha256: "d".repeat(64), created_at: "2026-01-01" },
      { import_job_id: "job-preview", request_kind: "chunk", request_id: "request-2",
        payload_sha256: "e".repeat(64), created_at: "2026-01-02" },
    ],
    plans: new Map(),
    targetIds: new Set(),
    maxParameterCount: 0,
  };
  return {
    state,
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params = []) {
          state.maxParameterCount = Math.max(state.maxParameterCount, params.length);
          if (sql.startsWith("DELETE FROM accounting_import_plans")) return [{ affectedRows: 0 }];
          if (sql.includes("INSERT INTO accounting_import_plans")) {
            const [id, owner, payloadHash, previewHash, payload, summary, expiresAt] = params;
            state.plans.set(id, { import_plan_id: id, owner_person_id: owner, import_kind: "transaction_delete",
              plan_status: "ready", payload_sha256: payloadHash, preview_sha256: previewHash,
              payload_json: payload, summary_json: summary, expires_at: expiresAt, committed_at: null,
              invalidated_at: null, invalidation_code: null, result_json: null, is_expired: 0 });
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("FROM accounting_import_plans") && sql.includes("transaction_delete")) {
            const [id, owner] = params;
            const plan = state.plans.get(id);
            return [[plan && Number(plan.owner_person_id) === Number(owner) ? plan : undefined].filter(Boolean)];
          }
          if (sql.includes("UPDATE accounting_import_plans")) {
            const committing = sql.includes("plan_status = 'committed'");
            const [value, id, owner] = params;
            const plan = state.plans.get(id);
            if (plan && Number(plan.owner_person_id) === Number(owner)) {
              plan.plan_status = committing ? "committed" : "invalidated";
              plan.committed_at = committing ? "now" : null;
              plan.result_json = committing ? value : null;
              plan.invalidation_code = committing ? null : value;
            }
            return [{ affectedRows: plan ? 1 : 0 }];
          }
          if (sql.includes("SELECT transaction_id, TransactionDate")) return [state.transactions.map((row) => ({ ...row }))];
          if (sql.includes("SELECT li.line_item_id")) return [state.lines.map((row) => ({ ...row }))];
          if (sql.includes("SELECT xrate_id, transaction_id")) return [state.rates.map((row) => ({ ...row }))];
          if (sql.includes("SELECT j.tagged_line_item_id")) return [state.tags.map((row) => ({ ...row }))];
          if (sql.includes("SELECT account_id, AccountName")) return [state.accounts.map((row) => ({ ...row }))];
          if (sql.includes("SELECT account_balance_assertion_id")) {
            assert.match(sql, /known_balance_units/);
            assert.doesNotMatch(sql, /,\s*balance_units\b|,\s*note\b/);
            return [state.assertions.map((row) => ({ ...row }))];
          }
          if (sql.startsWith("DROP TEMPORARY TABLE")) {
            state.targetIds = new Set();
            return [{ affectedRows: 0 }];
          }
          if (sql.startsWith("CREATE TEMPORARY TABLE")) return [{ affectedRows: 0 }];
          if (sql.startsWith("INSERT INTO transaction_delete_targets")) {
            params.forEach((id) => state.targetIds.add(Number(id)));
            return [{ affectedRows: params.length }];
          }
          if (sql.includes("COALESCE(SUM(j.job_status = 'committed')")) {
            const references = state.importItems.filter((row) => state.targetIds.has(Number(row.ledger_transaction_id)));
            return [[{
              deleted_audit_references: references.filter((row) => state.importJobs.get(row.import_job_id) === "committed").length,
              reopened_import_jobs: new Set(references.filter((row) => state.importJobs.get(row.import_job_id) !== "committed")
                .map((row) => row.import_job_id)).size,
            }]];
          }
          if (sql.includes("SELECT import_job_id, client_request_id")
            && sql.includes("FROM accounting_transaction_import_jobs")) {
            return [[...state.importJobs].map(([import_job_id, job_status], index) => ({
              import_job_id, client_request_id: `client-${index}`, source_system: "test",
              source_file_name: `${import_job_id}.csv`, expected_record_count: 1, job_status,
              preview_sha256: null, created_at: "2026-01-01", updated_at: "2026-01-02",
            }))];
          }
          if (sql.includes("FROM accounting_transaction_import_requests r")) {
            return [state.importRequests.map((row) => ({ ...row }))];
          }
          if (sql.includes("SELECT i.import_job_id, i.transaction_external_id, i.canonical_sha256")) {
            return [state.importItems.map((row) => ({ ...row }))];
          }
          if (sql.includes("FROM accounting_transaction_import_items i")) {
            return [state.importItems.filter((row) => state.targetIds.has(Number(row.ledger_transaction_id))).map((row) => ({
              ...row, job_status: state.importJobs.get(row.import_job_id),
            }))];
          }
          if (sql.includes("UPDATE accounting_transaction_import_items SET item_status = 'deleted'")) {
            const [jobId, externalId] = params;
            const item = state.importItems.find((row) => row.import_job_id === jobId
              && row.transaction_external_id === externalId);
            item.item_status = "deleted"; item.ledger_transaction_id = null; item.errors_json = null;
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("UPDATE accounting_transaction_import_items SET item_status = 'exception'")) {
            const [errors, jobId, externalId] = params;
            const item = state.importItems.find((row) => row.import_job_id === jobId
              && row.transaction_external_id === externalId);
            item.item_status = "exception"; item.ledger_transaction_id = null; item.errors_json = errors;
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("UPDATE accounting_transaction_import_jobs SET job_status = 'receiving'")) {
            state.importJobs.set(params[0], "receiving");
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("UPDATE accounting_transaction_import_jobs j") && sql.includes("j.job_status = 'receiving'")) {
            const reopened = new Set(state.importItems.filter((row) => state.targetIds.has(Number(row.ledger_transaction_id))
              && state.importJobs.get(row.import_job_id) !== "committed").map((row) => row.import_job_id));
            reopened.forEach((jobId) => state.importJobs.set(jobId, "receiving"));
            return [{ affectedRows: reopened.size }];
          }
          if (sql.includes("UPDATE accounting_transaction_import_items i") && sql.includes("CASE WHEN j.job_status")) {
            let affectedRows = 0;
            for (const item of state.importItems.filter((row) => state.targetIds.has(Number(row.ledger_transaction_id)))) {
              const committed = state.importJobs.get(item.import_job_id) === "committed";
              item.item_status = committed ? "deleted" : "exception";
              item.ledger_transaction_id = null;
              item.errors_json = committed ? null : params[0];
              affectedRows += 1;
            }
            return [{ affectedRows }];
          }
          if (sql.startsWith("DELETE FROM accounting_transaction_import_jobs WHERE owner_person_id")) {
            const affectedRows = state.importJobs.size;
            state.importJobs.clear(); state.importItems = []; state.importRequests = [];
            return [{ affectedRows }];
          }
          if (sql.startsWith("DELETE j FROM lineitems_tags_join")) {
            const before = state.tags.length;
            state.tags = state.tags.filter((row) => !state.targetIds.has(Number(row.transaction_id)));
            return [{ affectedRows: before - state.tags.length }];
          }
          if (sql.startsWith("DELETE li FROM line_items")) {
            const before = state.lines.length;
            state.lines = state.lines.filter((row) => !state.targetIds.has(Number(row.transaction_id)));
            return [{ affectedRows: before - state.lines.length }];
          }
          if (sql.startsWith("DELETE x FROM xrates")) {
            const before = state.rates.length;
            state.rates = state.rates.filter((row) => !state.targetIds.has(Number(row.transaction_id)));
            return [{ affectedRows: before - state.rates.length }];
          }
          if (sql.startsWith("UPDATE transactions t JOIN")) return [{ affectedRows: 0 }];
          if (sql.startsWith("DELETE t FROM transactions")) {
            const before = state.transactions.length;
            state.transactions = state.transactions.filter((row) => !state.targetIds.has(Number(row.transaction_id)));
            return [{ affectedRows: before - state.transactions.length }];
          }
          if (sql.startsWith("DELETE FROM account_balance_assertions")) {
            const before = state.assertions.length; state.assertions = []; return [{ affectedRows: before }];
          }
          if (sql.startsWith("UPDATE accounts SET parent_account_id")) return [{ affectedRows: 0 }];
          if (sql.startsWith("DELETE FROM accounts")) {
            const before = state.accounts.length; state.accounts = []; return [{ affectedRows: before }];
          }
          if (sql.includes("SELECT t.transaction_id FROM transactions")) {
            return [state.transactions.filter((row) => state.targetIds.has(Number(row.transaction_id)))];
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },
  };
}

test("all-transaction deletion freezes scope, deletes dependencies, and proves accounts unchanged", async () => {
  const pool = deletionPool();
  const preview = await previewTransactionDeletion({ pool, personId: 7, scope: "all" });
  assert.equal(preview.summary.transactionCount, 2);
  assert.equal(preview.summary.lineItemCount, 5);
  assert.equal(preview.summary.exchangeRateCount, 1);
  assert.equal(preview.summary.tagAssignmentCount, 1);
  assert.equal(preview.preview.targetDigest.startsWith("sha256:"), true);
  assert.equal("transactionIds" in preview.preview, false);

  const ready = await getTransactionDeletionPlan({ pool, personId: 7, deletionPlanId: preview.deletionPlanId });
  assert.equal(ready.readyToCommit, true);

  const result = await commitTransactionDeletion({ pool, personId: 7,
    deletionPlanId: preview.deletionPlanId, previewDigest: preview.previewDigest });
  assert.deepEqual(result.deleted, { transactionCount: 2, lineItemCount: 5,
    exchangeRateCount: 1, tagAssignmentCount: 1 });
  assert.equal(result.verification.targetTransactionsAbsent, true);
  assert.equal(result.verification.accountTreeUnchanged, true);
  assert.deepEqual(result.importReferences, { deletedAuditReferences: 1, reopenedImportJobs: 1 });
  assert.equal(pool.state.importItems[0].item_status, "deleted");
  assert.equal(pool.state.importItems[1].item_status, "exception");
  assert.equal(pool.state.importJobs.get("job-preview"), "receiving");
  assert.equal(pool.state.transactions.length, 0);
  assert.equal(pool.state.accounts.length, 3);

  const retry = await commitTransactionDeletion({ pool, personId: 7,
    deletionPlanId: preview.deletionPlanId, previewDigest: preview.previewDigest });
  assert.equal(retry.alreadyCommitted, true);
  await assert.rejects(
    commitTransactionDeletion({ pool, personId: 7, deletionPlanId: preview.deletionPlanId,
      previewDigest: `sha256:${"0".repeat(64)}` }),
    (error) => error.code === "TRANSACTION_DELETE_PREVIEW_MISMATCH",
  );
});

test("whole-ledger deletion can explicitly include accounts and known balances", async () => {
  const pool = deletionPool();
  const preview = await previewTransactionDeletion({ pool, personId: 7, scope: "all", deleteAccounts: true });
  assert.equal(preview.summary.transactionCount, 2);
  assert.equal(preview.summary.deleteAccounts, true);
  assert.equal(preview.summary.accountCount, 3);
  assert.equal(preview.summary.balanceAssertionCount, 1);

  const result = await commitTransactionDeletion({ pool, personId: 7,
    deletionPlanId: preview.deletionPlanId, previewDigest: preview.previewDigest });
  assert.equal(result.deleted.accountCount, 3);
  assert.equal(result.deleted.balanceAssertionCount, 1);
  assert.equal(result.verification.accountsAbsent, true);
  assert.equal(pool.state.accounts.length, 0);
  assert.equal(pool.state.assertions.length, 0);
});

test("import history can be removed after ledger transactions were already cleared", async () => {
  const pool = deletionPool();
  pool.state.transactions = []; pool.state.lines = []; pool.state.rates = []; pool.state.tags = [];
  const preview = await previewTransactionDeletion({ pool, personId: 7, scope: "all",
    deleteImportHistory: true });
  assert.equal(preview.summary.transactionCount, 0);
  assert.equal(preview.summary.importJobCount, 2);
  assert.equal(preview.summary.importItemCount, 2);
  assert.equal(preview.summary.importRequestCount, 2);

  const result = await commitTransactionDeletion({ pool, personId: 7,
    deletionPlanId: preview.deletionPlanId, previewDigest: preview.previewDigest });
  assert.equal(result.deleted.transactionCount, 0);
  assert.equal(result.deleted.importJobCount, 2);
  assert.equal(result.deleted.importItemCount, 2);
  assert.equal(result.importReferences.importHistoryDeleted, true);
  assert.equal(pool.state.importJobs.size, 0);
  assert.equal(pool.state.importItems.length, 0);
});

test("preview digest mismatch preserves the ready plan and names the bound-argument recovery", async () => {
  const pool = deletionPool();
  const preview = await previewTransactionDeletion({ pool, personId: 7, scope: "all" });
  await assert.rejects(
    commitTransactionDeletion({ pool, personId: 7, deletionPlanId: preview.deletionPlanId,
      previewDigest: `sha256:${"0".repeat(64)}` }),
    (error) => error.code === "TRANSACTION_DELETE_PREVIEW_MISMATCH"
      && error.requiredAction === "USE_BOUND_PREVIEW_ARGUMENTS",
  );
  assert.equal(pool.state.plans.get(preview.deletionPlanId).plan_status, "ready");
});

test("an invalidated plan can be refreshed without exposing its frozen target IDs", async () => {
  const pool = deletionPool();
  const preview = await previewTransactionDeletion({ pool, personId: 7, scope: "selected", transactionIds: [10] });
  pool.state.plans.get(preview.deletionPlanId).plan_status = "invalidated";
  const refreshed = await refreshTransactionDeletionPlan({ pool, personId: 7,
    deletionPlanId: preview.deletionPlanId });
  assert.notEqual(refreshed.deletionPlanId, preview.deletionPlanId);
  assert.equal(refreshed.summary.transactionCount, 1);
  assert.equal("transactionIds" in refreshed.preview, false);
});

test("a still-ready plan cannot be refreshed into a second confirmation", async () => {
  const pool = deletionPool();
  const preview = await previewTransactionDeletion({ pool, personId: 7, scope: "all" });
  await assert.rejects(
    refreshTransactionDeletionPlan({ pool, personId: 7, deletionPlanId: preview.deletionPlanId }),
    (error) => error.code === "TRANSACTION_DELETE_PLAN_REFRESH_NOT_ALLOWED"
      && error.requiredAction === "USE_EXISTING_DELETE_PLAN",
  );
});

test("all scope uses bounded internal target batches", async () => {
  const pool = deletionPool();
  for (let id = 12; id <= 1212; id += 1) {
    pool.state.transactions.push({ ...pool.state.transactions[0], transaction_id: id,
      source_id: `transaction-${id}` });
  }
  const preview = await previewTransactionDeletion({ pool, personId: 7, scope: "all" });
  const result = await commitTransactionDeletion({ pool, personId: 7,
    deletionPlanId: preview.deletionPlanId, previewDigest: preview.previewDigest });
  assert.equal(result.deleted.transactionCount, 1203);
  assert.equal(pool.state.maxParameterCount <= 500, true);
});

test("all-transaction deletion invalidates when the owner transaction set changes", async () => {
  const pool = deletionPool();
  const preview = await previewTransactionDeletion({ pool, personId: 7, scope: "all" });
  pool.state.transactions.push({ ...pool.state.transactions[0], transaction_id: 12, source_id: "new" });

  await assert.rejects(
    commitTransactionDeletion({ pool, personId: 7, deletionPlanId: preview.deletionPlanId,
      previewDigest: preview.previewDigest }),
    (error) => error.code === "TRANSACTION_DELETE_PLAN_INVALIDATED",
  );
  assert.equal(pool.state.transactions.length, 3);
  const status = await getTransactionDeletionPlan({ pool, personId: 7, deletionPlanId: preview.deletionPlanId });
  assert.equal(status.status, "invalidated");
});
