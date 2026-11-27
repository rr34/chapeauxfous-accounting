import { existsSync } from "node:fs";
import { withConnectionTransaction } from "../src/db.js";
import { invoiceTransaction, readInvoiceLines, saveInvoiceLedgerDraft } from "../src/invoice-ledger.js";
import { invoiceMinorToLedgerUnits } from "../src/invoice-payments.js";
import { validateTransaction } from "../src/accounting.js";

function requireMatch(condition, invoice, problem) {
  if (!condition) throw new Error(`Invoice #${invoice.invoice_number}: ${problem}`);
}

async function openGnuCash() {
  const filename = process.env.ACCOUNTING_GNUCASH_INVOICE_SOURCE
    ?? new URL("../../gnucash-file.sqlite", import.meta.url);
  if (!existsSync(filename)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(filename, { readOnly: true });
}

async function historicalPosting(db, invoice, source, units) {
  const [receipts] = await db.execute(`SELECT t.source_system,t.source_id,t.description,p.amount_minor
    FROM accounting_invoice_payments p JOIN line_items li USING (line_item_id)
    JOIN transactions t USING (transaction_id) WHERE p.invoice_id = ?`, [invoice.invoice_id]);
  if (!receipts.some((receipt) => receipt.source_system === "gnucash"
    || /^[0-9a-f]{32}\n/i.test(receipt.description ?? ""))) return null;
  requireMatch(source, invoice, "set ACCOUNTING_GNUCASH_INVOICE_SOURCE to the original SQLite file.");
  const lots = new Set();
  const findSplits = source.prepare(`SELECT i.guid, i.post_txn, s.value_num, s.value_denom
    FROM splits s JOIN invoices i ON i.post_lot = s.lot_guid AND i.post_acc = s.account_guid
    WHERE s.tx_guid = ? AND s.action = 'Payment'`);
  for (const receipt of receipts) {
    const guid = receipt.source_system === "gnucash" ? receipt.source_id
      : receipt.description?.match(/^([0-9a-f]{32})\n/i)?.[1];
    requireMatch(guid, invoice, "a linked receipt has no original GnuCash identity.");
    const matches = findSplits.all(guid).filter((split) =>
      -BigInt(split.value_num) * 100n === BigInt(receipt.amount_minor) * BigInt(split.value_denom));
    requireMatch(matches.length === 1, invoice, "a linked receipt does not identify one GnuCash invoice.");
    lots.add(matches[0].post_txn);
  }
  requireMatch(lots.size === 1 && invoice.currency === "USD", invoice, "its payments identify conflicting GnuCash postings.");
  const [[posting]] = await db.execute(`SELECT t.transaction_id FROM transactions t JOIN line_items li USING (transaction_id)
    WHERE t.owner_person_id = ? AND t.source_system = 'gnucash' AND t.source_id = ?
      AND t.TransactionState = 'posted' AND li.account_id = ? AND li.amount_units = ?`,
  [invoice.owner_person_id, [...lots][0], invoice.receivable_account_id, String(units)]);
  requireMatch(posting, invoice, "the original GnuCash charge could not be verified in the ledger.");
  return posting;
}

export async function migrateInvoiceLines(connection) {
  const [[{ present }]] = await connection.query(`SELECT COUNT(*) AS present FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounting_invoice_lines'`);
  // A restart after the drop can still advance the schema version.
  if (!Number(present)) return;
  const source = await openGnuCash();
  try {
    await withConnectionTransaction(connection, async (db) => {
      const [invoices] = await db.query(`SELECT i.*, a.account_currency_id, c.scale
        FROM accounting_invoices i JOIN accounts a ON a.account_id = i.receivable_account_id
        JOIN currencies c ON c.currency_id = a.account_currency_id ORDER BY i.invoice_id FOR UPDATE`);
      for (const invoice of invoices) {
        const [lines] = await db.execute(`SELECT * FROM accounting_invoice_lines
          WHERE invoice_id = ? ORDER BY position`, [invoice.invoice_id]);
        const total = BigInt(invoice.amount_minor);
        requireMatch(lines.reduce((sum, line) => sum + BigInt(line.amount_minor), 0n) === total,
          invoice, "saved invoice lines do not equal the invoice total.");
        const units = invoiceMinorToLedgerUnits(total, invoice.currency, Number(invoice.scale));
        const [[native]] = await db.execute(`SELECT transaction_id FROM transactions
          WHERE owner_person_id = ? AND source_system = 'accounting_invoice' AND source_id = ?`,
        [invoice.owner_person_id, invoice.invoice_id]);
        const posting = native ?? await historicalPosting(db, invoice, source, units);
        if (posting) {
          await db.execute("UPDATE accounting_invoices SET ledger_transaction_id = ? WHERE invoice_id = ?",
            [posting.transaction_id, invoice.invoice_id]);
          invoice.ledger_transaction_id = posting.transaction_id;
          for (const line of lines.filter((item) => item.receipt_ref)) {
            const [result] = await db.execute(`UPDATE line_items SET invoice_receipt_ref = ?
              WHERE transaction_id = ? AND source_id = ?`, [line.receipt_ref, posting.transaction_id, line.invoice_line_id]);
            requireMatch(result.affectedRows === 1, invoice, "an existing receipt lacks a matching ledger line.");
          }
        } else if (lines.length) {
          // Legacy documents without a matched posting remain outside ledger balances.
          await saveInvoiceLedgerDraft(db, invoice, { receivableId: Number(invoice.receivable_account_id),
            currencyId: Number(invoice.account_currency_id), scale: Number(invoice.scale),
            lineIds: lines.map((line) => Number(line.account_id)) },
          lines.map((line) => ({ ...line, id: line.invoice_line_id })));
          const [[saved]] = await db.execute("SELECT ledger_transaction_id FROM accounting_invoices WHERE invoice_id = ?",
            [invoice.invoice_id]);
          invoice.ledger_transaction_id = saved.ledger_transaction_id;
        }
        if (!invoice.ledger_transaction_id) continue;
        const transaction = await invoiceTransaction(db, invoice);
        await validateTransaction(db, Number(transaction.transaction_id), Number(invoice.owner_person_id), { lock: true });
        const projected = await readInvoiceLines(db, invoice, transaction);
        requireMatch(projected.reduce((sum, line) => sum + BigInt(line.amount_minor), 0n) === total,
          invoice, "the projected ledger lines do not equal the invoice total.");
        const refs = (items) => items.map((line) => line.receipt_ref).filter(Boolean).sort();
        requireMatch(JSON.stringify(refs(lines)) === JSON.stringify(refs(projected)), invoice, "receipt references differ.");
      }
    });
  } finally {
    source?.close();
  }
}
