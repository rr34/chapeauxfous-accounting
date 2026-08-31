import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const {
  commitAccountTreeImport,
  getAccountTreeImportPlan,
  importAccountTree,
  previewAccountTreeImport,
} = await import("../src/account-tree.js");
const { createAccountingMcpServer } = await import("../src/mcp.js");

function memoryPool(initialAccounts = []) {
  const state = {
    accounts: structuredClone(initialAccounts),
    currencies: [{
      currency_id: 1, owner_person_id: null, CurrencyAbbreviation: "USD",
      display_name: "USD", currency_type: "iso_4217", scale: 2,
    }],
    nextId: Math.max(0, ...initialAccounts.map((account) => Number(account.account_id))) + 1,
    nextCurrencyId: 2,
    inserts: [],
    plans: new Map(),
    commits: 0,
    rollbacks: 0,
  };
  return {
    state,
    async getConnection() {
      const accountSnapshot = structuredClone(state.accounts);
      const currencySnapshot = structuredClone(state.currencies);
      return {
        async beginTransaction() {},
        async commit() { state.commits += 1; },
        async rollback() {
          state.rollbacks += 1;
          state.accounts = accountSnapshot;
          state.currencies = currencySnapshot;
        },
        release() {},
        async query(sql, params = []) {
          if (sql.startsWith("DELETE FROM accounting_import_plans")) return [{ affectedRows: 0 }];
          if (sql.includes("INSERT INTO accounting_import_plans")) {
            const [planId, ownerPersonId, payloadSha256, previewSha256, payloadJson,
              summaryJson, expiresAt] = params;
            state.plans.set(planId, { import_plan_id: planId, owner_person_id: ownerPersonId,
              import_kind: "account_tree", plan_status: "ready", payload_sha256: payloadSha256,
              preview_sha256: previewSha256, payload_json: payloadJson, summary_json: summaryJson,
              expires_at: expiresAt, committed_at: null, invalidated_at: null,
              invalidation_code: null, result_json: null, is_expired: 0 });
            return [{ insertId: 0 }];
          }
          if (sql.includes("FROM accounting_import_plans")) {
            const [planId, ownerPersonId] = params;
            const plan = state.plans.get(planId);
            return [[plan && Number(plan.owner_person_id) === Number(ownerPersonId) ? plan : undefined].filter(Boolean)];
          }
          if (sql.includes("UPDATE accounting_import_plans")) {
            const committing = sql.includes("plan_status = 'committed'");
            const [resultJson, planId, ownerPersonId] = committing ? params : [null, ...params];
            const plan = state.plans.get(planId);
            if (plan && Number(plan.owner_person_id) === Number(ownerPersonId)) {
              if (committing) {
                plan.plan_status = "committed";
                plan.committed_at = "now";
                plan.result_json = resultJson;
              } else {
                plan.plan_status = "invalidated";
                plan.invalidated_at = "now";
                plan.invalidation_code = sql.includes("PAYLOAD_INTEGRITY_FAILURE")
                  ? "PAYLOAD_INTEGRITY_FAILURE" : "DATABASE_STATE_CHANGED";
              }
            }
            return [{ affectedRows: plan ? 1 : 0 }];
          }
          if (sql.includes("FROM currencies")) {
            return [state.currencies.filter((currency) =>
              currency.owner_person_id == null || Number(currency.owner_person_id) === 7)];
          }
          if (sql.includes("INSERT INTO currencies")) {
            const [owner, scopeOwner, code, displayName, type, scale] = params;
            const row = {
              currency_id: state.nextCurrencyId++, owner_person_id: owner,
              scope_owner_person_id: scopeOwner,
              CurrencyAbbreviation: code, display_name: displayName, currency_type: type, scale,
            };
            state.currencies.push(row);
            return [{ insertId: row.currency_id }];
          }
          if (sql.includes("FROM accounts a")) {
            return [state.accounts.map((account) => ({
              ...account,
              CurrencyAbbreviation: state.currencies.find((currency) =>
                Number(currency.currency_id) === Number(account.account_currency_id))?.CurrencyAbbreviation,
            }))];
          }
          if (sql.includes("INSERT INTO accounts")) {
            const [owner, name, description, placeholder, parentId, type, currencyId, sourceSystem, sourceId] = params;
            const row = {
              account_id: state.nextId++,
              owner_person_id: owner,
              AccountName: name,
              description,
              is_placeholder: placeholder,
              parent_account_id: parentId,
              AccountType: type,
              account_currency_id: currencyId,
              archived_at: null,
              source_system: sourceSystem,
              source_id: sourceId,
            };
            state.accounts.push(row);
            state.inserts.push(row);
            return [{ insertId: row.account_id }];
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },
  };
}

const tree = [
  { fullName: "Assets:Bank:Checking", type: "asset", currencyCode: "usd", description: "Daily account" },
  { fullName: "Assets", type: "asset", currencyCode: "USD", placeholder: true },
  { fullName: "Assets:Bank", type: "asset", currencyCode: "USD", placeholder: true },
];

test("account-tree import sorts parents, preserves metadata, and is retry-safe", async () => {
  const pool = memoryPool();
  const first = await importAccountTree({ pool, personId: 7, accounts: tree, dryRun: false });
  assert.equal(first.createdCount, 3);
  assert.deepEqual(pool.state.inserts.map((account) => account.AccountName), ["Assets", "Bank", "Checking"]);
  assert.equal(pool.state.inserts[1].parent_account_id, pool.state.inserts[0].account_id);
  assert.equal(pool.state.inserts[2].parent_account_id, pool.state.inserts[1].account_id);
  assert.equal(pool.state.inserts[0].is_placeholder, true);
  assert.equal(pool.state.inserts[2].description, "Daily account");

  const second = await importAccountTree({ pool, personId: 7, accounts: tree, dryRun: false });
  assert.equal(second.createdCount, 0);
  assert.equal(second.existingCount, 3);
  assert.equal(pool.state.inserts.length, 3);

  const retryPreview = await importAccountTree({ pool, personId: 7, accounts: tree, dryRun: true });
  assert.equal(retryPreview.wouldCreateAccountCount, 0);
  assert.equal(retryPreview.wouldReuseAccountCount, 3);
  assert.deepEqual(retryPreview.accountSummary.byStatus, { planned: 0, existing: 3, created: 0 });
});

test("dry-run validates the complete tree without inserting", async () => {
  const pool = memoryPool();
  const result = await importAccountTree({ pool, personId: 7, accounts: tree, dryRun: true });
  assert.equal(result.plannedCount, 3);
  assert.equal(result.createdCount, 0);
  assert.equal(result.wouldCreateAccountCount, 3);
  assert.equal(result.wouldReuseAccountCount, 0);
  assert.equal(result.wouldCreateCurrencyCount, 0);
  assert.deepEqual(result.accountSummary, {
    byStatus: { planned: 3, existing: 0, created: 0 },
    byAccountType: { asset: 3 },
    byCurrencyCode: { USD: 3 },
    byPlaceholderStatus: { placeholder: 2, postable: 1 },
    byTopLevelBranch: { Assets: 3 },
  });
  assert.deepEqual(result.accounts[2], {
    fullName: "Assets:Bank:Checking",
    accountType: "asset",
    currencyCode: "USD",
    description: "Daily account",
    placeholder: false,
    parentFullName: "Assets:Bank",
    topLevelBranch: "Assets",
    status: "planned",
    accountId: null,
  });
  assert.equal(pool.state.inserts.length, 0);
});

test("account-tree preview returns a durable plan and repeated commit is idempotent", async () => {
  const pool = memoryPool();
  const preview = await previewAccountTreeImport({ pool, personId: 7, accounts: tree });
  assert.equal(preview.readyToCommit, true);
  assert.match(preview.importPlanId, /^[0-9a-f-]{36}$/);
  assert.equal(preview.status, "ready");
  assert.match(preview.expiresAt, /Z$/);
  assert.match(preview.previewDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(preview.summary, {
    accountsCreated: 3, accountsReused: 0, currenciesCreated: 0, currenciesReused: 1, rejectedRows: 0,
  });
  assert.equal(preview.preview.wouldCreateAccountCount, 3);
  assert.equal(pool.state.inserts.length, 0);

  const ready = await getAccountTreeImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.deepEqual(ready, {
    readyToCommit: true,
    status: "ready",
    importPlanId: preview.importPlanId,
    expiresAt: preview.expiresAt,
    previewDigest: preview.previewDigest,
    summary: preview.summary,
  });

  await assert.rejects(
    commitAccountTreeImport({ pool, personId: 8, importPlanId: preview.importPlanId }),
    (error) => error.code === "IMPORT_PLAN_NOT_FOUND",
  );

  const committed = await commitAccountTreeImport({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.equal(committed.status, "committed");
  assert.equal(committed.commitResult.createdCount, 3);
  assert.equal(pool.state.inserts.length, 3);

  const repeated = await commitAccountTreeImport({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.deepEqual(repeated, committed);
  assert.equal(pool.state.inserts.length, 3);

  const committedStatus = await getAccountTreeImportPlan({ pool, personId: 7, importPlanId: preview.importPlanId });
  assert.equal(committedStatus.status, "committed");
  assert.deepEqual(committedStatus.commitResult, committed.commitResult);
});

test("account-tree plans report expired, invalidated, missing, and state-conflict outcomes", async () => {
  const missingPool = memoryPool();
  await assert.rejects(
    commitAccountTreeImport({ pool: missingPool, personId: 7,
      importPlanId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    (error) => error.code === "IMPORT_PLAN_NOT_FOUND" && error.requiredAction === "RUN_NEW_DRY_RUN",
  );

  const expiredPool = memoryPool();
  const expiredPreview = await previewAccountTreeImport({ pool: expiredPool, personId: 7, accounts: tree });
  expiredPool.state.plans.get(expiredPreview.importPlanId).is_expired = 1;
  const expiredStatus = await getAccountTreeImportPlan({
    pool: expiredPool, personId: 7, importPlanId: expiredPreview.importPlanId,
  });
  assert.equal(expiredStatus.status, "expired");
  await assert.rejects(
    commitAccountTreeImport({ pool: expiredPool, personId: 7, importPlanId: expiredPreview.importPlanId }),
    (error) => error.code === "IMPORT_PLAN_EXPIRED",
  );
  assert.equal(expiredPool.state.inserts.length, 0);

  const invalidatedPool = memoryPool();
  const invalidatedPreview = await previewAccountTreeImport({
    pool: invalidatedPool,
    personId: 7,
    currencies: [{ code: "VTSAX", displayName: "Vanguard Fund", type: "security", scale: 4 }],
    accounts: [
      { fullName: "Assets", type: "asset", currencyCode: "USD", placeholder: true },
      { fullName: "Assets:VTSAX", type: "asset", currencyCode: "VTSAX" },
    ],
  });
  invalidatedPool.state.accounts.push({ account_id: 99, owner_person_id: 7, AccountName: "Assets",
    description: "conflict", is_placeholder: 0, parent_account_id: null, AccountType: "asset",
    account_currency_id: 1, archived_at: null });
  await assert.rejects(
    commitAccountTreeImport({ pool: invalidatedPool, personId: 7, importPlanId: invalidatedPreview.importPlanId }),
    (error) => error.code === "IMPORT_PLAN_INVALIDATED",
  );
  assert.equal(invalidatedPool.state.inserts.length, 0);
  assert.equal(invalidatedPool.state.currencies.length, 1);
  const invalidatedStatus = await getAccountTreeImportPlan({
    pool: invalidatedPool, personId: 7, importPlanId: invalidatedPreview.importPlanId,
  });
  assert.equal(invalidatedStatus.status, "invalidated");

  const conflictPool = memoryPool();
  const conflictPreview = await previewAccountTreeImport({ pool: conflictPool, personId: 7, accounts: tree });
  const conflictPlan = conflictPool.state.plans.get(conflictPreview.importPlanId);
  conflictPlan.plan_status = "committed";
  conflictPlan.committed_at = "now";
  await assert.rejects(
    commitAccountTreeImport({ pool: conflictPool, personId: 7, importPlanId: conflictPreview.importPlanId }),
    (error) => error.code === "IMPORT_PLAN_STATE_CONFLICT",
  );
});

test("an account-tree plan survives a new MCP connection and unrelated tool call", async () => {
  const pool = memoryPool();
  const services = {
    async listCurrencies() { return [{ id: 1, code: "USD", displayName: "US Dollar", type: "iso_4217", scale: 2 }]; },
  };

  const firstServer = createAccountingMcpServer({ personId: 7, pool, services });
  const firstClient = new Client({ name: "first-plan-client", version: "1.0.0" });
  const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();
  await firstServer.connect(firstServerTransport);
  await firstClient.connect(firstClientTransport);
  const dryRun = await firstClient.callTool({
    name: "import_account_tree",
    arguments: {
      accounts: tree.map((account) => ({
        full_name: account.fullName,
        account_type: account.type,
        currency_code: account.currencyCode,
        description: account.description,
        placeholder: account.placeholder ?? false,
      })),
      dry_run: true,
    },
  });
  assert.match(dryRun.structuredContent.nextAction.instruction, /^Commit this account-tree import now\?/);
  const planId = dryRun.structuredContent.importPlanId;
  const blocked = await firstClient.callTool({
    name: "import_account_tree",
    arguments: {
      accounts: [
        { full_name: "Assets", account_type: "asset", currency_code: "USD", placeholder: true },
        { full_name: "Assets", account_type: "asset", currency_code: "USD", placeholder: true },
      ],
      dry_run: true,
    },
  });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.status, "blocked");
  assert.equal(blocked.structuredContent.code, "DUPLICATE_ACCOUNT_PATH");
  assert.equal(blocked.structuredContent.requiredAction, "CORRECT_INPUT_AND_RUN_NEW_DRY_RUN");
  assert.equal(blocked.structuredContent.nextAction.tool, "import_account_tree");
  assert.equal(blocked.structuredContent.retry.protocol, "agent-slayer.retry-descriptor");
  assert.equal(blocked.structuredContent.retry.preserve_complete_original_batch, true);
  await firstClient.close();
  await firstServer.close();

  const secondServer = createAccountingMcpServer({ personId: 7, pool, services });
  const secondClient = new Client({ name: "second-plan-client", version: "1.0.0" });
  const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
  await secondServer.connect(secondServerTransport);
  await secondClient.connect(secondClientTransport);
  await secondClient.callTool({ name: "list_currencies", arguments: {} });
  const status = await secondClient.callTool({
    name: "get_account_tree_import_plan", arguments: { import_plan_id: planId },
  });
  assert.equal(status.structuredContent.status, "ready");
  const committed = await secondClient.callTool({
    name: "commit_account_tree_import", arguments: { import_plan_id: planId },
  });
  assert.equal(committed.structuredContent.status, "committed");
  assert.equal(committed.structuredContent.commitResult.createdCount, 3);
  await secondClient.close();
  await secondServer.close();
});

test("account-tree import atomically creates explicit user-owned securities", async () => {
  const pool = memoryPool();
  const input = {
    pool,
    personId: 7,
    currencies: [{ code: "vtsax", displayName: "Vanguard Total Stock Market Index Fund", type: "security", scale: 4 }],
    accounts: [
      { fullName: "Assets", type: "asset", currencyCode: "USD", placeholder: true },
      { fullName: "Assets:Investments", type: "asset", currencyCode: "USD", placeholder: true },
      { fullName: "Assets:Investments:VTSAX", type: "asset", currencyCode: "VTSAX" },
    ],
    dryRun: false,
  };
  const preview = await importAccountTree({ ...input, dryRun: true });
  assert.equal(preview.wouldCreateCurrencyCount, 1);
  assert.equal(preview.wouldCreateAccountCount, 3);
  assert.equal(preview.currencies[0].status, "planned");

  const result = await importAccountTree(input);
  assert.equal(result.currencyCreatedCount, 1);
  assert.equal(result.createdCount, 3);
  assert.equal(pool.state.currencies[1].CurrencyAbbreviation, "VTSAX");
  assert.equal(pool.state.currencies[1].currency_type, "security");
  assert.equal(pool.state.inserts[2].account_currency_id, pool.state.currencies[1].currency_id);

  const retryPreview = await importAccountTree({ ...input, dryRun: true });
  assert.equal(retryPreview.wouldReuseCurrencyCount, 1);
  assert.equal(retryPreview.wouldReuseAccountCount, 3);

  const retry = await importAccountTree(input);
  assert.equal(retry.currencyExistingCount, 1);
  assert.equal(retry.currencyCreatedCount, 0);
  assert.equal(retry.createdCount, 0);
});

test("a missing parent rolls back the atomic import", async () => {
  const pool = memoryPool();
  await assert.rejects(
    importAccountTree({
      pool,
      personId: 7,
      accounts: [
        { fullName: "Assets", type: "asset", currencyCode: "USD" },
        { fullName: "Liabilities:Cards:Visa", type: "liability", currencyCode: "USD" },
      ],
      dryRun: false,
    }),
    (error) => error.code === "MISSING_PARENT_ACCOUNT",
  );
  assert.equal(pool.state.accounts.length, 0);
  assert.equal(pool.state.rollbacks, 1);
});

test("an existing path must match every imported field", async () => {
  const pool = memoryPool([{
    account_id: 4,
    AccountName: "Assets",
    description: null,
    is_placeholder: 1,
    parent_account_id: null,
    AccountType: "asset",
    account_currency_id: 1,
    archived_at: null,
  }]);
  await assert.rejects(
    importAccountTree({
      pool,
      personId: 7,
      accounts: [{ fullName: "Assets", type: "asset", currencyCode: "USD", placeholder: false }],
      dryRun: true,
    }),
    (error) => error.code === "ACCOUNT_PATH_CONFLICT" && error.details.differingFields.includes("placeholder"),
  );
});
