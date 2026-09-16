import { withPoolTransaction } from "./db.js";
import { normalBalanceUnits } from "./account-balances.js";

function reconciliationError(message, code, details = undefined, status = 400) {
  return Object.assign(new Error(message), { status, code, details });
}

function calendarDate(value) {
  const text = String(value ?? "").trim();
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== text) {
    throw reconciliationError("balance_date must be a valid YYYY-MM-DD date.", "INVALID_RECONCILIATION_DATE");
  }
  return text;
}

export async function reconcileAccountThroughDate({ pool, personId, accountId, balanceDate }) {
  const resolvedAccountId = Number(accountId);
  if (!Number.isInteger(resolvedAccountId) || resolvedAccountId <= 0) {
    throw reconciliationError("Account ID is invalid.", "ACCOUNT_NOT_FOUND", undefined, 404);
  }
  const date = calendarDate(balanceDate);
  return withPoolTransaction(pool, async (connection) => {
    const [assertions] = await connection.query(
      `SELECT aba.account_balance_assertion_id, aba.known_balance_units,
              a.AccountName, a.AccountType, a.account_currency_id,
              c.CurrencyAbbreviation, c.scale
         FROM account_balance_assertions aba
         JOIN accounts a ON a.account_id = aba.account_id AND a.owner_person_id = aba.owner_person_id
         JOIN currencies c ON c.currency_id = a.account_currency_id
        WHERE aba.owner_person_id = ? AND aba.account_id = ? AND aba.balance_date = ?
        FOR UPDATE`,
      [personId, resolvedAccountId, date],
    );
    const assertion = assertions[0];
    if (!assertion) {
      throw reconciliationError("Save an exact known balance for this account and date before reconciling.",
        "BALANCE_ASSERTION_REQUIRED", { accountId: resolvedAccountId, balanceDate: date }, 409);
    }
    const [lines] = await connection.query(
      `SELECT li.line_item_id, li.amount_units, li.reconciliation_state, li.reconciled_at
         FROM line_items li
         JOIN transactions t ON t.transaction_id = li.transaction_id
        WHERE li.account_id = ? AND t.owner_person_id = ?
          AND t.TransactionState = 'posted' AND t.TransactionDate <= ?
        ORDER BY li.line_item_id
        FOR UPDATE`,
      [resolvedAccountId, personId, date],
    );
    const rawPostingUnits = lines.reduce((sum, line) => sum + BigInt(line.amount_units), 0n);
    const calculatedBalanceUnits = normalBalanceUnits(assertion.AccountType, rawPostingUnits);
    const knownBalanceUnits = String(assertion.known_balance_units);
    if (calculatedBalanceUnits !== knownBalanceUnits) {
      throw reconciliationError("The posted account balance does not match the known balance assertion.",
        "ACCOUNT_BALANCE_NOT_RECONCILED", {
          accountId: resolvedAccountId, balanceDate: date, knownBalanceUnits, calculatedBalanceUnits,
          differenceUnits: (BigInt(knownBalanceUnits) - BigInt(calculatedBalanceUnits)).toString(),
        }, 409);
    }
    const alreadyReconciledLineCount = lines.filter((line) => line.reconciliation_state === "reconciled").length;
    const [update] = await connection.query(
      `UPDATE line_items li
       JOIN transactions t ON t.transaction_id = li.transaction_id
          SET li.reconciliation_state = 'reconciled', li.reconciled_at = ?
        WHERE li.account_id = ? AND t.owner_person_id = ?
          AND t.TransactionState = 'posted' AND t.TransactionDate <= ?
          AND li.reconciliation_state <> 'reconciled'`,
      [date, resolvedAccountId, personId, date],
    );
    return {
      accountId: resolvedAccountId,
      accountName: assertion.AccountName,
      currencyId: Number(assertion.account_currency_id),
      currencyCode: String(assertion.CurrencyAbbreviation).trim(),
      scale: Number(assertion.scale),
      balanceDate: date,
      assertionId: Number(assertion.account_balance_assertion_id),
      knownBalanceUnits,
      calculatedBalanceUnits,
      matches: true,
      totalLineCount: lines.length,
      newlyReconciledLineCount: Number(update.affectedRows),
      alreadyReconciledLineCount,
    };
  });
}
