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
  accounts, accountId, suspenseAccountId = null, valuationCurrencyCode, lines, questionAudience = "human",
}) {
  const resolvedAccountId = Number(accountId);
  if (!Number.isInteger(resolvedAccountId) || resolvedAccountId <= 0) {
    throw workflowError("A statement account ID is required.", "INVALID_SINGLE_ACCOUNT_IMPORT_ACCOUNTS");
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw workflowError("At least one authoritative statement line is required.", "STATEMENT_LINES_REQUIRED");
  }
  const statementAccount = accounts.find((account) => account.id === resolvedAccountId);
  if (!statementAccount) {
    throw workflowError("Statement account not found.", "ACCOUNT_NOT_FOUND", { accountId: resolvedAccountId }, 404);
  }
  const designated = accounts.filter((account) => account.suspense
    && account.currencyId === statementAccount.currencyId && account.archivedAt == null && !account.placeholder);
  if (designated.length !== 1) {
    throw workflowError("Designate one active, postable suspense account in the statement currency before importing.",
      "SUSPENSE_ACCOUNT_NOT_CONFIGURED", { accountId: resolvedAccountId,
        currencyCode: statementAccount.currencyCode, designatedAccountIds: designated.map((account) => account.id) });
  }
  const suspenseAccount = designated[0];
  if (suspenseAccountId != null && Number(suspenseAccountId) !== suspenseAccount.id) {
    throw workflowError("The supplied suspense account is not the designated account for this currency.",
      "SUSPENSE_ACCOUNT_NOT_DESIGNATED", { designatedAccountId: suspenseAccount.id });
  }
  if (resolvedAccountId === suspenseAccount.id) {
    throw workflowError("The statement account cannot also hold its own unresolved counterlines.",
      "SUSPENSE_ACCOUNT_MATCHES_STATEMENT_ACCOUNT");
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
      || `What evidence identifies the other side of ${description ? JSON.stringify(description) : `statement line ${JSON.stringify(externalId)}`}? Check for a matching imported account entry, including near matches affected by fees.`;
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
  pool, personId, accountId, suspenseAccountId = null, sourceSystem, valuationCurrencyCode,
  lines, questionAudience = "human", reconciliation = null, knownBalanceAssertions = [],
}) {
  const accounts = await listAccounts(pool, personId);
  const compiled = compileSingleAccountStatementImport({
    accounts, accountId, suspenseAccountId, valuationCurrencyCode, lines, questionAudience,
  });
  return previewTransactionImport({
    pool, personId, sourceSystem, transactions: compiled.transactions,
    knownBalanceAssertions,
    reconciliation: reconciliation == null ? null : {
      accountIds: [compiled.statementAccount.id],
      openingBalanceDate: reconciliation.openingBalanceDate,
      closingBalanceDate: reconciliation.closingBalanceDate,
    },
  });
}
