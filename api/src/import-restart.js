import { createHash, randomUUID } from "node:crypto";
import { withPoolTransaction } from "./db.js";
import { pruneOwnerAccountingImportPlans } from "./import-plan-retention.js";

function restartError(message, code = "IMPORT_RESTART_PLAN_STATE_CONFLICT", status = 409, details = undefined) {
  return Object.assign(new Error(message), { code, status, details });
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function expiresAtTimestamp(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function parseJson(value, label) {
  try { return JSON.parse(String(value)); }
  catch { throw restartError(`Import-restart plan ${label} is invalid.`); }
}

async function loadJob(connection, personId, importJobId, lock = false) {
  const [rows] = await connection.query(
    `SELECT import_job_id, source_system, source_file_name, expected_record_count,
            job_status, created_at, updated_at
       FROM accounting_transaction_import_jobs
      WHERE import_job_id = ? AND owner_person_id = ?${lock ? " FOR UPDATE" : ""}`,
    [importJobId, personId],
  );
  if (!rows[0]) throw restartError("Import job not found.", "IMPORT_JOB_NOT_FOUND", 404);
  return rows[0];
}

async function loadItems(connection, importJobId, lock = false) {
  const [rows] = await connection.query(
    `SELECT transaction_external_id, canonical_sha256, item_status,
            ledger_transaction_id, source_record_count, updated_at
       FROM accounting_transaction_import_items
      WHERE import_job_id = ? ORDER BY transaction_external_id${lock ? " FOR UPDATE" : ""}`,
    [importJobId],
  );
  return rows;
}

async function loadTransactionSnapshot(connection, personId, importJobId, lock = false) {
  const suffix = lock ? " FOR UPDATE" : "";
  const [transactions] = await connection.query(
    `SELECT t.transaction_id, t.TransactionDate, t.description, t.valuation_currency_id,
            t.TransactionState, t.reversal_of_transaction_id, t.source_system,
            t.source_id, t.source_fingerprint
       FROM transactions t
       JOIN accounting_transaction_import_items i ON i.ledger_transaction_id = t.transaction_id
      WHERE i.import_job_id = ? AND i.item_status = 'committed'
        AND t.owner_person_id = ? ORDER BY t.transaction_id${suffix}`,
    [importJobId, personId],
  );
  const [lines] = await connection.query(
    `SELECT li.line_item_id, li.transaction_id, li.amount_units, li.value_units,
            li.memo, li.account_id, li.reconciliation_state, li.reconciled_at, li.source_id
       FROM line_items li
       JOIN transactions t ON t.transaction_id = li.transaction_id
       JOIN accounting_transaction_import_items i ON i.ledger_transaction_id = t.transaction_id
      WHERE i.import_job_id = ? AND i.item_status = 'committed'
        AND t.owner_person_id = ? ORDER BY li.transaction_id, li.line_item_id${suffix}`,
    [importJobId, personId],
  );
  const [rates] = await connection.query(
    `SELECT x.xrate_id, x.transaction_id, x.xrate_type, x.ValidAt, x.from_units,
            x.from_currency_id, x.to_units, x.to_currency_id
       FROM xrates x
       JOIN accounting_transaction_import_items i ON i.ledger_transaction_id = x.transaction_id
      WHERE i.import_job_id = ? AND i.item_status = 'committed'
        AND x.owner_person_id = ? ORDER BY x.transaction_id, x.xrate_id${suffix}`,
    [importJobId, personId],
  );
  const [tags] = await connection.query(
    `SELECT j.tagged_line_item_id, j.tag_id, li.transaction_id
       FROM lineitems_tags_join j
       JOIN line_items li ON li.line_item_id = j.tagged_line_item_id
       JOIN transactions t ON t.transaction_id = li.transaction_id
       JOIN accounting_transaction_import_items i ON i.ledger_transaction_id = t.transaction_id
      WHERE i.import_job_id = ? AND i.item_status = 'committed'
        AND t.owner_person_id = ? ORDER BY li.transaction_id, j.tagged_line_item_id, j.tag_id${suffix}`,
    [importJobId, personId],
  );
  return { transactions, lines, rates, tags };
}

function summarize(job, items, snapshot) {
  const itemStatuses = {};
  for (const item of items) itemStatuses[item.item_status] = (itemStatuses[item.item_status] ?? 0) + 1;
  return {
    importJobId: String(job.import_job_id),
    sourceSystem: String(job.source_system),
    sourceFileName: job.source_file_name == null ? null : String(job.source_file_name),
    jobStatus: String(job.job_status),
    sourceRecordCount: Number(job.expected_record_count),
    importItemCount: items.length,
    itemStatuses,
    createdTransactionCount: snapshot.transactions.length,
    preservedReusedTransactionCount: Number(itemStatuses.reused ?? 0),
    lineItemCount: snapshot.lines.length,
    exchangeRateCount: snapshot.rates.length,
    tagAssignmentCount: snapshot.tags.length,
  };
}

async function loadPlan(connection, personId, planId, lock = false) {
  const [rows] = await connection.query(
    `SELECT import_plan_id, plan_status, payload_sha256, preview_sha256, payload_json,
            summary_json, expires_at, committed_at, result_json,
            expires_at <= UTC_TIMESTAMP(6) AS is_expired
       FROM accounting_import_plans
      WHERE import_plan_id = ? AND owner_person_id = ?
        AND import_kind = 'import_restart'${lock ? " FOR UPDATE" : ""}`,
    [planId, personId],
  );
  if (!rows[0]) throw restartError("Import-restart plan not found.", "IMPORT_RESTART_PLAN_NOT_FOUND", 404);
  return rows[0];
}

export async function previewImportRestart({ pool, personId, importJobId }) {
  const jobId = String(importJobId ?? "").trim();
  if (!jobId) throw restartError("Import job not found.", "IMPORT_JOB_NOT_FOUND", 404);
  return withPoolTransaction(pool, async (connection) => {
    await pruneOwnerAccountingImportPlans(connection, personId);
    const job = await loadJob(connection, personId, jobId);
    const items = await loadItems(connection, jobId);
    const snapshot = await loadTransactionSnapshot(connection, personId, jobId);
    const summary = summarize(job, items, snapshot);
    const payload = {
      importJobId: jobId,
      jobSha256: sha256(JSON.stringify({ job, items })),
      transactionSha256: sha256(JSON.stringify(snapshot)),
    };
    const preview = {
      effect: "delete_import_job_and_transactions_created_by_it",
      reusedTransactionsPreserved: true,
      accountsPreserved: true,
      ...summary,
    };
    const planId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const payloadJson = JSON.stringify(payload);
    const previewHash = sha256(JSON.stringify(preview));
    await connection.query(
      `INSERT INTO accounting_import_plans
        (import_plan_id, owner_person_id, import_kind, plan_status, source_system,
         payload_sha256, preview_sha256, payload_json, summary_json, expires_at)
       VALUES (?, ?, 'import_restart', 'ready', ?, ?, ?, ?, ?, ?)`,
      [planId, personId, job.source_system, sha256(payloadJson), previewHash,
        payloadJson, JSON.stringify(summary), expiresAtTimestamp(expiresAt)],
    );
    return { readyToCommit: true, restartPlanId: planId, status: "ready",
      expiresAt: expiresAt.toISOString(), previewDigest: `sha256:${previewHash}`, summary, preview };
  });
}

async function createTargetTable(connection, transactionIds) {
  await connection.query("DROP TEMPORARY TABLE IF EXISTS import_restart_targets");
  await connection.query(
    `CREATE TEMPORARY TABLE import_restart_targets (
       transaction_id BIGINT UNSIGNED NOT NULL PRIMARY KEY
     ) ENGINE=InnoDB`,
  );
  for (let offset = 0; offset < transactionIds.length; offset += 500) {
    const batch = transactionIds.slice(offset, offset + 500);
    await connection.query(
      `INSERT INTO import_restart_targets (transaction_id) VALUES ${batch.map(() => "(?)").join(", ")}`,
      batch,
    );
  }
}

export async function commitImportRestart({ pool, personId, restartPlanId, previewDigest }) {
  const planId = String(restartPlanId ?? "").trim();
  const suppliedDigest = String(previewDigest ?? "").trim().replace(/^sha256:/, "");
  if (!planId) throw restartError("Import-restart plan not found.", "IMPORT_RESTART_PLAN_NOT_FOUND", 404);
  return withPoolTransaction(pool, async (connection) => {
    const plan = await loadPlan(connection, personId, planId, true);
    if (plan.plan_status === "committed" && plan.result_json) {
      return { ...parseJson(plan.result_json, "result"), alreadyCommitted: true };
    }
    if (plan.plan_status !== "ready" || Boolean(plan.is_expired)) {
      throw restartError("Import-restart plan is no longer ready.", "IMPORT_RESTART_PLAN_INVALIDATED");
    }
    if (suppliedDigest !== String(plan.preview_sha256)) {
      throw restartError("The supplied preview digest does not match this restart plan.", "IMPORT_RESTART_PREVIEW_MISMATCH");
    }
    if (sha256(plan.payload_json) !== String(plan.payload_sha256)) {
      throw restartError("Import-restart plan failed its integrity check.", "IMPORT_RESTART_PLAN_INVALIDATED");
    }
    const payload = parseJson(plan.payload_json, "payload");
    const job = await loadJob(connection, personId, payload.importJobId, true);
    const items = await loadItems(connection, payload.importJobId, true);
    const snapshot = await loadTransactionSnapshot(connection, personId, payload.importJobId, true);
    if (sha256(JSON.stringify({ job, items })) !== payload.jobSha256
      || sha256(JSON.stringify(snapshot)) !== payload.transactionSha256) {
      throw restartError("The import or its transactions changed after preview.", "IMPORT_RESTART_PLAN_INVALIDATED");
    }
    const transactionIds = snapshot.transactions.map((row) => Number(row.transaction_id));
    if (transactionIds.length) await createTargetTable(connection, transactionIds);
    try {
      if (transactionIds.length) {
        const [externalReversals] = await connection.query(
          `SELECT t.transaction_id FROM transactions t
            JOIN import_restart_targets d ON d.transaction_id = t.reversal_of_transaction_id
            LEFT JOIN import_restart_targets own_target ON own_target.transaction_id = t.transaction_id
           WHERE t.owner_person_id = ? AND own_target.transaction_id IS NULL`, [personId],
        );
        if (externalReversals.length) throw restartError(
          "A transaction outside this import reverses a transaction that would be removed.",
          "IMPORT_RESTART_EXTERNAL_REVERSAL", 409,
          { transactionIds: externalReversals.map((row) => Number(row.transaction_id)) },
        );
      }

      const [jobDelete] = await connection.query(
        "DELETE FROM accounting_transaction_import_jobs WHERE import_job_id = ? AND owner_person_id = ?",
        [payload.importJobId, personId],
      );
      if (Number(jobDelete.affectedRows) !== 1) throw restartError("Import job changed after preview.");

      let reopenedImportJobs = 0;
      let tagCount = 0;
      let lineCount = 0;
      let rateCount = 0;
      let transactionCount = 0;
      if (transactionIds.length) {
        const [otherReferences] = await connection.query(
          `SELECT i.import_job_id, i.transaction_external_id
             FROM accounting_transaction_import_items i
             JOIN accounting_transaction_import_jobs j ON j.import_job_id = i.import_job_id
             JOIN import_restart_targets d ON d.transaction_id = i.ledger_transaction_id
            FOR UPDATE`,
        );
        const reopened = new Set();
        for (const reference of otherReferences) {
          await connection.query(
            `UPDATE accounting_transaction_import_items SET item_status = 'exception',
                    ledger_transaction_id = NULL, errors_json = ?, updated_at = UTC_TIMESTAMP(6)
              WHERE import_job_id = ? AND transaction_external_id = ?`,
            [JSON.stringify([{ code: "REFERENCED_TRANSACTION_DELETED",
              message: "The reused ledger transaction was removed when its original import was restarted." }]),
            reference.import_job_id, reference.transaction_external_id],
          );
          reopened.add(String(reference.import_job_id));
        }
        for (const otherJobId of reopened) await connection.query(
          `UPDATE accounting_transaction_import_jobs SET job_status = 'receiving',
                  preview_sha256 = NULL, updated_at = UTC_TIMESTAMP(6) WHERE import_job_id = ?`, [otherJobId],
        );
        reopenedImportJobs = reopened.size;

        const [tagDelete] = await connection.query(
          `DELETE j FROM lineitems_tags_join j
            JOIN line_items li ON li.line_item_id = j.tagged_line_item_id
            JOIN import_restart_targets d ON d.transaction_id = li.transaction_id`,
        );
        const [lineDelete] = await connection.query(
          `DELETE li FROM line_items li
            JOIN import_restart_targets d ON d.transaction_id = li.transaction_id`,
        );
        const [rateDelete] = await connection.query(
          `DELETE x FROM xrates x
            JOIN import_restart_targets d ON d.transaction_id = x.transaction_id
           WHERE x.owner_person_id = ?`, [personId],
        );
        await connection.query(
          `UPDATE transactions t JOIN import_restart_targets d ON d.transaction_id = t.transaction_id
              SET t.reversal_of_transaction_id = NULL WHERE t.owner_person_id = ?`, [personId],
        );
        const [transactionDelete] = await connection.query(
          `DELETE t FROM transactions t
            JOIN import_restart_targets d ON d.transaction_id = t.transaction_id
           WHERE t.owner_person_id = ?`, [personId],
        );
        tagCount = Number(tagDelete.affectedRows);
        lineCount = Number(lineDelete.affectedRows);
        rateCount = Number(rateDelete.affectedRows);
        transactionCount = Number(transactionDelete.affectedRows);
        if (tagCount !== snapshot.tags.length || lineCount !== snapshot.lines.length
          || rateCount !== snapshot.rates.length || transactionCount !== snapshot.transactions.length) {
          throw new Error("Import restart affected counts did not match its preview.");
        }
      }

      const summary = parseJson(plan.summary_json, "summary");
      const result = {
        readyToCommit: false,
        status: "committed",
        restartPlanId: planId,
        previewDigest: `sha256:${plan.preview_sha256}`,
        summary,
        deleted: { importJobCount: 1, transactionCount, lineItemCount: lineCount,
          exchangeRateCount: rateCount, tagAssignmentCount: tagCount },
        preserved: { reusedTransactionCount: summary.preservedReusedTransactionCount },
        reopenedImportJobs,
        alreadyCommitted: false,
      };
      await connection.query(
        `UPDATE accounting_import_plans SET plan_status = 'committed',
                committed_at = UTC_TIMESTAMP(6), result_json = ?
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [JSON.stringify(result), planId, personId],
      );
      return result;
    } finally {
      if (transactionIds.length) await connection.query("DROP TEMPORARY TABLE IF EXISTS import_restart_targets");
    }
  });
}
