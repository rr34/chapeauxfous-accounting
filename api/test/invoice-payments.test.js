import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_DATABASE = "accounting_test";
const { createInvoiceService } = await import("../src/invoices.js");
const { linkInvoiceDeposit, previewInvoiceDeposit } = await import("../src/invoice-payments.js");
const { invoicePdfHtml } = await import("../src/invoice-pdf.js");

test("a bank deposit can pay an invoice even if its available offset was booked as income", async () => {
  const invoice = { invoice_id: randomUUID(), invoice_number: 7, owner_person_id: 7, currency: "USD",
    amount_minor: 5000, amount_remaining_minor: 5000 };
  const ar = { account_id: 2, account_currency_id: 1, scale: 2 };
  const line = (line_item_id, account_id, amount_units, AccountName, AccountType) => ({
    line_item_id, account_id, amount_units, value_units: amount_units, AccountName, AccountType, transaction_id: 77,
    account_currency_id: 1, account_owner_person_id: 7, is_placeholder: 0, is_suspense: 0,
    reconciliation_state: line_item_id === 10 ? "reconciled" : "unreconciled",
    TransactionDate: "2026-11-20", description: "Customer deposit", memo: null,
  });
  const lines = [line(10, 1, "7500", "Checking", "asset"), line(11, 3, "-6500", "Sales", "income"),
    line(12, 2, "-1000", "Receivables", "asset")];
  const db = {
    async execute(sql, args) {
      if (sql.includes("FROM line_items deposit")) {
        assert.deepEqual(args, [10, 7, 1]);
        return [lines];
      }
      if (sql.includes("FROM accounting_invoice_payments")) return [[{ line_item_id: 12, amount_minor: 1000 }]];
      if (sql.startsWith("UPDATE line_items")) {
        assert.equal(args[2], 11);
        [lines[1].amount_units, lines[1].value_units] = args;
        return [[]];
      }
      if (sql.startsWith("INSERT INTO line_items")) {
        assert.deepEqual(args, [77, "-5000", "-5000", null, 2]);
        lines.push(line(13, 2, "-5000", "Receivables", "asset"));
        return [{ insertId: 13 }];
      }
      assert.match(sql, /^UPDATE transactions/);
      return [[]];
    },
    async query(sql) {
      if (sql.includes("FROM transactions")) return [[{ valuation_currency_id: 1, TransactionState: "posted" }]];
      if (sql.includes("FROM line_items")) return [lines];
      assert.match(sql, /FROM xrates/);
      return [[]];
    },
  };
  const originalDeposit = { ...lines[0] };
  const available = await previewInvoiceDeposit(db, invoice, ar, 10);
  assert.deepEqual(available.map((option) => [option.depositLineItemId, option.lineItemId, option.accountName,
    option.offsetAccountName, option.availableMinor, option.moveOffset]), [[10, 11, "Checking", "Sales", 6500, true]]);
  const input = { line_item_id: 10, offset_line_item_id: 11, offset_account_id: 3, amount_minor: 5000 };
  await assert.rejects(linkInvoiceDeposit(db, invoice, ar, { ...input, amount_minor: 6501 }, 6501n),
    { code: "INVOICE_DEPOSIT_CHANGED" });
  assert.deepEqual(await linkInvoiceDeposit(db, invoice, ar, input, 5000n), { lineItemId: 13, transactionId: 77 });
  assert.deepEqual(lines[0], originalDeposit);
  assert.equal(lines[1].amount_units, "-1500");
  assert.deepEqual((await previewInvoiceDeposit(db, invoice, ar, 10)).map((option) => option.lineItemId), [13]);
  assert.deepEqual(await linkInvoiceDeposit(db, invoice, ar, {
    line_item_id: 10, offset_line_item_id: 13, offset_account_id: 2, amount_minor: 5000,
  }, 5000n), { lineItemId: 13, transactionId: 77 });
  assert.equal(lines.length, 4);
  lines[1].reconciliation_state = "reconciled";
  assert.deepEqual((await previewInvoiceDeposit(db, invoice, ar, 10)).map((option) => option.lineItemId), [13]);
});

test("historical invoices show ledger payment links without an app-issued posting", async () => {
  const id = randomUUID();
  const paymentId = randomUUID();
  const row = { invoice_id: id, invoice_number: 27, owner_person_id: 7, invoice_status: "paid",
    currency: "USD", ledger_transaction_id: 90, amount_minor: "49800", amount_paid_minor: "49800", amount_remaining_minor: "0",
    stripe_invoice_id: null };
  const invoices = createInvoiceService({
    async execute(sql, args) {
      if (sql.startsWith("SELECT * FROM accounting_invoices")) {
        assert.deepEqual(args, [7, id]);
        return [[row]];
      }
      if (sql.includes("FROM transactions")) return [[{ transaction_id: 90, TransactionState: "posted" }]];
      if (sql.includes("FROM line_items li") && sql.includes("invoice_receipt_ref")) return [[]];
      assert.match(sql, /FROM accounting_invoice_payments/);
      assert.match(sql, /COALESCE\(NULLIF\(TRIM\(li\.memo\)/);
      assert.match(sql, /deposit\.amount_units > 0/);
      assert.deepEqual(args, [id]);
      const payment = { payment_id: paymentId, transaction_id: "16573", amount_minor: "49800",
        TransactionDate: "2025-09-09", description: "Payment memo" };
      return [[
        { ...payment, receiving_account_id: 12, receiving_account_name: "Checking" },
        { ...payment, receiving_account_id: 12, receiving_account_name: "Checking" },
        { ...payment, receiving_account_id: 13, receiving_account_name: "Savings" },
      ]];
    },
  });
  const { objects: [invoice] } = await invoices.list(7, { invoice_id: id });
  assert.equal(invoice.postingTransactionId, 90);
  assert.deepEqual(invoice.payments, [
    { id: paymentId, transactionId: 16573, amountMinor: 49800, date: "2025-09-09",
      description: "Payment memo", receivingAccountNames: ["Checking", "Savings"],
      receivingAccounts: [{ accountId: 12, accountName: "Checking" }, { accountId: 13, accountName: "Savings" }] },
  ]);
});

test("new and existing receipts settle a posted invoice in partial amounts", async () => {
  const id = randomUUID();
  const owner = 7;
  const date = "2026-11-26";
  const ledger = (line_item_id, transaction_id, account_id, amount_units, is_suspense = 0) => ({
    line_item_id, transaction_id, account_id, amount_units, value_units: amount_units, is_suspense,
    account_owner_person_id: owner, account_currency_id: 1, is_placeholder: 0, memo: "Deposit",
  });
  let state = {
    invoice: { invoice_id: id, owner_person_id: owner, invoice_number: 46, revision: randomUUID(), currency: "USD",
      invoice_status: "open", receivable_account_id: 11, ledger_transaction_id: 40, amount_minor: "60000", amount_paid_minor: "0",
      amount_remaining_minor: "60000", payer_name: "Customer", stripe_invoice_id: null },
    ledger: [ledger(100, 50, 12, "20000"), ledger(101, 50, 11, "-20000"),
      ledger(200, 60, 12, "45000"), ledger(201, 60, 13, "-45000", 1)],
    payments: [],
  };
  let snapshot;
  let inTransaction = false;
  const bank = { account_id: 12 };
  const db = {
    getConnection: async () => db,
    async beginTransaction() {
      assert.equal(inTransaction, false);
      snapshot = structuredClone(state);
      inTransaction = true;
    },
    async commit() { inTransaction = false; },
    async rollback() { state = snapshot; inTransaction = false; },
    release() {},
    async query(sql, args) {
      assert.equal(inTransaction, true);
      if (sql.includes("FROM transactions")) return [[{ valuation_currency_id: 1, TransactionState: "posted" }]];
      if (sql.includes("FROM line_items")) return [state.ledger.filter((line) => line.transaction_id === args[0])];
      assert.match(sql, /FROM xrates/);
      return [[]];
    },
    async execute(sql, args) {
      const { invoice, ledger: lines, payments } = state;
      if (sql.startsWith("SELECT * FROM accounting_invoices")) {
        return [args[0] === owner && args[1] === id ? [invoice] : []];
      }
      if (sql.includes("FROM line_items li") && sql.includes("invoice_receipt_ref")) return [[]];
      if (sql.includes("FROM transactions")) return [[{ transaction_id: 40, TransactionState: "posted" }]];
      if (sql.includes("FROM accounts a JOIN currencies")) return [[{ account_id: 11, account_currency_id: 1, scale: 2 }]];
      if (sql.includes("SELECT account_id FROM accounts")) {
        assert.deepEqual(args, [12, owner, 1, 11]);
        return [[bank]];
      }
      if (sql.includes("SELECT line_item_id FROM line_items")) {
        return [lines.filter((line) => line.transaction_id === args[0] && line.source_id === args[1])];
      }
      if (sql.includes("SELECT request_sha256")) {
        const existing = payments.find((payment) => payment.invoice_id === args[0] && payment.payment_id === args[1]);
        return [existing ? [{ request_sha256: Buffer.from(existing.request_sha256) }] : []];
      }
      if (sql.includes("li.line_item_id = ? FOR UPDATE")) {
        return [lines.filter((line) => line.line_item_id === args.at(-1))];
      }
      if (sql.includes("SELECT amount_minor FROM accounting_invoice_payments")) {
        assert.match(sql, /FOR UPDATE/);
        return [payments.filter((payment) => payment.line_item_id === args[0])];
      }
      if (sql.includes("SUM(p.amount_minor)")) {
        assert.equal(args[0], owner);
        const exact = sql.includes("AND t.transaction_id = ?");
        if (exact) assert.doesNotMatch(sql, /LIMIT 40/);
        return [lines.filter((line) => Number(line.amount_units) < 0 && (!exact || line.transaction_id === args[6])).map((line) => ({
          ...line, TransactionDate: date, description: "Existing deposit", AccountName: line.is_suspense ? "Suspense" : "A/R",
          applied_minor: payments.filter((payment) => payment.line_item_id === line.line_item_id)
            .reduce((sum, payment) => sum + payment.amount_minor, 0),
        }))];
      }
      if (sql.startsWith("UPDATE line_items")) {
        const line = lines.find((item) => item.line_item_id === args[2]);
        [line.amount_units, line.value_units] = args;
        return [[]];
      }
      if (sql.startsWith("INSERT INTO line_items")) {
        const [transactionId, amount, value, memo, accountId] = args;
        lines.push({ ...ledger(202, transactionId, accountId, amount), value_units: value, memo });
        return [{ insertId: 202 }];
      }
      if (sql.startsWith("UPDATE transactions")) return [[]];
      if (sql.startsWith("INSERT INTO accounting_invoice_payments")) {
        assert.equal(inTransaction, true);
        const [payment_id, invoice_id, line_item_id, amount_minor, request_sha256] = args;
        payments.push({ payment_id, invoice_id, line_item_id, amount_minor, request_sha256 });
        return [[]];
      }
      if (sql.startsWith("UPDATE accounting_invoices")) {
        assert.equal(inTransaction, true);
        [invoice.amount_paid_minor, invoice.amount_remaining_minor, invoice.invoice_status, invoice.revision] = args;
        return [[]];
      }
      assert.match(sql, /SELECT p.payment_id/);
      return [payments.map((payment) => ({ ...payment,
        transaction_id: lines.find((line) => line.line_item_id === payment.line_item_id).transaction_id,
        TransactionDate: date,
      }))];
    },
  };
  const invoices = createInvoiceService(db, {
    postTransaction: (input, runInTransaction) => runInTransaction(async (connection) => {
      assert.equal(connection, db);
      assert.equal(inTransaction, true);
      assert.equal(input.transactionDate, date);
      assert.deepEqual(input.lineItems.map((line) => [line.accountId, line.amountUnits]), [[12, "10000"], [11, "-10000"]]);
      state.ledger.push(ledger(300, 70, 12, "10000"), { ...ledger(301, 70, 11, "-10000"), source_id: input.sourceId });
      return { transactionId: 70 };
    }),
  });
  const record = { request_id: randomUUID(), revision: state.invoice.revision, amount_minor: 10000,
    method: "record", receiving_account_id: 12, payment_date: date, memo: "Cash" };
  await assert.rejects(invoices.applyPayment(owner + 1, id, record), { code: "INVOICE_NOT_FOUND" });
  const first = await invoices.applyPayment(owner, id, record);
  assert.equal(first.invoice.status, "open");
  assert.equal(first.invoice.amountRemainingMinor, 50000);
  assert.equal(first.payment.transactionId, 70);
  assert.equal((await invoices.applyPayment(owner, id, record)).idempotentReplay, true);
  await assert.rejects(invoices.applyPayment(owner, id, { ...record, amount_minor: 20000 }),
    { code: "INVOICE_PAYMENT_REQUEST_CONFLICT" });
  assert.match(invoicePdfHtml(first.invoice, "Business"), /Balance due.*\$500\.00/);
  const credits = await invoices.paymentCredits(owner, id, "Deposit");
  assert.deepEqual(credits.map((credit) => [credit.lineItemId, credit.availableMinor, credit.fromSuspense]),
    [[101, 20000, false], [201, 45000, true]]);
  const picked = await invoices.paymentCredits(owner, id, undefined, 60);
  assert.deepEqual(picked.map((credit) => [credit.lineItemId, credit.transactionId, credit.availableMinor]),
    [[201, 60, 45000]]);
  assert.deepEqual(await invoices.paymentCredits(owner, id, undefined, 6), []);
  const applyLink = (line_item_id, amount_minor) => invoices.applyPayment(owner, id, {
    request_id: randomUUID(), revision: state.invoice.revision, method: "link", line_item_id, amount_minor,
  });
  const second = await applyLink(101, 15000);
  assert.equal(second.invoice.amountRemainingMinor, 35000);
  assert.equal(second.payment.transactionId, 50);
  await assert.rejects(applyLink(101, 5001), { code: "INVOICE_PAYMENT_EXCEEDS_CREDIT" });
  await assert.rejects(applyLink(201, 35001), { code: "INVOICE_PAYMENT_EXCEEDS_BALANCE" });
  const last = await applyLink(201, 35000);
  assert.equal(last.invoice.status, "paid");
  assert.equal(last.invoice.amountPaidMinor, 60000);
  assert.equal(last.invoice.amountRemainingMinor, 0);
  assert.equal(last.invoice.payments.length, 3);
  assert.equal(last.payment.transactionId, 60);
  assert.deepEqual(state.ledger.filter((line) => line.transaction_id === 60)
    .map((line) => [line.line_item_id, line.account_id, line.amount_units]),
  [[200, 12, "45000"], [201, 13, "-10000"], [202, 11, "-35000"]]);
});
