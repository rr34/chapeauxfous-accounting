import { normalBalanceSign, normalBalanceUnits } from "./account-balances.js";

function applicationError(message, status = 400, code = "INVALID_RECONCILIATION_CONTEXT", details = undefined) {
  return Object.assign(new Error(message), { status, code, details });
}

function calendarDate(value, field) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw applicationError(`${field} must use YYYY-MM-DD.`, 400, "INVALID_RECONCILIATION_DATE", { field });
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw applicationError(`${field} is not a calendar date.`, 400, "INVALID_RECONCILIATION_DATE", { field });
  }
  return text;
}

function accountIds(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 25) {
    throw applicationError("Select between 1 and 25 accounts.", 400, "RECONCILIATION_ACCOUNTS_REQUIRED");
  }
  const ids = [...new Set(values.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw applicationError("Every selected account ID must be a positive integer.", 400,
      "INVALID_RECONCILIATION_ACCOUNT");
  }
  return ids;
}

function buildPaths(rows) {
  const byId = new Map(rows.map((row) => [Number(row.account_id), row]));
  const paths = new Map();
  const visiting = new Set();
  function resolve(id) {
    if (paths.has(id)) return paths.get(id);
    if (visiting.has(id)) throw applicationError("The account hierarchy contains a cycle.", 500,
      "INVALID_ACCOUNT_TREE");
    const row = byId.get(id);
    if (!row) throw applicationError("An account references a missing parent.", 500, "INVALID_ACCOUNT_TREE");
    visiting.add(id);
    const name = String(row.AccountName ?? "").trim();
    const path = row.parent_account_id == null ? name : `${resolve(Number(row.parent_account_id))}:${name}`;
    visiting.delete(id);
    paths.set(id, path);
    return path;
  }
  for (const id of byId.keys()) resolve(id);
  return paths;
}

function nullableUnits(value) {
  return value == null ? null : String(value);
}

export async function getStatementReconciliationContext({ pool, personId, accountIds: requestedAccountIds,
  openingBalanceDate, closingBalanceDate }) {
  const ids = accountIds(requestedAccountIds);
  const openingDate = calendarDate(openingBalanceDate, "opening_balance_date");
  const closingDate = calendarDate(closingBalanceDate, "closing_balance_date");
  if (closingDate <= openingDate) {
    throw applicationError("closing_balance_date must be after opening_balance_date.", 400,
      "INVALID_RECONCILIATION_INTERVAL");
  }
  const [treeRows] = await pool.query(
    `SELECT account_id, AccountName, parent_account_id
       FROM accounts WHERE owner_person_id = ?`, [personId],
  );
  const paths = buildPaths(treeRows);
  const placeholders = ids.map(() => "?").join(", ");
  const [rows] = await pool.query(
    `SELECT a.account_id, a.AccountName, a.AccountType, a.account_currency_id,
            a.is_placeholder, a.archived_at,
            c.CurrencyAbbreviation, c.scale,
            opening.account_balance_assertion_id AS opening_assertion_id,
            opening.known_balance_units AS opening_known_balance_units,
            closing.account_balance_assertion_id AS closing_assertion_id,
            closing.known_balance_units AS closing_known_balance_units,
            COALESCE(SUM(CASE WHEN t.TransactionState = 'posted' AND t.TransactionDate <= ?
                              THEN li.amount_units ELSE 0 END), 0) AS opening_posting_units,
            COALESCE(SUM(CASE WHEN t.TransactionState = 'posted' AND t.TransactionDate <= ?
                              THEN li.amount_units ELSE 0 END), 0) AS closing_posting_units
       FROM accounts a
       JOIN currencies c ON c.currency_id = a.account_currency_id
       LEFT JOIN account_balance_assertions opening
         ON opening.owner_person_id = a.owner_person_id
        AND opening.account_id = a.account_id AND opening.balance_date = ?
       LEFT JOIN account_balance_assertions closing
         ON closing.owner_person_id = a.owner_person_id
        AND closing.account_id = a.account_id AND closing.balance_date = ?
       LEFT JOIN line_items li ON li.account_id = a.account_id
       LEFT JOIN transactions t
         ON t.transaction_id = li.transaction_id AND t.owner_person_id = a.owner_person_id
      WHERE a.owner_person_id = ? AND a.account_id IN (${placeholders})
      GROUP BY a.account_id, a.AccountName, a.AccountType, a.account_currency_id,
               a.is_placeholder, a.archived_at, c.CurrencyAbbreviation, c.scale,
               opening.account_balance_assertion_id, opening.known_balance_units,
               closing.account_balance_assertion_id, closing.known_balance_units
      ORDER BY a.account_id`,
    [openingDate, closingDate, openingDate, closingDate, personId, ...ids],
  );
  if (rows.length !== ids.length) {
    const returned = new Set(rows.map((row) => Number(row.account_id)));
    throw applicationError("One or more selected accounts were not found in this ledger.", 404,
      "RECONCILIATION_ACCOUNT_NOT_FOUND", { accountIds: ids.filter((id) => !returned.has(id)) });
  }

  const accounts = rows.map((row) => {
    const openingKnown = nullableUnits(row.opening_known_balance_units);
    const closingKnown = nullableUnits(row.closing_known_balance_units);
    const openingCalculated = normalBalanceUnits(row.AccountType, row.opening_posting_units);
    const closingCalculated = normalBalanceUnits(row.AccountType, row.closing_posting_units);
    const sign = normalBalanceSign(row.AccountType);
    const postedLineItemMovement = BigInt(row.closing_posting_units) - BigInt(row.opening_posting_units);
    const knownNormalMovement = openingKnown == null || closingKnown == null
      ? null : BigInt(closingKnown) - BigInt(openingKnown);
    const targetLineItemMovement = knownNormalMovement == null ? null : knownNormalMovement * sign;
    const remainingLineItemMovement = targetLineItemMovement == null
      ? null : targetLineItemMovement - postedLineItemMovement;
    return {
      accountId: Number(row.account_id),
      accountFullName: paths.get(Number(row.account_id)),
      accountType: String(row.AccountType),
      currencyId: Number(row.account_currency_id),
      currencyCode: String(row.CurrencyAbbreviation).trim(),
      scale: Number(row.scale),
      opening: { assertionId: row.opening_assertion_id == null ? null : Number(row.opening_assertion_id),
        date: openingDate, knownBalanceUnits: openingKnown, calculatedBalanceUnits: openingCalculated },
      closing: { assertionId: row.closing_assertion_id == null ? null : Number(row.closing_assertion_id),
        date: closingDate, knownBalanceUnits: closingKnown, calculatedBalanceUnits: closingCalculated },
      requiredNormalMovementUnits: knownNormalMovement?.toString() ?? null,
      postedLineItemMovementUnits: postedLineItemMovement.toString(),
      remainingLineItemMovementUnits: remainingLineItemMovement?.toString() ?? null,
      grounded: openingKnown != null && closingKnown != null,
      postable: !Boolean(row.is_placeholder) && row.archived_at == null,
    };
  });
  const missingAssertions = accounts.flatMap((account) => [account.opening, account.closing]
    .filter((anchor) => anchor.knownBalanceUnits == null)
    .map((anchor) => ({ accountId: account.accountId, balanceDate: anchor.date })));
  return {
    interval: { openingBalanceDate: openingDate, closingBalanceDate: closingDate,
      includedTransactionDates: `>${openingDate} and <=${closingDate}` },
    accounts,
    grounded: missingAssertions.length === 0,
    evidenceRefs: accounts.flatMap((account) => [
      `accounting://accounts/${account.accountId}`,
      ...[account.opening, account.closing].filter((anchor) => anchor.assertionId != null)
        .map((anchor) => `accounting://balance-assertions/${anchor.assertionId}`),
    ]),
    missingAssertions,
    workflow: {
      evidenceOrder: ["statement_native_amounts", "statement_fees_and_values", "matched_counter_statement_rows",
        "timestamped_reference_rates", "derived_residuals"],
      rules: [
        "Analyze all statements together and match transfers before creating accounting transactions.",
        "Use transaction hashes, provider IDs, timestamps, directions, and quantities as matching evidence; do not require amounts to be equal because fees can reduce the received quantity.",
        "Copy each account's native quantity from its own statement. Never replace a statement amount merely to force balance.",
        "Use one valuation currency per joined transaction. Supply a source value_decimal for a foreign-currency line only when no reference rate is available.",
        "Accounting values each foreign asset line from its exact native quantity and the nearest available transaction-time reference rate, rounded once to the valuation currency's smallest unit; it accepts an explicit source valuation only when no rate exists. Keep exact statement cash proceeds or payments as separate cash lines and supply a fee expense account so Accounting can post a conversion residual. Never classify an unmatched account side as a fee.",
        "Record an explicitly disclosed provider fee separately from an inferred spread or margin; never double count the same residual.",
        "Infer spread or margin only as the valuation-currency residual after the acquired or disposed asset value and every explicit fee are accounted for.",
        "Report remainingLineItemMovementUnits when both known balances exist. Treat a nonzero residual as a prompt to review missing or misclassified evidence, not as a transaction-import blocker.",
        "If exact opening and closing balances prove residual movement but its category remains unknown after review, record the exact balance-derived adjustment against a user-selected ordinary postable suspense account of the same currency and attach an accounting question to the suspense line. Do not fabricate a source row or category.",
        "Resolve an accounting question later by reclassifying only its suspense line to a same-currency account; do not alter the proven statement-account line.",
        "Give a joined transaction one stable composite external ID and preserve each statement row ID on its corresponding line item.",
        "Preview with import_transactions and ask for confirmation before commit_transaction_import.",
      ],
    },
  };
}
