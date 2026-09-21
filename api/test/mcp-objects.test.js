import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { createAccountingMcpServer } = await import("../src/mcp.js");
const { loadAccountObjectPaths, listLineItemObjectsPage, listTransactionImportJobObjectsPage,
  listTransactionObjectsPage } = await import("../src/accounting-objects.js");
const { objectInputBindingProblem } = await import(
  "../../../agent-chapeaux-fous/src/object-input-bindings.mjs"
);
const { objectReferenceGroupsFromToolResult } = await import(
  "../../../agent-chapeaux-fous/src/object-references.mjs"
);

test("all seven Accounting object read paths return the fields they advertise", async () => {
  const currency = { id: 2, code: "BTC", displayName: "Bitcoin", type: "crypto", scale: 8,
    ownerPersonId: 7, userDefined: true };
  const account = { id: 10, name: "Coinbase Bitcoin", description: null, placeholder: false, suspense: false,
    parentAccountId: null, type: "asset", currencyId: 2, currencyCode: "BTC", scale: 8,
    balanceUnits: "100000000", archivedAt: null };
  const question = { lineItemId: 31, transactionId: 21, accountId: 10,
    accountFullName: "Coinbase Bitcoin", transactionDate: "2026-09-15",
    amountUnits: "-2500", currencyCode: "USD", status: "open", audience: "human",
    prompt: "What was this charge?" };
  const assertion = { id: 41, accountId: 10, accountName: "Coinbase Bitcoin", date: "2026-09-15",
    knownBalanceUnits: "12345", currencyCode: "USD", scale: 2, matches: true };
  const lineItem = { objectType: "accounting.line_item", id: 32, sourceRef: "accounting://line-items/32",
    displayName: "2026-09-15 · Coinbase Bitcoin · Coin purchase", transactionId: 21, accountId: 10,
    accountFullName: "Coinbase Bitcoin", transactionDate: "2026-09-15", amountUnits: "100000",
    currencyCode: "BTC", memo: null, reconciliationState: "cleared" };
  const importJobId = "0ed8cb57-efb5-419e-b4e5-59b73724f224";
  const objectQueries = [];
  const pool = { async query(sql, params) {
    objectQueries.push({ sql, params });
    if (sql.includes("FROM transactions t")) return [[{
      transaction_id: 21, TransactionDate: "2026-09-15", description: "Coinbase BTC purchase",
      TransactionState: "posted", CurrencyAbbreviation: "USD",
    }]];
    if (sql.includes("FROM line_items li")) return [[
      { transaction_id: 21, account_id: 10, memo: null, AccountName: "Coinbase Bitcoin" },
      { transaction_id: 21, account_id: 11, memo: null, AccountName: "Cash" },
    ]];
    if (sql.includes("FROM accounting_transaction_import_jobs")) return [[{
      import_job_id: importJobId, source_system: "coinbase",
      source_file_name: "coinbase.csv", expected_record_count: 17, job_status: "review_ready",
      created_at: "2026-09-15 12:00:00.000000", updated_at: "2026-09-16 10:00:00.000000",
    }]];
    assert.fail(`Unexpected object query: ${sql}`);
  } };
  const services = {
    async listCurrenciesPage() { return { currencies: [currency], nextCursor: null }; },
    async listAccountsPage() { return { accounts: [account], nextCursor: null }; },
    async listAccounts() { return [account]; },
    async getAccount() { return account; },
    async listAccountingQuestionsPage() { return { questions: [question], nextCursor: null }; },
    async listBalanceAssertionsPage() { return { assertions: [assertion], nextCursor: null }; },
    async listLineItemObjectsPage() { return { objects: [lineItem], nextCursor: null }; },
  };
  const server = createAccountingMcpServer({ personId: 7, pool, services });
  const client = new Client({ name: "accounting-object-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const discovered = await client.listTools();
    const cases = [
      ["list_currency_objects", {}, "accounting.currency", "accounting://currencies/2"],
      ["list_account_objects", {}, "accounting.account", "accounting://accounts/10"],
      ["list_transaction_objects", { text: "Coinbase" }, "accounting.transaction", "accounting://transactions/21"],
      ["list_line_item_objects", { text: "Coin" }, "accounting.line_item", "accounting://line-items/32"],
      ["list_accounting_question_objects", {}, "accounting.question", "accounting://questions/31"],
      ["list_transaction_import_job_objects", { text: "coinbase" }, "accounting.transaction_import_job",
        `accounting://transaction-import-jobs/${importJobId}`],
      ["list_balance_assertion_objects", {}, "accounting.balance_assertion",
        "accounting://balance-assertions/41"],
    ];
    for (const [name, args, objectType, sourceRef] of cases) {
      const tool = discovered.tools.find((item) => item.name === name);
      assert.ok(tool, name);
      const description = tool._meta["agent-slayer/objects"].types[0];
      assert.equal(description.id, objectType);
      assert.equal(tool.annotations.readOnlyHint, true);
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.structuredContent.status, "success", name);
      assert.equal(result.structuredContent.resultMetadata.complete, true);
      const [object] = result.structuredContent.objects;
      assert.equal(object.objectType, objectType);
      assert.equal(object[description.identity.field], object.id);
      assert.equal(object[description.reference.field], sourceRef);
      assert.ok(object[description.display.field]);
      assert.deepEqual(result.structuredContent.resultMetadata.sourceRefs, [sourceRef]);
      for (const qualifier of description.qualifiers) {
        assert.equal(Object.hasOwn(object, qualifier.field), true, `${name}: ${qualifier.field}`);
      }
    }
    assert.equal(objectQueries.length, 3);
    const [transactionQuery, lineQuery, importQuery] = objectQueries;
    assert.match(transactionQuery.sql, /t.owner_person_id = \?/);
    assert.match(transactionQuery.sql, /ORDER BY t.transaction_id DESC LIMIT \?/);
    assert.equal(transactionQuery.params[0], 7);
    assert.equal(transactionQuery.params.at(-1), 26);
    assert.match(lineQuery.sql, /t.owner_person_id = \?/);
    assert.deepEqual(lineQuery.params, [7, 21]);
    assert.match(importQuery.sql, /owner_person_id = \?/);
    assert.match(importQuery.sql, /ORDER BY import_job_id DESC LIMIT \?/);
    assert.equal(importQuery.params[0], 7);
    assert.equal(importQuery.params.at(-1), 101);
  } finally {
    await client.close();
    await server.close();
  }
});

test("an unknown exact account object is an empty search result rather than a provider error", async () => {
  const missing = Object.assign(new Error("Account not found."), {
    code: "ACCOUNT_NOT_FOUND",
    status: 404,
  });
  const server = createAccountingMcpServer({
    personId: 7,
    pool: { async query() { assert.fail("An empty account result must not query paths."); } },
    services: {
      async getAccount() { throw missing; },
      async loadAccountObjectPaths(_pool, _personId, accounts) {
        assert.deepEqual(accounts, []);
        return [];
      },
    },
  });
  const client = new Client({ name: "accounting-missing-object-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "list_account_objects", arguments: { account_id: 1 } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.status, "success");
    assert.deepEqual(result.structuredContent.objects, []);
    assert.equal(result.structuredContent.resultMetadata.complete, true);
    assert.equal(result.structuredContent.resultMetadata.returned, 0);
    assert.deepEqual(result.structuredContent.resultMetadata.sourceRefs, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the authoritative account read bootstraps the exact binding required by statement import", async () => {
  const account = { id: 178, name: "Fifth Third Main x5999", description: null, placeholder: false,
    suspense: false, parentAccountId: null, type: "asset", currencyId: 1, currencyCode: "USD",
    scale: 2, balanceUnits: "333182", archivedAt: null };
  const server = createAccountingMcpServer({
    personId: 7,
    pool: {},
    services: {
      async getAccount() { return account; },
      async loadAccountObjectPaths(_pool, _personId, accounts) { return accounts; },
    },
  });
  const client = new Client({ name: "accounting-object-binding-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const discovered = await client.listTools();
    const definitions = discovered.tools.map((tool) => ({
      ...tool,
      name: `remote_accounting_${tool.name}`,
      source: "mcp:accounting",
      metadata: tool._meta,
    }));
    const accountRead = definitions.find((tool) => tool.name === "remote_accounting_list_account_objects");
    const statementStart = definitions.find((tool) => tool.name === "remote_accounting_start_single_account_statement_import");
    assert.equal(objectInputBindingProblem({
      toolDefinition: accountRead, argumentsObject: { account_id: 178 },
    }), null, "the owning identifying read accepts an exact unbound ID");

    const result = await client.callTool({ name: "list_account_objects", arguments: { account_id: 178 } });
    const observed = objectReferenceGroupsFromToolResult({
      toolDefinition: accountRead,
      toolDefinitions: definitions,
      result: result.structuredContent,
      sourceEventSeq: 1,
    });
    assert.deepEqual(observed[0].objects, [{
      id: 178, ref: "accounting://accounts/178", display: "Fifth Third Main x5999",
    }]);
    assert.equal(objectInputBindingProblem({
      toolDefinition: statementStart,
      argumentsObject: { account_id: 178 },
      observedGroups: observed,
    }), null);
    assert.match(objectInputBindingProblem({
      toolDefinition: statementStart,
      argumentsObject: { account_id: 1 },
      observedGroups: observed,
    }), /must use the exact id.*178/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("import-job object reads are owner-scoped and expose a stable continuation", async () => {
  const jobs = ["a", "b", "c"].map((part) => ({
    import_job_id: `${part.repeat(8)}-${part.repeat(4)}-${part.repeat(4)}-${part.repeat(4)}-${part.repeat(12)}`,
    source_system: "coinbase", source_file_name: `${part}.csv`, expected_record_count: 2,
    job_status: "receiving", created_at: "2026-09-15 12:00:00.000000",
    updated_at: "2026-09-15 12:00:00.000000",
  }));
  let query;
  const pool = { async query(sql, params) { query = { sql, params }; return [jobs]; } };
  const page = await listTransactionImportJobObjectsPage(pool, 7, { limit: 2, text: "coinbase" });
  assert.equal(page.objects.length, 2);
  assert.equal(page.nextCursor, jobs[1].import_job_id);
  assert.match(query.sql, /owner_person_id = \?/);
  assert.match(query.sql, /INSTR\(LOWER\(source_system\), \?\)/);
  assert.equal(query.params[0], 7);
  assert.equal(query.params.at(-1), 3);

  await assert.rejects(listTransactionImportJobObjectsPage(pool, 7, {
    importJobId: jobs[0].import_job_id, cursor: jobs[1].import_job_id,
  }), { code: "INVALID_IMPORT_JOB_OBJECT_FILTER" });
});

test("transaction object search pages selected rows and loads postings only for that page", async () => {
  const queries = [];
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes("FROM transactions t")) return [[30, 20, 10].map((id) => ({
      transaction_id: id, TransactionDate: "2026-09-15", description: `Coin purchase ${id}`,
      TransactionState: "posted", CurrencyAbbreviation: "USD",
    }))];
    return [[
      { transaction_id: 30, account_id: 10, memo: "Coin transfer", AccountName: "Bitcoin" },
      { transaction_id: 20, account_id: 10, memo: null, AccountName: "Bitcoin" },
    ]];
  } };
  const page = await listTransactionObjectsPage(pool, 7, {
    limit: 2, text: "coin", accountId: 10, dateFrom: "2026-09-01",
  });
  assert.deepEqual(page.objects.map((object) => object.id), [30, 20]);
  assert.equal(page.nextCursor, "20");
  assert.deepEqual(page.objects[0].accountIds, [10]);
  assert.deepEqual(page.objects[0].matchedFields, ["description", "lineMemo", "accountName", "accountId", "date"]);
  assert.match(queries[0].sql, /t.owner_person_id = \?/);
  assert.match(queries[0].sql, /t.TransactionDate >= \?/);
  assert.match(queries[0].sql, /account_line.account_id = \?/);
  assert.match(queries[0].sql, /ORDER BY t.transaction_id DESC LIMIT \?/);
  assert.equal(queries[0].params.at(-1), 3);
  assert.deepEqual(queries[1].params, [7, 30, 20]);
  await assert.rejects(listTransactionObjectsPage(pool, 7, { transactionId: 30, cursor: "20" }), {
    code: "INVALID_TRANSACTION_OBJECT_FILTER",
  });
});

test("line-item object search is owner scoped and returns stable posting identity", async () => {
  let query;
  const pool = { async query(sql, params) {
    query = { sql, params };
    return [[{
      line_item_id: 32, transaction_id: 21, account_id: 10, amount_units: "100000",
      memo: "Coin purchase", reconciliation_state: "cleared", TransactionDate: "2026-09-15",
      transaction_description: "Buy BTC", AccountName: "Coinbase Bitcoin", parent_account_id: null,
      CurrencyAbbreviation: "BTC",
    }]];
  } };
  const page = await listLineItemObjectsPage(pool, 7, { lineItemId: 32, limit: 1 });
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.objects[0], {
    objectType: "accounting.line_item", id: 32, sourceRef: "accounting://line-items/32",
    displayName: "2026-09-15 · Coinbase Bitcoin · Coin purchase", transactionId: 21,
    accountId: 10, accountFullName: "Coinbase Bitcoin", transactionDate: "2026-09-15",
    amountUnits: "100000", currencyCode: "BTC", memo: "Coin purchase", reconciliationState: "cleared",
  });
  assert.match(query.sql, /t\.owner_person_id = \?/);
  assert.match(query.sql, /li\.line_item_id = \?/);
  assert.deepEqual(query.params, [7, 32, 2]);
});

test("account object paths read only the page's owner-scoped ancestors", async () => {
  const queries = [];
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (params[1] === 20) return [[{ account_id: 20, AccountName: "Assets", parent_account_id: 1 }]];
    return [[{ account_id: 1, AccountName: "Root", parent_account_id: null }]];
  } };
  const paths = await loadAccountObjectPaths(pool, 7, [
    { id: 30, name: "Cash", parentAccountId: 20 },
  ]);
  assert.deepEqual(paths.map((account) => account.id), [30, 20, 1]);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(({ sql }) => sql.includes("owner_person_id = ? AND account_id IN")));
  assert.deepEqual(queries.map(({ params }) => params), [[7, 20], [7, 1]]);
});
