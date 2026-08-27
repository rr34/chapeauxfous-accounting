import { createHash, randomUUID } from "node:crypto";
import { withPoolTransaction } from "./db.js";
import { deleteAccount, inspectAccountDeletion } from "./accounting.js";

const failureMetadata = Object.freeze({
  ACCOUNT_DELETE_PLAN_NOT_FOUND: { status: 404, recoverable: true, requiredAction: "RUN_NEW_DELETE_PREVIEW" },
  ACCOUNT_DELETE_PLAN_EXPIRED: { status: 410, recoverable: true, requiredAction: "RUN_NEW_DELETE_PREVIEW" },
  ACCOUNT_DELETE_PLAN_INVALIDATED: { status: 409, recoverable: true, requiredAction: "RUN_NEW_DELETE_PREVIEW" },
  ACCOUNT_DELETE_PLAN_STATE_CONFLICT: { status: 409, recoverable: true, requiredAction: "RUN_NEW_DELETE_PREVIEW" },
});

function planError(code, message, details = undefined) {
  const metadata = failureMetadata[code] ?? failureMetadata.ACCOUNT_DELETE_PLAN_STATE_CONFLICT;
  return Object.assign(new Error(message), { code, details, ...metadata });
}

export function accountDeletePlanFailure(error) {
  const metadata = failureMetadata[error?.code];
  if (!metadata) return null;
  return {
    code: error.code,
    message: error.message,
    details: error.details ?? null,
    recoverable: metadata.recoverable,
    requiredAction: metadata.requiredAction,
  };
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
  if (Number.isNaN(parsed.getTime())) throw planError("ACCOUNT_DELETE_PLAN_STATE_CONFLICT", "Deletion plan expiration is invalid.");
  return parsed.toISOString();
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch {
    throw planError("ACCOUNT_DELETE_PLAN_STATE_CONFLICT", `Deletion plan ${label} is invalid.`);
  }
}

async function loadPlan(connection, personId, planId, { lock = false } = {}) {
  const [rows] = await connection.query(
    `SELECT import_plan_id, plan_status, payload_sha256, preview_sha256, payload_json,
            summary_json, expires_at, committed_at, invalidated_at, invalidation_code,
            result_json, expires_at <= UTC_TIMESTAMP(6) AS is_expired
       FROM accounting_import_plans
      WHERE import_plan_id = ? AND owner_person_id = ? AND import_kind = 'account_delete'${lock ? " FOR UPDATE" : ""}`,
    [planId, personId],
  );
  if (!rows[0]) throw planError("ACCOUNT_DELETE_PLAN_NOT_FOUND", "Account-deletion plan not found.");
  return rows[0];
}

function identity(row) {
  const summary = parseJson(row.summary_json, "summary");
  if (!Number.isInteger(summary.accountId) || summary.accountId <= 0 || typeof summary.accountName !== "string") {
    throw planError("ACCOUNT_DELETE_PLAN_STATE_CONFLICT", "Deletion plan summary has an invalid shape.");
  }
  const digest = String(row.preview_sha256 ?? "");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw planError("ACCOUNT_DELETE_PLAN_STATE_CONFLICT", "Deletion preview digest is invalid.");
  return {
    deletionPlanId: String(row.import_plan_id),
    expiresAt: isoTimestamp(row.expires_at),
    previewDigest: `sha256:${digest}`,
    summary,
  };
}

export async function previewAccountDeletion({ pool, personId, accountId }) {
  return withPoolTransaction(pool, async (connection) => {
    const account = await inspectAccountDeletion({ personId, accountId }, async (work) => work(connection));
    const payloadJson = JSON.stringify({ accountId: account.accountId });
    const summary = { accountId: account.accountId, accountName: account.name };
    const preview = { accountId: account.accountId, accountName: account.name, effect: "permanently_delete_empty_leaf_account" };
    const planId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const previewHash = sha256(JSON.stringify(preview));
    await connection.query(
      `INSERT INTO accounting_import_plans
        (import_plan_id, owner_person_id, import_kind, plan_status, source_system,
         payload_sha256, preview_sha256, payload_json, summary_json, expires_at)
       VALUES (?, ?, 'account_delete', 'ready', NULL, ?, ?, ?, ?, ?)`,
      [planId, personId, sha256(payloadJson), previewHash, payloadJson, JSON.stringify(summary), expiresAtTimestamp(expiresAt)],
    );
    return {
      readyToCommit: true,
      deletionPlanId: planId,
      status: "ready",
      expiresAt: expiresAt.toISOString(),
      previewDigest: `sha256:${previewHash}`,
      summary,
      preview,
    };
  });
}

export async function getAccountDeletionPlan({ pool, personId, deletionPlanId }) {
  const planId = String(deletionPlanId ?? "").trim();
  if (!planId) throw planError("ACCOUNT_DELETE_PLAN_NOT_FOUND", "Account-deletion plan not found.");
  return withPoolTransaction(pool, async (connection) => {
    const row = await loadPlan(connection, personId, planId);
    const planIdentity = identity(row);
    if (row.plan_status === "committed") {
      if (!row.result_json) throw planError("ACCOUNT_DELETE_PLAN_STATE_CONFLICT", "Committed deletion plan has no stored result.");
      return { ...parseJson(row.result_json, "result"), alreadyCommitted: true };
    }
    if (row.plan_status === "invalidated") {
      return { readyToCommit: false, status: "invalidated", ...planIdentity,
        invalidationCode: row.invalidation_code ?? "DATABASE_STATE_CHANGED" };
    }
    if (Boolean(row.is_expired)) return { readyToCommit: false, status: "expired", ...planIdentity };
    return { readyToCommit: true, status: "ready", ...planIdentity };
  });
}

export async function commitAccountDeletion({ pool, personId, deletionPlanId }) {
  const planId = String(deletionPlanId ?? "").trim();
  if (!planId) throw planError("ACCOUNT_DELETE_PLAN_NOT_FOUND", "Account-deletion plan not found.");
  const outcome = await withPoolTransaction(pool, async (connection) => {
    const row = await loadPlan(connection, personId, planId, { lock: true });
    if (row.committed_at != null) {
      if (row.plan_status !== "committed" || !row.result_json) {
        return { failure: planError("ACCOUNT_DELETE_PLAN_STATE_CONFLICT", "Committed deletion plan state is inconsistent.") };
      }
      return { result: { ...parseJson(row.result_json, "result"), alreadyCommitted: true } };
    }
    if (row.plan_status !== "ready") {
      return { failure: planError("ACCOUNT_DELETE_PLAN_INVALIDATED", "Account-deletion plan is no longer ready.") };
    }
    if (Boolean(row.is_expired)) return { failure: planError("ACCOUNT_DELETE_PLAN_EXPIRED", "Account-deletion plan has expired.") };
    if (sha256(row.payload_json) !== String(row.payload_sha256)) {
      await connection.query(
        `UPDATE accounting_import_plans
            SET plan_status = 'invalidated', invalidated_at = UTC_TIMESTAMP(6),
                invalidation_code = 'INTEGRITY_FAILURE'
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [planId, personId],
      );
      return { failure: planError("ACCOUNT_DELETE_PLAN_INVALIDATED", "Account-deletion plan failed its integrity check.") };
    }
    const payload = parseJson(row.payload_json, "payload");
    let deleted;
    try {
      deleted = await deleteAccount({ personId, accountId: payload.accountId }, async (work) => work(connection));
    } catch (error) {
      if (!(Number(error?.status) >= 400 && Number(error?.status) < 500)) throw error;
      await connection.query(
        `UPDATE accounting_import_plans
            SET plan_status = 'invalidated', invalidated_at = UTC_TIMESTAMP(6),
                invalidation_code = 'DATABASE_STATE_CHANGED'
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [planId, personId],
      );
      return { failure: planError("ACCOUNT_DELETE_PLAN_INVALIDATED", `Account can no longer be deleted: ${error.message}`) };
    }
    const [remaining] = await connection.query(
      "SELECT account_id FROM accounts WHERE account_id = ? AND owner_person_id = ?",
      [payload.accountId, personId],
    );
    if (remaining.length) throw new Error("Deleted account remained visible after deletion.");
    const planIdentity = identity(row);
    const result = {
      readyToCommit: false,
      status: "committed",
      ...planIdentity,
      deleted,
      verifiedAbsent: true,
      alreadyCommitted: false,
    };
    await connection.query(
      `UPDATE accounting_import_plans
          SET plan_status = 'committed', committed_at = UTC_TIMESTAMP(6), result_json = ?
        WHERE import_plan_id = ? AND owner_person_id = ?`,
      [JSON.stringify(result), planId, personId],
    );
    return { result };
  });
  if (outcome.failure) throw outcome.failure;
  return outcome.result;
}
