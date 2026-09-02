import { createHash, randomUUID } from "node:crypto";
import { verifyPassword } from "./auth.js";
import { withPoolTransaction } from "./db.js";
import { pruneOwnerAccountingImportPlans } from "./import-plan-retention.js";

function userDeleteError(message, code = "USER_DELETE_PLAN_STATE_CONFLICT", status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function expiresAtTimestamp(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function parseJson(value, label) {
  try { return JSON.parse(String(value)); }
  catch { throw userDeleteError(`User-deletion plan ${label} is invalid.`); }
}

async function loadUser(connection, personId, lock = false) {
  const [rows] = await connection.query(
    `SELECT person_id, Name, OwnerEmail, OwnerPasscode
       FROM people2_people WHERE person_id = ?${lock ? " FOR UPDATE" : ""}`,
    [personId],
  );
  if (!rows[0]) throw userDeleteError("User account not found.", "USER_NOT_FOUND", 404);
  return rows[0];
}

async function dataCounts(connection, personId, excludedPlanId = null) {
  const [rows] = await connection.query(
    `SELECT
       (SELECT COUNT(*) FROM accounts WHERE owner_person_id = ?) AS account_count,
       (SELECT COUNT(*) FROM transactions WHERE owner_person_id = ?) AS transaction_count,
       (SELECT COUNT(*) FROM line_items li JOIN transactions t ON t.transaction_id = li.transaction_id
         WHERE t.owner_person_id = ?) AS line_item_count,
       (SELECT COUNT(*) FROM account_balance_assertions WHERE owner_person_id = ?) AS assertion_count,
       (SELECT COUNT(*) FROM currencies WHERE owner_person_id = ?) AS custom_currency_count,
       (SELECT COUNT(*) FROM tags WHERE owner_person_id = ?) AS tag_count,
       (SELECT COUNT(*) FROM xrates WHERE owner_person_id = ?) AS exchange_rate_count,
       (SELECT COUNT(*) FROM accounting_transaction_import_jobs WHERE owner_person_id = ?) AS import_job_count,
       (SELECT COUNT(*) FROM accounting_transaction_import_items i
          JOIN accounting_transaction_import_jobs j ON j.import_job_id = i.import_job_id
         WHERE j.owner_person_id = ?) AS import_item_count,
       (SELECT COUNT(*) FROM api_tokens WHERE owner_person_id = ?) AS api_token_count,
       (SELECT COUNT(*) FROM accounting_import_plans
         WHERE owner_person_id = ? AND (? IS NULL OR import_plan_id <> ?)) AS saved_plan_count`,
    [personId, personId, personId, personId, personId, personId, personId, personId,
      personId, personId, personId, excludedPlanId, excludedPlanId],
  );
  const row = rows[0] ?? {};
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()), Number(value)]));
}

export async function getUserDataSummary({ pool, personId }) {
  return dataCounts(pool, personId);
}

async function loadPlan(connection, personId, planId, lock = false) {
  const [rows] = await connection.query(
    `SELECT import_plan_id, plan_status, payload_sha256, preview_sha256,
            payload_json, summary_json, expires_at,
            expires_at <= UTC_TIMESTAMP(6) AS is_expired
       FROM accounting_import_plans
      WHERE import_plan_id = ? AND owner_person_id = ?
        AND import_kind = 'user_delete'${lock ? " FOR UPDATE" : ""}`,
    [planId, personId],
  );
  if (!rows[0]) throw userDeleteError("User-deletion plan not found.", "USER_DELETE_PLAN_NOT_FOUND", 404);
  return rows[0];
}

export async function previewUserDeletion({ pool, personId, currentPassword }) {
  return withPoolTransaction(pool, async (connection) => {
    await pruneOwnerAccountingImportPlans(connection, personId);
    const user = await loadUser(connection, personId);
    if (!(await verifyPassword(currentPassword, user.OwnerPasscode))) {
      throw userDeleteError("Current password is incorrect.", "INVALID_PASSWORD", 403);
    }
    const counts = await dataCounts(connection, personId);
    const summary = { name: String(user.Name), email: String(user.OwnerEmail), ...counts };
    const payload = { personId: Number(user.person_id), email: String(user.OwnerEmail),
      snapshotSha256: sha256(JSON.stringify(summary)) };
    const preview = { effect: "permanently_delete_user_and_all_owned_accounting_data", ...summary };
    const planId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const payloadJson = JSON.stringify(payload);
    const previewHash = sha256(JSON.stringify(preview));
    await connection.query(
      `INSERT INTO accounting_import_plans
        (import_plan_id, owner_person_id, import_kind, plan_status, source_system,
         payload_sha256, preview_sha256, payload_json, summary_json, expires_at)
       VALUES (?, ?, 'user_delete', 'ready', NULL, ?, ?, ?, ?, ?)`,
      [planId, personId, sha256(payloadJson), previewHash, payloadJson,
        JSON.stringify(summary), expiresAtTimestamp(expiresAt)],
    );
    return { readyToCommit: true, deletionPlanId: planId, status: "ready",
      expiresAt: expiresAt.toISOString(), previewDigest: `sha256:${previewHash}`,
      confirmationText: `DELETE ${user.OwnerEmail}`, summary, preview };
  });
}

export async function commitUserDeletion({ pool, personId, deletionPlanId, previewDigest,
  currentPassword, confirmationText }) {
  const planId = String(deletionPlanId ?? "").trim();
  const suppliedDigest = String(previewDigest ?? "").trim().replace(/^sha256:/, "");
  if (!planId) throw userDeleteError("User-deletion plan not found.", "USER_DELETE_PLAN_NOT_FOUND", 404);
  return withPoolTransaction(pool, async (connection) => {
    const plan = await loadPlan(connection, personId, planId, true);
    if (plan.plan_status !== "ready" || Boolean(plan.is_expired)) {
      throw userDeleteError("User-deletion plan is no longer ready.", "USER_DELETE_PLAN_INVALIDATED");
    }
    if (suppliedDigest !== String(plan.preview_sha256)) {
      throw userDeleteError("The supplied preview digest does not match this deletion plan.", "USER_DELETE_PREVIEW_MISMATCH");
    }
    if (sha256(plan.payload_json) !== String(plan.payload_sha256)) {
      throw userDeleteError("User-deletion plan failed its integrity check.", "USER_DELETE_PLAN_INVALIDATED");
    }
    const payload = parseJson(plan.payload_json, "payload");
    const user = await loadUser(connection, personId, true);
    if (!(await verifyPassword(currentPassword, user.OwnerPasscode))) {
      throw userDeleteError("Current password is incorrect.", "INVALID_PASSWORD", 403);
    }
    const requiredConfirmation = `DELETE ${user.OwnerEmail}`;
    if (confirmationText !== requiredConfirmation) {
      throw userDeleteError(`Type ${requiredConfirmation} exactly to delete this account.`, "USER_DELETE_CONFIRMATION_MISMATCH", 400);
    }
    const counts = await dataCounts(connection, personId, planId);
    const summary = { name: String(user.Name), email: String(user.OwnerEmail), ...counts };
    if (Number(payload.personId) !== Number(personId) || payload.email !== String(user.OwnerEmail)
      || payload.snapshotSha256 !== sha256(JSON.stringify(summary))) {
      throw userDeleteError("Account data changed after the deletion preview.", "USER_DELETE_PLAN_INVALIDATED");
    }

    await connection.query("DELETE FROM accounting_transaction_import_jobs WHERE owner_person_id = ?", [personId]);
    await connection.query(
      `DELETE j FROM lineitems_tags_join j
        JOIN line_items li ON li.line_item_id = j.tagged_line_item_id
        JOIN transactions t ON t.transaction_id = li.transaction_id
       WHERE t.owner_person_id = ?`, [personId],
    );
    await connection.query(
      `DELETE li FROM line_items li JOIN transactions t ON t.transaction_id = li.transaction_id
        WHERE t.owner_person_id = ?`, [personId],
    );
    await connection.query("DELETE FROM xrates WHERE owner_person_id = ?", [personId]);
    await connection.query("UPDATE transactions SET reversal_of_transaction_id = NULL WHERE owner_person_id = ?", [personId]);
    await connection.query("DELETE FROM transactions WHERE owner_person_id = ?", [personId]);
    await connection.query("DELETE FROM account_balance_assertions WHERE owner_person_id = ?", [personId]);
    await connection.query("UPDATE accounts SET parent_account_id = NULL WHERE owner_person_id = ?", [personId]);
    await connection.query("DELETE FROM accounts WHERE owner_person_id = ?", [personId]);
    await connection.query("DELETE FROM tags WHERE owner_person_id = ?", [personId]);
    await connection.query("DELETE FROM currencies WHERE owner_person_id = ?", [personId]);
    await connection.query("DELETE FROM api_tokens WHERE owner_person_id = ?", [personId]);
    await connection.query("DELETE FROM accounting_import_plans WHERE owner_person_id = ?", [personId]);
    const [deletedUser] = await connection.query("DELETE FROM people2_people WHERE person_id = ?", [personId]);
    if (Number(deletedUser.affectedRows) !== 1) throw new Error("User deletion did not remove the account identity.");
    return { status: "committed", deleted: { userCount: 1, ...counts }, confirmation: "account_and_owned_data_deleted" };
  });
}
