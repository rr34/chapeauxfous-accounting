import { z } from "zod";
import { invoicePostingSource, validateTransaction } from "./accounting.js";
import { accountingQuestionTagKeys, resolveAccountingQuestionWithConnection } from "./accounting-questions.js";

const paymentFields = {
  request_id: z.uuid(),
  revision: z.uuid(),
  amount_minor: z.number().int().positive(),
};
export const recordInvoicePaymentInput = z.object({ ...paymentFields, method: z.literal("record"),
  receiving_account_id: z.number().int().positive(), payment_date: z.iso.date(),
  memo: z.string().trim().max(500).optional() });
export const linkInvoicePaymentInput = z.object({ ...paymentFields, method: z.literal("link"), line_item_id: z.number().int().positive() });
const linkDepositInput = z.object({ ...paymentFields, method: z.literal("deposit"), line_item_id: z.number().int().positive(),
  offset_line_item_id: z.number().int().positive(), offset_account_id: z.number().int().positive() });
export const invoicePaymentInput = z.discriminatedUnion("method", [recordInvoicePaymentInput, linkInvoicePaymentInput, linkDepositInput]);

const error = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
const minorScale = (currency) => new Intl.NumberFormat("en", { style: "currency", currency })
  .resolvedOptions().maximumFractionDigits;

export function invoiceMinorToLedgerUnits(amount, currency, ledgerScale) {
  const diff = ledgerScale - minorScale(currency);
  const scaled = BigInt(amount) * 10n ** BigInt(Math.max(diff, 0));
  const divisor = 10n ** BigInt(Math.max(-diff, 0));
  const units = scaled / divisor;
  if (scaled % divisor || units > 9223372036854775807n || units < -9223372036854775808n) {
    throw error("The invoice amount cannot be represented in ledger currency units.", "INVOICE_AMOUNT_SCALE_INVALID", 400);
  }
  return units;
}

export function ledgerUnitsToInvoiceMinor(units, currency, ledgerScale) {
  const diff = minorScale(currency) - ledgerScale;
  const scaled = BigInt(units) * 10n ** BigInt(Math.max(diff, 0));
  const divisor = 10n ** BigInt(Math.max(-diff, 0));
  const amount = Number(scaled / divisor);
  if (scaled % divisor || !Number.isSafeInteger(amount)) {
    throw error("The ledger amount cannot be represented in invoice minor units.", "INVOICE_AMOUNT_SCALE_INVALID", 400);
  }
  return amount;
}

function availableMinor(units, currency, ledgerScale) {
  const diff = minorScale(currency) - ledgerScale;
  return units * 10n ** BigInt(Math.max(diff, 0)) / (10n ** BigInt(Math.max(-diff, 0)));
}

export async function paymentReceivable(db, row, lock = false) {
  const [[account]] = await db.execute(`SELECT a.account_id, a.account_currency_id, c.scale
    FROM accounts a JOIN currencies c ON c.currency_id = a.account_currency_id
    WHERE a.account_id = ? AND a.owner_person_id = ? AND a.AccountType = 'asset'
      AND a.is_placeholder = 0 AND a.is_suspense = 0 AND a.archived_at IS NULL
      AND c.currency_type = 'iso_4217' AND c.CurrencyAbbreviation = ?${lock ? " FOR UPDATE" : ""}`,
  [row.receivable_account_id, row.owner_person_id, row.currency]);
  if (!account) throw error("The invoice needs an active A/R account to apply payments.", "INVOICE_RECEIVABLE_ACCOUNT_REQUIRED", 400);
  return account;
}

const eligibleCredit = `
  FROM line_items li
  JOIN transactions t ON t.transaction_id = li.transaction_id
  JOIN accounts a ON a.account_id = li.account_id AND a.owner_person_id = t.owner_person_id
  WHERE t.owner_person_id = ? AND t.TransactionState = 'posted' AND t.valuation_currency_id = ?
    AND (t.source_system IS NULL OR t.source_system <> ?) AND a.account_currency_id = ?
    AND NOT EXISTS (SELECT 1 FROM accounting_invoices issued WHERE issued.ledger_transaction_id = t.transaction_id)
    AND li.amount_units < 0 AND (li.value_units IS NULL OR li.value_units = li.amount_units)
    AND (a.account_id = ? OR (a.is_suspense = 1 AND li.reconciliation_state = 'unreconciled'))
    AND EXISTS (SELECT 1 FROM line_items deposit
      JOIN accounts receiving ON receiving.account_id = deposit.account_id
      WHERE deposit.transaction_id = t.transaction_id AND deposit.amount_units > 0
        AND receiving.owner_person_id = t.owner_person_id AND receiving.account_currency_id = a.account_currency_id
        AND receiving.AccountType = 'asset' AND receiving.is_suspense = 0 AND receiving.is_placeholder = 0
        AND receiving.account_id <> ?)`;

const creditParameters = (row, ar) => [row.owner_person_id, ar.account_currency_id, invoicePostingSource,
  ar.account_currency_id, ar.account_id, ar.account_id];

export async function findInvoicePaymentCredits(db, row, ar, text, transactionId) {
  const exactTransaction = transactionId != null;
  const description = exactTransaction ? "COALESCE(NULLIF(TRIM(li.memo), ''), t.description)" : "t.description";
  const match = exactTransaction ? "t.transaction_id = ?" : `(? IS NULL OR LOCATE(LOWER(?),
    LOWER(CONCAT_WS(' ', t.transaction_id, t.TransactionDate, t.description, li.memo, a.AccountName))) > 0)`;
  const [rows] = await db.execute(`SELECT eligible.* FROM (
      SELECT li.line_item_id, t.transaction_id, t.TransactionDate,
        ${description} AS description,
        a.AccountName, a.is_suspense, li.amount_units,
        COALESCE((SELECT SUM(p.amount_minor) FROM accounting_invoice_payments p WHERE p.line_item_id = li.line_item_id), 0) AS applied_minor
      ${eligibleCredit}
      AND ${match}
    ) AS eligible
    WHERE (-CAST(amount_units AS DECIMAL(65,0)) * CAST(? AS DECIMAL(65,0))
      >= (applied_minor + 1) * CAST(? AS DECIMAL(65,0)))
    ORDER BY TransactionDate DESC, transaction_id DESC, line_item_id
    ${exactTransaction ? "" : "LIMIT 40"}`,
  [...creditParameters(row, ar), ...(exactTransaction ? [transactionId] : [text ?? null, text ?? null]),
    String(10n ** BigInt(minorScale(row.currency))), String(10n ** BigInt(ar.scale))]);
  return rows.flatMap((line) => {
    const amount = availableMinor(-BigInt(line.amount_units), row.currency, ar.scale) - BigInt(line.applied_minor);
    if (amount <= 0n) return [];
    return [{ lineItemId: Number(line.line_item_id), transactionId: Number(line.transaction_id),
      date: line.TransactionDate, description: line.description, accountName: line.AccountName,
      fromSuspense: Boolean(line.is_suspense), availableMinor: Math.min(Number(amount), Number.MAX_SAFE_INTEGER) }];
  });
}

export async function readInvoicePayments(db, invoiceId) {
  const [rows] = await db.execute(`SELECT p.payment_id, p.amount_minor, li.transaction_id, t.TransactionDate,
      COALESCE(NULLIF(TRIM(li.memo), ''), NULLIF(TRIM(t.description), '')) AS description,
      receiving.account_id AS receiving_account_id, receiving.AccountName AS receiving_account_name
    FROM accounting_invoice_payments p
    JOIN line_items li ON li.line_item_id = p.line_item_id
    JOIN transactions t ON t.transaction_id = li.transaction_id
    LEFT JOIN line_items deposit ON deposit.transaction_id = t.transaction_id
      AND deposit.amount_units > 0 AND deposit.account_id <> li.account_id
    LEFT JOIN accounts receiving ON receiving.account_id = deposit.account_id
      AND receiving.owner_person_id = t.owner_person_id AND receiving.AccountType = 'asset'
      AND receiving.is_suspense = 0 AND receiving.is_placeholder = 0
    WHERE p.invoice_id = ?
    ORDER BY t.TransactionDate, p.created_at, p.payment_id, receiving.account_id`, [invoiceId]);
  const payments = new Map();
  for (const row of rows) {
    if (!payments.has(row.payment_id)) {
      payments.set(row.payment_id, {
        id: row.payment_id, amountMinor: Number(row.amount_minor), transactionId: Number(row.transaction_id),
        date: row.TransactionDate, description: row.description ?? null, receivingAccounts: new Map(),
      });
    }
    if (row.receiving_account_id != null) {
      payments.get(row.payment_id).receivingAccounts.set(Number(row.receiving_account_id), row.receiving_account_name);
    }
  }
  return [...payments.values()].map(({ receivingAccounts, ...payment }) => ({
    ...payment, receivingAccountNames: [...receivingAccounts.values()],
    receivingAccounts: [...receivingAccounts].map(([accountId, accountName]) => ({ accountId, accountName })),
  }));
}

export async function recordInvoicePayment(db, row, ar, input, units, postTransaction) {
  const [[receiving]] = await db.execute(`SELECT account_id FROM accounts
    WHERE account_id = ? AND owner_person_id = ? AND account_currency_id = ? AND AccountType = 'asset'
      AND is_placeholder = 0 AND is_suspense = 0 AND archived_at IS NULL AND account_id <> ? FOR UPDATE`,
  [input.receiving_account_id, row.owner_person_id, ar.account_currency_id, ar.account_id]);
  if (!receiving) throw error("Choose an active cash, bank, or other receiving asset account in the invoice currency.",
    "INVOICE_PAYMENT_RECEIVING_ACCOUNT_INVALID", 400);
  const { transactionId } = await postTransaction({
    personId: Number(row.owner_person_id), transactionDate: input.payment_date,
    description: `Payment for invoice #${row.invoice_number}`, valuationCurrencyId: Number(ar.account_currency_id),
    sourceSystem: "accounting_invoice_payment", sourceId: input.request_id,
    lineItems: [{ accountId: Number(receiving.account_id), amountUnits: String(units), memo: input.memo },
      { accountId: Number(ar.account_id), amountUnits: String(-units), sourceId: input.request_id }],
  }, (work) => work(db));
  const [[credit]] = await db.execute("SELECT line_item_id FROM line_items WHERE transaction_id = ? AND source_id = ?",
    [transactionId, input.request_id]);
  return { lineItemId: credit.line_item_id, transactionId };
}

export async function linkInvoicePayment(db, row, ar, input, units) {
  const [[line]] = await db.execute(`SELECT li.line_item_id, li.amount_units, li.value_units, li.memo,
      a.is_suspense, t.transaction_id ${eligibleCredit} AND li.line_item_id = ? FOR UPDATE`,
  [...creditParameters(row, ar), input.line_item_id]);
  if (!line) throw error("That ledger line is no longer available as an invoice payment.", "INVOICE_PAYMENT_LINE_UNAVAILABLE");
  const [existing] = await db.execute("SELECT amount_minor FROM accounting_invoice_payments WHERE line_item_id = ? FOR UPDATE",
    [line.line_item_id]);
  const used = existing.reduce((sum, payment) => sum + invoiceMinorToLedgerUnits(payment.amount_minor, row.currency, ar.scale), 0n);
  const available = -BigInt(line.amount_units) - used;
  if (units > available) throw error("The payment exceeds the available amount on the ledger line.", "INVOICE_PAYMENT_EXCEEDS_CREDIT");
  return settlePaymentCredit(db, row, ar, line, units, Boolean(Number(line.is_suspense)));
}

async function depositPaymentOptions(db, row, ar, depositId, lock = false) {
  const [lines] = await db.execute(`SELECT li.line_item_id, li.transaction_id, li.account_id,
      li.amount_units, li.value_units, li.memo, li.reconciliation_state, a.AccountName,
      a.AccountType, a.account_currency_id, a.is_suspense, a.is_placeholder,
      t.TransactionDate, t.description
    FROM line_items deposit
    JOIN transactions t ON t.transaction_id = deposit.transaction_id
    JOIN line_items li ON li.transaction_id = t.transaction_id
    JOIN accounts a ON a.account_id = li.account_id AND a.owner_person_id = t.owner_person_id
    WHERE deposit.line_item_id = ? AND t.owner_person_id = ? AND t.TransactionState = 'posted'
      AND t.valuation_currency_id = ?
      AND NOT EXISTS (SELECT 1 FROM accounting_invoices i WHERE i.ledger_transaction_id = t.transaction_id)
    ORDER BY li.line_item_id${lock ? " FOR UPDATE" : ""}`, [depositId, row.owner_person_id, ar.account_currency_id]);
  const isDeposit = (line) => line.AccountType === "asset" && !Number(line.is_suspense) && !Number(line.is_placeholder)
    && BigInt(line.amount_units) > 0n;
  const deposit = lines.find((line) => Number(line.line_item_id) === depositId);
  if (!deposit || !isDeposit(deposit) || Number(deposit.account_id) === Number(ar.account_id)
    || Number(deposit.account_currency_id) !== Number(ar.account_currency_id)
    || (deposit.value_units != null && BigInt(deposit.value_units) !== BigInt(deposit.amount_units))) {
    throw error("Choose a posted line where money came into a bank or cash account in the invoice’s currency.",
      "INVOICE_DEPOSIT_LINE_UNAVAILABLE");
  }
  if (lines.filter(isDeposit).length !== 1) {
    throw error("This entry has more than one receiving line. Use an entry with a single bank or cash receipt to apply it here.",
      "INVOICE_DEPOSIT_AMBIGUOUS");
  }
  const [allocations] = await db.execute(`SELECT p.line_item_id, p.amount_minor
    FROM accounting_invoice_payments p JOIN line_items li ON li.line_item_id = p.line_item_id
    WHERE li.transaction_id = ?${lock ? " FOR UPDATE" : ""}`, [deposit.transaction_id]);
  const used = new Map();
  let depositRemaining = BigInt(deposit.amount_units);
  for (const allocation of allocations) {
    const amount = invoiceMinorToLedgerUnits(allocation.amount_minor, row.currency, ar.scale);
    const lineId = Number(allocation.line_item_id);
    used.set(lineId, (used.get(lineId) ?? 0n) + amount);
    depositRemaining -= amount;
  }
  const options = lines.flatMap((line) => {
    if (Number(line.account_currency_id) !== Number(ar.account_currency_id) || Number(line.is_placeholder)
      || Number(line.account_id) === Number(deposit.account_id)
      || BigInt(line.amount_units) >= 0n
      || (line.value_units != null && BigInt(line.value_units) !== BigInt(line.amount_units))) return [];
    const move = Number(line.account_id) !== Number(ar.account_id);
    const allocated = used.get(Number(line.line_item_id)) ?? 0n;
    if (move && (line.reconciliation_state === "reconciled" || allocated > 0n)) return [];
    const capacity = -BigInt(line.amount_units) - allocated;
    const remaining = capacity < depositRemaining ? capacity : depositRemaining;
    const minor = availableMinor(remaining, row.currency, ar.scale);
    if (minor <= 0n) return [];
    return [{ line, move, available: Math.min(Number(minor), Number.MAX_SAFE_INTEGER) }];
  });
  if (!options.length) {
    throw error(depositRemaining <= 0n ? "This deposit has already been fully applied."
      : "There’s no available offset on this deposit. Its offset may already be reconciled or applied to another invoice.",
    "INVOICE_DEPOSIT_OFFSET_UNAVAILABLE");
  }
  return { deposit, options };
}

export async function previewInvoiceDeposit(db, row, ar, depositId) {
  const { deposit, options } = await depositPaymentOptions(db, row, ar, depositId);
  const existing = options.filter((option) => !option.move);
  const balance = Number(row.amount_remaining_minor ?? row.amount_minor);
  const choices = existing.length === 1 && existing[0].available >= balance ? existing : options;
  return choices.map(({ line, move, available }) => ({
    lineItemId: Number(line.line_item_id), transactionId: Number(deposit.transaction_id),
    date: deposit.TransactionDate, description: deposit.memo?.trim() || deposit.description,
    accountName: deposit.AccountName, availableMinor: available,
    depositLineItemId: depositId, offsetAccountId: Number(line.account_id), offsetAccountName: line.AccountName,
    offsetMemo: line.memo, moveOffset: move, receivableAccountId: Number(ar.account_id),
  }));
}

export async function linkInvoiceDeposit(db, row, ar, input, units) {
  const { options } = await depositPaymentOptions(db, row, ar, input.line_item_id, true);
  const choice = options.find(({ line }) => Number(line.line_item_id) === input.offset_line_item_id
    && Number(line.account_id) === input.offset_account_id);
  if (!choice || input.amount_minor > choice.available) {
    throw error("This deposit changed. Select it again to review the available amount.", "INVOICE_DEPOSIT_CHANGED");
  }
  return settlePaymentCredit(db, row, ar, choice.line, units, choice.move);
}

async function settlePaymentCredit(db, row, ar, line, units, move) {
  const transactionId = Number(line.transaction_id);
  if (!move) return { lineItemId: line.line_item_id, transactionId };

  let lineItemId = line.line_item_id;
  const remaining = BigInt(line.amount_units) + units;
  if (remaining === 0n) {
    const [[question]] = Number(line.is_suspense) ? await db.execute(`SELECT tag.tag_id FROM lineitems_tags_join tagged
      JOIN tags tag ON tag.tag_id = tagged.tag_id
      WHERE tagged.tagged_line_item_id = ? AND tag.owner_person_id = ? AND tag.tag_key = ? AND tag.tag_value = 'open'`,
    [lineItemId, row.owner_person_id, accountingQuestionTagKeys.status]) : [[]];
    if (question) {
      await resolveAccountingQuestionWithConnection(db, { personId: Number(row.owner_person_id),
        lineItemId: Number(lineItemId), targetAccountId: Number(ar.account_id), resolution: `Payment for invoice #${row.invoice_number}` });
      return { lineItemId, transactionId };
    } else {
      await db.execute("UPDATE line_items SET account_id = ? WHERE line_item_id = ?", [ar.account_id, lineItemId]);
    }
  } else {
    await db.execute("UPDATE line_items SET amount_units = ?, value_units = ? WHERE line_item_id = ?",
      [String(remaining), line.value_units == null ? null : String(remaining), lineItemId]);
    const [credit] = await db.execute(`INSERT INTO line_items (transaction_id, amount_units, value_units, memo, account_id)
      VALUES (?, ?, ?, ?, ?)`, [transactionId, String(-units), String(-units), line.memo, ar.account_id]);
    lineItemId = credit.insertId;
  }
  await validateTransaction(db, transactionId, Number(row.owner_person_id), { lock: true });
  await db.execute("UPDATE transactions SET UpdatedAt = CURRENT_TIMESTAMP() WHERE transaction_id = ? AND owner_person_id = ?",
    [transactionId, row.owner_person_id]);
  return { lineItemId, transactionId };
}
