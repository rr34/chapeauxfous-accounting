import { createHash } from "node:crypto";

function applicationError(message, code = "INVALID_TRANSACTION_SEARCH") {
  return Object.assign(new Error(message), { status: 400, code });
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function calendarDate(value, field) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw applicationError(`${field} must be YYYY-MM-DD.`, "INVALID_TRANSACTION_DATE");
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw applicationError(`${field} is not a valid calendar date.`, "INVALID_TRANSACTION_DATE");
  }
  return normalized;
}

function decimal(value, field) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(normalized)) {
    throw applicationError(`${field} must be a nonnegative decimal with no more than 18 fractional digits.`,
      "INVALID_AMOUNT_FILTER");
  }
  const [whole, fractional = ""] = normalized.split(".");
  return { source: normalized, units: BigInt(`${whole}${fractional}`), scale: fractional.length };
}

function compareDecimal(leftUnits, leftScale, right) {
  return leftUnits * (10n ** BigInt(right.scale)) - right.units * (10n ** BigInt(leftScale));
}

function amountMatches(line, filters) {
  const signedUnits = BigInt(line.amountUnits);
  if (filters.amountSign === "positive" && signedUnits <= 0n) return false;
  if (filters.amountSign === "negative" && signedUnits >= 0n) return false;
  const magnitude = signedUnits < 0n ? -signedUnits : signedUnits;
  if (filters.amount != null) {
    const targetDifference = compareDecimal(magnitude, line.scale, filters.amount);
    const absoluteDifference = targetDifference < 0n ? -targetDifference : targetDifference;
    const toleranceUnits = filters.amountTolerance.units * (10n ** BigInt(line.scale));
    const lineUnits = absoluteDifference * (10n ** BigInt(filters.amountTolerance.scale));
    if (lineUnits > toleranceUnits * (10n ** BigInt(filters.amount.scale))) return false;
  }
  if (filters.minimumAmount != null && compareDecimal(magnitude, line.scale, filters.minimumAmount) < 0n) return false;
  if (filters.maximumAmount != null && compareDecimal(magnitude, line.scale, filters.maximumAmount) > 0n) return false;
  return true;
}

function formatUnits(units, scale) {
  const negative = String(units).startsWith("-");
  const digits = String(units).replace(/^-/, "").padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function accountPaths(accounts) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const paths = new Map();
  function pathFor(account, visiting = new Set()) {
    if (paths.has(account.id)) return paths.get(account.id);
    if (visiting.has(account.id)) return account.name;
    const nextVisiting = new Set(visiting).add(account.id);
    const parent = account.parentAccountId == null ? null : byId.get(account.parentAccountId);
    const path = parent ? `${pathFor(parent, nextVisiting)}:${account.name}` : account.name;
    paths.set(account.id, path);
    return path;
  }
  for (const account of accounts) pathFor(account);
  return paths;
}

function accountScope(accounts, accountId, includeDescendants) {
  if (accountId == null) return null;
  if (!accounts.some((account) => account.id === accountId)) {
    throw applicationError(`Account ${accountId} was not found.`, "ACCOUNT_NOT_FOUND");
  }
  const ids = new Set([accountId]);
  if (!includeDescendants) return ids;
  let changed = true;
  while (changed) {
    changed = false;
    for (const account of accounts) {
      if (account.parentAccountId != null && ids.has(account.parentAccountId) && !ids.has(account.id)) {
        ids.add(account.id);
        changed = true;
      }
    }
  }
  return ids;
}

function parseIssues(value) {
  if (value == null) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [{ code: "UNPARSEABLE_IMPORT_ISSUE", message: String(value) }];
  }
}

function addMatch(matches, field, lineId = null) {
  matches.fields.add(field);
  if (lineId != null) matches.lineIds.add(lineId);
}

function textMatch(transaction, query) {
  const matches = { fields: new Set(), lineIds: new Set() };
  const inspect = (value, field, lineId = null) => {
    if (normalizeText(value).includes(query)) addMatch(matches, field, lineId);
  };
  inspect(transaction.description, "description");
  inspect(transaction.sourceSystem, "sourceSystem");
  inspect(transaction.externalId, "externalId");
  inspect(transaction.valuationCurrencyCode, "valuationCurrencyCode");
  for (const line of transaction.lineItems) {
    inspect(line.memo, "lineItems.memo", line.id);
    inspect(line.sourceId, "lineItems.sourceId", line.id);
    inspect(line.accountName, "lineItems.accountName", line.id);
    inspect(line.accountFullName, "lineItems.accountFullName", line.id);
    inspect(line.accountDescription, "lineItems.accountDescription", line.id);
    inspect(line.currencyCode, "lineItems.currencyCode", line.id);
    for (const tag of line.tags) {
      inspect(tag.key, "lineItems.tags.key", line.id);
      inspect(tag.value, "lineItems.tags.value", line.id);
    }
  }
  for (const source of transaction.importSources) {
    inspect(source.importJobId, "importSources.importJobId");
    inspect(source.sourceSystem, "importSources.sourceSystem");
    inspect(source.sourceFileName, "importSources.sourceFileName");
    inspect(source.externalId, "importSources.externalId");
    for (const issue of source.issues) {
      inspect(issue.code, "importSources.issues.code");
      inspect(issue.message, "importSources.issues.message");
      inspect(JSON.stringify(issue.details), "importSources.issues.details");
    }
  }
  return matches;
}

function sourceMatches(transaction, source) {
  const wanted = normalizeText(source);
  return [transaction.sourceSystem, ...transaction.importSources.flatMap((item) => [
    item.importJobId, item.sourceSystem, item.sourceFileName,
  ])].some((value) => normalizeText(value) === wanted);
}

function externalIdMatches(transaction, externalId) {
  const wanted = normalizeText(externalId);
  return [transaction.externalId, ...transaction.importSources.map((source) => source.externalId)]
    .some((value) => normalizeText(value) === wanted);
}

function referenceMatches(transaction, reference) {
  const wanted = normalizeText(reference);
  return [transaction.externalId, ...transaction.lineItems.map((line) => line.sourceId)]
    .some((value) => normalizeText(value) === wanted);
}

function normalizedFilters(options) {
  const amount = decimal(options.amount, "amount");
  const amountTolerance = decimal(options.amountTolerance ?? "0", "amount_tolerance");
  const minimumAmount = decimal(options.minimumAmount, "minimum_amount");
  const maximumAmount = decimal(options.maximumAmount, "maximum_amount");
  if (amount == null && amountTolerance.units !== 0n) {
    throw applicationError("amount_tolerance requires amount.", "INVALID_AMOUNT_FILTER");
  }
  if (amount != null && (minimumAmount != null || maximumAmount != null)) {
    throw applicationError("Use amount with amount_tolerance or minimum_amount/maximum_amount, not both.",
      "INVALID_AMOUNT_FILTER");
  }
  if (minimumAmount != null && maximumAmount != null
      && compareDecimal(minimumAmount.units, minimumAmount.scale, maximumAmount) > 0n) {
    throw applicationError("minimum_amount cannot exceed maximum_amount.", "INVALID_AMOUNT_FILTER");
  }
  const date = calendarDate(options.date, "date");
  const dateFrom = calendarDate(options.dateFrom, "date_from");
  const dateTo = calendarDate(options.dateTo, "date_to");
  if (date != null && (dateFrom != null || dateTo != null)) {
    throw applicationError("Use date or date_from/date_to, not both.", "INVALID_TRANSACTION_DATE");
  }
  if (dateFrom != null && dateTo != null && dateFrom > dateTo) {
    throw applicationError("date_from cannot be after date_to.", "INVALID_TRANSACTION_DATE");
  }
  return {
    text: normalizeText(options.text) || null,
    accountId: options.accountId == null ? null : Number(options.accountId),
    includeAccountDescendants: options.includeAccountDescendants !== false,
    counterAccountId: options.counterAccountId == null ? null : Number(options.counterAccountId),
    includeCounterAccountDescendants: options.includeCounterAccountDescendants !== false,
    date: date ?? null,
    dateFrom: dateFrom ?? null,
    dateTo: dateTo ?? null,
    amount,
    amountTolerance,
    minimumAmount,
    maximumAmount,
    amountSign: options.amountSign ?? "either",
    transactionId: options.transactionId == null ? null : Number(options.transactionId),
    externalId: options.externalId == null ? null : String(options.externalId).trim(),
    reference: options.reference == null ? null : String(options.reference).trim(),
    currencyCode: options.currencyCode == null ? null : normalizeText(options.currencyCode),
    source: options.source == null ? null : String(options.source).trim(),
    hasIssues: options.hasIssues == null ? null : Boolean(options.hasIssues),
    sortBy: options.sortBy ?? "date",
    sortDirection: options.sortDirection ?? "desc",
  };
}

function publicFilters(filters) {
  return {
    text: filters.text,
    accountId: filters.accountId,
    includeAccountDescendants: filters.includeAccountDescendants,
    counterAccountId: filters.counterAccountId,
    includeCounterAccountDescendants: filters.includeCounterAccountDescendants,
    date: filters.date,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    amount: filters.amount?.source ?? null,
    amountTolerance: filters.amount == null ? null : filters.amountTolerance.source,
    minimumAmount: filters.minimumAmount?.source ?? null,
    maximumAmount: filters.maximumAmount?.source ?? null,
    amountSign: filters.amountSign,
    transactionId: filters.transactionId,
    externalId: filters.externalId,
    reference: filters.reference,
    currencyCode: filters.currencyCode?.toUpperCase() ?? null,
    source: filters.source,
    hasIssues: filters.hasIssues,
    sortBy: filters.sortBy,
    sortDirection: filters.sortDirection,
  };
}

function cursorDigest(filters) {
  return createHash("sha256").update(JSON.stringify(publicFilters(filters))).digest("hex");
}

function encodeCursor(filters, transactionId) {
  return Buffer.from(JSON.stringify({ version: 1, digest: cursorDigest(filters), transactionId }), "utf8")
    .toString("base64url");
}

function decodeCursor(cursor, filters) {
  if (cursor == null) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (decoded.version !== 1 || decoded.digest !== cursorDigest(filters)
        || !Number.isInteger(decoded.transactionId) || decoded.transactionId <= 0) throw new Error("invalid");
    return decoded.transactionId;
  } catch {
    throw applicationError("Transaction search cursor is invalid or belongs to different filters.", "INVALID_CURSOR");
  }
}

function compareLineAmounts(left, right) {
  const leftUnits = BigInt(left.amountUnits);
  const rightUnits = BigInt(right.amountUnits);
  return compareDecimal(leftUnits < 0n ? -leftUnits : leftUnits, left.scale,
    { units: rightUnits < 0n ? -rightUnits : rightUnits, scale: right.scale });
}

function compareTransactions(left, right, filters) {
  let compared = 0;
  if (filters.sortBy === "date") compared = left.date.localeCompare(right.date);
  if (filters.sortBy === "description") {
    compared = normalizeText(left.description).localeCompare(normalizeText(right.description));
  }
  if (filters.sortBy === "amount") {
    const amountComparison = compareLineAmounts(left.sortLine, right.sortLine);
    compared = amountComparison < 0n ? -1 : amountComparison > 0n ? 1 : 0;
  }
  if (compared === 0) compared = left.id - right.id;
  return filters.sortDirection === "asc" ? compared : -compared;
}

function searchOne(transaction, filters, primaryScope, counterScope) {
  const matches = { fields: new Set(), lineIds: new Set() };
  if (filters.transactionId != null && transaction.id !== filters.transactionId) return null;
  if (filters.transactionId != null) addMatch(matches, "transactionId");
  if (filters.date != null && transaction.date !== filters.date) return null;
  if (filters.dateFrom != null && transaction.date < filters.dateFrom) return null;
  if (filters.dateTo != null && transaction.date > filters.dateTo) return null;
  if (filters.date != null || filters.dateFrom != null || filters.dateTo != null) addMatch(matches, "date");
  if (filters.externalId != null && !externalIdMatches(transaction, filters.externalId)) return null;
  if (filters.externalId != null) addMatch(matches, "externalId");
  if (filters.reference != null && !referenceMatches(transaction, filters.reference)) return null;
  if (filters.reference != null) addMatch(matches, "reference");
  if (filters.source != null && !sourceMatches(transaction, filters.source)) return null;
  if (filters.source != null) addMatch(matches, "source");
  if (filters.hasIssues != null && transaction.hasIssues !== filters.hasIssues) return null;
  if (filters.hasIssues != null) addMatch(matches, "hasIssues");

  const primaryLines = primaryScope == null
    ? transaction.lineItems
    : transaction.lineItems.filter((line) => primaryScope.has(line.accountId));
  if (primaryScope != null && primaryLines.length === 0) return null;
  if (primaryScope != null) for (const line of primaryLines) addMatch(matches, "account", line.id);

  if (counterScope != null) {
    const counterLines = transaction.lineItems.filter((line) => counterScope.has(line.accountId)
      && (primaryScope == null || primaryLines.some((primary) => primary.id !== line.id)));
    if (counterLines.length === 0) return null;
    for (const line of counterLines) addMatch(matches, "counterAccount", line.id);
  }

  let amountLines = primaryLines;
  if (filters.currencyCode != null) {
    amountLines = amountLines.filter((line) => normalizeText(line.currencyCode) === filters.currencyCode);
    if (amountLines.length === 0 && primaryScope == null
        && normalizeText(transaction.valuationCurrencyCode) === filters.currencyCode
        && filters.amount == null && filters.minimumAmount == null && filters.maximumAmount == null) {
      amountLines = transaction.lineItems;
    }
    if (amountLines.length === 0) return null;
    addMatch(matches, "currency");
  }
  const hasAmountFilter = filters.amount != null || filters.minimumAmount != null
    || filters.maximumAmount != null || filters.amountSign !== "either";
  if (hasAmountFilter) {
    amountLines = amountLines.filter((line) => amountMatches(line, filters));
    if (amountLines.length === 0) return null;
    for (const line of amountLines) addMatch(matches, "amount", line.id);
  }

  if (filters.text != null) {
    const textMatches = textMatch(transaction, filters.text);
    if (textMatches.fields.size === 0) return null;
    for (const field of textMatches.fields) matches.fields.add(field);
    for (const lineId of textMatches.lineIds) matches.lineIds.add(lineId);
  }

  return {
    ...transaction,
    matchedFields: [...matches.fields].sort(),
    matchedLineItemIds: [...matches.lineIds].sort((left, right) => left - right),
    sortLine: amountLines[0] ?? transaction.lineItems[0] ?? { amountUnits: "0", scale: 0 },
  };
}

function mapRows(rows, accounts, paths) {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const transactions = new Map();
  for (const row of rows) {
    const transactionId = Number(row.transaction_id);
    if (!transactions.has(transactionId)) {
      transactions.set(transactionId, {
        id: transactionId,
        date: row.TransactionDate,
        description: row.transaction_description,
        state: row.TransactionState,
        valuationCurrencyId: Number(row.valuation_currency_id),
        valuationCurrencyCode: String(row.valuation_currency_code).trim(),
        valuationScale: Number(row.valuation_scale),
        sourceSystem: row.transaction_source_system,
        externalId: row.transaction_source_id,
        hasIssues: false,
        issueCodes: [],
        lineItems: [],
        importSources: [],
        _lines: new Map(),
        _imports: new Map(),
        _issueCodes: new Set(),
      });
    }
    const transaction = transactions.get(transactionId);
    if (row.line_item_id != null) {
      const lineId = Number(row.line_item_id);
      if (!transaction._lines.has(lineId)) {
        const accountId = Number(row.account_id);
        const account = accountById.get(accountId);
        const line = {
          id: lineId,
          amountUnits: String(row.amount_units),
          amountDecimal: formatUnits(row.amount_units, Number(row.account_scale)),
          valueUnits: row.value_units == null ? null : String(row.value_units),
          memo: row.line_memo,
          sourceId: row.line_source_id,
          reconciliationState: row.reconciliation_state,
          reconciledAt: row.reconciled_at,
          accountId,
          accountName: account?.name ?? row.AccountName,
          accountFullName: paths.get(accountId) ?? row.AccountName,
          accountDescription: account?.description ?? null,
          currencyId: Number(row.account_currency_id),
          currencyCode: String(row.account_currency_code).trim(),
          scale: Number(row.account_scale),
          tags: [],
          _tagKeys: new Set(),
        };
        transaction._lines.set(lineId, line);
        transaction.lineItems.push(line);
      }
      const line = transaction._lines.get(lineId);
      if (row.tag_key != null && row.tag_value != null) {
        const tagKey = `${row.tag_key}\u0000${row.tag_value}`;
        if (!line._tagKeys.has(tagKey)) {
          line._tagKeys.add(tagKey);
          line.tags.push({ key: row.tag_key, value: row.tag_value });
        }
      }
    }
    if (row.import_job_id != null && row.import_external_id != null) {
      const importKey = `${row.import_job_id}\u0000${row.import_external_id}`;
      if (!transaction._imports.has(importKey)) {
        const issues = parseIssues(row.import_errors_json);
        const source = {
          importJobId: row.import_job_id,
          sourceSystem: row.import_source_system,
          sourceFileName: row.source_file_name,
          externalId: row.import_external_id,
          status: row.import_item_status,
          issues: issues.map((issue) => ({ code: String(issue.code ?? "IMPORT_ISSUE"),
            message: String(issue.message ?? issue.code ?? "Import issue"), details: issue.details ?? null })),
        };
        transaction._imports.set(importKey, source);
        transaction.importSources.push(source);
        for (const issue of source.issues) transaction._issueCodes.add(issue.code);
        if (source.status === "exception" || source.issues.length > 0) transaction.hasIssues = true;
      }
    }
  }
  return [...transactions.values()].map((transaction) => {
    transaction.lineItems.sort((left, right) => left.id - right.id);
    transaction.importSources.sort((left, right) => left.importJobId.localeCompare(right.importJobId)
      || left.externalId.localeCompare(right.externalId));
    transaction.issueCodes = [...transaction._issueCodes].sort();
    for (const line of transaction.lineItems) delete line._tagKeys;
    delete transaction._lines;
    delete transaction._imports;
    delete transaction._issueCodes;
    return transaction;
  });
}

export async function searchTransactionsPage(pool, personId, options = {}) {
  const filters = normalizedFilters(options);
  const limit = Math.min(Math.max(Number(options.limit) || 25, 1), 100);
  const [accountRows] = await pool.query(
    `SELECT a.account_id, a.AccountName, a.description, a.parent_account_id,
            a.account_currency_id, c.CurrencyAbbreviation, c.scale
       FROM accounts a
       JOIN currencies c ON c.currency_id = a.account_currency_id
      WHERE a.owner_person_id = ?
      ORDER BY a.account_id`,
    [personId],
  );
  const accounts = accountRows.map((row) => ({
    id: Number(row.account_id),
    name: row.AccountName,
    description: row.description,
    parentAccountId: row.parent_account_id == null ? null : Number(row.parent_account_id),
    currencyId: Number(row.account_currency_id),
    currencyCode: String(row.CurrencyAbbreviation).trim(),
    scale: Number(row.scale),
  }));
  const paths = accountPaths(accounts);
  const primaryScope = accountScope(accounts, filters.accountId, filters.includeAccountDescendants);
  const counterScope = accountScope(accounts, filters.counterAccountId, filters.includeCounterAccountDescendants);

  const [rows] = await pool.query(
    `SELECT t.transaction_id, t.TransactionDate, t.description AS transaction_description,
            t.TransactionState, t.valuation_currency_id,
            vc.CurrencyAbbreviation AS valuation_currency_code, vc.scale AS valuation_scale,
            t.source_system AS transaction_source_system, t.source_id AS transaction_source_id,
            li.line_item_id, li.amount_units, li.value_units, li.memo AS line_memo,
            li.source_id AS line_source_id, li.reconciliation_state, li.reconciled_at,
            li.account_id, a.AccountName, a.account_currency_id,
            ac.CurrencyAbbreviation AS account_currency_code, ac.scale AS account_scale,
            tag.tag_key, tag.tag_value,
            item.import_job_id, item.transaction_external_id AS import_external_id,
            item.item_status AS import_item_status, item.errors_json AS import_errors_json,
            job.source_system AS import_source_system, job.source_file_name
       FROM transactions t
       JOIN currencies vc ON vc.currency_id = t.valuation_currency_id
       LEFT JOIN line_items li ON li.transaction_id = t.transaction_id
       LEFT JOIN accounts a ON a.account_id = li.account_id AND a.owner_person_id = t.owner_person_id
       LEFT JOIN currencies ac ON ac.currency_id = a.account_currency_id
       LEFT JOIN lineitems_tags_join tagged ON tagged.tagged_line_item_id = li.line_item_id
       LEFT JOIN tags tag ON tag.tag_id = tagged.tag_id AND tag.owner_person_id = t.owner_person_id
       LEFT JOIN accounting_transaction_import_items item ON item.ledger_transaction_id = t.transaction_id
       LEFT JOIN accounting_transaction_import_jobs job
         ON job.import_job_id = item.import_job_id AND job.owner_person_id = t.owner_person_id
      WHERE t.owner_person_id = ?
      ORDER BY t.transaction_id, li.line_item_id, tag.tag_id, item.import_job_id, item.transaction_external_id`,
    [personId],
  );
  const searched = mapRows(rows, accounts, paths)
    .map((transaction) => searchOne(transaction, filters, primaryScope, counterScope))
    .filter(Boolean)
    .sort((left, right) => compareTransactions(left, right, filters));
  const cursorId = decodeCursor(options.cursor, filters);
  let offset = 0;
  if (cursorId != null) {
    const cursorIndex = searched.findIndex((transaction) => transaction.id === cursorId);
    if (cursorIndex < 0) throw applicationError("Transaction search cursor no longer identifies a matching result.",
      "INVALID_CURSOR");
    offset = cursorIndex + 1;
  }
  const page = searched.slice(offset, offset + limit);
  const hasMore = offset + limit < searched.length;
  const transactions = page.map(({ sortLine, ...transaction }) => transaction);
  return {
    filters: publicFilters(filters),
    transactions,
    totalMatches: searched.length,
    nextCursor: hasMore ? encodeCursor(filters, transactions.at(-1).id) : null,
  };
}
