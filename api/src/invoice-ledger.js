import { createHash, randomUUID } from "node:crypto";
import { createTransaction, invoicePostingSource, validateTransaction } from "./accounting.js";
import { invoiceMinorToLedgerUnits, ledgerUnitsToInvoiceMinor } from "./invoice-payments.js";

export async function invoiceTransaction(db, row, lock = false) {
  if (row.ledger_transaction_id == null) return null;
  const [[transaction]] = await db.execute(`SELECT transaction_id, TransactionDate, TransactionState FROM transactions
    WHERE owner_person_id = ? AND transaction_id = ?${lock ? " FOR UPDATE" : ""}`,
  [row.owner_person_id, row.ledger_transaction_id]);
  if (!transaction) throw new Error("Invoice ledger transaction is missing.");
  return transaction;
}

// Older imported ledger lines lack Accounting invoice-line UUIDs.
function invoiceLineId(line) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(line.source_id ?? "")) {
    return line.source_id;
  }
  const hash = createHash("sha256").update(`accounting:invoice-ledger-line:${line.line_item_id}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function readInvoiceLines(db, row, transaction, lock = false) {
  if (!transaction) return [];
  const [lines] = await db.execute(`SELECT li.line_item_id, li.source_id, li.memo AS description,
      li.account_id, li.amount_units, li.reconciliation_state, li.invoice_receipt_ref AS receipt_ref, c.scale
    FROM line_items li JOIN accounts a USING (account_id)
    JOIN currencies c ON c.currency_id = a.account_currency_id
    WHERE li.transaction_id = ? AND li.account_id <> ?
    ORDER BY li.line_item_id${lock ? " FOR UPDATE" : ""}`, [transaction.transaction_id, row.receivable_account_id]);
  return lines.map((line, index) => ({
    ...line, invoice_line_id: invoiceLineId(line), description: line.description ?? "", position: index + 1,
    amount_minor: ledgerUnitsToInvoiceMinor(-BigInt(line.amount_units), row.currency, Number(line.scale)),
  }));
}

export async function saveInvoiceLedgerDraft(db, row, accounts, lines, existing = []) {
  const owner = Number(row.owner_person_id);
  const units = (amount) => String(invoiceMinorToLedgerUnits(amount, row.currency, accounts.scale));
  const description = `Invoice #${row.invoice_number}${row.payer_name ? ` · ${row.payer_name}` : ""}`;
  const billingLines = lines.map((line, index) => ({
    accountId: accounts.lineIds[index], amountUnits: units(-BigInt(line.amount_minor)),
    memo: line.description, sourceId: existing[index]?.invoice_line_id ?? line.id ?? randomUUID(),
    receiptRef: line.receipt_ref ?? null,
  }));
  const arLine = { accountId: accounts.receivableId, amountUnits: units(row.amount_minor), memo: row.description };
  let transactionId = row.ledger_transaction_id;
  if (transactionId == null) {
    const result = await createTransaction({ personId: owner, transactionDate: row.created_at.slice(0, 10),
      valuationCurrencyId: accounts.currencyId, description, sourceSystem: invoicePostingSource, sourceId: row.invoice_id,
      lineItems: [arLine, ...billingLines], post: false,
    }, (work) => work(db));
    transactionId = result.transactionId;
    await db.execute("UPDATE accounting_invoices SET ledger_transaction_id = ? WHERE invoice_id = ? AND owner_person_id = ?",
      [transactionId, row.invoice_id, owner]);
    for (const line of billingLines.filter((item) => item.receiptRef)) {
      await db.execute("UPDATE line_items SET invoice_receipt_ref = ? WHERE transaction_id = ? AND source_id = ?",
        [line.receiptRef, transactionId, line.sourceId]);
    }
    return;
  }
  const transaction = await invoiceTransaction(db, row, true);
  if (transaction.TransactionState !== "draft") throw new Error("Only an invoice draft can replace its ledger lines.");
  const [updated] = await db.execute(`UPDATE line_items SET account_id = ?, amount_units = ?, value_units = ?, memo = ?
    WHERE transaction_id = ? AND source_id IS NULL`,
  [arLine.accountId, arLine.amountUnits, arLine.amountUnits, arLine.memo, transactionId]);
  if (updated.affectedRows !== 1) throw new Error("Invoice draft must have one receivable posting.");
  for (const [index, line] of billingLines.entries()) {
    if (existing[index]) {
      await db.execute(`UPDATE line_items SET account_id = ?, amount_units = ?, value_units = ?, memo = ?, invoice_receipt_ref = ?
        WHERE transaction_id = ? AND line_item_id = ?`, [line.accountId, line.amountUnits, line.amountUnits,
        line.memo, line.receiptRef, transactionId, existing[index].line_item_id]);
    } else {
      await db.execute(`INSERT INTO line_items (transaction_id, account_id, amount_units, value_units, memo, source_id, invoice_receipt_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [transactionId, line.accountId, line.amountUnits, line.amountUnits,
        line.memo, line.sourceId, line.receiptRef]);
    }
  }
  await db.execute(`UPDATE transactions SET description = ?, valuation_currency_id = ?, UpdatedAt = CURRENT_TIMESTAMP()
    WHERE transaction_id = ? AND owner_person_id = ?`, [description, accounts.currencyId, transactionId, owner]);
  await validateTransaction(db, Number(transactionId), owner, { lock: true });
}

export async function postInvoiceLedger(db, row, transactionDate) {
  const transaction = await invoiceTransaction(db, row, true);
  if (!transaction || transaction.TransactionState !== "draft" || BigInt(row.amount_minor) <= 0n) {
    throw Object.assign(new Error("The invoice needs a balanced draft posting and a positive total."),
      { code: "INVOICE_POSTING_TOTAL_INVALID", status: 400 });
  }
  const lines = await readInvoiceLines(db, row, transaction, true);
  if (!lines.length || lines.reduce((sum, line) => sum + BigInt(line.amount_minor), 0n) !== BigInt(row.amount_minor)) {
    throw Object.assign(new Error("The invoice total differs from the draft ledger lines."),
      { code: "INVOICE_POSTING_TOTAL_INVALID", status: 400 });
  }
  await validateTransaction(db, Number(transaction.transaction_id), Number(row.owner_person_id), { lock: true });
  await db.execute(`UPDATE transactions SET TransactionState = 'posted', TransactionDate = ?, UpdatedAt = CURRENT_TIMESTAMP()
    WHERE transaction_id = ? AND owner_person_id = ?`, [transactionDate, transaction.transaction_id, row.owner_person_id]);
}
