import { currencyKey } from "./currencies.js";
import { makeRetryDescriptor } from "./mcp-contracts.js";

export function accountTreeCurrencyRequirements({ accounts, currencies, accessibleCurrencies }) {
  const accessibleCodes = new Set(accessibleCurrencies.map((currency) => currencyKey(currency.code)));
  const definitions = new Map(currencies.map((currency) => [currencyKey(currency.code), currency]));
  const references = new Map();
  for (const account of accounts) {
    const key = currencyKey(account.currency_code);
    const reference = references.get(key) ?? { code: String(account.currency_code).trim(), paths: [] };
    reference.paths.push(account.full_name);
    references.set(key, reference);
  }

  const unknownCodes = new Set([
    ...[...references.keys()].filter((code) => !accessibleCodes.has(code)),
    ...[...definitions.keys()].filter((code) => !accessibleCodes.has(code)),
  ]);
  return [...unknownCodes].sort().flatMap((key) => {
    const definition = definitions.get(key);
    const reference = references.get(key);
    const missingFields = [];
    if (!definition?.display_name) missingFields.push("display_name");
    if (!definition?.currency_type) missingFields.push("currency_type");
    if (definition?.scale == null) missingFields.push("scale");
    if (!missingFields.length) return [];

    const code = definition?.code ?? reference?.code ?? key;
    const userQuestions = [];
    if (missingFields.includes("scale")) userQuestions.push(`What decimal scale (0 through 18) should be used for ${code}?`);
    if (missingFields.includes("display_name")) userQuestions.push(`What display name should be used for ${code}?`);
    if (missingFields.includes("currency_type")) userQuestions.push(`Should ${code} be a crypto, security, commodity, or custom unit?`);
    return [{
      code,
      displayName: definition?.display_name ?? null,
      currencyType: definition?.currency_type ?? null,
      missingFields,
      referencedByAccountCount: reference?.paths.length ?? 0,
      exampleAccountPaths: reference?.paths.slice(0, 5) ?? [],
      userQuestions,
    }];
  });
}

export function accountTreeNeedsInputWorkflow({ accounts, currencies, requirements }) {
  const onlyScalesMissing = requirements.every((requirement) =>
    requirement.missingFields.length === 1 && requirement.missingFields[0] === "scale");
  return {
    readyToCommit: false,
    status: "needs_input",
    code: onlyScalesMissing ? "CURRENCY_SCALES_REQUIRED" : "CURRENCY_DETAILS_REQUIRED",
    requiredAction: onlyScalesMissing ? "ASK_USER_FOR_CURRENCY_SCALES" : "COMPLETE_CURRENCY_DEFINITIONS",
    message: onlyScalesMissing
      ? "Ask the user for the listed currency scales, then repeat this dry run with the complete original batch."
      : "Complete the listed currency definitions from authoritative source data or ask the user, then repeat this dry run with the complete original batch.",
    batchSummary: {
      accountCount: accounts.length,
      suppliedCurrencyDefinitionCount: currencies.length,
      unresolvedCurrencyCount: requirements.length,
    },
    missingCurrencies: requirements,
    retry: makeRetryDescriptor("missing_currency_details", { preserveCompleteOriginalBatch: true }),
    nextAction: {
      type: "collect_currency_details",
      askUser: requirements.flatMap((requirement) => requirement.userQuestions),
      tool: "import_account_tree",
      instruction: "Repeat import_account_tree with the entire original accounts array and completed currency definitions. Do not retry only the affected rows.",
    },
  };
}

export function accountTreeReadyWorkflow(result) {
  const { preview, ...identity } = result;
  return {
    ...identity,
    requiredAction: "REQUEST_USER_CONFIRMATION",
    nextAction: {
      type: "request_user_confirmation",
      instruction: `Commit this account-tree import now? It will create ${result.summary.accountsCreated} accounts and ${result.summary.currenciesCreated} currencies; ${result.summary.accountsReused} accounts and ${result.summary.currenciesReused} currencies will be reused.`,
      onApproval: { tool: "commit_account_tree_import", arguments: { import_plan_id: result.importPlanId } },
    },
    preview,
  };
}

export function transactionPreviewWorkflow(result) {
  if (result.readyToCommit && result.importPlanId) {
    return {
      ...result,
      status: "ready",
      requiredAction: "REQUEST_USER_CONFIRMATION",
      nextAction: {
        type: "request_user_confirmation",
        instruction: `Commit this transaction import now? It will create ${result.wouldCreateTransactionCount} transactions and ${result.wouldCreateLineItemCount} line items; ${result.wouldReuseTransactionCount} transactions and ${result.wouldReuseLineItemCount} line items will be reused.`,
        onApproval: { tool: "commit_transaction_import", arguments: { import_plan_id: result.importPlanId } },
      },
    };
  }
  return {
    ...result,
    status: "incomplete",
    requiredAction: "REVIEW_REJECTIONS_AND_RUN_NEW_DRY_RUN",
    retry: makeRetryDescriptor("transaction_batch_rejected", { preserveCompleteOriginalBatch: true }),
    nextAction: {
      type: "correct_rejected_transactions",
      instruction: "Report every rejection and unknown or ambiguous account path, correct the complete batch, then run a new dry run.",
      tool: "import_transactions",
    },
  };
}
