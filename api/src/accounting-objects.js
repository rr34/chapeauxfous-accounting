import { unitsToDecimal } from "./money.js";

function compact(value, maximum = 100) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join("")}…` : normalized;
}

export function transactionObject(transaction) {
  return {
    objectType: "accounting.transaction",
    id: transaction.id,
    sourceRef: `accounting://transactions/${transaction.id}`,
    displayName: `${transaction.date} · ${compact(transaction.description) || `Transaction #${transaction.id}`}`,
    date: transaction.date,
    state: transaction.state,
    valuationCurrencyCode: transaction.valuationCurrencyCode,
    accountIds: transaction.accountIds,
    matchedFields: transaction.matchedFields,
  };
}

function lineItemObject(row, accountFullName) {
  const description = compact(row.memo ?? row.transaction_description) || `Line item #${row.line_item_id}`;
  return {
    objectType: "accounting.line_item",
    id: Number(row.line_item_id),
    sourceRef: `accounting://line-items/${row.line_item_id}`,
    displayName: `${row.TransactionDate} · ${accountFullName} · ${description}`,
    transactionId: Number(row.transaction_id),
    accountId: Number(row.account_id),
    accountFullName,
    transactionDate: row.TransactionDate,
    amountUnits: String(row.amount_units),
    currencyCode: String(row.CurrencyAbbreviation).trim(),
    memo: row.memo == null ? null : String(row.memo),
    reconciliationState: String(row.reconciliation_state),
  };
}

function objectReadError(message, code) {
  return Object.assign(new Error(message), { code, status: 400 });
}

export async function loadAccountObjectPaths(pool, personId, accounts) {
  const known = new Map(accounts.map((account) => [account.id, account]));
  const requested = new Set();
  while (true) {
    const parentIds = [...new Set([...known.values()]
      .map((account) => account.parentAccountId)
      .filter((id) => id != null && !known.has(id) && !requested.has(id)))];
    if (!parentIds.length) break;
    parentIds.forEach((id) => requested.add(id));
    const [rows] = await pool.query(
      `SELECT account_id, AccountName, parent_account_id
         FROM accounts
        WHERE owner_person_id = ? AND account_id IN (${parentIds.map(() => "?").join(", ")})`,
      [personId, ...parentIds],
    );
    for (const row of rows) {
      known.set(Number(row.account_id), {
        id: Number(row.account_id), name: row.AccountName,
        parentAccountId: row.parent_account_id == null ? null : Number(row.parent_account_id),
      });
    }
  }
  return [...known.values()];
}

export async function listTransactionObjectsPage(pool, personId, {
  limit = 25, cursor = null, transactionId = null, text = null,
  accountId = null, dateFrom = null, dateTo = null,
} = {}) {
  const resolvedLimit = Number(limit);
  if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1 || resolvedLimit > 100) {
    throw objectReadError("Transaction object limit must be from 1 through 100.", "INVALID_TRANSACTION_OBJECT_LIMIT");
  }
  if (transactionId != null && [cursor, text, accountId, dateFrom, dateTo].some((value) => value != null)) {
    throw objectReadError("An exact transaction ID cannot be combined with other filters.", "INVALID_TRANSACTION_OBJECT_FILTER");
  }
  const clauses = ["t.owner_person_id = ?"];
  const params = [personId];
  if (transactionId != null) {
    clauses.push("t.transaction_id = ?");
    params.push(transactionId);
  } else {
    if (cursor != null) {
      clauses.push("t.transaction_id < ?");
      params.push(cursor);
    }
    if (dateFrom != null) {
      clauses.push("t.TransactionDate >= ?");
      params.push(dateFrom);
    }
    if (dateTo != null) {
      clauses.push("t.TransactionDate <= ?");
      params.push(dateTo);
    }
    if (accountId != null) {
      clauses.push(`EXISTS (SELECT 1 FROM line_items account_line
        WHERE account_line.transaction_id = t.transaction_id AND account_line.account_id = ?)`);
      params.push(accountId);
    }
    if (text != null) {
      const term = String(text).trim().toLocaleLowerCase("en-US");
      clauses.push(`(INSTR(LOWER(COALESCE(t.description, '')), ?) > 0
        OR EXISTS (SELECT 1 FROM line_items text_line
          LEFT JOIN accounts text_account ON text_account.account_id = text_line.account_id
            AND text_account.owner_person_id = t.owner_person_id
          WHERE text_line.transaction_id = t.transaction_id
            AND (INSTR(LOWER(COALESCE(text_line.memo, '')), ?) > 0
              OR INSTR(LOWER(COALESCE(text_account.AccountName, '')), ?) > 0)))`);
      params.push(term, term, term);
    }
  }
  const [rows] = await pool.query(
    `SELECT t.transaction_id, t.TransactionDate, t.description, t.TransactionState,
            c.CurrencyAbbreviation
       FROM transactions t
       JOIN currencies c ON c.currency_id = t.valuation_currency_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY t.transaction_id DESC LIMIT ?`,
    [...params, resolvedLimit + 1],
  );
  const pageRows = rows.slice(0, resolvedLimit);
  const lineItemsByTransaction = new Map();
  if (pageRows.length) {
    const placeholders = pageRows.map(() => "?").join(", ");
    const [lineRows] = await pool.query(
      `SELECT li.transaction_id, li.account_id, li.memo, a.AccountName
         FROM line_items li
         JOIN transactions t ON t.transaction_id = li.transaction_id AND t.owner_person_id = ?
         JOIN accounts a ON a.account_id = li.account_id AND a.owner_person_id = t.owner_person_id
        WHERE li.transaction_id IN (${placeholders})
        ORDER BY li.transaction_id, li.line_item_id`,
      [personId, ...pageRows.map((row) => row.transaction_id)],
    );
    for (const row of lineRows) {
      const id = Number(row.transaction_id);
      if (!lineItemsByTransaction.has(id)) lineItemsByTransaction.set(id, []);
      lineItemsByTransaction.get(id).push(row);
    }
  }
  const term = text == null ? null : String(text).trim().toLocaleLowerCase("en-US");
  const transactions = pageRows.map((row) => {
    const lines = lineItemsByTransaction.get(Number(row.transaction_id)) ?? [];
    const matchedFields = [];
    if (term != null) {
      if (String(row.description ?? "").toLocaleLowerCase("en-US").includes(term)) matchedFields.push("description");
      if (lines.some((line) => String(line.memo ?? "").toLocaleLowerCase("en-US").includes(term))) {
        matchedFields.push("lineMemo");
      }
      if (lines.some((line) => String(line.AccountName ?? "").toLocaleLowerCase("en-US").includes(term))) {
        matchedFields.push("accountName");
      }
    }
    if (accountId != null) matchedFields.push("accountId");
    if (dateFrom != null || dateTo != null) matchedFields.push("date");
    if (transactionId != null) matchedFields.push("id");
    return transactionObject({
      id: Number(row.transaction_id), date: row.TransactionDate, description: row.description,
      state: row.TransactionState, valuationCurrencyCode: String(row.CurrencyAbbreviation).trim(),
      accountIds: [...new Set(lines.map((line) => Number(line.account_id)))], matchedFields,
    });
  });
  return { objects: transactions, nextCursor: rows.length > resolvedLimit ? String(transactions.at(-1).id) : null };
}

export async function listLineItemObjectsPage(pool, personId, {
  limit = 100, cursor = null, lineItemId = null, transactionId = null,
  accountId = null, text = null,
} = {}) {
  const resolvedLimit = Number(limit);
  if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1 || resolvedLimit > 500) {
    throw objectReadError("Line-item object limit must be from 1 through 500.", "INVALID_LINE_ITEM_OBJECT_LIMIT");
  }
  if (lineItemId != null && [cursor, transactionId, accountId, text].some((value) => value != null)) {
    throw objectReadError("An exact line-item ID cannot be combined with other filters.", "INVALID_LINE_ITEM_OBJECT_FILTER");
  }
  const clauses = ["t.owner_person_id = ?", "a.owner_person_id = t.owner_person_id"];
  const params = [personId];
  if (lineItemId != null) {
    clauses.push("li.line_item_id = ?");
    params.push(lineItemId);
  } else {
    if (cursor != null) {
      clauses.push("li.line_item_id < ?");
      params.push(cursor);
    }
    if (transactionId != null) {
      clauses.push("li.transaction_id = ?");
      params.push(transactionId);
    }
    if (accountId != null) {
      clauses.push("li.account_id = ?");
      params.push(accountId);
    }
    if (text != null) {
      const term = String(text).trim().toLocaleLowerCase("en-US");
      clauses.push("(INSTR(LOWER(COALESCE(li.memo, '')), ?) > 0 OR INSTR(LOWER(COALESCE(t.description, '')), ?) > 0 OR INSTR(LOWER(a.AccountName), ?) > 0)");
      params.push(term, term, term);
    }
  }
  const [rows] = await pool.query(
    `SELECT li.line_item_id, li.transaction_id, li.account_id, li.amount_units, li.memo,
            li.reconciliation_state, t.TransactionDate, t.description AS transaction_description,
            a.AccountName, a.parent_account_id, c.CurrencyAbbreviation
       FROM line_items li
       JOIN transactions t ON t.transaction_id = li.transaction_id
       JOIN accounts a ON a.account_id = li.account_id
       JOIN currencies c ON c.currency_id = a.account_currency_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY li.line_item_id DESC LIMIT ?`,
    [...params, resolvedLimit + 1],
  );
  const pageRows = rows.slice(0, resolvedLimit);
  const pathAccounts = await loadAccountObjectPaths(pool, personId, pageRows.map((row) => ({
    id: Number(row.account_id), name: row.AccountName,
    parentAccountId: row.parent_account_id == null ? null : Number(row.parent_account_id),
  })));
  const paths = new Map();
  const byId = new Map(pathAccounts.map((account) => [account.id, account]));
  const fullName = (id, seen = new Set()) => {
    if (paths.has(id)) return paths.get(id);
    if (seen.has(id)) return byId.get(id)?.name ?? `Account #${id}`;
    const account = byId.get(id);
    if (!account) return `Account #${id}`;
    const nextSeen = new Set(seen).add(id);
    const value = account.parentAccountId == null
      ? account.name
      : `${fullName(account.parentAccountId, nextSeen)}:${account.name}`;
    paths.set(id, value);
    return value;
  };
  const objects = pageRows.map((row) => lineItemObject(row, fullName(Number(row.account_id))));
  return {
    objects,
    nextCursor: rows.length > resolvedLimit ? String(objects.at(-1).id) : null,
  };
}

export function accountingQuestionObject(question) {
  return {
    objectType: "accounting.question",
    id: question.lineItemId,
    sourceRef: `accounting://questions/${question.lineItemId}`,
    displayName: `${question.transactionDate} · ${compact(question.prompt)}`,
    transactionId: question.transactionId,
    accountId: question.accountId,
    accountFullName: question.accountFullName,
    transactionDate: question.transactionDate,
    amountUnits: question.amountUnits,
    currencyCode: question.currencyCode,
    status: question.status,
    audience: question.audience,
    prompt: question.prompt,
  };
}

export function balanceAssertionObject(assertion) {
  return {
    objectType: "accounting.balance_assertion",
    id: assertion.id,
    sourceRef: `accounting://balance-assertions/${assertion.id}`,
    displayName: `${assertion.date} · ${compact(assertion.accountName, 80)} · ${unitsToDecimal(assertion.knownBalanceUnits, assertion.scale)} ${assertion.currencyCode}`,
    accountId: assertion.accountId,
    accountName: assertion.accountName,
    date: assertion.date,
    knownBalanceUnits: assertion.knownBalanceUnits,
    currencyCode: assertion.currencyCode,
    matches: assertion.matches,
  };
}

function importJobObject(row) {
  const id = String(row.import_job_id);
  const sourceSystem = String(row.source_system);
  const fileName = row.source_file_name == null ? null : String(row.source_file_name);
  const createdAt = String(row.created_at);
  const jobStatus = String(row.job_status);
  return {
    objectType: "accounting.transaction_import_job",
    id,
    sourceRef: `accounting://transaction-import-jobs/${id}`,
    displayName: `${compact(fileName || sourceSystem)} · ${createdAt.slice(0, 10)} · ${jobStatus}`,
    sourceSystem,
    fileName,
    jobStatus,
    expectedRecordCount: Number(row.expected_record_count),
    createdAt,
    updatedAt: String(row.updated_at),
  };
}

export async function listTransactionImportJobObjectsPage(pool, personId, {
  limit = 100, cursor = null, importJobId = null, text = null,
} = {}) {
  const resolvedLimit = Number(limit);
  if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1 || resolvedLimit > 500) {
    throw Object.assign(new Error("Import-job object limit must be from 1 through 500."), {
      code: "INVALID_IMPORT_JOB_OBJECT_LIMIT", status: 400,
    });
  }
  if (cursor != null && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(cursor)) {
    throw Object.assign(new Error("Import-job object cursor is invalid."), {
      code: "INVALID_IMPORT_JOB_OBJECT_CURSOR", status: 400,
    });
  }
  if (importJobId != null && (cursor != null || text != null)) {
    throw Object.assign(new Error("An exact import-job ID cannot be combined with cursor or text."), {
      code: "INVALID_IMPORT_JOB_OBJECT_FILTER", status: 400,
    });
  }
  const clauses = ["owner_person_id = ?"];
  const params = [personId];
  if (importJobId != null) {
    clauses.push("import_job_id = ?");
    params.push(importJobId);
  } else {
    if (cursor != null) {
      clauses.push("import_job_id < ?");
      params.push(cursor);
    }
    if (text != null) {
      const term = String(text).trim().toLocaleLowerCase("en-US");
      clauses.push("(INSTR(LOWER(source_system), ?) > 0 OR INSTR(LOWER(COALESCE(source_file_name, '')), ?) > 0)");
      params.push(term, term);
    }
  }
  const [rows] = await pool.query(
    `SELECT import_job_id, source_system, source_file_name, expected_record_count,
            job_status, created_at, updated_at
       FROM accounting_transaction_import_jobs
      WHERE ${clauses.join(" AND ")}
      ORDER BY import_job_id DESC LIMIT ?`,
    [...params, resolvedLimit + 1],
  );
  const page = rows.slice(0, resolvedLimit).map(importJobObject);
  return {
    objects: page,
    nextCursor: rows.length > resolvedLimit ? page.at(-1).id : null,
  };
}
