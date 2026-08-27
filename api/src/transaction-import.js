import { createHash, randomUUID } from "node:crypto";
import { withPoolTransaction } from "./db.js";
import { currencyKey } from "./currencies.js";
import { decimalToUnits, greatestCommonDivisor } from "./money.js";
import { validateTransaction } from "./accounting.js";
import { pruneOwnerAccountingImportPlans } from "./import-plan-retention.js";
import {
  TRANSACTION_IMPORT_MAX_LINE_ITEMS,
  TRANSACTION_IMPORT_MAX_TRANSACTIONS,
} from "./transaction-import-limits.js";

const signedBigIntMinimum = -(2n ** 63n);
const signedBigIntMaximum = (2n ** 63n) - 1n;

function importError(message, code, details = undefined, status = 400) {
  return Object.assign(new Error(message), { status, code, details });
}

function trimmedText(value) {
  return String(value ?? "").trim() || null;
}

function optionalLimitedText(value, field, maximum) {
  const text = trimmedText(value);
  if (text != null && [...text].length > maximum) {
    throw importError(`${field} cannot exceed ${maximum} characters.`, `${field.toLocaleUpperCase("en-US")}_TOO_LONG`);
  }
  return text;
}

function limitedRequiredText(value, field, maximum) {
  const text = String(value ?? "").trim();
  if (!text) throw importError(`${field} is required.`, `${field.toLocaleUpperCase("en-US")}_REQUIRED`);
  if ([...text].length > maximum) {
    throw importError(`${field} cannot exceed ${maximum} characters.`, `${field.toLocaleUpperCase("en-US")}_TOO_LONG`);
  }
  return text;
}

function normalizeAccountPath(value) {
  const supplied = String(value ?? "").trim();
  if ([...supplied].length > 4096) {
    throw importError("An account path cannot exceed 4,096 characters.", "ACCOUNT_PATH_TOO_LONG");
  }
  const parts = supplied.split(":").map((part) => part.trim());
  if (!supplied || parts.some((part) => !part)) {
    throw importError("Every line item requires a valid colon-delimited full account path.", "INVALID_ACCOUNT_PATH", {
      accountFullName: supplied,
    });
  }
  return parts.join(":");
}

function normalizeDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw importError("Every transaction date must use YYYY-MM-DD.", "INVALID_TRANSACTION_DATE", { value: text });
  }
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw importError(`Transaction date "${text}" is not a calendar date.`, "INVALID_TRANSACTION_DATE", { value: text });
  }
  return text;
}

function normalizeLine(line, transactionExternalId) {
  const externalId = optionalLimitedText(line?.externalId, "line external ID", 128);
  if (externalId != null && [...externalId].length > 128) {
    throw importError("A line-item external ID cannot exceed 128 characters.", "LINE_EXTERNAL_ID_TOO_LONG", {
      transactionExternalId,
    });
  }
  return {
    externalId,
    accountFullName: normalizeAccountPath(line?.accountFullName),
    amountDecimal: limitedRequiredText(line?.amountDecimal, "amount", 128),
    valueDecimal: optionalLimitedText(line?.valueDecimal, "value", 128),
    memo: optionalLimitedText(line?.memo, "memo", 16000),
  };
}

function normalizeTransaction(transaction) {
  const externalId = limitedRequiredText(transaction?.externalId, "external transaction ID", 128);
  if (!Array.isArray(transaction?.lineItems) || transaction.lineItems.length < 2) {
    throw importError(`Transaction "${externalId}" requires at least two line items.`, "TOO_FEW_LINE_ITEMS", { externalId });
  }
  return {
    externalId,
    transactionDate: normalizeDate(transaction?.transactionDate),
    description: optionalLimitedText(transaction?.description, "description", 16000),
    valuationCurrencyCode: limitedRequiredText(transaction?.valuationCurrencyCode, "valuation currency code", 50),
    lineItems: transaction.lineItems.map((line) => normalizeLine(line, externalId)),
  };
}

export function normalizeTransactionImport({ sourceSystem, transactions }) {
  const normalizedSourceSystem = limitedRequiredText(sourceSystem, "source system", 32);
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw importError("At least one complete transaction is required.", "TRANSACTIONS_REQUIRED");
  }
  if (transactions.length > TRANSACTION_IMPORT_MAX_TRANSACTIONS) {
    throw importError(`At most ${TRANSACTION_IMPORT_MAX_TRANSACTIONS} transactions can be imported in one atomic batch.`, "TOO_MANY_TRANSACTIONS");
  }

  const byExternalId = new Map();
  const conflictingExternalIds = new Set();
  let duplicateInputTransactionCount = 0;
  let submittedLineItemCount = 0;
  for (const transaction of transactions) {
    const normalized = normalizeTransaction(transaction);
    submittedLineItemCount += normalized.lineItems.length;
    const prior = byExternalId.get(normalized.externalId);
    if (!prior) {
      byExternalId.set(normalized.externalId, normalized);
    } else if (JSON.stringify(prior) === JSON.stringify(normalized)) {
      duplicateInputTransactionCount += 1;
    } else {
      conflictingExternalIds.add(normalized.externalId);
    }
  }
  if (submittedLineItemCount > TRANSACTION_IMPORT_MAX_LINE_ITEMS) {
    throw importError(`At most ${TRANSACTION_IMPORT_MAX_LINE_ITEMS} line items can be imported in one atomic batch.`, "TOO_MANY_LINE_ITEMS");
  }
  return {
    sourceSystem: normalizedSourceSystem,
    transactions: [...byExternalId.values()],
    submittedTransactionCount: transactions.length,
    submittedLineItemCount,
    duplicateInputTransactionCount,
    conflictingExternalIds: [...conflictingExternalIds],
  };
}

function buildAccountPaths(rows) {
  const byId = new Map(rows.map((row) => [Number(row.account_id), row]));
  const pathById = new Map();
  const visiting = new Set();

  function resolve(row) {
    const id = Number(row.account_id);
    if (pathById.has(id)) return pathById.get(id);
    if (visiting.has(id)) throw importError("The account hierarchy contains a cycle.", "INVALID_ACCOUNT_TREE");
    visiting.add(id);
    const name = String(row.AccountName ?? "").trim();
    if (!name || name.includes(":")) {
      throw importError("An account name cannot be resolved as a colon-delimited path.", "INVALID_ACCOUNT_TREE", {
        accountId: id,
      });
    }
    let path = name;
    if (row.parent_account_id != null) {
      const parent = byId.get(Number(row.parent_account_id));
      if (!parent) throw importError("An account references a missing parent.", "INVALID_ACCOUNT_TREE", { accountId: id });
      path = `${resolve(parent)}:${name}`;
    }
    visiting.delete(id);
    pathById.set(id, path);
    return path;
  }

  const candidatesByPath = new Map();
  for (const row of rows) {
    const path = resolve(row);
    const candidate = {
      id: Number(row.account_id),
      path,
      currencyId: Number(row.account_currency_id),
      currencyCode: String(row.CurrencyAbbreviation ?? "").trim(),
      scale: Number(row.scale),
      placeholder: Boolean(row.is_placeholder),
      archived: row.archived_at != null,
    };
    if (!candidatesByPath.has(path)) candidatesByPath.set(path, []);
    candidatesByPath.get(path).push(candidate);
  }
  return candidatesByPath;
}

function issue(code, message, details = undefined) {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function checkedDecimalToUnits(value, scale, field, details) {
  try {
    const units = decimalToUnits(value, scale);
    const integer = BigInt(units);
    if (integer < signedBigIntMinimum || integer > signedBigIntMaximum) {
      throw new Error("Amount is outside the signed 64-bit range");
    }
    return units;
  } catch (error) {
    throw importError(`${field} ${JSON.stringify(value)} is invalid for a unit with scale ${scale}: ${error.message}.`,
      "INVALID_DECIMAL_AMOUNT", { ...details, field, scale, value: String(value ?? "") });
  }
}

function fingerprintFor(transaction) {
  const lineItems = transaction.lineItems.map((line) => ({
    accountId: line.accountId,
    amountUnits: line.amountUnits,
    valueUnits: line.valueUnits,
    memo: line.memo,
    externalId: line.externalId,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const rates = transaction.rates.map((rate) => ({
    fromCurrencyId: rate.fromCurrencyId,
    fromUnits: rate.fromUnits,
    toCurrencyId: rate.toCurrencyId,
    toUnits: rate.toUnits,
  })).sort((left, right) => left.fromCurrencyId - right.fromCurrencyId);
  return createHash("sha256").update(JSON.stringify({
    transactionDate: transaction.transactionDate,
    description: transaction.description,
    valuationCurrencyId: transaction.valuationCurrencyId,
    lineItems,
    rates,
  }), "utf8").digest("hex");
}

function resolveTransaction(input, context, conflictingExternalIds) {
  const errors = [];
  if (conflictingExternalIds.has(input.externalId)) {
    errors.push(issue("CONFLICTING_DUPLICATE_EXTERNAL_ID",
      `External transaction ID "${input.externalId}" appears with different transaction data.`));
  }
  const lineExternalIds = new Set();
  for (const line of input.lineItems) {
    if (line.externalId == null) continue;
    if (lineExternalIds.has(line.externalId)) {
      errors.push(issue("DUPLICATE_LINE_EXTERNAL_ID",
        `Line external ID "${line.externalId}" appears more than once in transaction "${input.externalId}".`, {
          externalId: input.externalId, lineExternalId: line.externalId,
        }));
    }
    lineExternalIds.add(line.externalId);
  }

  const currencyCandidates = context.currenciesByCode.get(currencyKey(input.valuationCurrencyCode)) ?? [];
  let valuationCurrency = null;
  if (currencyCandidates.length === 0) {
    errors.push(issue("UNKNOWN_VALUATION_CURRENCY",
      `Valuation currency "${input.valuationCurrencyCode}" is not available.`, { currencyCode: input.valuationCurrencyCode }));
  } else if (currencyCandidates.length > 1) {
    errors.push(issue("AMBIGUOUS_VALUATION_CURRENCY",
      `Valuation currency "${input.valuationCurrencyCode}" is ambiguous.`, { currencyCode: input.valuationCurrencyCode }));
  } else {
    [valuationCurrency] = currencyCandidates;
  }

  const resolvedLines = [];
  for (const line of input.lineItems) {
    const accountCandidates = context.accountsByPath.get(line.accountFullName) ?? [];
    if (accountCandidates.length === 0) {
      errors.push(issue("UNKNOWN_ACCOUNT_PATH", `Account path "${line.accountFullName}" does not exist.`, {
        accountFullName: line.accountFullName,
      }));
      continue;
    }
    if (accountCandidates.length > 1) {
      errors.push(issue("AMBIGUOUS_ACCOUNT_PATH", `Account path "${line.accountFullName}" matches multiple accounts.`, {
        accountFullName: line.accountFullName,
        accountIds: accountCandidates.map((account) => account.id),
      }));
      continue;
    }
    const [account] = accountCandidates;
    if (account.archived) {
      errors.push(issue("ARCHIVED_ACCOUNT_PATH", `Account path "${line.accountFullName}" is archived.`, {
        accountFullName: line.accountFullName,
      }));
    }
    if (account.placeholder) {
      errors.push(issue("PLACEHOLDER_ACCOUNT_PATH", `Account path "${line.accountFullName}" is non-postable.`, {
        accountFullName: line.accountFullName,
      }));
    }
    try {
      const amountUnits = checkedDecimalToUnits(line.amountDecimal, account.scale, "amount_decimal", {
        externalId: input.externalId, accountFullName: line.accountFullName,
      });
      let valueUnits = null;
      if (valuationCurrency) {
        if (account.currencyId === valuationCurrency.id && line.valueDecimal == null) {
          valueUnits = amountUnits;
        } else if (line.valueDecimal == null) {
          errors.push(issue("FOREIGN_VALUE_REQUIRED",
            `Line for "${line.accountFullName}" requires its value in ${valuationCurrency.code}.`, {
              accountFullName: line.accountFullName, valuationCurrencyCode: valuationCurrency.code,
            }));
        } else {
          valueUnits = checkedDecimalToUnits(line.valueDecimal, valuationCurrency.scale, "value_decimal", {
            externalId: input.externalId, accountFullName: line.accountFullName,
          });
          if (account.currencyId === valuationCurrency.id && valueUnits !== amountUnits) {
            errors.push(issue("NATIVE_VALUE_MISMATCH",
              `Amount and value differ for native-currency account "${line.accountFullName}".`, {
                accountFullName: line.accountFullName, amountUnits, valueUnits,
              }));
          }
        }
      }
      resolvedLines.push({ ...line, accountId: account.id, accountCurrencyId: account.currencyId,
        accountCurrencyCode: account.currencyCode, amountUnits, valueUnits });
    } catch (error) {
      if (error.code === "INVALID_DECIMAL_AMOUNT") errors.push(issue(error.code, error.message, error.details));
      else throw error;
    }
  }

  const rates = [];
  if (valuationCurrency && resolvedLines.length === input.lineItems.length) {
    const foreignByCurrency = new Map();
    for (const line of resolvedLines) {
      if (line.accountCurrencyId === valuationCurrency.id) continue;
      if (!foreignByCurrency.has(line.accountCurrencyId)) foreignByCurrency.set(line.accountCurrencyId, []);
      foreignByCurrency.get(line.accountCurrencyId).push(line);
    }
    for (const [fromCurrencyId, lines] of foreignByCurrency) {
      const usable = lines.find((line) => BigInt(line.amountUnits) !== 0n && BigInt(line.valueUnits ?? "0") !== 0n);
      if (!usable) {
        errors.push(issue("EXCHANGE_RATE_REQUIRED", "A foreign currency has no non-zero amount/value pair from which to validate its rate.", {
          currencyCode: lines[0].accountCurrencyCode,
        }));
        continue;
      }
      const amount = BigInt(usable.amountUnits);
      const value = BigInt(usable.valueUnits);
      if ((amount < 0n) !== (value < 0n)) {
        errors.push(issue("INVALID_EXCHANGE_RATE_SIGN", "Foreign amount and valuation value must have the same sign.", {
          currencyCode: usable.accountCurrencyCode, accountFullName: usable.accountFullName,
        }));
        continue;
      }
      const absoluteAmount = amount < 0n ? -amount : amount;
      const absoluteValue = value < 0n ? -value : value;
      const divisor = greatestCommonDivisor(absoluteAmount, absoluteValue);
      const fromUnits = absoluteAmount / divisor;
      const toUnits = absoluteValue / divisor;
      const inconsistent = lines.find((line) =>
        BigInt(line.amountUnits) * toUnits !== BigInt(line.valueUnits ?? "0") * fromUnits);
      if (inconsistent) {
        errors.push(issue("INCONSISTENT_EXCHANGE_RATE",
          `Lines in ${inconsistent.accountCurrencyCode} do not use one consistent transaction exchange rate.`, {
            currencyCode: inconsistent.accountCurrencyCode, accountFullName: inconsistent.accountFullName,
          }));
        continue;
      }
      rates.push({ fromCurrencyId, fromUnits: fromUnits.toString(), toCurrencyId: valuationCurrency.id,
        toUnits: toUnits.toString() });
    }

    const valueTotal = resolvedLines.reduce((sum, line) => sum + BigInt(line.valueUnits ?? "0"), 0n);
    if (valueTotal !== 0n) {
      errors.push(issue("UNBALANCED_TRANSACTION",
        `Transaction values do not balance in ${valuationCurrency.code}.`, {
          valuationCurrencyCode: valuationCurrency.code, imbalanceUnits: valueTotal.toString(),
        }));
    }
  }

  if (errors.length) return { input, errors };
  const resolved = {
    ...input,
    valuationCurrencyId: valuationCurrency.id,
    valuationCurrencyCode: valuationCurrency.code,
    lineItems: resolvedLines,
    rates,
  };
  resolved.fingerprint = fingerprintFor(resolved);
  return { input, resolved, errors: [] };
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = key(item);
    if (value == null) continue;
    counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function transactionSummary(entry) {
  const transaction = entry.resolved ?? entry.input;
  return {
    externalId: transaction.externalId,
    transactionDate: transaction.transactionDate,
    description: transaction.description,
    valuationCurrencyCode: transaction.valuationCurrencyCode,
    lineItemCount: transaction.lineItems.length,
    status: entry.status,
    transactionId: entry.transactionId ?? null,
    errors: entry.errors ?? [],
  };
}

function summarize(normalized, entries, { importPlanId = null, expiresAt = null, ledgerChanged = false } = {}) {
  const unknownAccountPaths = new Set();
  const ambiguousAccountPaths = new Set();
  for (const entry of entries) {
    for (const error of entry.errors ?? []) {
      if (error.code === "UNKNOWN_ACCOUNT_PATH") unknownAccountPaths.add(error.details.accountFullName);
      if (error.code === "AMBIGUOUS_ACCOUNT_PATH") ambiguousAccountPaths.add(error.details.accountFullName);
    }
  }
  const planned = entries.filter((entry) => entry.status === "planned");
  const existing = entries.filter((entry) => entry.status === "existing");
  const created = entries.filter((entry) => entry.status === "created");
  const rejected = entries.filter((entry) => entry.status === "rejected");
  const resolved = entries.filter((entry) => entry.resolved);
  return {
    dryRun: !ledgerChanged,
    ledgerChanged,
    readyToCommit: rejected.length === 0 && !ledgerChanged,
    importPlanId,
    importPlanExpiresAt: expiresAt,
    sourceSystem: normalized.sourceSystem,
    submittedTransactionCount: normalized.submittedTransactionCount,
    uniqueTransactionCount: normalized.transactions.length,
    duplicateInputTransactionCount: normalized.duplicateInputTransactionCount,
    submittedLineItemCount: normalized.submittedLineItemCount,
    wouldCreateTransactionCount: ledgerChanged ? 0 : planned.length,
    wouldReuseTransactionCount: ledgerChanged ? 0 : existing.length,
    wouldCreateLineItemCount: ledgerChanged ? 0
      : planned.reduce((sum, entry) => sum + entry.resolved.lineItems.length, 0),
    wouldReuseLineItemCount: ledgerChanged ? 0
      : existing.reduce((sum, entry) => sum + entry.existingLineItemCount, 0),
    createdTransactionCount: created.length,
    reusedTransactionCount: ledgerChanged ? existing.length : 0,
    createdLineItemCount: created.reduce((sum, entry) => sum + entry.resolved.lineItems.length, 0),
    reusedLineItemCount: ledgerChanged
      ? existing.reduce((sum, entry) => sum + entry.existingLineItemCount, 0) : 0,
    rejectedTransactionCount: rejected.length,
    rejectedLineItemCount: rejected.reduce((sum, entry) => sum + entry.input.lineItems.length, 0),
    unknownAccountPaths: [...unknownAccountPaths].sort(),
    ambiguousAccountPaths: [...ambiguousAccountPaths].sort(),
    transactionSummary: {
      byStatus: { planned: planned.length, existing: existing.length, created: created.length, rejected: rejected.length },
      byValuationCurrency: countBy(resolved, (entry) => entry.resolved.valuationCurrencyCode),
      byYear: countBy(resolved, (entry) => entry.resolved.transactionDate.slice(0, 4)),
    },
    lineItemSummary: {
      byAccountCurrency: countBy(resolved.flatMap((entry) => entry.resolved.lineItems), (line) => line.accountCurrencyCode),
      byTopLevelBranch: countBy(resolved.flatMap((entry) => entry.resolved.lineItems),
        (line) => line.accountFullName.split(":")[0]),
    },
    transactions: entries.map(transactionSummary),
  };
}

async function loadContext(connection, personId, lock) {
  const suffix = lock ? " FOR UPDATE" : "";
  const [accountRows] = await connection.query(
    `SELECT a.account_id, a.AccountName, a.parent_account_id, a.account_currency_id,
            a.is_placeholder, a.archived_at, c.CurrencyAbbreviation, c.scale
       FROM accounts a
       JOIN currencies c ON c.currency_id = a.account_currency_id
      WHERE a.owner_person_id = ?
      ORDER BY a.account_id${suffix}`,
    [personId],
  );
  const [currencyRows] = await connection.query(
    `SELECT currency_id, CurrencyAbbreviation, scale
       FROM currencies
      WHERE owner_person_id IS NULL OR owner_person_id = ?
      ORDER BY currency_id${suffix}`,
    [personId],
  );
  const currenciesByCode = new Map();
  for (const row of currencyRows) {
    const currency = { id: Number(row.currency_id), code: String(row.CurrencyAbbreviation).trim(), scale: Number(row.scale) };
    const key = currencyKey(currency.code);
    if (!currenciesByCode.has(key)) currenciesByCode.set(key, []);
    currenciesByCode.get(key).push(currency);
  }
  return { accountsByPath: buildAccountPaths(accountRows), currenciesByCode };
}

async function loadExistingTransactions(connection, personId, sourceSystem, externalIds, lock) {
  if (!externalIds.length) return new Map();
  const placeholders = externalIds.map(() => "?").join(", ");
  const [rows] = await connection.query(
    `SELECT t.transaction_id, t.source_id, t.source_fingerprint, COUNT(li.line_item_id) AS line_item_count
       FROM transactions t
       LEFT JOIN line_items li ON li.transaction_id = t.transaction_id
      WHERE t.owner_person_id = ? AND t.source_system = ? AND t.source_id IN (${placeholders})
      GROUP BY t.transaction_id, t.source_id, t.source_fingerprint
      ORDER BY t.transaction_id${lock ? " FOR UPDATE" : ""}`,
    [personId, sourceSystem, ...externalIds],
  );
  return new Map(rows.map((row) => [String(row.source_id), {
    transactionId: Number(row.transaction_id), fingerprint: row.source_fingerprint,
    lineItemCount: Number(row.line_item_count),
  }]));
}

export async function analyzeTransactionImport(connection, personId, normalized, lock = false) {
  const context = await loadContext(connection, personId, lock);
  const existingByExternalId = await loadExistingTransactions(connection, personId, normalized.sourceSystem,
    normalized.transactions.map((transaction) => transaction.externalId), lock);
  const conflictingExternalIds = new Set(normalized.conflictingExternalIds);
  const entries = [];
  for (const input of normalized.transactions) {
    const entry = resolveTransaction(input, context, conflictingExternalIds);
    if (entry.errors.length) {
      entries.push({ ...entry, status: "rejected" });
      continue;
    }
    const existing = existingByExternalId.get(input.externalId);
    if (!existing) {
      entries.push({ ...entry, status: "planned" });
    } else if (existing.fingerprint && String(existing.fingerprint).toLocaleLowerCase("en-US") === entry.resolved.fingerprint) {
      entries.push({ ...entry, status: "existing", transactionId: existing.transactionId,
        existingLineItemCount: existing.lineItemCount });
    } else {
      entries.push({ ...entry, status: "rejected", errors: [issue("SOURCE_TRANSACTION_CONFLICT",
        `External transaction ID "${input.externalId}" already exists with different or unverifiable content.`, {
          externalId: input.externalId, transactionId: existing.transactionId,
        })] });
    }
  }
  return entries;
}

function payloadHash(payloadJson) {
  return createHash("sha256").update(payloadJson, "utf8").digest("hex");
}

function mariaDbUtcTimestamp(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function planIsoTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  const normalized = String(value ?? "").trim().replace(" ", "T");
  const parsed = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  if (Number.isNaN(parsed.getTime())) throw importError("Transaction import plan expiration is invalid.", "IMPORT_PLAN_STATE_CONFLICT", undefined, 500);
  return parsed.toISOString();
}

function parsePlanJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch {
    throw importError(`Transaction import plan ${label} is invalid.`, "IMPORT_PLAN_STATE_CONFLICT", undefined, 500);
  }
}

function transactionPlanIdentity(plan) {
  const digest = String(plan.preview_sha256 ?? "");
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw importError("Transaction import plan preview digest is invalid.", "IMPORT_PLAN_STATE_CONFLICT", undefined, 500);
  }
  return {
    importPlanId: String(plan.import_plan_id),
    expiresAt: planIsoTimestamp(plan.expires_at),
    previewDigest: `sha256:${digest}`,
    summary: parsePlanJson(plan.summary_json, "summary"),
  };
}

export async function previewTransactionImport({ pool, personId, sourceSystem, transactions }) {
  const normalized = normalizeTransactionImport({ sourceSystem, transactions });
  return withPoolTransaction(pool, async (connection) => {
    await pruneOwnerAccountingImportPlans(connection, personId);
    const entries = await analyzeTransactionImport(connection, personId, normalized, false);
    if (entries.some((entry) => entry.status === "rejected")) return summarize(normalized, entries);

    const importPlanId = randomUUID();
    const expiresAtDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const expiresAt = mariaDbUtcTimestamp(expiresAtDate);
    const payloadJson = JSON.stringify(normalized);
    const preview = summarize(normalized, entries);
    const transactionSummary = {
      transactionsCreated: preview.wouldCreateTransactionCount,
      transactionsReused: preview.wouldReuseTransactionCount,
      lineItemsCreated: preview.wouldCreateLineItemCount,
      lineItemsReused: preview.wouldReuseLineItemCount,
      rejectedTransactions: preview.rejectedTransactionCount,
    };
    const previewHash = payloadHash(JSON.stringify(preview));
    await connection.query(
      `INSERT INTO accounting_import_plans
        (import_plan_id, owner_person_id, import_kind, plan_status, source_system,
         payload_sha256, preview_sha256, payload_json, summary_json, expires_at)
       VALUES (?, ?, 'transactions', 'ready', ?, ?, ?, ?, ?, ?)`,
      [importPlanId, personId, normalized.sourceSystem, payloadHash(payloadJson), previewHash,
        payloadJson, JSON.stringify(transactionSummary), expiresAt],
    );
    return {
      ...summarize(normalized, entries, { importPlanId, expiresAt: expiresAtDate.toISOString() }),
      status: "ready",
      expiresAt: expiresAtDate.toISOString(),
      previewDigest: `sha256:${previewHash}`,
      summary: transactionSummary,
    };
  });
}

export async function getTransactionImportPlan({ pool, personId, importPlanId }) {
  const resolvedPlanId = limitedRequiredText(importPlanId, "import plan ID", 36);
  return withPoolTransaction(pool, async (connection) => {
    const [rows] = await connection.query(
      `SELECT import_plan_id, plan_status, preview_sha256, summary_json, expires_at,
              committed_at, invalidated_at, invalidation_code, result_json,
              expires_at <= UTC_TIMESTAMP(6) AS is_expired
         FROM accounting_import_plans
        WHERE import_plan_id = ? AND owner_person_id = ? AND import_kind = 'transactions'`,
      [resolvedPlanId, personId],
    );
    const plan = rows[0];
    if (!plan) throw importError("Transaction import plan not found.", "IMPORT_PLAN_NOT_FOUND", undefined, 404);
    const identity = transactionPlanIdentity(plan);
    if (plan.plan_status === "committed") {
      if (plan.committed_at == null || !plan.result_json) {
        throw importError("The committed import plan state is inconsistent.", "IMPORT_PLAN_STATE_CONFLICT", undefined, 500);
      }
      return {
        readyToCommit: false,
        status: "committed",
        ...identity,
        commitResult: { ...parsePlanJson(plan.result_json, "result"), alreadyCommitted: true },
        alreadyCommitted: true,
      };
    }
    if (plan.plan_status === "invalidated") {
      return { readyToCommit: false, status: "invalidated", ...identity,
        invalidationCode: plan.invalidation_code ?? "DATABASE_STATE_CHANGED" };
    }
    if (Boolean(plan.is_expired)) return { readyToCommit: false, status: "expired", ...identity };
    return { readyToCommit: true, status: "ready", ...identity };
  });
}

export async function insertImportedTransaction(connection, personId, sourceSystem, resolved) {
  const [insert] = await connection.query(
    `INSERT INTO transactions
      (owner_person_id, description, valuation_currency_id, TransactionState, TransactionDate,
       source_system, source_id, source_fingerprint)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [personId, resolved.description, resolved.valuationCurrencyId, resolved.transactionDate,
      sourceSystem, resolved.externalId, resolved.fingerprint],
  );
  const transactionId = Number(insert.insertId);
  for (const line of resolved.lineItems) {
    await connection.query(
      `INSERT INTO line_items (transaction_id, amount_units, memo, account_id, source_id)
       VALUES (?, ?, ?, ?, ?)`,
      [transactionId, line.amountUnits, line.memo, line.accountId, line.externalId],
    );
  }
  for (const rate of resolved.rates) {
    await connection.query(
      `INSERT INTO xrates
        (owner_person_id, xrate_type, ValidAt, transaction_id, from_units,
         from_currency_id, to_units, to_currency_id)
       VALUES (?, 'transaction', NULL, ?, ?, ?, ?, ?)`,
      [personId, transactionId, rate.fromUnits, rate.fromCurrencyId, rate.toUnits, rate.toCurrencyId],
    );
  }
  await validateTransaction(connection, transactionId, personId, { lock: true });
  await connection.query(
    "UPDATE transactions SET TransactionState = 'posted', UpdatedAt = CURRENT_TIMESTAMP() WHERE transaction_id = ? AND owner_person_id = ?",
    [transactionId, personId],
  );
  return transactionId;
}

export async function commitTransactionImportPlan({ pool, personId, importPlanId }) {
  const resolvedPlanId = limitedRequiredText(importPlanId, "import plan ID", 36);
  const outcome = await withPoolTransaction(pool, async (connection) => {
    const [planRows] = await connection.query(
      `SELECT import_plan_id, plan_status, source_system, payload_sha256, preview_sha256,
              payload_json, summary_json, expires_at, committed_at, invalidated_at,
              invalidation_code, result_json, expires_at <= UTC_TIMESTAMP(6) AS is_expired
         FROM accounting_import_plans
        WHERE import_plan_id = ? AND owner_person_id = ? AND import_kind = 'transactions'
        FOR UPDATE`,
      [resolvedPlanId, personId],
    );
    const plan = planRows[0];
    if (!plan) throw importError("Transaction import plan not found.", "IMPORT_PLAN_NOT_FOUND", undefined, 404);
    const identity = transactionPlanIdentity(plan);
    if (plan.committed_at != null) {
      if (plan.plan_status !== "committed" || !plan.result_json) {
        throw importError("The committed import plan state is inconsistent.", "IMPORT_PLAN_STATE_CONFLICT", undefined, 500);
      }
      return { result: { ...parsePlanJson(plan.result_json, "result"), ...identity, status: "committed", alreadyCommitted: true } };
    }
    if (plan.plan_status === "invalidated") throw importError("Transaction import plan is invalidated; run a new dry run.", "IMPORT_PLAN_INVALIDATED");
    if (plan.plan_status !== "ready") throw importError("Transaction import plan is not ready.", "IMPORT_PLAN_STATE_CONFLICT");
    if (Boolean(plan.is_expired)) throw importError("Transaction import plan has expired; run a new dry run.", "IMPORT_PLAN_EXPIRED");
    if (payloadHash(plan.payload_json) !== String(plan.payload_sha256)) {
      await connection.query(
        `UPDATE accounting_import_plans
            SET plan_status = 'invalidated', invalidated_at = UTC_TIMESTAMP(6),
                invalidation_code = 'PAYLOAD_INTEGRITY_FAILURE'
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [resolvedPlanId, personId],
      );
      return { failure: importError("Stored transaction import plan failed its integrity check.", "IMPORT_PLAN_INTEGRITY_FAILURE", undefined, 500) };
    }

    const normalized = JSON.parse(plan.payload_json);
    const entries = await analyzeTransactionImport(connection, personId, normalized, true);
    if (entries.some((entry) => entry.status === "rejected")) {
      const details = summarize(normalized, entries);
      await connection.query(
        `UPDATE accounting_import_plans
            SET plan_status = 'invalidated', invalidated_at = UTC_TIMESTAMP(6),
                invalidation_code = 'DATABASE_STATE_CHANGED'
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [resolvedPlanId, personId],
      );
      return { failure: importError("Transaction import plan is no longer valid; review a new dry run.",
        "IMPORT_PLAN_NO_LONGER_VALID", details) };
    }

    for (const entry of entries) {
      if (entry.status !== "planned") continue;
      entry.transactionId = await insertImportedTransaction(connection, personId, normalized.sourceSystem, entry.resolved);
      entry.status = "created";
    }
    const result = { ...summarize(normalized, entries, { ledgerChanged: true }),
      ...identity, readyToCommit: false, status: "committed", committed: true, alreadyCommitted: false };
    const resultJson = JSON.stringify(result);
    await connection.query(
      `UPDATE accounting_import_plans
          SET plan_status = 'committed', committed_at = UTC_TIMESTAMP(6), result_json = ?
        WHERE import_plan_id = ? AND owner_person_id = ?`,
      [resultJson, resolvedPlanId, personId],
    );
    return { result };
  });
  if (outcome.failure) throw outcome.failure;
  return outcome.result;
}
