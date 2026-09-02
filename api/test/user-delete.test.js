import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-only-jwt-secret";
process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { hashPassword } = await import("../src/auth.js");
const { commitUserDeletion, previewUserDeletion } = await import("../src/user-delete.js");

function userDeletionPool(passwordHash) {
  const counts = { account_count: 4, transaction_count: 3, line_item_count: 7, assertion_count: 1,
    custom_currency_count: 1, tag_count: 2, exchange_rate_count: 0, import_job_count: 1,
    import_item_count: 3, api_token_count: 2, saved_plan_count: 0 };
  const state = {
    user: { person_id: 7, Name: "Ledger Owner", OwnerEmail: "owner@example.com", OwnerPasscode: passwordHash },
    plans: new Map(), deletedTables: [],
  };
  return { state, async getConnection() { return {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params = []) {
      if (sql.startsWith("DELETE FROM accounting_import_plans") && sql.includes("expires_at")) {
        return [{ affectedRows: 0 }];
      }
      if (sql.includes("SELECT person_id") && sql.includes("FROM people2_people WHERE person_id")) {
        return [[state.user].filter(Boolean)];
      }
      if (sql.includes("AS account_count") && sql.includes("AS saved_plan_count")) return [[{ ...counts }]];
      if (sql.includes("INSERT INTO accounting_import_plans")) {
        const [id, owner, payloadHash, previewHash, payload, summary, expiresAt] = params;
        state.plans.set(id, { import_plan_id: id, owner_person_id: owner, import_kind: "user_delete",
          plan_status: "ready", payload_sha256: payloadHash, preview_sha256: previewHash,
          payload_json: payload, summary_json: summary, expires_at: expiresAt, is_expired: 0 });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM accounting_import_plans") && sql.includes("user_delete")) {
        const plan = state.plans.get(params[0]);
        return [[plan && Number(plan.owner_person_id) === Number(params[1]) ? plan : undefined].filter(Boolean)];
      }
      const deletionTargets = ["accounting_transaction_import_jobs", "lineitems_tags_join", "line_items",
        "xrates", "transactions", "account_balance_assertions", "accounts", "tags", "currencies", "api_tokens"];
      const deletionTarget = deletionTargets.find((table) => sql.includes(`DELETE FROM ${table}`)
        || sql.includes(`DELETE j FROM ${table}`) || sql.includes(`DELETE li FROM ${table}`));
      if (deletionTarget) { state.deletedTables.push(deletionTarget); return [{ affectedRows: 1 }]; }
      if (sql.startsWith("UPDATE transactions SET") || sql.startsWith("UPDATE accounts SET")) return [{ affectedRows: 0 }];
      if (sql.startsWith("DELETE FROM accounting_import_plans WHERE owner_person_id")) {
        state.deletedTables.push("accounting_import_plans"); state.plans.clear(); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("DELETE FROM people2_people")) {
        state.deletedTables.push("people2_people"); state.user = null; return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  }; } };
}

test("user deletion requires password plus exact preview confirmation and removes owned data", async () => {
  const password = "correct horse battery staple";
  const pool = userDeletionPool(await hashPassword(password));
  const preview = await previewUserDeletion({ pool, personId: 7, currentPassword: password });
  assert.equal(preview.confirmationText, "DELETE owner@example.com");
  assert.equal(preview.summary.transactionCount, 3);
  assert.equal(preview.summary.accountCount, 4);

  await assert.rejects(commitUserDeletion({ pool, personId: 7, deletionPlanId: preview.deletionPlanId,
    previewDigest: preview.previewDigest, currentPassword: password, confirmationText: "DELETE" }),
  (error) => error.code === "USER_DELETE_CONFIRMATION_MISMATCH");
  assert.notEqual(pool.state.user, null);

  const result = await commitUserDeletion({ pool, personId: 7, deletionPlanId: preview.deletionPlanId,
    previewDigest: preview.previewDigest, currentPassword: password,
    confirmationText: preview.confirmationText });
  assert.equal(result.status, "committed");
  assert.equal(result.deleted.userCount, 1);
  assert.equal(pool.state.user, null);
  assert.equal(pool.state.deletedTables.includes("transactions"), true);
  assert.equal(pool.state.deletedTables.at(-1), "people2_people");
});

test("an incorrect current password cannot create a deletion plan", async () => {
  const pool = userDeletionPool(await hashPassword("right password"));
  await assert.rejects(previewUserDeletion({ pool, personId: 7, currentPassword: "wrong password" }),
    (error) => error.code === "INVALID_PASSWORD" && error.status === 403);
  assert.equal(pool.state.plans.size, 0);
});
