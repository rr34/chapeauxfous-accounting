import { addFractions, fraction } from "./money.js";
import { withTransaction } from "./db.js";
import { requireAccessibleCurrency } from "./currencies.js";

function applicationError(message, status = 400, code = "INVALID_ACCOUNTING_OPERATION", details = undefined) {
  return Object.assign(new Error(message), { status, code, details });
}

function integerString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^-?\d+$/.test(normalized)) throw applicationError(`${field} must be an integer string.`);
  return normalized;
}

export async function listAccounts(pool, personId) {
  const [rows] = await pool.query(
    `SELECT a.account_id, a.AccountName, a.description, a.is_placeholder,
            a.parent_account_id, a.AccountType,
            a.account_currency_id, c.CurrencyAbbreviation, c.scale,
            COALESCE(SUM(CASE WHEN t.TransactionState = 'posted' THEN li.amount_units ELSE 0 END), 0) AS balance_units,
            a.archived_at
       FROM accounts a
       JOIN currencies c ON c.currency_id = a.account_currency_id
       LEFT JOIN line_items li ON li.account_id = a.account_id
       LEFT JOIN transactions t ON t.transaction_id = li.transaction_id AND t.owner_person_id = a.owner_person_id
      WHERE a.owner_person_id = ?
      GROUP BY a.account_id, a.AccountName, a.description, a.is_placeholder,
               a.parent_account_id, a.AccountType,
               a.account_currency_id, c.CurrencyAbbreviation, c.scale, a.archived_at
      ORDER BY a.account_id`,
    [personId],
  );
  return rows.map((row) => ({
    id: Number(row.account_id), name: row.AccountName, description: row.description,
    placeholder: Boolean(row.is_placeholder),
    parentAccountId: row.parent_account_id == null ? null : Number(row.parent_account_id),
    type: row.AccountType, currencyId: Number(row.account_currency_id), currencyCode: row.CurrencyAbbreviation.trim(),
    scale: Number(row.scale), balanceUnits: String(row.balance_units), archivedAt: row.archived_at,
  }));
}

export async function createAccount({ personId, name, description, placeholder = false, parentAccountId, type, currencyId }) {
  const accountName = String(name ?? "").trim();
  const accountDescription = String(description ?? "").trim() || null;
  const isPlaceholder = placeholder === true;
  const resolvedCurrencyId = Number(currencyId);
  const allowedTypes = new Set(["asset", "liability", "equity", "income", "expense"]);
  if (!accountName) throw applicationError("Account name is required.");
  if (!allowedTypes.has(type)) throw applicationError("Invalid account type.");
  if (!Number.isInteger(resolvedCurrencyId) || resolvedCurrencyId <= 0) throw applicationError("Currency is required.");
  return withTransaction(async (connection) => {
    if (parentAccountId != null) {
      const [parentRows] = await connection.query(
        "SELECT account_id FROM accounts WHERE account_id = ? AND owner_person_id = ? AND archived_at IS NULL",
        [parentAccountId, personId],
      );
      if (!parentRows.length) throw applicationError("Parent account not found.", 404, "PARENT_ACCOUNT_NOT_FOUND");
    }
    await requireAccessibleCurrency(connection, personId, resolvedCurrencyId);
    const [result] = await connection.query(
      `INSERT INTO accounts
        (owner_person_id, AccountName, description, is_placeholder, parent_account_id, AccountType, account_currency_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [personId, accountName, accountDescription, isPlaceholder, parentAccountId ?? null, type, resolvedCurrencyId],
    );
    return { id: Number(result.insertId) };
  });
}

export async function updateAccount({ personId, accountId, name, description, placeholder = false, parentAccountId, type, currencyId }, runInTransaction = withTransaction) {
  const resolvedAccountId = Number(accountId);
  const accountName = String(name ?? "").trim();
  const accountDescription = String(description ?? "").trim() || null;
  const isPlaceholder = placeholder === true;
  const resolvedParentId = parentAccountId == null ? null : Number(parentAccountId);
  const resolvedCurrencyId = Number(currencyId);
  const allowedTypes = new Set(["asset", "liability", "equity", "income", "expense"]);
  if (!Number.isInteger(resolvedAccountId) || resolvedAccountId <= 0) throw applicationError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
  if (!accountName) throw applicationError("Account name is required.");
  if (!allowedTypes.has(type)) throw applicationError("Invalid account type.");
  if (!Number.isInteger(resolvedCurrencyId) || resolvedCurrencyId <= 0) throw applicationError("Currency is required.");
  if (resolvedParentId != null && (!Number.isInteger(resolvedParentId) || resolvedParentId <= 0)) {
    throw applicationError("Parent account not found.", 404, "PARENT_ACCOUNT_NOT_FOUND");
  }
  if (resolvedParentId === resolvedAccountId) throw applicationError("An account cannot be its own parent.", 409, "ACCOUNT_PARENT_CYCLE");

  return runInTransaction(async (connection) => {
    const [accountRows] = await connection.query(
      `SELECT account_id, AccountName, description, is_placeholder, parent_account_id,
              AccountType, account_currency_id
         FROM accounts
        WHERE account_id = ? AND owner_person_id = ?
        FOR UPDATE`,
      [resolvedAccountId, personId],
    );
    const account = accountRows[0];
    if (!account) throw applicationError("Account not found.", 404, "ACCOUNT_NOT_FOUND");

    if (resolvedParentId != null && Number(account.parent_account_id) !== resolvedParentId) {
      const visited = new Set([resolvedAccountId]);
      let ancestorId = resolvedParentId;
      while (ancestorId != null) {
        if (visited.has(ancestorId)) throw applicationError("An account cannot be moved beneath itself.", 409, "ACCOUNT_PARENT_CYCLE");
        visited.add(ancestorId);
        const [parentRows] = await connection.query(
          `SELECT account_id, parent_account_id
             FROM accounts
            WHERE account_id = ? AND owner_person_id = ? AND archived_at IS NULL
            FOR UPDATE`,
          [ancestorId, personId],
        );
        const parent = parentRows[0];
        if (!parent) throw applicationError("Parent account not found.", 404, "PARENT_ACCOUNT_NOT_FOUND");
        ancestorId = parent.parent_account_id == null ? null : Number(parent.parent_account_id);
      }
    }

    const currencyChanged = Number(account.account_currency_id) !== resolvedCurrencyId;
    const becomingPlaceholder = !Boolean(account.is_placeholder) && isPlaceholder;
    if (currencyChanged || becomingPlaceholder) {
      const [lineItems] = await connection.query(
        "SELECT line_item_id FROM line_items WHERE account_id = ? LIMIT 1 FOR UPDATE",
        [resolvedAccountId],
      );
      if (lineItems.length) {
        const message = currencyChanged
          ? "Account currency cannot change after transactions reference it."
          : "An account with transactions cannot become a placeholder.";
        throw applicationError(message, 409, currencyChanged ? "ACCOUNT_CURRENCY_IN_USE" : "ACCOUNT_HAS_TRANSACTIONS");
      }
      const [assertions] = await connection.query(
        "SELECT account_balance_assertion_id FROM account_balance_assertions WHERE account_id = ? LIMIT 1 FOR UPDATE",
        [resolvedAccountId],
      );
      if (assertions.length) {
        const message = currencyChanged
          ? "Account currency cannot change after balance assertions reference it."
          : "An account with balance assertions cannot become a placeholder.";
        throw applicationError(message, 409, currencyChanged ? "ACCOUNT_CURRENCY_IN_USE" : "ACCOUNT_HAS_BALANCE_ASSERTIONS");
      }
    }

    if (currencyChanged) await requireAccessibleCurrency(connection, personId, resolvedCurrencyId);
    const [result] = await connection.query(
      `UPDATE accounts
          SET AccountName = ?, description = ?, is_placeholder = ?, parent_account_id = ?,
              AccountType = ?, account_currency_id = ?
        WHERE account_id = ? AND owner_person_id = ?`,
      [accountName, accountDescription, isPlaceholder, resolvedParentId, type, resolvedCurrencyId, resolvedAccountId, personId],
    );
    if (Number(result.affectedRows) !== 1) throw applicationError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
    return { updated: true, accountId: resolvedAccountId };
  });
}

export async function deleteAccount({ personId, accountId }, runInTransaction = withTransaction) {
  const resolvedAccountId = Number(accountId);
  if (!Number.isInteger(resolvedAccountId) || resolvedAccountId <= 0) {
    throw applicationError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
  }

  return runInTransaction(async (connection) => {
    const [accountRows] = await connection.query(
      `SELECT account_id, AccountName
         FROM accounts
        WHERE account_id = ? AND owner_person_id = ?
        FOR UPDATE`,
      [resolvedAccountId, personId],
    );
    const account = accountRows[0];
    if (!account) throw applicationError("Account not found.", 404, "ACCOUNT_NOT_FOUND");

    const [children] = await connection.query(
      "SELECT account_id FROM accounts WHERE parent_account_id = ? LIMIT 1 FOR UPDATE",
      [resolvedAccountId],
    );
    if (children.length) {
      throw applicationError("Move or delete this account's child accounts first.", 409, "ACCOUNT_HAS_CHILDREN");
    }

    const [lineItems] = await connection.query(
      "SELECT line_item_id FROM line_items WHERE account_id = ? LIMIT 1 FOR UPDATE",
      [resolvedAccountId],
    );
    if (lineItems.length) {
      throw applicationError("Account cannot be deleted because transactions reference it.", 409, "ACCOUNT_HAS_TRANSACTIONS");
    }

    const [assertions] = await connection.query(
      "SELECT account_balance_assertion_id FROM account_balance_assertions WHERE account_id = ? LIMIT 1 FOR UPDATE",
      [resolvedAccountId],
    );
    if (assertions.length) {
      throw applicationError("Delete this account's balance assertions before deleting the account.", 409, "ACCOUNT_HAS_BALANCE_ASSERTIONS");
    }

    try {
      const [result] = await connection.query(
        "DELETE FROM accounts WHERE account_id = ? AND owner_person_id = ?",
        [resolvedAccountId, personId],
      );
      if (Number(result.affectedRows) !== 1) {
        throw applicationError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
      }
    } catch (error) {
      if (error?.code === "ER_ROW_IS_REFERENCED_2") {
        throw applicationError("Account is still referenced and cannot be deleted.", 409, "ACCOUNT_IN_USE");
      }
      throw error;
    }

    return { deleted: true, accountId: resolvedAccountId, name: account.AccountName };
  });
}

async function attachTags(connection, personId, lineItemId, tags) {
  for (const input of Array.isArray(tags) ? tags : []) {
    const key = String(input?.key ?? "").trim().toLowerCase();
    const value = String(input?.value ?? "").trim();
    if (!key || !value || key.length > 50) throw applicationError("Tags require a key and value; keys are limited to 50 characters.");
    const [result] = await connection.query(
      `INSERT INTO tags (owner_person_id, tag_key, tag_value)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE tag_id = LAST_INSERT_ID(tag_id)`,
      [personId, key, value],
    );
    await connection.query(
      "INSERT INTO lineitems_tags_join (tagged_line_item_id, tag_id) VALUES (?, ?)",
      [lineItemId, Number(result.insertId)],
    );
  }
}

export async function validateTransaction(connection, transactionId, personId, { lock = false } = {}) {
  const lockSql = lock ? " FOR UPDATE" : "";
  const [transactionRows] = await connection.query(
    `SELECT transaction_id, owner_person_id, valuation_currency_id, TransactionState
       FROM transactions WHERE transaction_id = ? AND owner_person_id = ?${lockSql}`,
    [transactionId, personId],
  );
  const transaction = transactionRows[0];
  if (!transaction) throw applicationError("Transaction not found.", 404, "TRANSACTION_NOT_FOUND");

  const [lines] = await connection.query(
    `SELECT li.line_item_id, li.amount_units, li.account_id,
            a.owner_person_id AS account_owner_person_id, a.account_currency_id, a.is_placeholder
       FROM line_items li
       JOIN accounts a ON a.account_id = li.account_id
      WHERE li.transaction_id = ?
      ORDER BY li.line_item_id${lockSql}`,
    [transactionId],
  );
  if (lines.length < 2) throw applicationError("A transaction requires at least two line items.", 400, "TOO_FEW_LINE_ITEMS");
  if (lines.some((line) => Number(line.account_owner_person_id) !== Number(personId))) {
    throw applicationError("A transaction cannot use another user's account.", 403, "CROSS_USER_ACCOUNT");
  }
  if (lines.some((line) => Boolean(line.is_placeholder))) {
    throw applicationError("A transaction cannot post to a placeholder account.", 400, "PLACEHOLDER_ACCOUNT");
  }

  const [rates] = await connection.query(
    `SELECT xrate_id, from_units, from_currency_id, to_units, to_currency_id
       FROM xrates
      WHERE transaction_id = ? AND owner_person_id = ? AND xrate_type = 'transaction'
      ORDER BY xrate_id${lockSql}`,
    [transactionId, personId],
  );
  const valuationCurrencyId = Number(transaction.valuation_currency_id);
  const usedForeignCurrencies = new Set(
    lines.map((line) => Number(line.account_currency_id)).filter((currencyId) => currencyId !== valuationCurrencyId),
  );
  const rateByCurrency = new Map();
  for (const rate of rates) {
    const fromCurrencyId = Number(rate.from_currency_id);
    const toCurrencyId = Number(rate.to_currency_id);
    if (toCurrencyId !== valuationCurrencyId) throw applicationError("Every transaction rate must convert to the valuation currency.", 400, "RATE_TARGET_MISMATCH");
    if (!usedForeignCurrencies.has(fromCurrencyId)) throw applicationError("Transaction contains an unnecessary exchange rate.", 400, "UNUSED_RATE");
    if (rateByCurrency.has(fromCurrencyId)) throw applicationError("Transaction has duplicate exchange rates.", 400, "DUPLICATE_RATE");
    const fromUnits = BigInt(rate.from_units);
    const toUnits = BigInt(rate.to_units);
    if (fromUnits <= 0n || toUnits <= 0n || fromCurrencyId === toCurrencyId) {
      throw applicationError("Exchange-rate units must be positive and currencies must differ.", 400, "INVALID_RATE");
    }
    rateByCurrency.set(fromCurrencyId, { fromUnits, toUnits });
  }
  for (const currencyId of usedForeignCurrencies) {
    if (!rateByCurrency.has(currencyId)) throw applicationError(`Missing exchange rate for currency ${currencyId}.`, 400, "MISSING_RATE");
  }

  let total = fraction(0n);
  for (const line of lines) {
    const amount = BigInt(line.amount_units);
    const currencyId = Number(line.account_currency_id);
    const value = currencyId === valuationCurrencyId
      ? fraction(amount)
      : fraction(amount * rateByCurrency.get(currencyId).toUnits, rateByCurrency.get(currencyId).fromUnits);
    total = addFractions(total, value);
  }
  if (total.numerator !== 0n) {
    throw applicationError("Transaction values do not balance.", 400, "UNBALANCED_TRANSACTION", {
      numerator: total.numerator.toString(), denominator: total.denominator.toString(), valuationCurrencyId,
    });
  }
  return { valid: true, lineItemCount: lines.length, valuationCurrencyId, foreignCurrencyIds: [...usedForeignCurrencies] };
}

export async function createTransaction({ personId, description, transactionDate, valuationCurrencyId, lineItems, rates, post = true, sourceSystem, sourceId }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(transactionDate ?? ""))) throw applicationError("Transaction date must be YYYY-MM-DD.");
  if (!Array.isArray(lineItems) || lineItems.length < 2) throw applicationError("At least two line items are required.");
  return withTransaction(async (connection) => {
    await requireAccessibleCurrency(connection, personId, valuationCurrencyId);
    const [result] = await connection.query(
      `INSERT INTO transactions
        (owner_person_id, description, valuation_currency_id, TransactionState, TransactionDate, source_system, source_id)
       VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
      [personId, String(description ?? "").trim() || null, valuationCurrencyId, transactionDate, sourceSystem ?? null, sourceId ?? null],
    );
    const transactionId = Number(result.insertId);
    for (const line of lineItems) {
      const accountId = Number(line.accountId);
      const amountUnits = integerString(line.amountUnits, "amountUnits");
      const [accountRows] = await connection.query(
        "SELECT account_id, is_placeholder FROM accounts WHERE account_id = ? AND owner_person_id = ? AND archived_at IS NULL",
        [accountId, personId],
      );
      if (!accountRows.length) throw applicationError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
      if (Boolean(accountRows[0].is_placeholder)) {
        throw applicationError("A transaction cannot post to a placeholder account.", 400, "PLACEHOLDER_ACCOUNT");
      }
      const [lineResult] = await connection.query(
        `INSERT INTO line_items (transaction_id, amount_units, memo, account_id, source_id)
         VALUES (?, ?, ?, ?, ?)`,
        [transactionId, amountUnits, String(line.memo ?? "").trim() || null, accountId, line.sourceId ?? null],
      );
      await attachTags(connection, personId, Number(lineResult.insertId), line.tags);
    }
    for (const rate of Array.isArray(rates) ? rates : []) {
      await connection.query(
        `INSERT INTO xrates
          (owner_person_id, xrate_type, ValidAt, transaction_id, from_units, from_currency_id, to_units, to_currency_id)
         VALUES (?, 'transaction', NULL, ?, ?, ?, ?, ?)`,
        [personId, transactionId, integerString(rate.fromUnits, "fromUnits"), Number(rate.fromCurrencyId),
          integerString(rate.toUnits, "toUnits"), Number(rate.toCurrencyId)],
      );
    }
    const validation = await validateTransaction(connection, transactionId, personId, { lock: true });
    if (post) {
      await connection.query(
        "UPDATE transactions SET TransactionState = 'posted', UpdatedAt = CURRENT_TIMESTAMP() WHERE transaction_id = ? AND owner_person_id = ?",
        [transactionId, personId],
      );
    }
    return { transactionId, state: post ? "posted" : "draft", validation };
  });
}

export async function listTransactions(pool, personId, limit = 100) {
  const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [rows] = await pool.query(
    `SELECT t.transaction_id, t.TransactionDate, t.description, t.TransactionState,
            t.valuation_currency_id, c.CurrencyAbbreviation, c.scale,
            COUNT(li.line_item_id) AS line_item_count
       FROM transactions t
       JOIN currencies c ON c.currency_id = t.valuation_currency_id
       LEFT JOIN line_items li ON li.transaction_id = t.transaction_id
      WHERE t.owner_person_id = ?
      GROUP BY t.transaction_id, t.TransactionDate, t.description, t.TransactionState,
               t.valuation_currency_id, c.CurrencyAbbreviation, c.scale
      ORDER BY t.TransactionDate DESC, t.transaction_id DESC
      LIMIT ?`,
    [personId, resolvedLimit],
  );
  return rows.map((row) => ({
    id: Number(row.transaction_id), date: row.TransactionDate, description: row.description, state: row.TransactionState,
    valuationCurrencyId: Number(row.valuation_currency_id), valuationCurrencyCode: row.CurrencyAbbreviation.trim(),
    scale: Number(row.scale), lineItemCount: Number(row.line_item_count),
  }));
}

export async function getTransaction(pool, personId, transactionId) {
  const [transactions] = await pool.query(
    `SELECT t.transaction_id, t.TransactionDate, t.description, t.TransactionState, t.valuation_currency_id
       FROM transactions t WHERE t.transaction_id = ? AND t.owner_person_id = ?`,
    [transactionId, personId],
  );
  if (!transactions.length) throw applicationError("Transaction not found.", 404, "TRANSACTION_NOT_FOUND");
  const [lines] = await pool.query(
    `SELECT li.line_item_id, li.amount_units, li.memo, li.account_id, a.AccountName,
            a.account_currency_id, c.CurrencyAbbreviation, c.scale
       FROM line_items li JOIN accounts a ON a.account_id = li.account_id
       JOIN currencies c ON c.currency_id = a.account_currency_id
      WHERE li.transaction_id = ? ORDER BY li.line_item_id`, [transactionId],
  );
  const [tags] = await pool.query(
    `SELECT j.tagged_line_item_id, t.tag_key, t.tag_value
       FROM lineitems_tags_join j JOIN tags t ON t.tag_id = j.tag_id
      WHERE t.owner_person_id = ? AND j.tagged_line_item_id IN
        (SELECT line_item_id FROM line_items WHERE transaction_id = ?)
      ORDER BY j.tagged_line_item_id, t.tag_key, t.tag_value`, [personId, transactionId],
  );
  const [rates] = await pool.query(
    `SELECT xrate_id, from_units, from_currency_id, to_units, to_currency_id
       FROM xrates WHERE transaction_id = ? AND owner_person_id = ? AND xrate_type = 'transaction'`,
    [transactionId, personId],
  );
  const tagsByLine = new Map();
  for (const tag of tags) {
    const key = Number(tag.tagged_line_item_id);
    if (!tagsByLine.has(key)) tagsByLine.set(key, []);
    tagsByLine.get(key).push({ key: tag.tag_key, value: tag.tag_value });
  }
  return {
    id: Number(transactions[0].transaction_id), date: transactions[0].TransactionDate,
    description: transactions[0].description, state: transactions[0].TransactionState,
    valuationCurrencyId: Number(transactions[0].valuation_currency_id),
    lineItems: lines.map((line) => ({ id: Number(line.line_item_id), amountUnits: String(line.amount_units), memo: line.memo,
      accountId: Number(line.account_id), accountName: line.AccountName, currencyId: Number(line.account_currency_id),
      currencyCode: line.CurrencyAbbreviation.trim(), scale: Number(line.scale), tags: tagsByLine.get(Number(line.line_item_id)) ?? [] })),
    rates: rates.map((rate) => ({ id: Number(rate.xrate_id), fromUnits: String(rate.from_units),
      fromCurrencyId: Number(rate.from_currency_id), toUnits: String(rate.to_units), toCurrencyId: Number(rate.to_currency_id) })),
  };
}

export async function verifyAllPostedTransactions(pool, personId = null) {
  const params = [];
  const where = personId == null ? "" : " AND owner_person_id = ?";
  if (personId != null) params.push(personId);
  const [rows] = await pool.query(
    `SELECT transaction_id, owner_person_id FROM transactions WHERE TransactionState = 'posted'${where} ORDER BY transaction_id`, params,
  );
  const failures = [];
  const connection = await pool.getConnection();
  try {
    for (const row of rows) {
      try {
        await validateTransaction(connection, Number(row.transaction_id), Number(row.owner_person_id));
      } catch (error) {
        failures.push({ transactionId: Number(row.transaction_id), code: error.code ?? "VALIDATION_ERROR", message: error.message, details: error.details });
      }
    }
  } finally {
    connection.release();
  }
  return { valid: failures.length === 0, checked: rows.length, failures };
}
