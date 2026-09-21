import { createHash, randomUUID } from "node:crypto";
import { withPoolTransaction } from "./db.js";
import { currencyKey } from "./currencies.js";
import { decimalToUnits, unitsToDecimal } from "./money.js";
import { nearestReferenceRate, referenceRatePairKey, valueAtReferenceRate } from "./reference-valuation.js";
import { normalizeTransactionAt, transactionAtForDatabase } from "./transaction-time.js";
import { attachTags, validateTransaction } from "./accounting.js";
import { accountingQuestionTags, normalizeAccountingQuestion } from "./accounting-questions.js";
import { pruneOwnerAccountingImportPlans } from "./import-plan-retention.js";
import { getStatementReconciliationContext } from "./statement-reconciliation.js";
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
  const reconciliationState = String(line?.reconciliationState ?? "unreconciled").trim().toLocaleLowerCase("en-US");
  if (!new Set(["unreconciled", "cleared"]).has(reconciliationState)) {
    throw importError("Imported lines may start as unreconciled or cleared; reconciled requires a matching known balance.",
      "INVALID_INITIAL_RECONCILIATION_STATE", { transactionExternalId, reconciliationState });
  }
  return {
    externalId,
    accountFullName: normalizeAccountPath(line?.accountFullName),
    amountDecimal: limitedRequiredText(line?.amountDecimal, "amount", 128),
    valueDecimal: optionalLimitedText(line?.valueDecimal, "value", 128),
    memo: optionalLimitedText(line?.memo, "memo", 16000),
    question: normalizeAccountingQuestion(line?.question),
    reconciliationState,
  };
}

function normalizeTransaction(transaction) {
  const externalId = limitedRequiredText(transaction?.externalId, "external transaction ID", 128);
  if (!Array.isArray(transaction?.lineItems) || transaction.lineItems.length === 0) {
    throw importError(`Transaction "${externalId}" requires at least one line item.`, "TOO_FEW_LINE_ITEMS", { externalId });
  }
  const transactionDate = normalizeDate(transaction?.transactionDate);
  return {
    externalId,
    transactionDate,
    transactionAt: normalizeTransactionAt(transaction?.transactionAt),
    description: optionalLimitedText(transaction?.description, "description", 16000),
    valuationCurrencyCode: limitedRequiredText(transaction?.valuationCurrencyCode, "valuation currency code", 50),
    feeAccountFullName: transaction?.feeAccountFullName == null ? null
      : normalizeAccountPath(transaction.feeAccountFullName),
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
    valuationContractVersion: 3,
    transactions: [...byExternalId.values()],
    submittedTransactionCount: transactions.length,
    submittedLineItemCount,
    duplicateInputTransactionCount,
    conflictingExternalIds: [...conflictingExternalIds],
  };
}

function normalizeImportReview(review, transactions) {
  if (review == null) return null;
  const accountId = Number(review.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw importError("An import review requires a positive account ID.", "INVALID_IMPORT_REVIEW");
  }
  const statementId = limitedRequiredText(review.statementId, "statement ID", 128);
  const externalIds = new Set(transactions.map((transaction) => transaction.externalId));
  const supplied = Array.isArray(review.decisions) ? review.decisions : [];
  const byExternalId = new Map();
  for (const item of supplied) {
    const externalId = limitedRequiredText(item?.externalId, "review external transaction ID", 128);
    if (!externalIds.has(externalId) || byExternalId.has(externalId)) {
      throw importError("Every import-review decision must identify one transaction in this plan.",
        "INVALID_IMPORT_REVIEW", { externalId });
    }
    const decision = String(item?.decision ?? "").trim();
    if (decision !== "include" && decision !== "exclude") {
      throw importError("An import-review decision must be include or exclude.", "INVALID_IMPORT_REVIEW",
        { externalId });
    }
    byExternalId.set(externalId, {
      externalId,
      decision,
      confidence: optionalLimitedText(item?.confidence, "review confidence", 40),
      reason: optionalLimitedText(item?.reason, "review reason", 2000),
      sourceRecordId: optionalLimitedText(item?.sourceRecordId, "source record ID", 128),
      matchedTransactionIds: [...new Set((Array.isArray(item?.matchedTransactionIds)
        ? item.matchedTransactionIds : []).map(Number))]
        .filter((id) => Number.isInteger(id) && id > 0).slice(0, 20),
    });
  }
  for (const transaction of transactions) {
    if (!byExternalId.has(transaction.externalId)) byExternalId.set(transaction.externalId, {
      externalId: transaction.externalId, decision: "include", confidence: "tentative",
      reason: "No conclusive duplicate evidence was found.", sourceRecordId: null, matchedTransactionIds: [],
    });
  }
  return { accountId, statementId, decisions: [...byExternalId.values()] };
}

function normalizeReconciliation(reconciliation) {
  if (reconciliation == null) return null;
  const ids = Array.isArray(reconciliation.accountIds)
    ? [...new Set(reconciliation.accountIds.map(Number))] : [];
  if (ids.length === 0 || ids.length > 25 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw importError("Reconciliation requires between 1 and 25 positive account IDs.",
      "INVALID_RECONCILIATION_ACCOUNTS");
  }
  return {
    accountIds: ids,
    openingBalanceDate: normalizeDate(reconciliation.openingBalanceDate),
    closingBalanceDate: normalizeDate(reconciliation.closingBalanceDate),
  };
}

function normalizeKnownBalanceAssertions(assertions) {
  if (!Array.isArray(assertions) || assertions.length > 2) {
    throw importError("Supply at most two dated statement balances.", "INVALID_IMPORT_BALANCE_ASSERTIONS");
  }
  const seen = new Set();
  return assertions.map((assertion) => {
    const accountId = Number(assertion.accountId);
    const balanceDate = normalizeDate(assertion.balanceDate);
    const knownBalanceUnits = String(assertion.knownBalanceUnits ?? "").trim();
    if (!Number.isInteger(accountId) || accountId <= 0 || !/^-?\d+$/.test(knownBalanceUnits)) {
      throw importError("A statement balance needs an account, date, and integer native-unit amount.",
        "INVALID_IMPORT_BALANCE_ASSERTIONS");
    }
    const key = `${accountId}:${balanceDate}`;
    if (seen.has(key)) throw importError("A statement balance date was supplied twice.",
      "DUPLICATE_IMPORT_BALANCE_ASSERTION");
    seen.add(key);
    return { accountId, balanceDate, knownBalanceUnits };
  });
}

async function inspectKnownBalanceAssertions(connection, personId, assertions, { commit = false } = {}) {
  const results = [];
  for (const assertion of assertions) {
    const [existing] = await connection.query(
      `SELECT known_balance_units FROM account_balance_assertions
        WHERE owner_person_id = ? AND account_id = ? AND balance_date = ?${commit ? " FOR UPDATE" : ""}`,
      [personId, assertion.accountId, assertion.balanceDate],
    );
    let stored = existing[0];
    let created = false;
    if (!stored && commit) {
      const [insert] = await connection.query(
        `INSERT INTO account_balance_assertions
          (owner_person_id, account_id, balance_date, known_balance_units) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE account_balance_assertion_id = account_balance_assertion_id`,
        [personId, assertion.accountId, assertion.balanceDate, assertion.knownBalanceUnits],
      );
      created = insert.affectedRows === 1;
      const [rows] = await connection.query(
        `SELECT known_balance_units FROM account_balance_assertions
          WHERE owner_person_id = ? AND account_id = ? AND balance_date = ?`,
        [personId, assertion.accountId, assertion.balanceDate],
      );
      stored = rows[0];
    }
    results.push({
      accountId: assertion.accountId, balanceDate: assertion.balanceDate,
      sourceKnownBalanceUnits: assertion.knownBalanceUnits,
      storedKnownBalanceUnits: stored == null ? null : String(stored.known_balance_units),
      status: commit ? (created ? "created" : "preserved") : (stored ? "preserved" : "planned"),
    });
  }
  return results;
}

async function validateReconciliation(connection, personId, reconciliation, entries) {
  if (reconciliation == null) return null;
  const context = await getStatementReconciliationContext({
    pool: connection, personId, ...reconciliation,
  });
  const proposedByAccount = new Map(reconciliation.accountIds.map((id) => [id, 0n]));
  const issues = [];
  for (const entry of entries) {
    if (entry.status !== "planned" || !entry.resolved) continue;
    if (entry.resolved.transactionDate <= reconciliation.openingBalanceDate
        || entry.resolved.transactionDate > reconciliation.closingBalanceDate) {
      issues.push(issue("RECONCILIATION_TRANSACTION_OUTSIDE_INTERVAL",
        `Transaction "${entry.resolved.externalId}" is outside the balance-assertion interval.`, {
          externalId: entry.resolved.externalId, transactionDate: entry.resolved.transactionDate,
          openingBalanceDate: reconciliation.openingBalanceDate,
          closingBalanceDate: reconciliation.closingBalanceDate,
        }));
      continue;
    }
    for (const line of entry.resolved.lineItems) {
      if (!proposedByAccount.has(line.accountId)) continue;
      proposedByAccount.set(line.accountId, proposedByAccount.get(line.accountId) + BigInt(line.amountUnits));
    }
  }
  const accounts = context.accounts.map((account) => {
    const required = account.remainingLineItemMovementUnits == null
      ? null : BigInt(account.remainingLineItemMovementUnits);
    const proposed = proposedByAccount.get(account.accountId) ?? 0n;
    return {
      accountId: account.accountId,
      accountFullName: account.accountFullName,
      currencyCode: account.currencyCode,
      scale: account.scale,
      requiredRemainingUnits: required?.toString() ?? null,
      proposedNewLineItemUnits: proposed.toString(),
      residualUnits: required == null ? null : (required - proposed).toString(),
      matches: account.postable && required != null && required === proposed,
    };
  });
  for (const account of accounts) {
    const source = context.accounts.find((item) => item.accountId === account.accountId);
    if (!source.postable) issues.push(issue("RECONCILIATION_ACCOUNT_NOT_POSTABLE",
      `Account "${account.accountFullName}" cannot receive imported lines.`, { accountId: account.accountId }));
    else if (account.requiredRemainingUnits == null) issues.push(issue("RECONCILIATION_ASSERTION_REQUIRED",
      `Account "${account.accountFullName}" needs exact opening and closing balance assertions.`,
      { accountId: account.accountId }));
    else if (!account.matches) issues.push(issue("RECONCILIATION_MOVEMENT_MISMATCH",
      `Proposed lines do not satisfy the known-balance movement for "${account.accountFullName}".`, {
        accountId: account.accountId, requiredRemainingUnits: account.requiredRemainingUnits,
        proposedNewLineItemUnits: account.proposedNewLineItemUnits, residualUnits: account.residualUnits,
      }));
  }
  return {
    passed: issues.length === 0,
    openingBalanceDate: reconciliation.openingBalanceDate,
    closingBalanceDate: reconciliation.closingBalanceDate,
    accounts,
    issues,
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
      type: String(row.AccountType ?? "").trim().toLowerCase(),
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

function checkedDecimalToUnits(value, scale, field, details, options = {}) {
  try {
    const units = decimalToUnits(value, scale, options);
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
    ...(line.question == null ? {} : { question: line.question }),
    ...(line.reconciliationState === "unreconciled" ? {} : { reconciliationState: line.reconciliationState }),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const rates = transaction.rates.map((rate) => ({
    fromCurrencyId: rate.fromCurrencyId,
    fromUnits: rate.fromUnits,
    toCurrencyId: rate.toCurrencyId,
    toUnits: rate.toUnits,
  })).sort((left, right) => left.fromCurrencyId - right.fromCurrencyId);
  return createHash("sha256").update(JSON.stringify({
    transactionDate: transaction.transactionDate,
    ...(transaction.transactionAt == null ? {} : { transactionAt: transaction.transactionAt }),
    description: transaction.description,
    valuationCurrencyId: transaction.valuationCurrencyId,
    lineItems,
    rates,
  }), "utf8").digest("hex");
}

export function transactionValuationSignature(transaction) {
  return createHash("sha256").update(JSON.stringify({
    fingerprint: transaction.fingerprint,
    referenceRates: transaction.lineItems.map((line) => line.referenceRate?.id ?? null),
  }), "utf8").digest("hex");
}

function importResolutionDigest(entries) {
  return createHash("sha256").update(JSON.stringify(entries.map((entry) => ({
    externalId: entry.input.externalId,
    status: entry.status,
    signature: entry.resolved == null ? null : transactionValuationSignature(entry.resolved),
  }))), "utf8").digest("hex");
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
      let referenceRate = null;
      if (valuationCurrency) {
        if (account.currencyId === valuationCurrency.id && line.valueDecimal == null) {
          valueUnits = amountUnits;
        } else if (account.currencyId !== valuationCurrency.id) {
          const pair = referenceRatePairKey(account.currencyId, valuationCurrency.id);
          const selected = nearestReferenceRate(context.referenceRatesByPair.get(pair),
            input.transactionAt ?? `${input.transactionDate}T00:00:00.000Z`,
            account.currencyId, valuationCurrency.id);
          if (selected) {
            valueUnits = valueAtReferenceRate(amountUnits, selected);
            referenceRate = { id: Number(selected.rate.xrate_id),
              validAt: new Date(selected.validAtMs).toISOString() };
            const nativeValue = BigInt(valueUnits);
            if (nativeValue < signedBigIntMinimum || nativeValue > signedBigIntMaximum) {
              errors.push(issue("REFERENCE_VALUATION_OUT_OF_RANGE",
                `Reference-rate value for "${line.accountFullName}" exceeds the valuation currency's native-unit range.`, {
                  accountFullName: line.accountFullName, referenceRateId: referenceRate.id,
                }));
            }
          } else if (line.valueDecimal == null) {
            errors.push(issue("FOREIGN_VALUE_REQUIRED",
              `No reference rate is available for "${line.accountFullName}"; supply a source value in ${valuationCurrency.code}.`, {
                accountFullName: line.accountFullName, valuationCurrencyCode: valuationCurrency.code,
              }));
          } else {
            valueUnits = checkedDecimalToUnits(line.valueDecimal, valuationCurrency.scale, "value_decimal", {
              externalId: input.externalId, accountFullName: line.accountFullName,
            }, { round: true });
          }
        } else {
          valueUnits = checkedDecimalToUnits(line.valueDecimal, valuationCurrency.scale, "value_decimal", {
            externalId: input.externalId, accountFullName: line.accountFullName,
          }, { round: true });
          if (valueUnits !== amountUnits) {
            errors.push(issue("NATIVE_VALUE_MISMATCH",
              `Amount and value differ for native-currency account "${line.accountFullName}".`, {
                accountFullName: line.accountFullName, amountUnits, valueUnits,
              }));
          }
        }
      }
      resolvedLines.push({ ...line, accountId: account.id, accountCurrencyId: account.currencyId,
        accountCurrencyCode: account.currencyCode, accountType: account.type,
        amountUnits, valueUnits, referenceRate });
    } catch (error) {
      if (error.code === "INVALID_DECIMAL_AMOUNT" || error.code === "CONFLICTING_REFERENCE_RATES") {
        errors.push(issue(error.code, error.message, error.details));
      } else throw error;
    }
  }

  const allSourceLinesResolved = resolvedLines.length === input.lineItems.length;
  if (valuationCurrency && allSourceLinesResolved) {
    let valueTotal = resolvedLines.reduce((sum, line) => sum + BigInt(line.valueUnits ?? "0"), 0n);
    const hasRatedForeignLine = resolvedLines.some((line) => line.referenceRate != null);
    const hasNativeCashLine = resolvedLines.some((line) => line.accountCurrencyId === valuationCurrency.id
      && (line.accountType === "asset" || line.accountType === "liability"));
    if (errors.length === 0 && resolvedLines.length >= 2 && hasRatedForeignLine
        && hasNativeCashLine && valueTotal !== 0n) {
      const feePath = input.feeAccountFullName;
      const candidates = feePath == null ? [] : context.accountsByPath.get(feePath) ?? [];
      const feeAccount = candidates.length === 1 ? candidates[0] : null;
      if (feeAccount == null || feeAccount.type !== "expense" || feeAccount.currencyId !== valuationCurrency.id
          || feeAccount.placeholder || feeAccount.archived) {
        errors.push(issue("FEE_ACCOUNT_REQUIRED",
          "The reference-rate valuation and exact cash amount differ; supply one postable expense account in the valuation currency for the residual fee.", {
            feeAccountFullName: feePath, feeValueUnits: (-valueTotal).toString(),
          }));
      } else {
        const feeUnits = -valueTotal;
        if (feeUnits < signedBigIntMinimum || feeUnits > signedBigIntMaximum) {
          errors.push(issue("FEE_VALUE_OUT_OF_RANGE", "The derived fee exceeds the native-unit range."));
        } else {
          const feeDecimal = unitsToDecimal(feeUnits, valuationCurrency.scale);
          resolvedLines.push({ externalId: null, accountFullName: feePath,
            amountDecimal: feeDecimal, valueDecimal: feeDecimal,
            memo: "Reference-rate valuation difference", question: null,
            reconciliationState: "unreconciled", accountId: feeAccount.id,
            accountCurrencyId: feeAccount.currencyId, accountCurrencyCode: feeAccount.currencyCode,
            accountType: feeAccount.type,
            amountUnits: feeUnits.toString(), valueUnits: feeUnits.toString(), referenceRate: null });
          valueTotal = 0n;
        }
      }
    }
    const onlyLine = resolvedLines.length === 1 ? resolvedLines[0] : null;
    const singleLineQuantityAdjustment = onlyLine != null
      && onlyLine.accountCurrencyId !== valuationCurrency.id
      && BigInt(onlyLine.amountUnits) !== 0n
      && onlyLine.valueUnits != null
      && BigInt(onlyLine.valueUnits) === 0n;
    if (resolvedLines.length === 1 && !singleLineQuantityAdjustment) {
      errors.push(issue("TOO_FEW_LINE_ITEMS",
        "A transaction requires at least two line items unless it is a single-line zero-value quantity adjustment.", {
          externalId: input.externalId,
        }));
    }
    for (const line of resolvedLines) {
      if (line.accountCurrencyId === valuationCurrency.id) continue;
      const amount = BigInt(line.amountUnits);
      const value = BigInt(line.valueUnits ?? "0");
      if (amount === 0n && value !== 0n) {
        errors.push(issue("VALUE_WITHOUT_AMOUNT", "A foreign line cannot carry valuation value without an account-currency amount.", {
          currencyCode: line.accountCurrencyCode, accountFullName: line.accountFullName,
        }));
        continue;
      }
      if (amount !== 0n && value !== 0n && (amount < 0n) !== (value < 0n)) {
        errors.push(issue("INVALID_EXCHANGE_RATE_SIGN", "Foreign amount and valuation value must have the same sign.", {
          currencyCode: line.accountCurrencyCode, accountFullName: line.accountFullName,
        }));
      }
    }

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
    rates: [],
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
    transactionAt: transaction.transactionAt,
    description: transaction.description,
    valuationCurrencyCode: transaction.valuationCurrencyCode,
    lineItemCount: transaction.lineItems.length,
    status: entry.status,
    ...(entry.reviewDecision == null ? {} : { importDecision: entry.reviewDecision }),
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
  const excluded = entries.filter((entry) => entry.status === "excluded");
  const resolved = entries.filter((entry) => entry.resolved);
  const questionLines = resolved.flatMap((entry) => entry.resolved.lineItems)
    .filter((line) => line.question != null);
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
    excludedTransactionCount: excluded.length,
    rejectedLineItemCount: rejected.reduce((sum, entry) => sum + entry.input.lineItems.length, 0),
    unknownAccountPaths: [...unknownAccountPaths].sort(),
    ambiguousAccountPaths: [...ambiguousAccountPaths].sort(),
    transactionSummary: {
      byStatus: { planned: planned.length, existing: existing.length, excluded: excluded.length,
        created: created.length, rejected: rejected.length },
      byValuationCurrency: countBy(resolved, (entry) => entry.resolved.valuationCurrencyCode),
      byYear: countBy(resolved, (entry) => entry.resolved.transactionDate.slice(0, 4)),
    },
    lineItemSummary: {
      byAccountCurrency: countBy(resolved.flatMap((entry) => entry.resolved.lineItems), (line) => line.accountCurrencyCode),
      byTopLevelBranch: countBy(resolved.flatMap((entry) => entry.resolved.lineItems),
        (line) => line.accountFullName.split(":")[0]),
    },
    questionSummary: {
      openQuestionCount: questionLines.length,
      byAudience: countBy(questionLines, (line) => line.question.audience),
      bySuspenseAccount: countBy(questionLines, (line) => line.accountFullName),
    },
    transactions: entries.map(transactionSummary),
  };
}

async function loadContext(connection, personId, lock) {
  const suffix = lock ? " FOR UPDATE" : "";
  const [accountRows] = await connection.query(
    `SELECT a.account_id, a.AccountName, a.parent_account_id, a.AccountType, a.account_currency_id,
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

async function loadReferenceRatesForImport(connection, personId, transactions, context) {
  const pairs = new Map();
  for (const transaction of transactions) {
    const currencies = context.currenciesByCode.get(currencyKey(transaction.valuationCurrencyCode)) ?? [];
    if (currencies.length !== 1) continue;
    for (const line of transaction.lineItems) {
      const accounts = context.accountsByPath.get(line.accountFullName) ?? [];
      if (accounts.length !== 1 || accounts[0].currencyId === currencies[0].id) continue;
      const left = accounts[0].currencyId;
      const right = currencies[0].id;
      pairs.set(referenceRatePairKey(left, right), { left, right });
    }
  }
  const result = new Map();
  for (const [key, { left, right }] of pairs) {
    const [rows] = await connection.query(
      `SELECT xrate_id, ValidAt, from_currency_id, to_currency_id, from_units, to_units
         FROM xrates
        WHERE owner_person_id = ? AND xrate_type = 'reference' AND transaction_id IS NULL
          AND ((from_currency_id = ? AND to_currency_id = ?)
            OR (from_currency_id = ? AND to_currency_id = ?))
        ORDER BY ValidAt, xrate_id`,
      [personId, left, right, right, left],
    );
    result.set(key, rows);
  }
  return result;
}

export async function analyzeTransactionImport(connection, personId, normalized, lock = false) {
  const context = await loadContext(connection, personId, lock);
  context.referenceRatesByPair = await loadReferenceRatesForImport(connection, personId,
    normalized.transactions, context);
  const existingByExternalId = await loadExistingTransactions(connection, personId, normalized.sourceSystem,
    normalized.transactions.map((transaction) => transaction.externalId), lock);
  const conflictingExternalIds = new Set(normalized.conflictingExternalIds);
  const reviewByExternalId = new Map((normalized.importReview?.decisions ?? [])
    .map((decision) => [decision.externalId, decision]));
  const entries = [];
  for (const input of normalized.transactions) {
    const entry = resolveTransaction(input, context, conflictingExternalIds);
    if (entry.errors.length) {
      entries.push({ ...entry, status: "rejected", reviewDecision: reviewByExternalId.get(input.externalId) ?? null });
      continue;
    }
    const existing = existingByExternalId.get(input.externalId);
    if (!existing) {
      const reviewDecision = reviewByExternalId.get(input.externalId) ?? null;
      entries.push({ ...entry, status: reviewDecision?.decision === "exclude" ? "excluded" : "planned",
        reviewDecision });
    } else if (existing.fingerprint && String(existing.fingerprint).toLocaleLowerCase("en-US") === entry.resolved.fingerprint) {
      entries.push({ ...entry, status: "existing", transactionId: existing.transactionId,
        existingLineItemCount: existing.lineItemCount,
        reviewDecision: reviewByExternalId.get(input.externalId) ?? null });
    } else {
      entries.push({ ...entry, status: "rejected", errors: [issue("SOURCE_TRANSACTION_CONFLICT",
        `External transaction ID "${input.externalId}" already exists with different or unverifiable content.`, {
          externalId: input.externalId, transactionId: existing.transactionId,
        })], reviewDecision: reviewByExternalId.get(input.externalId) ?? null });
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

export async function previewTransactionImport({ pool, personId, sourceSystem, transactions,
  reconciliation = null, knownBalanceAssertions = [], importReview = null }) {
  const normalized = normalizeTransactionImport({ sourceSystem, transactions });
  normalized.reconciliation = normalizeReconciliation(reconciliation);
  normalized.knownBalanceAssertions = normalizeKnownBalanceAssertions(knownBalanceAssertions);
  normalized.importReview = normalizeImportReview(importReview, normalized.transactions);
  return withPoolTransaction(pool, async (connection) => {
    await pruneOwnerAccountingImportPlans(connection, personId);
    const entries = await analyzeTransactionImport(connection, personId, normalized, false);
    if (entries.some((entry) => entry.status === "rejected")) return summarize(normalized, entries);
    const reconciliationValidation = await validateReconciliation(connection, personId,
      normalized.reconciliation, entries);
    const balanceAssertions = await inspectKnownBalanceAssertions(connection, personId,
      normalized.knownBalanceAssertions);

    const importPlanId = randomUUID();
    const expiresAtDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const expiresAt = mariaDbUtcTimestamp(expiresAtDate);
    normalized.previewResolutionDigest = importResolutionDigest(entries);
    const payloadJson = JSON.stringify(normalized);
    const preview = { ...summarize(normalized, entries),
      ...(balanceAssertions.length ? { balanceAssertions } : {}),
      ...(reconciliationValidation == null ? {} : { reconciliationValidation }) };
    const transactionSummary = {
      transactionsCreated: preview.wouldCreateTransactionCount,
      transactionsReused: preview.wouldReuseTransactionCount,
      transactionsExcluded: preview.excludedTransactionCount,
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
      ...(balanceAssertions.length ? { balanceAssertions } : {}),
      ...(reconciliationValidation == null ? {} : { reconciliationValidation }),
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

function importReviewView(normalized, plan) {
  const review = normalized.importReview;
  if (review == null) return null;
  const decisions = new Map(review.decisions.map((decision) => [decision.externalId, decision]));
  const rows = normalized.transactions.map((transaction) => {
    const decision = decisions.get(transaction.externalId);
    const statementLine = transaction.lineItems[0];
    return {
      externalId: transaction.externalId,
      sourceRecordId: decision?.sourceRecordId ?? null,
      transactionDate: transaction.transactionDate,
      transactionAt: transaction.transactionAt ?? null,
      description: transaction.description,
      amountDecimal: statementLine.amountDecimal,
      memo: statementLine.memo,
      decision: decision?.decision ?? "include",
      confidence: decision?.confidence ?? null,
      reason: decision?.reason ?? null,
      matchedTransactionIds: decision?.matchedTransactionIds ?? [],
      otherLines: transaction.lineItems.slice(1).map((line) => ({
        accountFullName: line.accountFullName, amountDecimal: line.amountDecimal, memo: line.memo,
      })),
    };
  });
  return {
    importPlanId: String(plan.import_plan_id),
    previewDigest: `sha256:${String(plan.preview_sha256)}`,
    expiresAt: planIsoTimestamp(plan.expires_at),
    accountId: review.accountId,
    statementId: review.statementId,
    sourceSystem: normalized.sourceSystem,
    rows,
    includedCount: rows.filter((row) => row.decision === "include").length,
    excludedCount: rows.filter((row) => row.decision === "exclude").length,
  };
}

export async function listAccountTransactionImportReviews({ pool, personId, accountId }) {
  const resolvedAccountId = Number(accountId);
  if (!Number.isInteger(resolvedAccountId) || resolvedAccountId <= 0) {
    throw importError("Account not found.", "ACCOUNT_NOT_FOUND", undefined, 404);
  }
  return withPoolTransaction(pool, async (connection) => {
    const [rows] = await connection.query(
      `SELECT import_plan_id, source_system, payload_sha256, preview_sha256, payload_json, expires_at
         FROM accounting_import_plans
        WHERE owner_person_id = ? AND import_kind = 'transactions' AND plan_status = 'ready'
          AND expires_at > UTC_TIMESTAMP(6)
        ORDER BY created_at DESC, import_plan_id DESC`,
      [personId],
    );
    const seenStatements = new Set();
    const reviews = [];
    for (const plan of rows) {
      if (payloadHash(plan.payload_json) !== String(plan.payload_sha256)) continue;
      const normalized = parsePlanJson(plan.payload_json, "payload");
      if (Number(normalized.importReview?.accountId) !== resolvedAccountId) continue;
      const key = String(normalized.importReview.statementId);
      if (seenStatements.has(key)) continue;
      seenStatements.add(key);
      reviews.push(importReviewView(normalized, plan));
    }
    return reviews;
  });
}

export async function updateTransactionImportReviewDecision({ pool, personId, importPlanId, accountId,
  externalId, decision }) {
  const resolvedPlanId = limitedRequiredText(importPlanId, "import plan ID", 36);
  const resolvedExternalId = limitedRequiredText(externalId, "external transaction ID", 128);
  if (decision !== "include" && decision !== "exclude") {
    throw importError("Import decision must be include or exclude.", "INVALID_IMPORT_DECISION");
  }
  return withPoolTransaction(pool, async (connection) => {
    const [rows] = await connection.query(
      `SELECT import_plan_id, source_system, plan_status, payload_sha256, preview_sha256,
              payload_json, summary_json, expires_at, expires_at <= UTC_TIMESTAMP(6) AS is_expired
         FROM accounting_import_plans
        WHERE import_plan_id = ? AND owner_person_id = ? AND import_kind = 'transactions'
        FOR UPDATE`,
      [resolvedPlanId, personId],
    );
    const plan = rows[0];
    if (!plan) throw importError("Transaction import plan not found.", "IMPORT_PLAN_NOT_FOUND", undefined, 404);
    if (plan.plan_status !== "ready" || Boolean(plan.is_expired)) {
      throw importError("This transaction import can no longer be changed.", "IMPORT_PLAN_STATE_CONFLICT", undefined, 409);
    }
    if (payloadHash(plan.payload_json) !== String(plan.payload_sha256)) {
      throw importError("Stored transaction import plan failed its integrity check.",
        "IMPORT_PLAN_INTEGRITY_FAILURE", undefined, 500);
    }
    const normalized = parsePlanJson(plan.payload_json, "payload");
    if (Number(normalized.importReview?.accountId) !== Number(accountId)) {
      throw importError("Transaction import review not found for this account.",
        "IMPORT_REVIEW_NOT_FOUND", undefined, 404);
    }
    const selected = normalized.importReview.decisions.find((item) => item.externalId === resolvedExternalId);
    if (!selected) throw importError("Imported transaction was not found in this review.",
      "IMPORT_REVIEW_ROW_NOT_FOUND", undefined, 404);
    selected.decision = decision;
    selected.confidence = "user_selected";
    selected.reason = decision === "include"
      ? "The user selected this statement row for import."
      : "The user excluded this statement row from import.";

    const entries = await analyzeTransactionImport(connection, personId, normalized, false);
    if (entries.some((entry) => entry.status === "rejected")) {
      throw importError("The import changed while it was being reviewed. Create a new preview.",
        "IMPORT_PLAN_NO_LONGER_VALID", summarize(normalized, entries), 409);
    }
    normalized.previewResolutionDigest = importResolutionDigest(entries);
    const reconciliationValidation = await validateReconciliation(connection, personId,
      normalized.reconciliation ?? null, entries);
    const balanceAssertions = await inspectKnownBalanceAssertions(connection, personId,
      normalized.knownBalanceAssertions ?? []);
    const preview = { ...summarize(normalized, entries),
      ...(balanceAssertions.length ? { balanceAssertions } : {}),
      ...(reconciliationValidation == null ? {} : { reconciliationValidation }) };
    const transactionSummaryValue = {
      transactionsCreated: preview.wouldCreateTransactionCount,
      transactionsReused: preview.wouldReuseTransactionCount,
      transactionsExcluded: preview.excludedTransactionCount,
      lineItemsCreated: preview.wouldCreateLineItemCount,
      lineItemsReused: preview.wouldReuseLineItemCount,
      rejectedTransactions: preview.rejectedTransactionCount,
    };
    const payloadJson = JSON.stringify(normalized);
    const previewHash = payloadHash(JSON.stringify(preview));
    await connection.query(
      `UPDATE accounting_import_plans
          SET payload_json = ?, payload_sha256 = ?, preview_sha256 = ?, summary_json = ?
        WHERE import_plan_id = ? AND owner_person_id = ?`,
      [payloadJson, payloadHash(payloadJson), previewHash, JSON.stringify(transactionSummaryValue),
        resolvedPlanId, personId],
    );
    return importReviewView(normalized, { ...plan, payload_json: payloadJson,
      payload_sha256: payloadHash(payloadJson), preview_sha256: previewHash });
  });
}

export async function insertImportedTransaction(connection, personId, sourceSystem, resolved) {
  const [insert] = await connection.query(
    `INSERT INTO transactions
      (owner_person_id, description, valuation_currency_id, TransactionState, TransactionDate, TransactionAtUtc,
       source_system, source_id, source_fingerprint)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    [personId, resolved.description, resolved.valuationCurrencyId, resolved.transactionDate,
      transactionAtForDatabase(resolved.transactionAt),
      sourceSystem, resolved.externalId, resolved.fingerprint],
  );
  const transactionId = Number(insert.insertId);
  for (const line of resolved.lineItems) {
    const [lineResult] = await connection.query(
      `INSERT INTO line_items
        (transaction_id, amount_units, value_units, memo, account_id, source_id, reconciliation_state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [transactionId, line.amountUnits, line.valueUnits, line.memo, line.accountId, line.externalId,
        line.reconciliationState ?? "unreconciled"],
    );
    await attachTags(connection, personId, Number(lineResult.insertId), accountingQuestionTags(line.question));
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
    if (normalized.valuationContractVersion !== 3) {
      await connection.query(
        `UPDATE accounting_import_plans
            SET plan_status = 'invalidated', invalidated_at = UTC_TIMESTAMP(6),
                invalidation_code = 'VALUATION_CONTRACT_CHANGED'
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [resolvedPlanId, personId],
      );
      return { failure: importError("Valuation rules changed; review a new import preview.",
        "IMPORT_PLAN_VALUATION_CHANGED") };
    }
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
    if (importResolutionDigest(entries) !== normalized.previewResolutionDigest) {
      await connection.query(
        `UPDATE accounting_import_plans
            SET plan_status = 'invalidated', invalidated_at = UTC_TIMESTAMP(6),
                invalidation_code = 'VALUATION_CHANGED'
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [resolvedPlanId, personId],
      );
      return { failure: importError("A reference valuation changed after preview; review a new import preview.",
        "IMPORT_PLAN_VALUATION_CHANGED") };
    }
    const reconciliationValidation = await validateReconciliation(connection, personId,
      normalized.reconciliation ?? null, entries);

    for (const entry of entries) {
      if (entry.status !== "planned") continue;
      entry.transactionId = await insertImportedTransaction(connection, personId, normalized.sourceSystem, entry.resolved);
      entry.status = "created";
    }
    const balanceAssertions = await inspectKnownBalanceAssertions(connection, personId,
      normalized.knownBalanceAssertions ?? [], { commit: true });
    const result = { ...summarize(normalized, entries, { ledgerChanged: true }),
      ...(balanceAssertions.length ? { balanceAssertions } : {}),
      ...(reconciliationValidation == null ? {} : { reconciliationValidation }),
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
