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

test("the MCP exposes scoped tools with schema-semantic projections", async () => {
  const seen = [];
  let imported;
  let committedAccountPlan;
  let readAccountPlan;
  let importedTransactions;
  let committedTransactionPlan;
  let createdCurrency;
  const services = {
    async listCurrencies(_pool, personId) {
      seen.push(`currencies:${personId}`);
      return [{ id: 2, code: "BTC", displayName: "Bitcoin", type: "crypto", scale: 8 }];
    },
    async createCurrency(input) { createdCurrency = input; return { id: 12, ...input }; },
    async listAccounts(_pool, personId) {
      seen.push(personId);
      return [{ id: 10, name: "Wallet", balanceUnits: "123" }];
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
        preview: { dryRun: true, totalCount: input.accounts.length, plannedCount: input.accounts.length },
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
      return { readyToCommit: true, importPlanId: "11111111-1111-4111-8111-111111111111",
        wouldCreateTransactionCount: input.transactions.length };
    },
    async commitTransactionImportPlan(input) {
      committedTransactionPlan = input;
      return { committed: true, createdTransactionCount: 1 };
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
  assert.equal(tools.tools.find((tool) => tool.name === "list_accounts").annotations.readOnlyHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "create_account").annotations.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "create_currency").annotations.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "import_account_tree").annotations.idempotentHint, true);
  assert.match(tools.tools.find((tool) => tool.name === "create_currency").description, /Never guess or choose a default scale/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /ask the user for the scale of each such unit/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /entire intended file batch/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /successful dry run is a change preview/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /created, reused, skipped, or rejected/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /importPlanId/);
  assert.match(tools.tools.find((tool) => tool.name === "commit_account_tree_import").description, /only import_plan_id/);
  const accountTreeOutputSchema = tools.tools.find((tool) => tool.name === "import_account_tree").outputSchema;
  assert.match(JSON.stringify(accountTreeOutputSchema), /readyToCommit/);
  assert.match(JSON.stringify(accountTreeOutputSchema), /previewDigest/);
  assert.match(JSON.stringify(accountTreeOutputSchema), /expiresAt/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /source-neutral/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /unknown or ambiguous paths/);
  assert.equal(tools.tools.find((tool) => tool.name === "commit_transaction_import").annotations.idempotentHint, true);
  assert.match(
    tools.tools.find((tool) => tool.name === "import_account_tree").inputSchema.properties.dry_run.description,
    /Never reduce a file retry/,
  );
  assert.match(
    tools.tools.find((tool) => tool.name === "import_account_tree").inputSchema.properties.currencies.items.properties.scale.description,
    /explicitly confirmed by the user/,
  );

  const currenciesResult = await client.callTool({ name: "list_currencies", arguments: {} });
  assert.equal(currenciesResult.structuredContent.currencies[0].displayName, "Bitcoin");

  await client.callTool({
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
  assert.deepEqual(missingPlan.structuredContent, {
    code: "IMPORT_PLAN_NOT_FOUND", recoverable: true, requiredAction: "RUN_NEW_DRY_RUN",
  });

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
    assert.deepEqual(failure.structuredContent, {
      code, recoverable: true, requiredAction: "RUN_NEW_DRY_RUN",
    });
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
  assert.equal(discovery.result._meta["io.modelcontextprotocol/serverInfo"].version, "0.5.0");

  await handler.close();
});
