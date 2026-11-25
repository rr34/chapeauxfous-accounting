import test from "node:test";
import assert from "node:assert/strict";
import { importAgentInvoices, normalizeAgentInvoice } from "../scripts/import-agent-invoices.mjs";

const row = {
  payment_invoice_id: "17", status: "paid", currency: "USD", amount_minor: "2500", amount_paid_minor: "2500",
  payment_method_policy: "ach_only", description: "Work", payer_name_snapshot: "Payer",
  payer_email_snapshot: "payer@example.test", created_at_utc: "2026-01-01 00:00:00",
  stripe_connected_account_id: null, stripe_invoice_id: null, stripe_customer_id: null,
  processor_status: null, hosted_invoice_url: null, due_on: null, opened_at_utc: null,
};
const line = { payment_invoice_id: "17", line_position: 1, description_snapshot: "Work",
  amount_minor_snapshot: "2500", personal_task_id: "15", file_id: "4" };

test("preserves local payment status and exact source references", () => {
  const invoice = normalizeAgentInvoice(row, [line]);
  assert.equal(invoice.row.status, "paid");
  assert.equal(invoice.remaining, 0);
  assert.equal(invoice.stripeStatus, null);
  assert.equal(invoice.lines[0].todoRef, "agent-slayer://todos/15");
  assert.equal(invoice.lines[0].receiptRef, "agent-slayer://files/4");
  assert.throws(() => normalizeAgentInvoice(row, [{ ...line, amount_minor_snapshot: "2400" }]), /total validation/);
});

test("dry run is read-only, apply is atomic, and retry skips already imported invoices", async () => {
  let previous;
  let committed = 0;
  let sourcePerson;
  const source = {
    async query(sql, values) {
      if (sql === "SET @timev3_person_id = ?") {
        [sourcePerson] = values;
        return;
      }
      if (sql.includes("FROM payment_invoices")) return [sourcePerson === 1 ? [row] : []];
      if (sql.includes("FROM payment_invoice_lines")) return [sourcePerson === 1 ? [line] : []];
      assert.match(sql, /REPEATABLE READ|READ ONLY/);
    },
    async rollback() {},
  };
  const destination = {
    async execute(sql, values) {
      if (sql.includes("FROM people2_people")) return [[{ person_id: 1 }]];
      if (sql.includes("FROM accounting_stripe_accounts")) return [[]];
      if (sql.includes("WHERE agent_invoice_id")) return [[previous].filter(Boolean)];
      assert.match(sql, /INSERT INTO accounting_invoices/);
      assert.equal(values.length, sql.split("?").length - 1);
      assert.deepEqual(values.slice(-2), ["17", "paid"]);
      previous = { owner_person_id: 1, stripe_invoice_id: null, stripe_account_id: null };
    },
    async query(sql, args) {
      if (sql === "START TRANSACTION READ ONLY") return;
      assert.match(sql, /INSERT INTO accounting_invoice_lines/);
      assert.deepEqual(args[0][0].slice(-2), ["agent-slayer://todos/15", "agent-slayer://files/4"]);
    },
    async beginTransaction() {}, async commit() { committed++; }, async rollback() {},
  };
  const input = { source, destination, sourcePerson: 1, owner: 1 };
  assert.equal((await importAgentInvoices({ ...input, sourcePerson: 2 })).sourceInvoices, 0);
  await assert.rejects(importAgentInvoices({ ...input, sourcePerson: 2, apply: true }), /No invoices found/);
  assert.equal((await importAgentInvoices(input)).create, 1);
  assert.equal(previous, undefined);
  assert.equal((await importAgentInvoices({ ...input, apply: true })).create, 1);
  assert.equal(committed, 1);
  assert.equal((await importAgentInvoices(input)).alreadyImported, 1);
});
