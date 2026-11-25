import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_DATABASE = "accounting_test";
const { createInvoiceService } = await import("../src/invoices.js");
const { createAccountingMcpServer } = await import("../src/mcp.js");
const { extractDeferredActionReference } = await import("../../../agent-chapeaux-fous/src/deferred-actions.mjs");

const id = "4fe90874-623c-4a4e-9ceb-4ac43f89a610";
const revision = "c7b93470-acde-4c4f-83f2-ef4b3b24aaab";
const accountId = "acct_test";
const env = {
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_fixture",
  ACCOUNTING_STRIPE_STATE_SECRET: "fixture-state-secret-at-least-32-characters",
};

test("drafts can change recipient and append a line, while local paid invoices only accept recipient correction", async () => {
  const row = {
    invoice_id: id, owner_person_id: 7, revision, payer_name: "Old name", payer_email: "old@example.com",
    currency: "USD", amount_minor: 2500, amount_paid_minor: 0, amount_remaining_minor: 2500,
    payment_methods: "ach_only", invoice_number: 16, invoice_status: "draft", stripe_invoice_id: null,
  };
  let lines = [{ invoice_line_id: id, position: 1, description: "Work", amount_minor: 2500 }];
  const db = {
    getConnection: async () => db,
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    async execute(sql, values) {
      if (sql.startsWith("SELECT * FROM accounting_invoices")) {
        assert.deepEqual(values, [7, id]);
        return [[{ ...row }]];
      }
      if (sql.includes("SELECT") && sql.includes("FROM accounting_invoice_lines")) return [lines];
      if (sql.startsWith("DELETE FROM accounting_invoice_lines")) { lines = []; return; }
      if (sql.includes("amount_remaining_minor = NULL")) {
        row.amount_remaining_minor = null;
        row.amount_minor = values[6];
        row.revision = values[7];
      } else {
        assert.match(sql, /SET payer_name = \?, payer_email = \?, revision = \?/);
        row.revision = values[2];
      }
      [row.payer_name, row.payer_email] = values;
    },
    async query(sql, [values]) {
      assert.match(sql, /INSERT INTO accounting_invoice_lines/);
      lines = values.map(([invoice_line_id, , position, description, amount_minor]) =>
        ({ invoice_line_id, position, description, amount_minor }));
    },
  };
  const invoices = createInvoiceService(db, { env });
  const input = { payer_name: "New name", payer_email: "new@example.com", currency: "USD",
    lines: [{ description: "Work edited", amount_minor: 2500 }, { description: "More work", amount_minor: 500 }] };
  const saved = await invoices.saveDraft(7, input, { id, revision });
  assert.equal(saved.payerName, "New name");
  assert.equal(saved.invoiceNumber, 16);
  assert.match(saved.displayName, /^#16 /);
  assert.equal(saved.amountRemainingMinor, 3000);
  assert.equal(saved.lines[0].id, id);
  assert.equal(saved.lines[1].description, "More work");
  row.send_review_required = 1;
  await assert.rejects(invoices.prepareSend(7, id), { code: "INVOICE_SEND_REVIEW_REQUIRED" });
  await assert.rejects(invoices.saveDraft(7, input, { id, revision: saved.revision }), { code: "INVOICE_REVISION_CONFLICT" });
  row.send_review_required = 0;
  row.invoice_status = "paid";
  row.amount_paid_minor = 3000;
  row.amount_remaining_minor = 0;
  await assert.rejects(invoices.saveDraft(7, input, { id, revision: saved.revision }), { code: "INVOICE_REVISION_CONFLICT" });
  await assert.rejects(invoices.correctPaidPayer(7, id, revision,
    { payer_name: "Corrected", payer_email: null }), { code: "INVOICE_REVISION_CONFLICT" });
  const corrected = await invoices.correctPaidPayer(7, id, saved.revision,
    { payer_name: "Corrected", payer_email: null });
  assert.equal(corrected.payerName, "Corrected");
  assert.equal(corrected.status, "paid");
  assert.equal(corrected.amountPaidMinor, 3000);
  assert.deepEqual(corrected.lines, saved.lines);
  row.stripe_invoice_id = "in_existing";
  await assert.rejects(invoices.correctPaidPayer(7, id, corrected.revision,
    { payer_name: "Another name", payer_email: null }), { code: "INVOICE_PAYER_LOCKED" });
});

test("Stripe setup returns to the initiating Accounting owner and browser", async () => {
  const browserKey = "9a029d16-737b-451c-8707-53d161b0d38f";
  const accounts = new Map();
  const db = {
    getConnection: async () => db,
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    async execute(sql, [owner, account]) {
      if (sql.includes("FROM people2_people")) return [[{ person_id: owner }]];
      if (sql.includes("FROM accounting_stripe_accounts")) {
        return [accounts.has(owner) ? [{ stripe_account_id: accounts.get(owner) }] : []];
      }
      assert.match(sql, /INSERT INTO accounting_stripe_accounts/);
      accounts.set(owner, account);
      return [[]];
    },
  };
  const invoices = createInvoiceService(db, {
    env: { ...env, STRIPE_CONNECT_CLIENT_ID: "ca_fixture",
      ACCOUNTING_STRIPE_CALLBACK_URL: "https://accounting.example.test/api/payments/stripe/oauth/callback" },
    stripeFactory: () => ({ oauth: { token: async ({ code }) => {
      assert.equal(code, "provider-code");
      return { stripe_user_id: accountId };
    } } }),
  });
  const { url } = await invoices.beginConnect(7, browserKey);
  const state = new URL(url).searchParams.get("state");
  const completion = await invoices.finishConnect({ state, code: "provider-code" });
  assert.equal((await invoices.connectionStatus(7)).stripeAccountId, null);
  await assert.rejects(invoices.completeConnect(8, completion, browserKey), { code: "STRIPE_OWNER_MISMATCH" });
  await assert.rejects(invoices.completeConnect(7, completion, id), { code: "STRIPE_BROWSER_MISMATCH" });
  await invoices.completeConnect(7, completion, browserKey);
  assert.equal((await invoices.connectionStatus(7)).stripeAccountId, accountId);
});

test("a confirmed invoice sends once, with an owner- and revision-bound handoff", async () => {
  const row = {
    invoice_id: id, owner_person_id: 7, revision, payer_name: "Alice", payer_email: "alice@example.com",
    currency: "USD", amount_minor: "2500", amount_paid_minor: "0", due_on: "2099-01-15",
    payment_methods: "card_only", description: null, stripe_invoice_id: null, stripe_status: null,
    invoice_number: 16, invoice_status: "draft",
    stripe_hosted_url: null, stripe_pdf_url: null, sent_at: null, adopted_at: null, send_started_at: null,
  };
  const calls = [];
  const db = {
    getConnection: async () => db,
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    async execute(sql, args) {
      if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
      if (sql.includes("RELEASE_LOCK")) return [[]];
      if (sql.startsWith("SELECT * FROM accounting_invoices")) return [[{ ...row }]];
      if (sql.includes("FROM accounting_stripe_accounts")) return [[{ stripe_account_id: accountId }]];
      if (sql.includes("FROM accounting_invoice_lines")) return [[{
        invoice_line_id: id, position: 1, description: "Work", amount_minor: "2500", todo_ref: null, receipt_ref: null,
      }]];
      if (sql.includes("SET stripe_account_id")) {
        row.send_started_at ??= "2099-01-01 00:00:00";
      }
      else if (sql.includes("SET stripe_invoice_id")) row.stripe_invoice_id = args[0];
      else if (sql.includes("SET stripe_status")) {
        [row.stripe_status, row.amount_paid_minor, row.amount_remaining_minor, row.stripe_hosted_url, row.stripe_pdf_url] = args;
        if (args[5]) row.sent_at = "2099-01-01 00:00:00";
        if (args[6]) row.invoice_status = args[6];
      } else assert.fail(sql);
      return [[]];
    },
  };
  const status = { id: "in_real", customer: "cus_real", status: "open", amount_paid: 0, amount_remaining: 2500,
    hosted_invoice_url: "https://invoice.stripe.com/i/existing" };
  const step = (name, value) => async (...args) => {
    assert.equal(args.at(-1).stripeAccount, accountId);
    assert.ok(args.at(-1).idempotencyKey.includes(id));
    calls.push(name);
    return value;
  };
  const stripe = {
    accounts: { retrieve: async () => ({ charges_enabled: true }) },
    customers: { create: step("customer", { id: "cus_real" }) },
    invoiceItems: { create: step("line", {}) },
    invoices: {
      create: step("create", { id: "in_real" }),
      retrieve: async () => ({ ...status, status: "draft" }),
      finalizeInvoice: step("finalize", status),
      sendInvoice: step("send", status),
    },
  };
  const invoices = createInvoiceService(db, { env, stripeFactory: () => stripe });
  const server = createAccountingMcpServer({ personId: 7, pool: db, services: { invoices } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { structuredContent: prepared } = await client.callTool({
      name: "prepare_invoice_send", arguments: { invoice_id: id },
    });
    assert.equal(prepared.status, "ready");
    assert.match(prepared.nextAction.instruction, /invoice #16/);
    assert.deepEqual(calls, []);
    const handoff = prepared.nextAction.onApproval;
    assert.equal(handoff.tool, "send_invoice");
    const { tools } = await client.listTools();
    const definition = (name) => ({
      name: `remote_accounting_${name}`, source: "mcp:accounting",
      upstreamName: name, parameters: tools.find((tool) => tool.name === name).inputSchema,
    });
    const deferred = extractDeferredActionReference({
      tool: "remote_accounting_prepare_invoice_send", toolDefinition: definition("prepare_invoice_send"),
      result: prepared, requestId: "invoice-test", resolveProviderTool: definition,
    });
    assert.deepEqual(deferred.arguments, handoff.arguments);
    await assert.rejects(invoices.send(8, handoff.arguments.send_token), { code: "INVOICE_OWNER_MISMATCH" });
    row.revision = id;
    await assert.rejects(invoices.send(7, handoff.arguments.send_token), { code: "INVOICE_REVISION_CONFLICT" });
    row.revision = revision;
    const result = await client.callTool({ name: handoff.tool, arguments: handoff.arguments });
    assert.equal(Boolean(result.isError), false, JSON.stringify(result.structuredContent ?? result.content));
    assert.equal(result.structuredContent.invoice.hostedInvoiceUrl, status.hosted_invoice_url);
    assert.deepEqual(calls, ["customer", "create", "line", "finalize", "send"]);
    assert.equal((await invoices.send(7, handoff.arguments.send_token)).idempotentReplay, true);
    assert.equal(calls.length, 5);
  } finally {
    await client.close();
    await server.close();
  }
});

test("adoption retains the original Stripe invoice and only reads Stripe", async () => {
  let row;
  let lines;
  const db = {
    getConnection: async () => db,
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    async query(sql, [values]) {
      assert.match(sql, /INSERT INTO accounting_invoice_lines/);
      lines = values.map(([invoice_line_id, , position, description, amount_minor, todo_ref, receipt_ref]) =>
        ({ invoice_line_id, position, description, amount_minor, todo_ref, receipt_ref }));
    },
    async execute(sql, args) {
      if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
      if (sql.includes("RELEASE_LOCK")) return [[]];
      if (sql.includes("FROM people2_people")) {
        assert.match(sql, /FOR UPDATE/);
        return [[{ person_id: 7 }]];
      }
      if (sql.startsWith("SELECT invoice_number")) return [[{ invoice_number: 16 }]];
      if (sql.includes("FROM accounting_stripe_accounts")) return [[{ stripe_account_id: accountId }]];
      if (sql.startsWith("SELECT * FROM accounting_invoices")) return [[row]];
      if (sql.includes("FROM accounting_invoice_lines")) return [lines];
      if (sql.startsWith("SELECT invoice_id")) return [[row]];
      if (sql.startsWith("INSERT INTO accounting_invoices")) {
        if (row) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
        const fields = ["invoice_id", "owner_person_id", "payer_name", "payer_email", "description", "currency",
          "due_on", "payment_methods", "amount_minor", "revision", "stripe_account_id", "stripe_customer_id",
          "stripe_invoice_id", "invoice_number", "invoice_status"];
        row = { ...Object.fromEntries(fields.map((field, index) => [field, args[index]])),
          adopted_at: "2099-01-01 00:00:00", sent_at: null };
      } else if (sql.includes("SET stripe_status")) {
        [row.stripe_status, row.amount_paid_minor, row.amount_remaining_minor, row.stripe_hosted_url, row.stripe_pdf_url] = args;
        if (args[6]) row.invoice_status = args[6];
      } else assert.fail(sql);
      return [[]];
    },
  };
  const remote = { status: "open", total: 2500, amount_paid: 500, amount_remaining: 2000, currency: "usd",
    customer: "cus_existing", customer_name: "Alice", customer_email: "alice@example.com",
    hosted_invoice_url: "https://invoice.stripe.com/i/existing" };
  const provider = { invoices: {
    retrieve: async (remoteId, _, options) => {
      assert.equal(remoteId, "in_existing");
      assert.equal(options.stripeAccount, accountId);
      return remote;
    },
    async *listLineItems(remoteId, _, options) {
      assert.equal(remoteId, "in_existing");
      assert.equal(options.stripeAccount, accountId);
      yield { description: "Work", amount: 2500 };
    },
  } };
  const invoices = createInvoiceService(db, { env, stripeFactory: () => provider });
  const adopted = await invoices.adopt(7, "in_existing");
  assert.equal(adopted.invoice.invoiceNumber, 17);
  assert.equal(adopted.invoice.invoiceStatus, "open");
  assert.equal(adopted.invoice.stripeStatus, "open");
  assert.equal(adopted.invoice.stripeInvoiceId, "in_existing");
  assert.equal(adopted.invoice.hostedInvoiceUrl, remote.hosted_invoice_url);
  assert.equal(adopted.invoice.amountRemainingMinor, 2000);
  assert.equal(adopted.invoice.lines[0].description, "Work");
  assert.equal((await invoices.adopt(7, "in_existing")).idempotentReplay, true);
  await assert.rejects(invoices.prepareSend(7, adopted.invoice.id), { code: "INVOICE_ALREADY_ISSUED" });
  Object.assign(remote, { status: "paid", amount_paid: 2500, amount_remaining: 0 });
  const { objects: [paid] } = await invoices.list(7, { invoice_id: adopted.invoice.id });
  assert.equal(paid.invoiceStatus, "paid");
  assert.equal(paid.stripeStatus, "paid");
});
