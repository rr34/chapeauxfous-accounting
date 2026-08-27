import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { commitAccountDeletion, getAccountDeletionPlan, previewAccountDeletion } = await import("../src/account-delete.js");

function deletionPool() {
  const state = {
    account: { account_id: 12, owner_person_id: 7, AccountName: "Unused" },
    plans: new Map(),
  };
  return {
    state,
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params = []) {
          if (sql.includes("INSERT INTO accounting_import_plans")) {
            const [id, owner, payloadHash, previewHash, payload, summary, expiresAt] = params;
            state.plans.set(id, { import_plan_id: id, owner_person_id: owner, import_kind: "account_delete",
              plan_status: "ready", payload_sha256: payloadHash, preview_sha256: previewHash,
              payload_json: payload, summary_json: summary, expires_at: expiresAt, committed_at: null,
              invalidated_at: null, invalidation_code: null, result_json: null, is_expired: 0 });
            return [{ insertId: 0 }];
          }
          if (sql.includes("FROM accounting_import_plans")) {
            const [id, owner] = params;
            const plan = state.plans.get(id);
            return [[plan && Number(plan.owner_person_id) === Number(owner) ? plan : undefined].filter(Boolean)];
          }
          if (sql.includes("UPDATE accounting_import_plans")) {
            const committing = sql.includes("plan_status = 'committed'");
            const [resultJson, id, owner] = committing ? params : [null, ...params];
            const plan = state.plans.get(id);
            if (plan && Number(plan.owner_person_id) === Number(owner)) {
              plan.plan_status = committing ? "committed" : "invalidated";
              plan.committed_at = committing ? "now" : null;
              plan.result_json = resultJson;
            }
            return [{ affectedRows: plan ? 1 : 0 }];
          }
          if (sql.includes("SELECT account_id, AccountName") && sql.includes("FROM accounts")) {
            const [id, owner] = params;
            return [[state.account && Number(state.account.account_id) === Number(id)
              && Number(state.account.owner_person_id) === Number(owner) ? state.account : undefined].filter(Boolean)];
          }
          if (sql.includes("FROM accounts WHERE parent_account_id")) return [[]];
          if (sql.includes("FROM line_items WHERE account_id")) return [[]];
          if (sql.includes("FROM account_balance_assertions WHERE account_id")) return [[]];
          if (sql.startsWith("DELETE FROM accounts")) {
            const [id, owner] = params;
            const matches = state.account && Number(state.account.account_id) === Number(id)
              && Number(state.account.owner_person_id) === Number(owner);
            if (matches) state.account = null;
            return [{ affectedRows: matches ? 1 : 0 }];
          }
          if (sql.includes("SELECT account_id FROM accounts WHERE account_id")) return [state.account ? [state.account] : []];
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },
  };
}

test("account deletion requires a durable preview and verifies absence after commit", async () => {
  const pool = deletionPool();
  const preview = await previewAccountDeletion({ pool, personId: 7, accountId: 12 });
  assert.equal(preview.status, "ready");
  assert.equal(preview.summary.accountName, "Unused");
  assert.match(preview.previewDigest, /^sha256:/);

  const status = await getAccountDeletionPlan({ pool, personId: 7, deletionPlanId: preview.deletionPlanId });
  assert.equal(status.readyToCommit, true);

  const committed = await commitAccountDeletion({ pool, personId: 7, deletionPlanId: preview.deletionPlanId });
  assert.equal(committed.status, "committed");
  assert.equal(committed.verifiedAbsent, true);
  assert.equal(pool.state.account, null);

  const retry = await commitAccountDeletion({ pool, personId: 7, deletionPlanId: preview.deletionPlanId });
  assert.equal(retry.alreadyCommitted, true);
});

test("account deletion persists invalidation when its stored payload fails verification", async () => {
  const pool = deletionPool();
  const preview = await previewAccountDeletion({ pool, personId: 7, accountId: 12 });
  pool.state.plans.get(preview.deletionPlanId).payload_json += " ";

  await assert.rejects(
    commitAccountDeletion({ pool, personId: 7, deletionPlanId: preview.deletionPlanId }),
    (error) => error.code === "ACCOUNT_DELETE_PLAN_INVALIDATED",
  );
  const status = await getAccountDeletionPlan({ pool, personId: 7, deletionPlanId: preview.deletionPlanId });
  assert.equal(status.status, "invalidated");
  assert.equal(pool.state.account.account_id, 12);
});
