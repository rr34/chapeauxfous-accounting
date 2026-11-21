import { withPoolTransaction } from "./db.js";
import { getTransaction, validateTransaction } from "./accounting.js";
import { accountingQuestionTagKeys } from "./accounting-questions.js";

export const SUSPENSE_TRANSFER_MAX_DATE_GAP_DAYS = 3;
const LINE_MEMO_MAX_LENGTH = 16000;

function mergeError(message, code, details = undefined, status = 400) {
  return Object.assign(new Error(message), { message, code, details, status });
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw mergeError(`${label} is invalid.`,
    "INVALID_SUSPENSE_TRANSFER_MERGE");
  return id;
}

function calendarDayNumber(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value).slice(0, 10));
  if (!match) throw mergeError("A transfer transaction has an invalid accounting date.",
    "INVALID_SUSPENSE_TRANSFER_DATE", undefined, 409);
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
}

function appendAbsorbedHeaderToMemo(memo, description) {
  const existingMemo = memo == null ? "" : String(memo);
  const absorbedHeader = description == null ? "" : String(description);
  if (!absorbedHeader.trim() || existingMemo === absorbedHeader
    || existingMemo.endsWith(`\n${absorbedHeader}`)) return existingMemo || null;
  const mergedMemo = existingMemo ? `${existingMemo}\n${absorbedHeader}` : absorbedHeader;
  if (mergedMemo.length > LINE_MEMO_MAX_LENGTH) throw mergeError(
    "The absorbed transaction header cannot fit in the statement posting memo.",
    "SUSPENSE_TRANSFER_MEMO_TOO_LONG", { maximumLength: LINE_MEMO_MAX_LENGTH }, 409);
  return mergedMemo;
}

export async function mergeSuspenseTransferPair({
  pool, personId, lineItemIds, retainedTransactionId,
}) {
  if (!Array.isArray(lineItemIds) || lineItemIds.length !== 2) throw mergeError(
    "Choose exactly two opposite suspense questions to merge.", "INVALID_SUSPENSE_TRANSFER_MERGE");
  const ids = [...new Set(lineItemIds.map((id) => positiveId(id, "Suspense line item ID")))];
  if (ids.length !== 2) throw mergeError("Choose two different suspense questions.",
    "INVALID_SUSPENSE_TRANSFER_MERGE");
  const retainedId = positiveId(retainedTransactionId, "Retained transaction ID");
  const ownerId = positiveId(personId, "Owner ID");

  const result = await withPoolTransaction(pool, async (connection) => {
    const placeholders = ids.map(() => "?").join(", ");
    const [selected] = await connection.query(
      `SELECT li.line_item_id, li.transaction_id, li.amount_units, li.value_units, li.account_id,
              li.reconciliation_state, a.account_currency_id, a.is_suspense,
              t.TransactionDate, t.description, t.valuation_currency_id, t.TransactionState,
              t.reversal_of_transaction_id, t.source_system, t.source_id, t.source_fingerprint,
              EXISTS (
                SELECT 1 FROM lineitems_tags_join tagged
                JOIN tags tag ON tag.tag_id = tagged.tag_id
                WHERE tagged.tagged_line_item_id = li.line_item_id AND tag.owner_person_id = ?
                  AND tag.tag_key = ? AND tag.tag_value = 'open') AS is_open
         FROM line_items li
         JOIN transactions t ON t.transaction_id = li.transaction_id
         JOIN accounts a ON a.account_id = li.account_id
        WHERE t.owner_person_id = ? AND li.line_item_id IN (${placeholders})
        ORDER BY li.line_item_id FOR UPDATE`,
      [ownerId, accountingQuestionTagKeys.status, ownerId, ...ids],
    );
    if (selected.length !== 2) throw mergeError("Both suspense questions must still exist.",
      "SUSPENSE_TRANSFER_PAIR_NOT_FOUND", undefined, 404);
    if (selected.some((line) => line.TransactionState !== "posted" || !Boolean(line.is_open)
      || !Boolean(line.is_suspense))) throw mergeError(
      "Both lines must still be open questions in a designated suspense account.",
      "SUSPENSE_TRANSFER_PAIR_NOT_OPEN", undefined, 409);
    if (Number(selected[0].account_id) !== Number(selected[1].account_id)
      || Number(selected[0].account_currency_id) !== Number(selected[1].account_currency_id)) {
      throw mergeError("Both lines must use the same designated suspense account and currency.",
        "SUSPENSE_TRANSFER_SCOPE_MISMATCH");
    }
    if (Number(selected[0].transaction_id) === Number(selected[1].transaction_id)
      || BigInt(selected[0].amount_units) !== -BigInt(selected[1].amount_units)) {
      throw mergeError("The two suspense lines must come from different transactions with exact opposite amounts.",
        "SUSPENSE_TRANSFER_AMOUNT_MISMATCH");
    }
    if ((selected[0].value_units == null) !== (selected[1].value_units == null)
      || (selected[0].value_units != null
        && BigInt(selected[0].value_units) !== -BigInt(selected[1].value_units))) {
      throw mergeError("The two suspense lines must have exact opposite transaction values.",
        "SUSPENSE_TRANSFER_VALUE_MISMATCH");
    }
    const gapDays = Math.abs(calendarDayNumber(selected[0].TransactionDate)
      - calendarDayNumber(selected[1].TransactionDate));
    if (gapDays > SUSPENSE_TRANSFER_MAX_DATE_GAP_DAYS) throw mergeError(
      `The transaction dates must be within ${SUSPENSE_TRANSFER_MAX_DATE_GAP_DAYS} calendar days.`,
      "SUSPENSE_TRANSFER_DATE_GAP", { gapDays, maximumDays: SUSPENSE_TRANSFER_MAX_DATE_GAP_DAYS });
    const transactionIds = selected.map((line) => Number(line.transaction_id));
    if (!transactionIds.includes(retainedId)) throw mergeError(
      "The retained transaction must be one of the selected pair.", "INVALID_SUSPENSE_TRANSFER_RETAINED_TRANSACTION");
    if (selected.some((line) => Number(line.valuation_currency_id) !== Number(selected[0].valuation_currency_id)
      || line.reversal_of_transaction_id != null)) throw mergeError(
      "The exact transfer merge supports ordinary same-valuation transactions, not reversals.",
      "SUSPENSE_TRANSFER_UNSUPPORTED_TRANSACTION");

    const [evidenceJobs] = await connection.query(
      `SELECT pejl.line_item_id, pej.purchase_evidence_job_id
         FROM accounting_purchase_evidence_job_lines pejl
         JOIN accounting_purchase_evidence_jobs pej
           ON pej.purchase_evidence_job_id = pejl.purchase_evidence_job_id
        WHERE pej.owner_person_id = ? AND pejl.line_item_id IN (${placeholders})
        FOR UPDATE`,
      [ownerId, ...ids],
    );
    if (evidenceJobs.length) throw mergeError(
      "A selected line belongs to a purchase-evidence workflow and cannot be merged as a transfer.",
      "SUSPENSE_TRANSFER_PURCHASE_EVIDENCE_CONFLICT", {
        purchaseEvidenceJobIds: [...new Set(evidenceJobs.map((row) =>
          String(row.purchase_evidence_job_id)))],
      }, 409);

    const txPlaceholders = transactionIds.map(() => "?").join(", ");
    const [lines] = await connection.query(
      `SELECT li.line_item_id, li.transaction_id, li.account_id, li.amount_units, li.value_units, li.memo,
              a.account_currency_id, a.AccountName
         FROM line_items li
         JOIN accounts a ON a.account_id = li.account_id
        WHERE li.transaction_id IN (${txPlaceholders})
        ORDER BY li.transaction_id, li.line_item_id FOR UPDATE`,
      transactionIds,
    );
    const byTransaction = new Map(transactionIds.map((id) => [id, []]));
    for (const line of lines) byTransaction.get(Number(line.transaction_id))?.push(line);
    if ([...byTransaction.values()].some((transactionLines) => transactionLines.length !== 2)
      || lines.some((line) => Number(line.account_currency_id) !== Number(selected[0].account_currency_id))) {
      throw mergeError("Exact transfer merging currently requires two ordinary two-line transactions in one currency.",
        "SUSPENSE_TRANSFER_UNSUPPORTED_TRANSACTION");
    }
    const [rates] = await connection.query(
      `SELECT xrate_id FROM xrates WHERE owner_person_id = ?
        AND transaction_id IN (${txPlaceholders}) LIMIT 1 FOR UPDATE`,
      [ownerId, ...transactionIds],
    );
    if (rates.length) throw mergeError("Transactions with retained exchange-rate rows cannot use exact transfer merging.",
      "SUSPENSE_TRANSFER_UNSUPPORTED_TRANSACTION");
    const [externalReversals] = await connection.query(
      `SELECT transaction_id FROM transactions WHERE owner_person_id = ?
        AND reversal_of_transaction_id IN (${txPlaceholders}) LIMIT 1 FOR UPDATE`,
      [ownerId, ...transactionIds],
    );
    if (externalReversals.length) throw mergeError("A reversal transaction depends on one selected transaction.",
      "SUSPENSE_TRANSFER_UNSUPPORTED_TRANSACTION", undefined, 409);

    const retainedSelected = selected.find((line) => Number(line.transaction_id) === retainedId);
    const absorbedSelected = selected.find((line) => Number(line.transaction_id) !== retainedId);
    const absorbedId = Number(absorbedSelected.transaction_id);
    const retainedOther = byTransaction.get(retainedId).find((line) =>
      Number(line.line_item_id) !== Number(retainedSelected.line_item_id));
    const absorbedOther = byTransaction.get(absorbedId).find((line) =>
      Number(line.line_item_id) !== Number(absorbedSelected.line_item_id));
    if (Number(retainedOther.account_id) === Number(absorbedOther.account_id)) throw mergeError(
      "The two statement sides must belong to different real accounts.",
      "SUSPENSE_TRANSFER_COUNTERPART_MISMATCH");

    await connection.query(
      `INSERT INTO accounting_transaction_merges
        (owner_person_id, retained_transaction_id, absorbed_transaction_id,
         retained_suspense_line_item_id, absorbed_suspense_line_item_id,
         absorbed_transaction_date, absorbed_description, absorbed_valuation_currency_id,
         absorbed_source_system, absorbed_source_id, absorbed_source_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ownerId, retainedId, absorbedId, Number(retainedSelected.line_item_id),
        Number(absorbedSelected.line_item_id), String(absorbedSelected.TransactionDate).slice(0, 10),
        absorbedSelected.description, Number(absorbedSelected.valuation_currency_id),
        absorbedSelected.source_system, absorbedSelected.source_id, absorbedSelected.source_fingerprint],
    );
    await connection.query(
      "UPDATE accounting_transaction_merges SET retained_transaction_id = ? WHERE retained_transaction_id = ? AND owner_person_id = ?",
      [retainedId, absorbedId, ownerId],
    );
    await connection.query(
      "UPDATE accounting_transaction_import_items SET ledger_transaction_id = ? WHERE ledger_transaction_id = ?",
      [retainedId, absorbedId],
    );
    const movedLineMemo = appendAbsorbedHeaderToMemo(absorbedOther.memo, absorbedSelected.description);
    await connection.query("UPDATE line_items SET transaction_id = ?, memo = ? WHERE line_item_id = ?",
      [retainedId, movedLineMemo, Number(absorbedOther.line_item_id)]);
    await connection.query(`DELETE FROM line_items WHERE line_item_id IN (${placeholders})`, ids);
    await connection.query("DELETE FROM transactions WHERE transaction_id = ? AND owner_person_id = ?",
      [absorbedId, ownerId]);
    await connection.query(
      "UPDATE transactions SET UpdatedAt = CURRENT_TIMESTAMP() WHERE transaction_id = ? AND owner_person_id = ?",
      [retainedId, ownerId],
    );
    await validateTransaction(connection, retainedId, ownerId, { lock: true });
    return {
      retainedTransactionId: retainedId,
      absorbedTransactionId: absorbedId,
      retainedDate: String(retainedSelected.TransactionDate).slice(0, 10),
      absorbedDate: String(absorbedSelected.TransactionDate).slice(0, 10),
      dateGapDays: gapDays,
      amountUnits: String(retainedSelected.amount_units),
      movedLineItemId: Number(absorbedOther.line_item_id),
      retainedAccountId: Number(retainedOther.account_id),
      retainedAccountName: String(retainedOther.AccountName),
      absorbedAccountId: Number(absorbedOther.account_id),
      absorbedAccountName: String(absorbedOther.AccountName),
    };
  });
  return { ...result, transaction: await getTransaction(pool, ownerId, result.retainedTransactionId) };
}
