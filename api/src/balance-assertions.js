import { withTransaction } from "./db.js";

function applicationError(message, status = 400, code = "INVALID_BALANCE_ASSERTION") {
  return Object.assign(new Error(message), { status, code });
}

function endOfDayDate(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw applicationError("Balance date must be YYYY-MM-DD.", 400, "INVALID_BALANCE_DATE");
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw applicationError("Balance date is not a valid calendar date.", 400, "INVALID_BALANCE_DATE");
  }
  return normalized;
}

function integerUnits(value) {
  const normalized = String(value ?? "").trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw applicationError("Known balance must be an integer number of native units.", 400, "INVALID_BALANCE_UNITS");
  }
  return normalized;
}

const assertionSelect = `
  SELECT aba.account_balance_assertion_id, aba.account_id, aba.balance_date,
         aba.known_balance_units, a.AccountName, a.account_currency_id,
         c.CurrencyAbbreviation, c.scale,
         COALESCE((
           SELECT SUM(li.amount_units)
             FROM line_items li
             JOIN transactions t ON t.transaction_id = li.transaction_id
            WHERE li.account_id = aba.account_id
              AND t.owner_person_id = aba.owner_person_id
              AND t.TransactionState = 'posted'
              AND t.TransactionDate <= aba.balance_date
         ), 0) AS calculated_balance_units
    FROM account_balance_assertions aba
    JOIN accounts a
      ON a.account_id = aba.account_id
     AND a.owner_person_id = aba.owner_person_id
    JOIN currencies c ON c.currency_id = a.account_currency_id`;

function mapAssertion(row) {
  const knownBalanceUnits = String(row.known_balance_units);
  const calculatedBalanceUnits = String(row.calculated_balance_units);
  const differenceUnits = (BigInt(knownBalanceUnits) - BigInt(calculatedBalanceUnits)).toString();
  return {
    id: Number(row.account_balance_assertion_id),
    accountId: Number(row.account_id),
    accountName: row.AccountName,
    date: row.balance_date,
    knownBalanceUnits,
    calculatedBalanceUnits,
    differenceUnits,
    matches: differenceUnits === "0",
    currencyId: Number(row.account_currency_id),
    currencyCode: row.CurrencyAbbreviation.trim(),
    scale: Number(row.scale),
  };
}

export async function listBalanceAssertions(pool, personId) {
  const [rows] = await pool.query(
    `${assertionSelect}
      WHERE aba.owner_person_id = ?
      ORDER BY aba.balance_date DESC, a.AccountName, aba.account_balance_assertion_id DESC`,
    [personId],
  );
  return rows.map(mapAssertion);
}

export async function saveBalanceAssertion({ personId, accountId, balanceDate, knownBalanceUnits }) {
  const resolvedAccountId = Number(accountId);
  if (!Number.isInteger(resolvedAccountId) || resolvedAccountId <= 0) {
    throw applicationError("Account is required.", 400, "ACCOUNT_REQUIRED");
  }
  const resolvedDate = endOfDayDate(balanceDate);
  const resolvedUnits = integerUnits(knownBalanceUnits);

  return withTransaction(async (connection) => {
    const [accounts] = await connection.query(
      "SELECT account_id FROM accounts WHERE account_id = ? AND owner_person_id = ? AND archived_at IS NULL",
      [resolvedAccountId, personId],
    );
    if (!accounts.length) throw applicationError("Account not found.", 404, "ACCOUNT_NOT_FOUND");

    const [result] = await connection.query(
      `INSERT INTO account_balance_assertions
        (owner_person_id, account_id, balance_date, known_balance_units)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         account_balance_assertion_id = LAST_INSERT_ID(account_balance_assertion_id),
         owner_person_id = VALUES(owner_person_id),
         known_balance_units = VALUES(known_balance_units)`,
      [personId, resolvedAccountId, resolvedDate, resolvedUnits],
    );

    const [rows] = await connection.query(
      `${assertionSelect}
        WHERE aba.account_balance_assertion_id = ? AND aba.owner_person_id = ?`,
      [Number(result.insertId), personId],
    );
    return mapAssertion(rows[0]);
  });
}
