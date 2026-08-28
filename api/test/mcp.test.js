import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { createAccountingMcpHandler, createAccountingMcpServer } = await import("../src/mcp.js");
const { extractDeferredActionReference } = await import(
  "../../../agent-chapeaux-fous/src/deferred-actions.mjs"
);

test("the MCP exposes scoped tools with schema-semantic projections", async () => {
  const seen = [];
  let imported;
  let committedAccountPlan;
  let readAccountPlan;
  let importedTransactions;
  let committedTransactionPlan;
  let previewedTransactionDeletion;
  let committedTransactionDeletion;
  let createdCurrency;
  const transactionImportFixture = ({ status, readyToCommit, ledgerChanged, importPlanId, transactionCount = 1 }) => ({
    status,
    dryRun: !ledgerChanged,
    ledgerChanged,
    readyToCommit,
    importPlanId,
    importPlanExpiresAt: importPlanId ? "2026-08-25T18:42:00.000Z" : null,
    sourceSystem: "source_app",
    submittedTransactionCount: transactionCount,
    uniqueTransactionCount: transactionCount,
    duplicateInputTransactionCount: 0,
    submittedLineItemCount: transactionCount * 2,
    wouldCreateTransactionCount: ledgerChanged ? 0 : transactionCount,
    wouldReuseTransactionCount: 0,
    wouldCreateLineItemCount: ledgerChanged ? 0 : transactionCount * 2,
    wouldReuseLineItemCount: 0,
    createdTransactionCount: ledgerChanged ? transactionCount : 0,
    reusedTransactionCount: 0,
    createdLineItemCount: ledgerChanged ? transactionCount * 2 : 0,
    reusedLineItemCount: 0,
    rejectedTransactionCount: 0,
    rejectedLineItemCount: 0,
    unknownAccountPaths: [],
    ambiguousAccountPaths: [],
    transactionSummary: {
      byStatus: { planned: ledgerChanged ? 0 : transactionCount, existing: 0,
        created: ledgerChanged ? transactionCount : 0, rejected: 0 },
      byValuationCurrency: { USD: transactionCount },
      byYear: { 2026: transactionCount },
    },
    lineItemSummary: { byAccountCurrency: { USD: transactionCount * 2 }, byTopLevelBranch: { Assets: transactionCount } },
    transactions: [{ externalId: "tx-1", transactionDate: "2026-01-01", description: "Test",
      valuationCurrencyCode: "USD", lineItemCount: 2, status: ledgerChanged ? "created" : "planned",
      transactionId: ledgerChanged ? 91 : null, errors: [] }],
  });
  const services = {
    async listCurrencies(_pool, personId) {
      seen.push(`currencies:${personId}`);
      return [
        { id: 2, code: "BTC", displayName: "Bitcoin", type: "crypto", scale: 8, ownerPersonId: 7, userDefined: true },
        { id: 1, code: "USD", displayName: "US Dollar", type: "iso_4217", scale: 2, ownerPersonId: null, userDefined: false },
      ];
    },
    async createCurrency(input) {
      createdCurrency = input;
      return { id: 12, code: input.code, displayName: input.displayName, type: input.type, scale: input.scale,
        ownerPersonId: input.personId, userDefined: true };
    },
    async getCurrency(_pool, personId, currencyId) {
      return { id: Number(currencyId), code: "VTSAX", displayName: "Vanguard Total Stock Market Index Fund Admiral Shares",
        type: "security", scale: 4, ownerPersonId: personId, userDefined: true };
    },
    async listAccounts(_pool, personId) {
      seen.push(personId);
      return [{ id: 10, name: "Wallet", description: null, placeholder: false, parentAccountId: null,
        type: "asset", currencyId: 1, currencyCode: "USD", scale: 2, balanceUnits: "123", archivedAt: null }];
    },
    async importAccountTree(input) {
      imported = input;
      return {
        readyToCommit: true,
        importPlanId: "11111111-1111-4111-8111-111111111111",
        status: "ready",
        expiresAt: "2026-08-25T18:42:00.000Z",
        previewDigest: `sha256:${"a".repeat(64)}`,
        summary: { accountsCreated: 1, accountsReused: 0, currenciesCreated: 1, currenciesReused: 0, rejectedRows: 0 },
        preview: {
          dryRun: true, ledgerChanged: false, totalCount: input.accounts.length,
          createdCount: 0, existingCount: 0, plannedCount: input.accounts.length,
          currencyCreatedCount: 0, currencyExistingCount: 0, currencyPlannedCount: 1,
          wouldCreateAccountCount: input.accounts.length, wouldReuseAccountCount: 0,
          wouldCreateCurrencyCount: 1, wouldReuseCurrencyCount: 0,
          accountSummary: {
            byStatus: { planned: input.accounts.length, existing: 0, created: 0 },
            byAccountType: { asset: input.accounts.length }, byCurrencyCode: { USD: input.accounts.length },
            byPlaceholderStatus: { placeholder: input.accounts.filter((account) => account.placeholder).length,
              postable: input.accounts.filter((account) => !account.placeholder).length },
            byTopLevelBranch: { Assets: input.accounts.length },
          },
          currencies: [{ id: null, ownerPersonId: 7, userDefined: true, code: "VTSAX",
            displayName: "Vanguard Total Stock Market Index Fund Admiral Shares", type: "security", scale: 4,
            status: "planned" }],
          accounts: input.accounts.map((account) => ({
            fullName: account.fullName, accountType: account.type, currencyCode: account.currencyCode,
            description: account.description ?? null, placeholder: account.placeholder,
            parentFullName: account.fullName.includes(":") ? account.fullName.split(":").slice(0, -1).join(":") : null,
            topLevelBranch: account.fullName.split(":")[0], status: "planned", accountId: null,
          })),
        },
      };
    },
    async commitAccountTreeImport(input) {
      committedAccountPlan = input;
      if (input.importPlanId.startsWith("3333")) {
        throw Object.assign(new Error("expired"), { code: "IMPORT_PLAN_EXPIRED" });
      }
      if (input.importPlanId.startsWith("4444")) {
        throw Object.assign(new Error("state conflict"), { code: "IMPORT_PLAN_STATE_CONFLICT" });
      }
      return {
        readyToCommit: false,
        importPlanId: input.importPlanId,
        status: "committed",
        expiresAt: "2026-08-25T18:42:00.000Z",
        previewDigest: `sha256:${"a".repeat(64)}`,
        summary: { accountsCreated: 1, accountsReused: 0, currenciesCreated: 1, currenciesReused: 0, rejectedRows: 0 },
        commitResult: { createdCount: 1 },
      };
    },
    async getAccountTreeImportPlan(input) {
      readAccountPlan = input;
      if (input.importPlanId.startsWith("2222")) {
        throw Object.assign(new Error("not found"), { code: "IMPORT_PLAN_NOT_FOUND" });
      }
      return {
        readyToCommit: true,
        importPlanId: input.importPlanId,
        status: "ready",
        expiresAt: "2026-08-25T18:42:00.000Z",
        previewDigest: `sha256:${"a".repeat(64)}`,
        summary: { accountsCreated: 1, accountsReused: 0, currenciesCreated: 1, currenciesReused: 0, rejectedRows: 0 },
      };
    },
    async previewTransactionImport(input) {
      importedTransactions = input;
      return transactionImportFixture({ status: "ready", readyToCommit: true, ledgerChanged: false,
        importPlanId: "11111111-1111-4111-8111-111111111111", transactionCount: input.transactions.length });
    },
    async commitTransactionImportPlan(input) {
      committedTransactionPlan = input;
      return { ...transactionImportFixture({ status: "committed", readyToCommit: false, ledgerChanged: true,
        importPlanId: input.importPlanId }), committed: true, alreadyCommitted: false,
        expiresAt: "2026-08-25T18:42:00.000Z", previewDigest: `sha256:${"b".repeat(64)}`,
        summary: { transactionsCreated: 1, transactionsReused: 0, lineItemsCreated: 2,
          lineItemsReused: 0, rejectedTransactions: 0 } };
    },
    async getTransactionImportPlan(input) {
      const commitResult = { ...transactionImportFixture({
        status: "committed", readyToCommit: false, ledgerChanged: true, importPlanId: input.importPlanId,
      }), committed: true, alreadyCommitted: true };
      return {
        readyToCommit: false,
        status: "committed",
        importPlanId: input.importPlanId,
        expiresAt: "2026-08-25T18:42:00.000Z",
        previewDigest: `sha256:${"b".repeat(64)}`,
        summary: { transactionsCreated: 1, transactionsReused: 0, lineItemsCreated: 2,
          lineItemsReused: 0, rejectedTransactions: 0 },
        commitResult,
        alreadyCommitted: true,
      };
    },
    async previewTransactionDeletion(input) {
      previewedTransactionDeletion = input;
      const summary = { scope: input.scope, transactionCount: 13, lineItemCount: 31,
        exchangeRateCount: 0, tagAssignmentCount: 0, affectedAccountCount: 9,
        transactionStates: { draft: 0, posted: 13, voided: 0 },
        dateRange: { first: "2025-04-11", last: "2026-07-29" } };
      return { readyToCommit: true, deletionPlanId: "55555555-5555-4555-8555-555555555555",
        status: "ready", expiresAt: "2026-08-27T23:35:00.000Z", previewDigest: `sha256:${"c".repeat(64)}`,
        summary, preview: { ...summary, targetDigest: `sha256:${"d".repeat(64)}`,
          effect: "permanently_delete_exact_transactions_and_dependent_postings",
          accountsPreserved: true, accountTreeChanged: false } };
    },
    async refreshTransactionDeletionPlan(input) {
      return this.previewTransactionDeletion({ ...input, scope: "all" });
    },
    async getTransactionDeletionPlan(input) {
      return { readyToCommit: false, deletionPlanId: input.deletionPlanId, status: "invalidated",
        expiresAt: "2026-08-27T23:35:00.000Z", previewDigest: `sha256:${"c".repeat(64)}`,
        invalidationCode: "DATABASE_STATE_CHANGED",
        summary: { scope: "all", transactionCount: 13, lineItemCount: 31,
          exchangeRateCount: 0, tagAssignmentCount: 0, affectedAccountCount: 9,
          transactionStates: { draft: 0, posted: 13, voided: 0 },
          dateRange: { first: "2025-04-11", last: "2026-07-29" } } };
    },
    async commitTransactionDeletion(input) {
      if (input.previewDigest === `sha256:${"0".repeat(64)}`) {
        throw Object.assign(new Error("The supplied preview digest does not match this deletion plan."), {
          code: "TRANSACTION_DELETE_PREVIEW_MISMATCH", status: 409,
        });
      }
      committedTransactionDeletion = input;
      return { readyToCommit: false, deletionPlanId: input.deletionPlanId, status: "committed",
        expiresAt: "2026-08-27T23:35:00.000Z", previewDigest: input.previewDigest,
        summary: { scope: "all", transactionCount: 13, lineItemCount: 31,
          exchangeRateCount: 0, tagAssignmentCount: 0, affectedAccountCount: 9,
          transactionStates: { draft: 0, posted: 13, voided: 0 },
          dateRange: { first: "2025-04-11", last: "2026-07-29" } },
        deleted: { transactionCount: 13, lineItemCount: 31, exchangeRateCount: 0, tagAssignmentCount: 0 },
        importReferences: { deletedAuditReferences: 0, reopenedImportJobs: 0 },
        verification: { targetTransactionsAbsent: true, accountTreeUnchanged: true, accountCount: 273 },
        alreadyCommitted: false };
    },
  };
  const server = createAccountingMcpServer({ personId: 7, pool: {}, services });
  assert.equal(server.server.getCapabilities().tools.listChanged, true);
  const client = new Client({ name: "accounting-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "describe_accounting_schema"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "create_transaction"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_account_tree_import"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_account_tree_import_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "import_transactions"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_transaction_import"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_transaction_import_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_transaction_import_schema"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "create_transaction_import_job"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "stage_transaction_import_artifact"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "stage_transaction_import_chunk"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "retry_transaction_import_exception"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_transaction_import_job"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "list_transaction_import_exceptions"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "preview_transaction_import_job"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_transaction_import_job"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "preview_delete_transactions"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "refresh_transaction_delete_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_transaction_delete_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_delete_transactions"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "update_account"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "preview_delete_account"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_account_delete_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_delete_account"), true);
  assert.equal(tools.tools.every((tool) => tool.outputSchema?.type === "object"), true);
  assert.equal(tools.tools.every((tool) => ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]
    .every((annotation) => typeof tool.annotations?.[annotation] === "boolean")), true);
  assert.equal(tools.tools.find((tool) => tool.name === "list_accounts").annotations.readOnlyHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "create_account").annotations.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "create_currency").annotations.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "import_account_tree").annotations.idempotentHint, false);
  assert.match(tools.tools.find((tool) => tool.name === "create_currency").description, /Never guess or choose a default scale/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /even when new currency details or scales are unknown/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /entire intended batch/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /status=needs_input/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /numerical created\/reused summaries/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /nextAction\.onApproval/);
  assert.match(tools.tools.find((tool) => tool.name === "commit_account_tree_import").description, /only import_plan_id/);
  const accountTreeOutputSchema = tools.tools.find((tool) => tool.name === "import_account_tree").outputSchema;
  assert.match(JSON.stringify(accountTreeOutputSchema), /readyToCommit/);
  assert.match(JSON.stringify(accountTreeOutputSchema), /previewDigest/);
  assert.match(JSON.stringify(accountTreeOutputSchema), /expiresAt/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /source-neutral/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /unknown or ambiguous paths/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /does not parse CSV/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /confirm each plan sequentially/);
  assert.equal(
    tools.tools.find((tool) => tool.name === "import_transactions").inputSchema.properties.transactions.maxItems,
    1000,
  );
  assert.equal(tools.tools.find((tool) => tool.name === "commit_transaction_import").annotations.idempotentHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "stage_transaction_import_chunk").annotations.idempotentHint, true);
  const artifactImportTool = tools.tools.find((tool) => tool.name === "stage_transaction_import_artifact");
  assert.equal(artifactImportTool.annotations.idempotentHint, true);
  assert.deepEqual(artifactImportTool._meta["agent-slayer/artifactUpload"], {
    contractVersion: 1,
    transportId: "transaction_import",
    endpointPath: "/mcp/artifacts",
    acceptedMediaTypes: ["application/x-ndjson"],
    maximumChunkBytes: 1024 * 1024,
    maximumBytes: 64 * 1024 * 1024,
  });
  assert.equal(artifactImportTool._meta["agent-slayer/artifactInput"], undefined);
  assert.match(artifactImportTool.description, /without placing its records or transport chunks in model context/);
  assert.equal(tools.tools.find((tool) => tool.name === "retry_transaction_import_exception").annotations.idempotentHint, true);
  assert.match(tools.tools.find((tool) => tool.name === "stage_transaction_import_chunk").description,
    /expected_source_records = newly_staged_records \+ previously_staged_or_reused_records \+ exception_records \+ remaining_records/);
  assert.equal(tools.tools.find((tool) => tool.name === "import_transactions").annotations.idempotentHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "commit_delete_account").annotations.destructiveHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "commit_delete_transactions").annotations.destructiveHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "commit_delete_transactions").annotations.idempotentHint, true);
  assert.match(tools.tools.find((tool) => tool.name === "preview_delete_transactions").description,
    /freezes the exact current owner-scoped transaction IDs/);
  assert.match(tools.tools.find((tool) => tool.name === "commit_delete_transactions").description,
    /verifies absence and account-tree identity/);
  const deletionPreviewInput = tools.tools.find((tool) => tool.name === "preview_delete_transactions").inputSchema;
  assert.match(JSON.stringify(deletionPreviewInput), /anyOf|oneOf/);
  const invalidAllDeletionPreview = await client.callTool({ name: "preview_delete_transactions",
    arguments: { scope: "all", transaction_ids: [1] } });
  assert.equal(invalidAllDeletionPreview.isError, true);
  assert.match(invalidAllDeletionPreview.content[0].text, /Invalid arguments/);
  const invalidSelectedDeletionPreview = await client.callTool({ name: "preview_delete_transactions",
    arguments: { scope: "selected" } });
  assert.equal(invalidSelectedDeletionPreview.isError, true);
  assert.match(invalidSelectedDeletionPreview.content[0].text, /Invalid arguments/);

  const resources = await client.listResources();
  assert.equal(resources.resources.some((resource) => resource.uri === "accounting://manifest/capabilities/v1"), true);
  assert.equal(resources.resources.some((resource) => resource.uri === "accounting://context/currencies/active"), true);
  assert.equal(resources.resources.some((resource) =>
    resource.uri === "accounting://schemas/transaction-import-record/v1"), true);
  const resourceTemplates = await client.listResourceTemplates();
  assert.equal(resourceTemplates.resourceTemplates.some((template) =>
    template.uriTemplate === "accounting://currencies/{currencyId}"), true);
  assert.equal(resourceTemplates.resourceTemplates.some((template) =>
    template.uriTemplate === "accounting://transaction-delete-plans/{planId}"), true);
  const manifestResource = await client.readResource({ uri: "accounting://manifest/capabilities/v1" });
  const manifest = JSON.parse(manifestResource.contents[0].text);
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.capabilities.some((capability) => capability.id === "accounting.accounts"), true);
  const transactionCapability = manifest.capabilities.find((capability) => capability.id === "accounting.transactions");
  assert.match(transactionCapability.summary, /permanently delete/);
  assert.equal(transactionCapability.tools.includes("refresh_transaction_delete_plan"), true);
  assert.equal(transactionCapability.tools.includes("stage_transaction_import_artifact"), true);
  assert.equal(manifest.server.artifactUpload.endpointPath, "/mcp/artifacts");
  assert.equal(manifest.server.artifactUpload.maximumChunkBytes, 1024 * 1024);
  const canonicalSchemaResource = await client.readResource({
    uri: "accounting://schemas/transaction-import-record/v1",
  });
  const canonicalSchema = JSON.parse(canonicalSchemaResource.contents[0].text);
  assert.equal(canonicalSchema.additionalProperties, false);
  assert.equal(canonicalSchema.properties.transaction_external_id.type, "string");
  assert.equal(canonicalSchema.required.includes("value_decimal"), true);
  const canonicalSchemaToolResult = await client.callTool({ name: "get_transaction_import_schema", arguments: {} });
  assert.deepEqual(canonicalSchemaToolResult.structuredContent.artifact_upload,
    artifactImportTool._meta["agent-slayer/artifactUpload"]);
  assert.match(
    tools.tools.find((tool) => tool.name === "import_account_tree").inputSchema.properties.dry_run.description,
    /Never reduce a file retry/,
  );
  assert.match(
    tools.tools.find((tool) => tool.name === "import_account_tree").inputSchema.properties.currencies.items.properties.scale.description,
    /Omit this when unknown/,
  );

  const currenciesResult = await client.callTool({ name: "list_currencies", arguments: {} });
  assert.equal(currenciesResult.structuredContent.currencies[0].displayName, "Bitcoin");

  const createCurrencyResult = await client.callTool({
    name: "create_currency",
    arguments: {
      code: "VTSAX",
      display_name: "Vanguard Total Stock Market Index Fund Admiral Shares",
      currency_type: "security",
      scale: 4,
    },
  });
  assert.deepEqual(createdCurrency, {
    pool: {}, personId: 7, code: "VTSAX",
    displayName: "Vanguard Total Stock Market Index Fund Admiral Shares",
    type: "security", scale: 4,
  });
  assert.equal(createCurrencyResult.structuredContent.contractVersion, 1);
  assert.equal(createCurrencyResult.structuredContent.status, "success");
  assert.equal(createCurrencyResult.structuredContent.effectReceipt.tool, "create_currency");
  assert.match(createCurrencyResult.structuredContent.effectReceipt.argumentsSha256, /^sha256:/);
  const currencyLink = createCurrencyResult.content.find((item) => item.type === "resource_link");
  assert.equal(currencyLink.uri, "accounting://currencies/12");
  const currencyResource = await client.readResource({ uri: currencyLink.uri });
  assert.equal(JSON.parse(currencyResource.contents[0].text).currency.id, 12);

  const result = await client.callTool({ name: "list_accounts", arguments: {} });
  assert.deepEqual(seen, ["currencies:7", 7]);
  assert.equal(result.structuredContent.accounts[0].name, "Wallet");
  assert.equal(
    result.structuredContent.schemaProjection.product,
    "schema-semantic-compiler/schema-semantic-projection",
  );
  assert.equal(
    Object.hasOwn(result.structuredContent.schemaProjection.schemaProjection.schemaObjects, "accounts"),
    true,
  );

  const importResult = await client.callTool({
    name: "import_account_tree",
    arguments: {
      currencies: [{
        code: "VTSAX",
        display_name: "Vanguard Total Stock Market Index Fund Admiral Shares",
        currency_type: "security",
        scale: 4,
      }],
      accounts: [{
        full_name: "Assets:Bank",
        account_type: "asset",
        currency_code: "USD",
        description: "Primary bank grouping",
        placeholder: true,
      }],
      dry_run: true,
    },
  });
  assert.deepEqual(imported.accounts, [{
    fullName: "Assets:Bank",
    type: "asset",
    currencyCode: "USD",
    description: "Primary bank grouping",
    placeholder: true,
  }]);
  assert.deepEqual(imported.currencies, [{
    code: "VTSAX",
    displayName: "Vanguard Total Stock Market Index Fund Admiral Shares",
    type: "security",
    scale: 4,
  }]);
  assert.equal(importResult.structuredContent.readyToCommit, true);
  assert.equal(importResult.structuredContent.preview.plannedCount, 1);
  assert.equal(importResult.structuredContent.summary.accountsCreated, 1);
  assert.equal(importResult.structuredContent.requiredAction, "REQUEST_USER_CONFIRMATION");
  assert.deepEqual(importResult.structuredContent.nextAction.onApproval, {
    tool: "commit_account_tree_import",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.deepEqual(seen, ["currencies:7", 7, "currencies:7"]);

  const missingScales = await client.callTool({
    name: "import_account_tree",
    arguments: {
      currencies: [
        { code: "VIGIX", display_name: "Vanguard Growth Index Fund", currency_type: "security" },
        { code: "S5L", display_name: "Shiloh's Five Loaves", currency_type: "security", scale: null },
      ],
      accounts: [
        { full_name: "Assets:VIGIX", account_type: "asset", currency_code: "VIGIX" },
        { full_name: "Assets:S5L", account_type: "asset", currency_code: "S5L" },
      ],
      dry_run: true,
    },
  });
  assert.equal(missingScales.structuredContent.status, "needs_input");
  assert.equal(missingScales.structuredContent.requiredAction, "ASK_USER_FOR_CURRENCY_SCALES");
  assert.equal(missingScales.structuredContent.batchSummary.accountCount, 2);
  assert.deepEqual(missingScales.structuredContent.missingCurrencies.map((currency) => currency.code), ["S5L", "VIGIX"]);
  assert.equal(missingScales.structuredContent.nextAction.tool, "import_account_tree");
  assert.equal(missingScales.structuredContent.retry.protocol, "agent-slayer.retry-descriptor");
  assert.equal(missingScales.structuredContent.retry.preserve_complete_original_batch, true);
  assert.equal(imported.accounts.length, 1);

  const planStatus = await client.callTool({
    name: "get_account_tree_import_plan",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.equal(planStatus.structuredContent.status, "ready");
  assert.deepEqual(readAccountPlan, {
    pool: {}, personId: 7, importPlanId: "11111111-1111-4111-8111-111111111111",
  });

  const missingPlan = await client.callTool({
    name: "get_account_tree_import_plan",
    arguments: { import_plan_id: "22222222-2222-4222-8222-222222222222" },
  });
  assert.equal(missingPlan.isError, true);
  assert.equal(missingPlan.structuredContent.contractVersion, 1);
  assert.equal(missingPlan.structuredContent.status, "error");
  assert.equal(missingPlan.structuredContent.code, "IMPORT_PLAN_NOT_FOUND");
  assert.equal(missingPlan.structuredContent.recoverable, true);
  assert.equal(missingPlan.structuredContent.requiredAction, "RUN_NEW_DRY_RUN");

  await client.callTool({
    name: "commit_account_tree_import",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.deepEqual(committedAccountPlan, {
    pool: {}, personId: 7, importPlanId: "11111111-1111-4111-8111-111111111111",
  });

  for (const [planId, code] of [
    ["33333333-3333-4333-8333-333333333333", "IMPORT_PLAN_EXPIRED"],
    ["44444444-4444-4444-8444-444444444444", "IMPORT_PLAN_STATE_CONFLICT"],
  ]) {
    const failure = await client.callTool({
      name: "commit_account_tree_import", arguments: { import_plan_id: planId },
    });
    assert.equal(failure.isError, true);
    assert.equal(failure.structuredContent.status, "error");
    assert.equal(failure.structuredContent.code, code);
    assert.equal(failure.structuredContent.recoverable, true);
    assert.equal(failure.structuredContent.requiredAction, "RUN_NEW_DRY_RUN");
  }

  const transactionPreview = await client.callTool({
    name: "import_transactions",
    arguments: {
      source_system: "source_app",
      transactions: [{
        external_id: "tx-1",
        transaction_date: "2026-01-01",
        description: "Test",
        valuation_currency_code: "USD",
        line_items: [
          { external_id: "1", account_full_name: "Assets:Cash", amount_decimal: "-1.00" },
          { external_id: "2", account_full_name: "Expenses:Food", amount_decimal: "1.00" },
        ],
      }],
      dry_run: true,
    },
  });
  assert.equal(transactionPreview.structuredContent.import.wouldCreateTransactionCount, 1);
  assert.equal(transactionPreview.structuredContent.import.requiredAction, "REQUEST_USER_CONFIRMATION");
  assert.deepEqual(importedTransactions.transactions[0].lineItems[0], {
    externalId: "1", accountFullName: "Assets:Cash", amountDecimal: "-1.00",
    valueDecimal: undefined, memo: undefined,
  });

  await client.callTool({
    name: "commit_transaction_import",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.deepEqual(committedTransactionPlan, {
    pool: {}, personId: 7, importPlanId: "11111111-1111-4111-8111-111111111111",
  });

  const transactionPlanStatus = await client.callTool({
    name: "get_transaction_import_plan",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.equal(transactionPlanStatus.structuredContent.status, "committed");
  assert.equal(transactionPlanStatus.structuredContent.commitResult.alreadyCommitted, true);

  const deletionPreview = await client.callTool({
    name: "preview_delete_transactions", arguments: { scope: "all" },
  });
  assert.equal(deletionPreview.structuredContent.requiredAction, "REQUEST_USER_CONFIRMATION");
  assert.equal(deletionPreview.structuredContent.preview.targetDigest, `sha256:${"d".repeat(64)}`);
  assert.equal("transactionIds" in deletionPreview.structuredContent.preview, false);
  assert.equal(deletionPreview.structuredContent.nextAction.onApproval.tool, "commit_delete_transactions");
  assert.equal(Object.hasOwn(deletionPreview.structuredContent.schemaProjection.schemaProjection.schemaObjects,
    "accounting_transaction_import_jobs"), true);
  assert.equal(Object.hasOwn(deletionPreview.structuredContent.schemaProjection.schemaProjection.schemaObjects,
    "accounting_transaction_import_items"), true);
  assert.deepEqual(previewedTransactionDeletion, { pool: {}, personId: 7, scope: "all", transactionIds: [] });

  const previewTool = tools.tools.find((tool) => tool.name === "preview_delete_transactions");
  const commitTool = tools.tools.find((tool) => tool.name === "commit_delete_transactions");
  const deferredReference = extractDeferredActionReference({
    tool: "accounting_preview_delete_transactions",
    toolDefinition: { name: "accounting_preview_delete_transactions", source: "mcp:accounting",
      upstreamName: "preview_delete_transactions", parameters: previewTool.inputSchema },
    result: deletionPreview.structuredContent,
    requestId: "request-1",
    resolveProviderTool(name) {
      if (name !== "commit_delete_transactions") return null;
      return { name: "accounting_commit_delete_transactions", source: "mcp:accounting",
        upstreamName: name, parameters: commitTool.inputSchema };
    },
  });
  assert.deepEqual(deferredReference.arguments, deletionPreview.structuredContent.nextAction.onApproval.arguments);
  assert.equal(deferredReference.targetUpstreamTool, "commit_delete_transactions");

  const invalidatedDeletionPlan = await client.callTool({
    name: "get_transaction_delete_plan",
    arguments: { deletion_plan_id: "55555555-5555-4555-8555-555555555555" },
  });
  assert.equal(invalidatedDeletionPlan.structuredContent.requiredAction, "RUN_NEW_DELETE_PREVIEW");
  assert.deepEqual(invalidatedDeletionPlan.structuredContent.nextAction, {
    type: "run_provider_tool", tool: "refresh_transaction_delete_plan",
    arguments: { deletion_plan_id: "55555555-5555-4555-8555-555555555555" },
  });

  const mismatchedDeletionCommit = await client.callTool({
    name: "commit_delete_transactions",
    arguments: { deletion_plan_id: "55555555-5555-4555-8555-555555555555",
      preview_digest: `sha256:${"0".repeat(64)}` },
  });
  assert.equal(mismatchedDeletionCommit.isError, true);
  assert.equal(mismatchedDeletionCommit.structuredContent.code, "TRANSACTION_DELETE_PREVIEW_MISMATCH");
  assert.equal(mismatchedDeletionCommit.structuredContent.requiredAction, "USE_BOUND_PREVIEW_ARGUMENTS");

  const deletionCommit = await client.callTool({
    name: "commit_delete_transactions",
    arguments: { deletion_plan_id: "55555555-5555-4555-8555-555555555555",
      preview_digest: `sha256:${"c".repeat(64)}` },
  });
  assert.equal(deletionCommit.structuredContent.verification.accountTreeUnchanged, true);
  assert.deepEqual(committedTransactionDeletion, { pool: {}, personId: 7,
    deletionPlanId: "55555555-5555-4555-8555-555555555555", previewDigest: `sha256:${"c".repeat(64)}` });

  await client.close();
  await server.close();
});

test("the HTTP MCP handler advertises modern tool-list refresh support", async () => {
  const handler = createAccountingMcpHandler({ pool: {} });
  const protocolVersion = "2026-07-28";
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  };
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "server/discover",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify(body),
  }), {
    authInfo: {
      token: "test-token",
      clientId: "accounting-mcp-test",
      scopes: ["accounting"],
      extra: { accountingAuth: { personId: 7, tokenId: 1 } },
    },
    parsedBody: body,
  });

  assert.equal(response.status, 200);
  const discovery = await response.json();
  assert.deepEqual(discovery.result.supportedVersions, [protocolVersion]);
  assert.equal(discovery.result.capabilities.tools.listChanged, true);
  assert.equal(discovery.result._meta["io.modelcontextprotocol/serverInfo"].version, "0.1.0");

  await handler.close();
});
