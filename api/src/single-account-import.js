import { listAccounts } from "./accounting.js";
import { previewTransactionImport } from "./transaction-import.js";

function workflowError(message, code, details = undefined, status = 400) {
  return Object.assign(new Error(message), { status, code, details });
}

function accountPaths(accounts) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const paths = new Map();
  const resolve = (account, visiting = new Set()) => {
    if (paths.has(account.id)) return paths.get(account.id);
    if (visiting.has(account.id)) throw workflowError("The account hierarchy contains a cycle.", "INVALID_ACCOUNT_TREE");
    visiting.add(account.id);
    const parent = account.parentAccountId == null ? null : byId.get(account.parentAccountId);
    if (account.parentAccountId != null && !parent) {
      throw workflowError("The account hierarchy references a missing parent.", "INVALID_ACCOUNT_TREE");
    }
    const path = parent ? `${resolve(parent, visiting)}:${account.name}` : account.name;
    visiting.delete(account.id);
    paths.set(account.id, path);
    return path;
  };
  for (const account of accounts) resolve(account);
  return paths;
}

function decimalText(value, field) {
  const text = String(value ?? "").trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    throw workflowError(`${field} must be a signed decimal amount.`, "INVALID_STATEMENT_LINE_AMOUNT");
  }
  return text;
}

function signedDecimal(value, field) {
  const text = decimalText(value, field);
  if (/^[+-]?0+(?:\.0+)?$/.test(text)) {
    throw workflowError(`${field} must contain nonzero account movement.`, "ZERO_STATEMENT_LINE_AMOUNT");
  }
  return text;
}

function negateDecimal(value, field, { allowZero = false } = {}) {
  const text = allowZero ? decimalText(value, field) : signedDecimal(value, field);
  if (text.startsWith("-")) return text.slice(1);
  if (text.startsWith("+")) return `-${text.slice(1)}`;
  return `-${text}`;
}

function requiredText(value, field, maximum) {
  const text = String(value ?? "").trim();
  if (!text) throw workflowError(`${field} is required.`, "STATEMENT_LINE_FIELD_REQUIRED", { field });
  if ([...text].length > maximum) throw workflowError(`${field} cannot exceed ${maximum} characters.`,
    "STATEMENT_LINE_FIELD_TOO_LONG", { field });
  return text;
}

export function compileSingleAccountStatementImport({
  accounts, accountId, suspenseAccountId, valuationCurrencyCode, lines, questionAudience = "human",
}) {
  const resolvedAccountId = Number(accountId);
  const resolvedSuspenseId = Number(suspenseAccountId);
  if (!Number.isInteger(resolvedAccountId) || resolvedAccountId <= 0
      || !Number.isInteger(resolvedSuspenseId) || resolvedSuspenseId <= 0) {
    throw workflowError("Statement and suspense account IDs are required.", "INVALID_SINGLE_ACCOUNT_IMPORT_ACCOUNTS");
  }
  if (resolvedAccountId === resolvedSuspenseId) {
    throw workflowError("The suspense bucket must be different from the statement account.",
      "SUSPENSE_ACCOUNT_MATCHES_STATEMENT_ACCOUNT");
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw workflowError("At least one authoritative statement line is required.", "STATEMENT_LINES_REQUIRED");
  }
  const statementAccount = accounts.find((account) => account.id === resolvedAccountId);
  const suspenseAccount = accounts.find((account) => account.id === resolvedSuspenseId);
  if (!statementAccount || !suspenseAccount) {
    throw workflowError("Statement or suspense account not found.", "ACCOUNT_NOT_FOUND", {
      accountId: resolvedAccountId, suspenseAccountId: resolvedSuspenseId,
    }, 404);
  }
  for (const [label, account] of [["Statement", statementAccount], ["Suspense", suspenseAccount]]) {
    if (account.placeholder || account.archivedAt != null) {
      throw workflowError(`${label} account must be active and postable.`, "ACCOUNT_NOT_POSTABLE", { accountId: account.id });
    }
  }
  if (statementAccount.currencyId !== suspenseAccount.currencyId) {
    throw workflowError("The statement account and suspense bucket must use the same native currency.",
      "SUSPENSE_ACCOUNT_CURRENCY_MISMATCH", {
        accountCurrencyCode: statementAccount.currencyCode,
        suspenseCurrencyCode: suspenseAccount.currencyCode,
      });
  }
  const paths = accountPaths(accounts);
  const audience = requiredText(questionAudience, "question_audience", 50).toLocaleLowerCase("en-US");
  const transactions = lines.map((line, index) => {
    const externalId = requiredText(line?.externalId, `lines[${index}].external_id`, 128);
    const amountDecimal = signedDecimal(line?.amountDecimal, `lines[${index}].amount_decimal`);
    const valueDecimal = line?.valueDecimal == null ? null
      : decimalText(line.valueDecimal, `lines[${index}].value_decimal`);
    const description = String(line?.description ?? "").trim() || null;
    const prompt = String(line?.questionPrompt ?? "").trim()
      || `What is the final account for ${description ? JSON.stringify(description) : `statement line ${JSON.stringify(externalId)}`}?`;
    return {
      externalId,
      transactionDate: line?.transactionDate,
      description,
      valuationCurrencyCode,
      lineItems: [
        {
          externalId,
          accountFullName: paths.get(statementAccount.id),
          amountDecimal,
          valueDecimal,
          memo: line?.memo,
          reconciliationState: "cleared",
        },
        {
          externalId: null,
          accountFullName: paths.get(suspenseAccount.id),
          amountDecimal: negateDecimal(amountDecimal, `lines[${index}].amount_decimal`),
          valueDecimal: valueDecimal == null ? null
            : negateDecimal(valueDecimal, `lines[${index}].value_decimal`, { allowZero: true }),
          memo: line?.memo,
          reconciliationState: "unreconciled",
          question: { audience, prompt },
        },
      ],
    };
  });
  return { statementAccount, suspenseAccount, transactions };
}

export async function previewSingleAccountStatementImport({
  pool, personId, accountId, suspenseAccountId, sourceSystem, valuationCurrencyCode,
  lines, questionAudience = "human", reconciliation = null,
}) {
  const accounts = await listAccounts(pool, personId);
  const compiled = compileSingleAccountStatementImport({
    accounts, accountId, suspenseAccountId, valuationCurrencyCode, lines, questionAudience,
  });
  return previewTransactionImport({
    pool, personId, sourceSystem, transactions: compiled.transactions,
    reconciliation: reconciliation == null ? null : {
      accountIds: [compiled.statementAccount.id],
      openingBalanceDate: reconciliation.openingBalanceDate,
      closingBalanceDate: reconciliation.closingBalanceDate,
    },
  });
}
