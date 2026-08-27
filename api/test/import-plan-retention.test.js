import test from "node:test";
import assert from "node:assert/strict";

const {
  ACCOUNTING_IMPORT_PLAN_RETENTION_HOURS,
  pruneOwnerAccountingImportPlans,
} = await import("../src/import-plan-retention.js");

test("plan retention prunes only the owner's terminal or long-expired plans after 48 hours", async () => {
  let observed;
  const connection = {
    async query(sql, params) {
      observed = { sql, params };
      return [{ affectedRows: 3 }];
    },
  };

  const result = await pruneOwnerAccountingImportPlans(connection, 7);
  assert.equal(ACCOUNTING_IMPORT_PLAN_RETENTION_HOURS, 48);
  assert.equal(result.deletedPlanCount, 3);
  assert.deepEqual(observed.params, [7]);
  assert.match(observed.sql, /owner_person_id = \?/);
  assert.match(observed.sql, /plan_status = 'committed'/);
  assert.match(observed.sql, /plan_status = 'invalidated'/);
  assert.match(observed.sql, /plan_status = 'ready'/);
  assert.equal((observed.sql.match(/INTERVAL 48 HOUR/g) ?? []).length, 3);
});

test("plan retention rejects an invalid owner scope", async () => {
  await assert.rejects(
    pruneOwnerAccountingImportPlans({ query: async () => [{ affectedRows: 0 }] }, null),
    /valid plan owner/,
  );
});
