import { createHash, randomUUID } from "node:crypto";
import { withPoolTransaction } from "./db.js";
import { pruneOwnerAccountingImportPlans } from "./import-plan-retention.js";

const failureMetadata = Object.freeze({
  TRANSACTION_DELETE_PLAN_NOT_FOUND: { status: 404, recoverable: true, requiredAction: "RUN_NEW_DELETE_PREVIEW" },
  TRANSACTION_DELETE_PLAN_EXPIRED: { status: 410, recoverable: true, requiredAction: "RUN_NEW_DELETE_PREVIEW" },
  TRANSACTION_DELETE_PLAN_INVALIDATED: { status: 409, recoverable: true, requiredAction: "RUN_NEW_DELETE_PREVIEW" },
  TRANSACTION_DELETE_PREVIEW_MISMATCH: { status: 409, recoverable: true, requiredAction: "USE_BOUND_PREVIEW_ARGUMENTS" },
  TRANSACTION_DELETE_PLAN_REFRESH_NOT_ALLOWED: { status: 409, recoverable: true, requiredAction: "USE_EXISTING_DELETE_PLAN" },
  TRANSACTION_DELETE_PLAN_STATE_CONFLICT: { status: 409, recoverable: true, requiredAction: "RUN_NEW_DELETE_PREVIEW" },
  TRANSACTIONS_REQUIRED: { status: 404, recoverable: true, requiredAction: "SELECT_TRANSACTIONS" },
});

function planError(code, message, details = undefined) {
  const metadata = failureMetadata[code] ?? failureMetadata.TRANSACTION_DELETE_PLAN_STATE_CONFLICT;
  return Object.assign(new Error(message), { code, details, ...metadata });
}

export function transactionDeletePlanFailure(error) {
  const metadata = failureMetadata[error?.code];
  if (!metadata) return null;
  return { code: error.code, message: error.message, details: error.details ?? null,
    recoverable: metadata.recoverable, requiredAction: metadata.requiredAction };
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function expiresAtTimestamp(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function isoTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  const normalized = String(value ?? "").trim().replace(" ", "T");
  const parsed = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  if (Number.isNaN(parsed.getTime())) throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "Deletion plan expiration is invalid.");
  return parsed.toISOString();
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch {
    throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", `Transaction-deletion plan ${label} is invalid.`);
  }
}

function normalizeIds(values) {
  if (!Array.isArray(values)) return [];
  const ids = [...new Set(values.map(Number))].sort((left, right) => left - right);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "Every transaction ID must be a positive safe integer.");
  }
  return ids;
}

async function loadPlan(connection, personId, planId, lock = false) {
  const [rows] = await connection.query(
    `SELECT import_plan_id, plan_status, payload_sha256, preview_sha256, payload_json,
            summary_json, expires_at, committed_at, invalidated_at, invalidation_code,
            result_json, expires_at <= UTC_TIMESTAMP(6) AS is_expired
       FROM accounting_import_plans
      WHERE import_plan_id = ? AND owner_person_id = ?
        AND import_kind = 'transaction_delete'${lock ? " FOR UPDATE" : ""}`,
    [planId, personId],
  );
  if (!rows[0]) throw planError("TRANSACTION_DELETE_PLAN_NOT_FOUND", "Transaction-deletion plan not found.");
  return rows[0];
}

function identity(row) {
  const summary = parseJson(row.summary_json, "summary");
  const digest = String(row.preview_sha256 ?? "");
  if (!/^[0-9a-f]{64}$/.test(digest) || !Number.isInteger(summary.transactionCount)) {
    throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "Transaction-deletion plan identity is invalid.");
  }
  return { deletionPlanId: String(row.import_plan_id), expiresAt: isoTimestamp(row.expires_at),
    previewDigest: `sha256:${digest}`, summary };
}

async function ledgerSnapshot(connection, personId, { lock = false } = {}) {
  const suffix = lock ? " FOR UPDATE" : "";
  const [transactions] = await connection.query(
    `SELECT transaction_id, TransactionDate, description, valuation_currency_id,
            TransactionState, reversal_of_transaction_id, source_system, source_id,
            source_fingerprint
       FROM transactions WHERE owner_person_id = ? ORDER BY transaction_id${suffix}`,
    [personId],
  );
  const [lines] = await connection.query(
    `SELECT li.line_item_id, li.transaction_id, li.amount_units, li.value_units, li.memo, li.account_id,
            li.reconciliation_state, li.reconciled_at, li.source_id
       FROM line_items li JOIN transactions t ON t.transaction_id = li.transaction_id
      WHERE t.owner_person_id = ? ORDER BY li.transaction_id, li.line_item_id${suffix}`,
    [personId],
  );
  const [rates] = await connection.query(
    `SELECT xrate_id, transaction_id, xrate_type, ValidAt, from_units,
            from_currency_id, to_units, to_currency_id
       FROM xrates WHERE owner_person_id = ? AND transaction_id IS NOT NULL
      ORDER BY transaction_id, xrate_id${suffix}`,
    [personId],
  );
  const [tags] = await connection.query(
    `SELECT j.tagged_line_item_id, j.tag_id, li.transaction_id
       FROM lineitems_tags_join j
       JOIN line_items li ON li.line_item_id = j.tagged_line_item_id
       JOIN transactions t ON t.transaction_id = li.transaction_id
      WHERE t.owner_person_id = ? ORDER BY li.transaction_id, j.tagged_line_item_id, j.tag_id${suffix}`,
    [personId],
  );
  return { transactions, lines, rates, tags };
}

function targetSnapshot(snapshot, transactionIds) {
  const selected = new Set(transactionIds.map(Number));
  return {
    transactions: snapshot.transactions.filter((row) => selected.has(Number(row.transaction_id))),
    lines: snapshot.lines.filter((row) => selected.has(Number(row.transaction_id))),
    rates: snapshot.rates.filter((row) => selected.has(Number(row.transaction_id))),
    tags: snapshot.tags.filter((row) => selected.has(Number(row.transaction_id))),
  };
}

function snapshotHash(snapshot) {
  return sha256(JSON.stringify(snapshot));
}

function summarize(scope, selected, { deleteAccounts = false, accountCount = 0, assertionCount = 0 } = {}) {
  const dates = selected.transactions.map((row) => String(row.TransactionDate).slice(0, 10)).sort();
  const states = { draft: 0, posted: 0, voided: 0 };
  selected.transactions.forEach((row) => { states[String(row.TransactionState)] += 1; });
  const affectedAccountIds = new Set(selected.lines.map((row) => Number(row.account_id)));
  return {
    scope,
    transactionCount: selected.transactions.length,
    lineItemCount: selected.lines.length,
    exchangeRateCount: selected.rates.length,
    tagAssignmentCount: selected.tags.length,
    affectedAccountCount: affectedAccountIds.size,
    deleteAccounts,
    accountCount: deleteAccounts ? accountCount : 0,
    balanceAssertionCount: deleteAccounts ? assertionCount : 0,
    transactionStates: states,
    dateRange: { first: dates[0] ?? null, last: dates.at(-1) ?? null },
  };
}

async function accountDataFingerprint(connection, personId, lock = false) {
  const [accounts] = await connection.query(
    `SELECT account_id, AccountName, description, is_placeholder, parent_account_id,
            AccountType, account_currency_id, archived_at, source_system, source_id
       FROM accounts WHERE owner_person_id = ? ORDER BY account_id${lock ? " FOR UPDATE" : ""}`,
    [personId],
  );
  const [assertions] = await connection.query(
    `SELECT account_balance_assertion_id, account_id, balance_date, balance_units, note
       FROM account_balance_assertions WHERE owner_person_id = ?
      ORDER BY account_balance_assertion_id${lock ? " FOR UPDATE" : ""}`,
    [personId],
  );
  return { count: accounts.length, assertionCount: assertions.length,
    sha256: sha256(JSON.stringify({ accounts, assertions })) };
}

async function invalidate(connection, planId, personId, code) {
  await connection.query(
    `UPDATE accounting_import_plans SET plan_status = 'invalidated',
            invalidated_at = UTC_TIMESTAMP(6), invalidation_code = ?
      WHERE import_plan_id = ? AND owner_person_id = ?`,
    [code, planId, personId],
  );
}

export async function previewTransactionDeletion({ pool, personId, scope, transactionIds = [], deleteAccounts = false }) {
  const normalizedScope = String(scope ?? "").trim();
  const removeAccounts = deleteAccounts === true;
  if (!["all", "selected"].includes(normalizedScope)) {
    throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "scope must be all or selected.");
  }
  const requestedIds = normalizeIds(transactionIds);
  if (normalizedScope === "all" && requestedIds.length) {
    throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "transaction IDs must be omitted when scope is all.");
  }
  if (normalizedScope === "selected" && (!requestedIds.length || requestedIds.length > 1000)) {
    throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "selected scope requires between 1 and 1,000 transaction IDs.");
  }
  if (normalizedScope === "selected" && removeAccounts) {
    throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "Accounts can be deleted only when clearing the whole ledger.");
  }
  return withPoolTransaction(pool, async (connection) => {
    await pruneOwnerAccountingImportPlans(connection, personId);
    const snapshot = await ledgerSnapshot(connection, personId);
    const availableIds = snapshot.transactions.map((row) => Number(row.transaction_id));
    const ids = normalizedScope === "all" ? availableIds : requestedIds;
    const selected = targetSnapshot(snapshot, ids);
    if (selected.transactions.length !== ids.length) {
      const found = new Set(selected.transactions.map((row) => Number(row.transaction_id)));
      throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "One or more selected transactions do not exist or are not owner-scoped.",
        { missingTransactionIds: ids.filter((id) => !found.has(id)) });
    }
    const accountData = await accountDataFingerprint(connection, personId);
    if (!ids.length && !(removeAccounts && accountData.count > 0)) {
      throw planError("TRANSACTIONS_REQUIRED", "There are no owner-scoped transactions or requested accounts to delete.");
    }
    const summary = summarize(normalizedScope, selected, { deleteAccounts: removeAccounts,
      accountCount: accountData.count, assertionCount: accountData.assertionCount });
    const payload = { scope: normalizedScope, transactionIds: ids, snapshotSha256: snapshotHash(selected),
      deleteAccounts: removeAccounts, accountDataSha256: removeAccounts ? accountData.sha256 : null };
    const preview = { ...summary, targetDigest: `sha256:${sha256(JSON.stringify(ids))}`,
      effect: "permanently_delete_exact_transactions_and_dependent_postings",
      accountsPreserved: !removeAccounts, accountTreeChanged: removeAccounts };
    const planId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const payloadJson = JSON.stringify(payload);
    const previewHash = sha256(JSON.stringify(preview));
    await connection.query(
      `INSERT INTO accounting_import_plans
        (import_plan_id, owner_person_id, import_kind, plan_status, source_system,
         payload_sha256, preview_sha256, payload_json, summary_json, expires_at)
       VALUES (?, ?, 'transaction_delete', 'ready', NULL, ?, ?, ?, ?, ?)`,
      [planId, personId, sha256(payloadJson), previewHash, payloadJson,
        JSON.stringify(summary), expiresAtTimestamp(expiresAt)],
    );
    return { readyToCommit: true, deletionPlanId: planId, status: "ready",
      expiresAt: expiresAt.toISOString(), previewDigest: `sha256:${previewHash}`, summary, preview };
  });
}

export async function refreshTransactionDeletionPlan({ pool, personId, deletionPlanId }) {
  const planId = String(deletionPlanId ?? "").trim();
  if (!planId) throw planError("TRANSACTION_DELETE_PLAN_NOT_FOUND", "Transaction-deletion plan not found.");
  const request = await withPoolTransaction(pool, async (connection) => {
    const row = await loadPlan(connection, personId, planId);
    if (row.plan_status === "committed" || (row.plan_status === "ready" && !Boolean(row.is_expired))) {
      throw planError("TRANSACTION_DELETE_PLAN_REFRESH_NOT_ALLOWED",
        "Only an expired or invalidated transaction-deletion plan can be refreshed.");
    }
    const payload = parseJson(row.payload_json, "payload");
    const transactionIds = normalizeIds(payload.transactionIds);
    if (!["all", "selected"].includes(payload.scope)
      || (!transactionIds.length && payload.deleteAccounts !== true)) {
      throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "Transaction-deletion plan payload is invalid.");
    }
    return { scope: payload.scope, transactionIds: payload.scope === "selected" ? transactionIds : [],
      deleteAccounts: payload.deleteAccounts === true };
  });
  return previewTransactionDeletion({ pool, personId, ...request });
}

export async function getTransactionDeletionPlan({ pool, personId, deletionPlanId }) {
  const planId = String(deletionPlanId ?? "").trim();
  if (!planId) throw planError("TRANSACTION_DELETE_PLAN_NOT_FOUND", "Transaction-deletion plan not found.");
  return withPoolTransaction(pool, async (connection) => {
    const row = await loadPlan(connection, personId, planId);
    const planIdentity = identity(row);
    if (row.plan_status === "committed") {
      if (!row.result_json) throw planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "Committed deletion plan has no result.");
      return { ...parseJson(row.result_json, "result"), alreadyCommitted: true };
    }
    if (row.plan_status === "invalidated") return { readyToCommit: false, status: "invalidated",
      ...planIdentity, invalidationCode: row.invalidation_code ?? "DATABASE_STATE_CHANGED" };
    if (Boolean(row.is_expired)) return { readyToCommit: false, status: "expired", ...planIdentity };
    return { readyToCommit: true, status: "ready", ...planIdentity };
  });
}

async function createTargetTable(connection, transactionIds) {
  await connection.query("DROP TEMPORARY TABLE IF EXISTS transaction_delete_targets");
  await connection.query(
     `CREATE TEMPORARY TABLE transaction_delete_targets (
       transaction_id BIGINT UNSIGNED NOT NULL PRIMARY KEY
     ) ENGINE=InnoDB`,
  );
  for (let offset = 0; offset < transactionIds.length; offset += 500) {
    const batch = transactionIds.slice(offset, offset + 500);
    await connection.query(
      `INSERT INTO transaction_delete_targets (transaction_id) VALUES ${batch.map(() => "(?)").join(", ")}`,
      batch,
    );
  }
}

async function updateImportReferences(connection) {
  const [rows] = await connection.query(
    `SELECT i.import_job_id, i.transaction_external_id, i.ledger_transaction_id,
            j.job_status
       FROM accounting_transaction_import_items i
       JOIN accounting_transaction_import_jobs j ON j.import_job_id = i.import_job_id
       JOIN transaction_delete_targets d ON d.transaction_id = i.ledger_transaction_id
      FOR UPDATE`,
  );
  const reopenedJobs = new Set();
  let deletedAuditReferences = 0;
  for (const row of rows) {
    if (row.job_status === "committed") {
      await connection.query(
        `UPDATE accounting_transaction_import_items SET item_status = 'deleted',
                ledger_transaction_id = NULL, errors_json = NULL, updated_at = UTC_TIMESTAMP(6)
          WHERE import_job_id = ? AND transaction_external_id = ?`,
        [row.import_job_id, row.transaction_external_id],
      );
      deletedAuditReferences += 1;
    } else {
      await connection.query(
        `UPDATE accounting_transaction_import_items SET item_status = 'exception',
                ledger_transaction_id = NULL, errors_json = ?, updated_at = UTC_TIMESTAMP(6)
          WHERE import_job_id = ? AND transaction_external_id = ?`,
        [JSON.stringify([{ code: "REFERENCED_TRANSACTION_DELETED",
          message: "The previously reused ledger transaction was explicitly deleted after staging." }]),
        row.import_job_id, row.transaction_external_id],
      );
      reopenedJobs.add(String(row.import_job_id));
    }
  }
  for (const jobId of reopenedJobs) await connection.query(
    `UPDATE accounting_transaction_import_jobs SET job_status = 'receiving',
            preview_sha256 = NULL, updated_at = UTC_TIMESTAMP(6) WHERE import_job_id = ?`, [jobId],
  );
  return { deletedAuditReferences, reopenedImportJobs: reopenedJobs.size };
}

export async function commitTransactionDeletion({ pool, personId, deletionPlanId, previewDigest }) {
  const planId = String(deletionPlanId ?? "").trim();
  if (!planId) throw planError("TRANSACTION_DELETE_PLAN_NOT_FOUND", "Transaction-deletion plan not found.");
  const suppliedDigest = String(previewDigest ?? "").trim().replace(/^sha256:/, "");
  const outcome = await withPoolTransaction(pool, async (connection) => {
    const row = await loadPlan(connection, personId, planId, true);
    if (suppliedDigest !== String(row.preview_sha256)) {
      return { failure: planError("TRANSACTION_DELETE_PREVIEW_MISMATCH", "The supplied preview digest does not match this deletion plan.") };
    }
    if (row.committed_at != null) {
      if (row.plan_status !== "committed" || !row.result_json) {
        return { failure: planError("TRANSACTION_DELETE_PLAN_STATE_CONFLICT", "Committed deletion plan is inconsistent.") };
      }
      return { result: { ...parseJson(row.result_json, "result"), alreadyCommitted: true } };
    }
    if (row.plan_status !== "ready") return { failure: planError("TRANSACTION_DELETE_PLAN_INVALIDATED", "Transaction-deletion plan is no longer ready.") };
    if (Boolean(row.is_expired)) return { failure: planError("TRANSACTION_DELETE_PLAN_EXPIRED", "Transaction-deletion plan has expired.") };
    if (sha256(row.payload_json) !== String(row.payload_sha256)) {
      await invalidate(connection, planId, personId, "INTEGRITY_FAILURE");
      return { failure: planError("TRANSACTION_DELETE_PLAN_INVALIDATED", "Transaction-deletion plan failed its integrity check.") };
    }
    const payload = parseJson(row.payload_json, "payload");
    const transactionIds = normalizeIds(payload.transactionIds);
    const deleteAccounts = payload.deleteAccounts === true;
    if (deleteAccounts && payload.scope !== "all") {
      await invalidate(connection, planId, personId, "INVALID_ACCOUNT_DELETE_SCOPE");
      return { failure: planError("TRANSACTION_DELETE_PLAN_INVALIDATED", "Account deletion requires whole-ledger scope.") };
    }
    const snapshot = await ledgerSnapshot(connection, personId, { lock: true });
    const currentIds = snapshot.transactions.map((item) => Number(item.transaction_id));
    if (payload.scope === "all" && JSON.stringify(currentIds) !== JSON.stringify(transactionIds)) {
      await invalidate(connection, planId, personId, "TRANSACTION_SET_CHANGED");
      return { failure: planError("TRANSACTION_DELETE_PLAN_INVALIDATED", "The owner transaction set changed after preview.") };
    }
    const selected = targetSnapshot(snapshot, transactionIds);
    if (selected.transactions.length !== transactionIds.length || snapshotHash(selected) !== payload.snapshotSha256) {
      await invalidate(connection, planId, personId, "DATABASE_STATE_CHANGED");
      return { failure: planError("TRANSACTION_DELETE_PLAN_INVALIDATED", "A planned transaction changed after preview.") };
    }
    const targetSet = new Set(transactionIds);
    const externalReversals = snapshot.transactions.filter((item) =>
      item.reversal_of_transaction_id != null && targetSet.has(Number(item.reversal_of_transaction_id))
      && !targetSet.has(Number(item.transaction_id)));
    if (externalReversals.length) {
      await invalidate(connection, planId, personId, "UNPLANNED_REVERSAL_REFERENCE");
      return { failure: planError("TRANSACTION_DELETE_PLAN_INVALIDATED",
        "A transaction outside the plan reverses a planned transaction.",
        { transactionIds: externalReversals.map((item) => Number(item.transaction_id)) }) };
    }
    const accountsBefore = await accountDataFingerprint(connection, personId, true);
    if (deleteAccounts && accountsBefore.sha256 !== payload.accountDataSha256) {
      await invalidate(connection, planId, personId, "ACCOUNT_DATA_CHANGED");
      return { failure: planError("TRANSACTION_DELETE_PLAN_INVALIDATED", "The chart of accounts changed after preview.") };
    }
    await createTargetTable(connection, transactionIds);
    try {
      const importReferences = await updateImportReferences(connection);
      const [tagDelete] = await connection.query(
        `DELETE j FROM lineitems_tags_join j
          JOIN line_items li ON li.line_item_id = j.tagged_line_item_id
          JOIN transactions t ON t.transaction_id = li.transaction_id
          JOIN transaction_delete_targets d ON d.transaction_id = t.transaction_id
         WHERE t.owner_person_id = ?`,
        [personId],
      );
      const [lineDelete] = await connection.query(
        `DELETE li FROM line_items li JOIN transactions t ON t.transaction_id = li.transaction_id
          JOIN transaction_delete_targets d ON d.transaction_id = t.transaction_id
          WHERE t.owner_person_id = ?`,
        [personId],
      );
      const [rateDelete] = await connection.query(
        `DELETE x FROM xrates x
          JOIN transaction_delete_targets d ON d.transaction_id = x.transaction_id
         WHERE x.owner_person_id = ?`,
        [personId],
      );
      await connection.query(
        `UPDATE transactions t JOIN transaction_delete_targets d ON d.transaction_id = t.transaction_id
            SET t.reversal_of_transaction_id = NULL
          WHERE t.owner_person_id = ?`, [personId],
      );
      const [transactionDelete] = await connection.query(
        `DELETE t FROM transactions t
          JOIN transaction_delete_targets d ON d.transaction_id = t.transaction_id
         WHERE t.owner_person_id = ?`,
        [personId],
      );
      if (Number(transactionDelete.affectedRows) !== transactionIds.length
        || Number(lineDelete.affectedRows) !== selected.lines.length
        || Number(rateDelete.affectedRows) !== selected.rates.length
        || Number(tagDelete.affectedRows) !== selected.tags.length) {
        throw new Error("Transaction deletion affected counts did not match the bound preview.");
      }
      const [remaining] = await connection.query(
        `SELECT t.transaction_id FROM transactions t
          JOIN transaction_delete_targets d ON d.transaction_id = t.transaction_id
         WHERE t.owner_person_id = ?`, [personId],
      );
      if (remaining.length) throw new Error("Deleted transactions remained visible after deletion.");
      let deletedAccountCount = 0;
      let deletedAssertionCount = 0;
      if (deleteAccounts) {
        const [assertionDelete] = await connection.query(
          "DELETE FROM account_balance_assertions WHERE owner_person_id = ?", [personId],
        );
        await connection.query("UPDATE accounts SET parent_account_id = NULL WHERE owner_person_id = ?", [personId]);
        const [accountDelete] = await connection.query(
          "DELETE FROM accounts WHERE owner_person_id = ?", [personId],
        );
        deletedAssertionCount = Number(assertionDelete.affectedRows);
        deletedAccountCount = Number(accountDelete.affectedRows);
        if (deletedAssertionCount !== accountsBefore.assertionCount || deletedAccountCount !== accountsBefore.count) {
          throw new Error("Account deletion affected counts did not match the bound preview.");
        }
      }
      const accountsAfter = await accountDataFingerprint(connection, personId);
      if (deleteAccounts ? accountsAfter.count !== 0 || accountsAfter.assertionCount !== 0
        : accountsAfter.count !== accountsBefore.count || accountsAfter.sha256 !== accountsBefore.sha256) {
        throw new Error(deleteAccounts ? "Deleted accounts remained visible after deletion."
          : "Account tree changed during transaction deletion.");
      }
      const planIdentity = identity(row);
      const result = {
        readyToCommit: false, status: "committed", ...planIdentity,
        deleted: { transactionCount: Number(transactionDelete.affectedRows),
          lineItemCount: Number(lineDelete.affectedRows), exchangeRateCount: Number(rateDelete.affectedRows),
          tagAssignmentCount: Number(tagDelete.affectedRows),
          ...(deleteAccounts ? { accountCount: deletedAccountCount,
            balanceAssertionCount: deletedAssertionCount } : {}) },
        importReferences,
        verification: { targetTransactionsAbsent: true, accountTreeUnchanged: !deleteAccounts,
          accountsAbsent: deleteAccounts, accountCount: accountsAfter.count },
        alreadyCommitted: false,
      };
      await connection.query(
        `UPDATE accounting_import_plans SET plan_status = 'committed',
                committed_at = UTC_TIMESTAMP(6), result_json = ?
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [JSON.stringify(result), planId, personId],
      );
      return { result };
    } finally {
      await connection.query("DROP TEMPORARY TABLE IF EXISTS transaction_delete_targets");
    }
  });
  if (outcome.failure) throw outcome.failure;
  return outcome.result;
}
