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
  const services = {
    async listCurrencies() { return [{ id: 2, code: "BTC", scale: 8 }]; },
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
  assert.equal(tools.tools.find((tool) => tool.name === "import_account_tree").annotations.idempotentHint, true);

  const result = await client.callTool({ name: "list_accounts", arguments: {} });
  assert.deepEqual(seen, [7]);
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
  assert.equal(discovery.result._meta["io.modelcontextprotocol/serverInfo"].version, "0.2.0");

  await handler.close();
});
