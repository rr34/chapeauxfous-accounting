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
      return { dryRun: input.dryRun, totalCount: input.accounts.length, plannedCount: input.accounts.length };
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
  assert.equal(tools.tools.find((tool) => tool.name === "list_accounts").annotations.readOnlyHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "create_account").annotations.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "create_currency").annotations.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "import_account_tree").annotations.idempotentHint, true);
  assert.match(tools.tools.find((tool) => tool.name === "create_currency").description, /Never guess or choose a default scale/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /ask the user for the scale of each such unit/);
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
  assert.equal(importResult.structuredContent.import.plannedCount, 1);

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
  assert.equal(discovery.result._meta["io.modelcontextprotocol/serverInfo"].version, "0.3.0");

  await handler.close();
});
