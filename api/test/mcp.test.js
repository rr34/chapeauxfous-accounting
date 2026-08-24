import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { createAccountingMcpServer } = await import("../src/mcp.js");

test("the MCP exposes scoped tools with schema-semantic projections", async () => {
  const seen = [];
  const services = {
    async listCurrencies() { return [{ id: 2, code: "BTC", scale: 8 }]; },
    async listAccounts(_pool, personId) {
      seen.push(personId);
      return [{ id: 10, name: "Wallet", balanceUnits: "123" }];
    },
  };
  const server = createAccountingMcpServer({ personId: 7, pool: {}, services });
  const client = new Client({ name: "accounting-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "describe_accounting_schema"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "create_transaction"), true);
  assert.equal(tools.tools.find((tool) => tool.name === "list_accounts").annotations.readOnlyHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "create_account").annotations.readOnlyHint, false);

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

  await client.close();
  await server.close();
});
