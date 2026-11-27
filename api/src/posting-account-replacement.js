import { createHash } from "node:crypto";
import { invoicePostingSource } from "./accounting.js";
import { accountingQuestionTagKeys } from "./accounting-questions.js";
import { withPoolTransaction } from "./db.js";

const maxTransactions = 10_000;
const maxSplits = 50_000;

function replacementError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export async function replacePostingAccount({ pool, personId, sourceAccountId, targetAccountId,
  transactionIds, reviewDigest = null }) {
  const validId = (id) => Number.isSafeInteger(id) && id > 0;
  if (!validId(sourceAccountId) || !validId(targetAccountId) || sourceAccountId === targetAccountId) {
    throw replacementError("Choose two different accounts.", "INVALID_REPLACEMENT_ACCOUNTS");
  }
  if (!Array.isArray(transactionIds) || transactionIds.length < 1 || transactionIds.length > maxTransactions
    || !transactionIds.every(validId) || new Set(transactionIds).size !== transactionIds.length) {
    throw replacementError("Select between 1 and 10,000 distinct transactions.", "INVALID_REPLACEMENT_SELECTION");
  }
  if (reviewDigest !== null && (typeof reviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(reviewDigest))) {
    throw replacementError("Review the account replacement before applying it.", "INVALID_REPLACEMENT_REVIEW");
  }

  const ids = [...transactionIds].sort((left, right) => left - right);
  const placeholders = ids.map(() => "?").join(", ");
  const lock = reviewDigest === null ? "" : " FOR UPDATE";
  return withPoolTransaction(pool, async (connection) => {
    // Invoice edits lock the invoice first, then its transaction and ledger lines.
    const [invoices] = await connection.query(
      `SELECT invoice_id, ledger_transaction_id, receivable_account_id, currency, revision
         FROM accounting_invoices WHERE owner_person_id = ? AND ledger_transaction_id IN (${placeholders})
        ORDER BY invoice_id${lock}`, [personId, ...ids]);
    const invoiceByTransaction = new Map(invoices.map((invoice) => [String(invoice.ledger_transaction_id), invoice]));
    const [transactions] = await connection.query(
      `SELECT transaction_id, source_system FROM transactions WHERE owner_person_id = ? AND TransactionState = 'posted'
          AND transaction_id IN (${placeholders})
        ORDER BY transaction_id${lock}`, [personId, ...ids]);
    if (transactions.length !== ids.length) {
      throw replacementError("Some selected transactions no longer exist or are unavailable. Refresh the register and select them again.",
        "REPLACEMENT_SELECTION_UNAVAILABLE", 409);
    }
    const invoiceSourced = new Set(transactions.filter((transaction) => transaction.source_system === invoicePostingSource)
      .map((transaction) => String(transaction.transaction_id)));

    const accountIds = [...new Set([sourceAccountId, targetAccountId,
      ...invoices.map((invoice) => Number(invoice.receivable_account_id))])];
    const [accounts] = await connection.query(
      `SELECT account_id, AccountName, AccountType, parent_account_id, account_currency_id,
              archived_at, is_placeholder, is_suspense
         FROM accounts WHERE owner_person_id = ? AND account_id IN (${accountIds.map(() => "?").join(", ")})
        ORDER BY account_id${lock}`, [personId, ...accountIds]);
    const accountById = new Map(accounts.map((account) => [Number(account.account_id), account]));
    const source = accountById.get(sourceAccountId);
    const target = accountById.get(targetAccountId);
    if (!source || !target || source.is_placeholder || target.is_placeholder || target.archived_at != null) {
      throw replacementError("Choose a postable source and an active, postable destination.", "REPLACEMENT_ACCOUNT_UNAVAILABLE");
    }
    if (Number(source.account_currency_id) !== Number(target.account_currency_id)) {
      throw replacementError("The two accounts must use the same currency.", "REPLACEMENT_CURRENCY_MISMATCH");
    }
    // Currency code and type cannot change once an account uses the unit.
    let invoiceCurrency = null;
    if (invoices.length) {
      const [[currency]] = await connection.query(
        "SELECT CurrencyAbbreviation, currency_type FROM currencies WHERE currency_id = ?", [target.account_currency_id]);
      invoiceCurrency = currency;
    }

    const [splits] = await connection.query(
      `SELECT li.line_item_id, li.transaction_id, li.amount_units, li.value_units, li.reconciliation_state,
              t.TransactionDate,
              EXISTS (SELECT 1 FROM accounting_invoice_payments p WHERE p.line_item_id = li.line_item_id) AS applied_payment,
              EXISTS (SELECT 1 FROM lineitems_tags_join j JOIN tags g ON g.tag_id = j.tag_id
                       WHERE j.tagged_line_item_id = li.line_item_id AND g.tag_key = ?) AS question_linked,
              EXISTS (SELECT 1 FROM line_item_evidence_links e WHERE e.line_item_id = li.line_item_id) AS statement_linked
         FROM line_items li JOIN transactions t ON t.transaction_id = li.transaction_id
        WHERE t.owner_person_id = ? AND li.account_id = ? AND li.transaction_id IN (${placeholders})
        ORDER BY li.line_item_id LIMIT ${maxSplits + 1}${lock}`,
      [accountingQuestionTagKeys.status, personId, sourceAccountId, ...ids]);
    if (splits.length > maxSplits) {
      throw replacementError("Select a smaller batch. Up to 50,000 matching splits can be moved at once.", "REPLACEMENT_TOO_MANY_SPLITS");
    }

    const blockers = { reconciled: 0, invoices: 0, invoiceDestinations: 0, questions: 0, statements: 0 };
    const affectedIds = new Set();
    const affectedInvoiceIds = new Set();
    const blockedIds = new Set();
    for (const split of splits) {
      affectedIds.add(split.transaction_id);
      const transactionId = String(split.transaction_id);
      const invoice = invoiceByTransaction.get(transactionId);
      const receivableId = Number(invoice?.receivable_account_id);
      const receivable = accountById.get(receivableId);
      const protectedInvoiceLine = Boolean(Number(split.applied_payment) || sourceAccountId === receivableId
        || (!invoice && invoiceSourced.has(transactionId)));
      const invalidInvoiceDestination = Boolean(invoice && !protectedInvoiceLine && (targetAccountId === receivableId
        || invoiceCurrency?.currency_type !== "iso_4217" || invoiceCurrency.CurrencyAbbreviation.trim() !== invoice.currency
        || receivable?.AccountType !== "asset" || receivable.is_placeholder || receivable.is_suspense || receivable.archived_at != null
        || Number(target.account_currency_id) !== Number(receivable?.account_currency_id)));
      const reconciled = split.reconciliation_state === "reconciled";
      blockers.reconciled += Number(reconciled);
      blockers.invoices += Number(protectedInvoiceLine);
      blockers.invoiceDestinations += Number(invalidInvoiceDestination);
      blockers.questions += Number(split.question_linked);
      blockers.statements += Number(split.statement_linked);
      if (reconciled || protectedInvoiceLine || invalidInvoiceDestination || Number(split.question_linked) || Number(split.statement_linked)) {
        blockedIds.add(Number(split.transaction_id));
      } else if (invoice) {
        affectedInvoiceIds.add(invoice.invoice_id);
      }
    }
    const digest = createHash("sha256")
      .update(JSON.stringify([personId, ids, sourceAccountId, targetAccountId, accounts, transactions, invoices, invoiceCurrency, splits]))
      .digest("hex");
    const summary = { reviewDigest: digest, selectedCount: ids.length, transactionCount: affectedIds.size,
      splitCount: splits.length, invoiceCount: affectedInvoiceIds.size, blockers, blockedTransactionIds: [...blockedIds] };
    if (reviewDigest === null) return summary;
    if (reviewDigest !== digest) {
      throw replacementError("The selected postings or accounts have changed. Review the batch again.", "REPLACEMENT_REVIEW_STALE", 409);
    }
    if (!splits.length || blockedIds.size) {
      throw replacementError("This batch has no matching splits or includes protected splits.", "REPLACEMENT_BLOCKED", 409);
    }

    // Same-currency reassignment preserves native units, valuation and transaction balance.
    for (let offset = 0; offset < splits.length; offset += 1000) {
      const lineIds = splits.slice(offset, offset + 1000).map((split) => split.line_item_id);
      const [updated] = await connection.query(
        `UPDATE line_items SET account_id = ? WHERE account_id = ? AND line_item_id IN (${lineIds.map(() => "?").join(", ")})`,
        [targetAccountId, sourceAccountId, ...lineIds]);
      if (Number(updated.affectedRows) !== lineIds.length) {
        throw replacementError("The full batch could not be moved. Review the batch again.", "REPLACEMENT_REVIEW_STALE", 409);
      }
    }
    await connection.query(
      `UPDATE transactions SET UpdatedAt = CURRENT_TIMESTAMP() WHERE owner_person_id = ?
        AND transaction_id IN (${[...affectedIds].map(() => "?").join(", ")})`, [personId, ...affectedIds]);
    if (affectedInvoiceIds.size) {
      await connection.query(
        `UPDATE accounting_invoices SET revision = UUID() WHERE owner_person_id = ?
          AND invoice_id IN (${[...affectedInvoiceIds].map(() => "?").join(", ")})`, [personId, ...affectedInvoiceIds]);
    }
    return summary;
  });
}
