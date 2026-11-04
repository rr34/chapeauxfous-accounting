import { withTransaction } from "./db.js";
import { normalBalanceUnits } from "./account-balances.js";

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
         aba.known_balance_units, a.AccountName, a.AccountType, a.account_currency_id,
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
  const calculatedBalanceUnits = normalBalanceUnits(row.AccountType, row.calculated_balance_units);
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

async function attachAssertionEvidence(connection, personId, assertions) {
  if (!assertions.length) return assertions;
  const ids = assertions.map((assertion) => assertion.id);
  const [rows] = await connection.query(
    `SELECT bael.account_balance_assertion_id, ef.evidence_file_id, ef.original_file_name,
            ef.media_type, ef.byte_size, ef.sha256,
            ef.start_date, ef.start_amount_units, ef.end_date, ef.end_amount_units,
            ef.currency_id, ec.CurrencyAbbreviation AS evidence_currency_code,
            ec.scale AS evidence_currency_scale, bael.evidence_role
       FROM balance_assertion_evidence_links bael
       JOIN accounting_evidence_files ef ON ef.evidence_file_id = bael.evidence_file_id
       LEFT JOIN currencies ec ON ec.currency_id = ef.currency_id
      WHERE ef.owner_person_id = ?
        AND bael.account_balance_assertion_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY bael.account_balance_assertion_id, ef.evidence_file_id`,
    [personId, ...ids],
  );
  const byAssertion = new Map();
  for (const row of rows) {
    const id = Number(row.account_balance_assertion_id);
    if (!byAssertion.has(id)) byAssertion.set(id, []);
    byAssertion.get(id).push({
      id: Number(row.evidence_file_id), fileName: String(row.original_file_name),
      mediaType: String(row.media_type), byteSize: Number(row.byte_size),
      sha256: `sha256:${String(row.sha256)}`, role: String(row.evidence_role),
      startDate: row.start_date == null ? null : String(row.start_date),
      startAmountUnits: row.start_amount_units == null ? null : String(row.start_amount_units),
      endDate: row.end_date == null ? null : String(row.end_date),
      endAmountUnits: row.end_amount_units == null ? null : String(row.end_amount_units),
      currencyId: row.currency_id == null ? null : Number(row.currency_id),
      currencyCode: row.evidence_currency_code == null ? null : String(row.evidence_currency_code).trim(),
      scale: row.evidence_currency_scale == null ? null : Number(row.evidence_currency_scale),
      downloadPath: `/api/evidence-files/${row.evidence_file_id}/content`,
    });
  }
  return assertions.map((assertion) => ({ ...assertion,
    evidenceFiles: byAssertion.get(assertion.id) ?? [] }));
}

export async function listBalanceAssertions(pool, personId) {
  const [rows] = await pool.query(
    `${assertionSelect}
      WHERE aba.owner_person_id = ?
      ORDER BY aba.balance_date DESC, a.AccountName, aba.account_balance_assertion_id DESC`,
    [personId],
  );
  return attachAssertionEvidence(pool, personId, rows.map(mapAssertion));
}

export async function listMatchingBalanceCheckpoints(pool, personId, accountIds, throughDate) {
  const ids = [...new Set(accountIds.map(Number))];
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) return [];
  const closingDate = endOfDayDate(throughDate);
  const placeholders = ids.map(() => "?").join(", ");
  const [rows] = await pool.query(
    `${assertionSelect}
      WHERE aba.owner_person_id = ? AND aba.account_id IN (${placeholders})
        AND aba.balance_date <= ?
      ORDER BY aba.account_id, aba.balance_date DESC, aba.account_balance_assertion_id DESC`,
    [personId, ...ids, closingDate],
  );
  const latestByAccount = new Map();
  for (const assertion of rows.map(mapAssertion)) {
    if (assertion.matches && !latestByAccount.has(assertion.accountId)) {
      latestByAccount.set(assertion.accountId, assertion);
    }
  }
  return [...latestByAccount.values()];
}

export async function listBalanceAssertionsPage(pool, personId, { limit = 100, beforeAssertionId = null } = {}) {
  const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const cursor = beforeAssertionId == null ? null : Number(beforeAssertionId);
  if (cursor != null && (!Number.isInteger(cursor) || cursor <= 0)) {
    throw applicationError("Balance-assertion cursor is invalid.", 400, "INVALID_CURSOR");
  }
  const cursorSql = cursor == null ? "" : " AND aba.account_balance_assertion_id < ?";
  const [rows] = await pool.query(
    `${assertionSelect}
      WHERE aba.owner_person_id = ?${cursorSql}
      ORDER BY aba.account_balance_assertion_id DESC
      LIMIT ?`,
    cursor == null ? [personId, resolvedLimit + 1] : [personId, cursor, resolvedLimit + 1],
  );
  const hasMore = rows.length > resolvedLimit;
  const assertions = await attachAssertionEvidence(pool, personId, rows.slice(0, resolvedLimit).map(mapAssertion));
  return { assertions, nextCursor: hasMore ? String(assertions.at(-1).id) : null };
}

export async function getBalanceAssertion(pool, personId, assertionId) {
  const resolvedAssertionId = Number(assertionId);
  if (!Number.isInteger(resolvedAssertionId) || resolvedAssertionId <= 0) {
    throw applicationError("Balance assertion not found.", 404, "BALANCE_ASSERTION_NOT_FOUND");
  }
  const [rows] = await pool.query(
    `${assertionSelect}
      WHERE aba.account_balance_assertion_id = ? AND aba.owner_person_id = ?`,
    [resolvedAssertionId, personId],
  );
  if (!rows.length) throw applicationError("Balance assertion not found.", 404, "BALANCE_ASSERTION_NOT_FOUND");
  return (await attachAssertionEvidence(pool, personId, [mapAssertion(rows[0])]))[0];
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
      "SELECT account_id, is_placeholder FROM accounts WHERE account_id = ? AND owner_person_id = ? AND archived_at IS NULL",
      [resolvedAccountId, personId],
    );
    if (!accounts.length) throw applicationError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
    if (Boolean(accounts[0].is_placeholder)) {
      throw applicationError("A balance cannot be asserted for a placeholder account.", 400, "PLACEHOLDER_ACCOUNT");
    }

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
    return (await attachAssertionEvidence(connection, personId, [mapAssertion(rows[0])]))[0];
  });
}
