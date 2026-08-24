import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { requireApiToken } from "./api-tokens.js";
import { listBalanceAssertions, saveBalanceAssertion } from "./balance-assertions.js";
import {
  createAccount,
  createTransaction,
  getTransaction,
  listAccounts,
  listTransactions,
  verifyAllPostedTransactions,
} from "./accounting.js";
import {
  accountTreeImportPlanFailure,
  commitAccountTreeImport,
  getAccountTreeImportPlan,
  previewAccountTreeImport,
} from "./account-tree.js";
import { createCurrency, listCurrencies, userCurrencyTypes } from "./currencies.js";
import { AccountingSchemaSemantics, withSchemaProjection } from "./schema-semantics.js";
import { commitTransactionImportPlan, previewTransactionImport } from "./transaction-import.js";

const readOnly = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const writesData = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const idempotentWrite = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });

const operations = Object.freeze({
  listCurrencies: {
    name: "list_currencies",
    purpose: "List global and user-owned currencies, securities, commodities, and their native-unit scales.",
    schemaObjects: ["currencies"],
    fields: { currencies: ["currency_id", "owner_person_id", "CurrencyAbbreviation", "display_name", "currency_type", "scale"] },
  },
  createCurrency: {
    name: "create_currency",
    purpose: "Create one user-owned currency, security, commodity, or other accounting unit.",
    schemaObjects: ["currencies"],
    fields: { currencies: ["currency_id", "owner_person_id", "CurrencyAbbreviation", "display_name", "currency_type", "scale"] },
  },
  listAccounts: {
    name: "list_accounts",
    purpose: "List this user's accounts and balances derived from posted line items.",
    schemaObjects: ["accounts", "currencies", "transactions", "line_items"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      transactions: ["transaction_id", "TransactionState"],
      line_items: ["transaction_id", "amount_units", "account_id"],
    },
  },
  createAccount: {
    name: "create_account",
    purpose: "Create one user-owned accounting account.",
    schemaObjects: ["accounts", "currencies"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
    },
  },
  importAccountTree: {
    name: "import_account_tree",
    purpose: "Validate a colon-delimited account hierarchy and save a durable owner-scoped commit plan.",
    schemaObjects: ["accounts", "currencies"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id", "archived_at", "source_system", "source_id"],
      currencies: ["currency_id", "owner_person_id", "CurrencyAbbreviation", "display_name", "currency_type", "scale"],
    },
  },
  commitAccountTreeImport: {
    name: "commit_account_tree_import",
    purpose: "Commit one previously validated account-tree import plan.",
    schemaObjects: ["accounts", "currencies"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id", "source_system", "source_id"],
      currencies: ["currency_id", "owner_person_id", "CurrencyAbbreviation", "display_name", "currency_type", "scale"],
    },
  },
  listTransactions: {
    name: "list_transactions",
    purpose: "List this user's recent accounting transactions.",
    schemaObjects: ["transactions", "currencies", "line_items"],
    fields: {
      transactions: ["transaction_id", "TransactionDate", "description", "TransactionState", "valuation_currency_id"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      line_items: ["line_item_id", "transaction_id"],
    },
  },
  getTransaction: {
    name: "get_transaction",
    purpose: "Read one user-owned transaction with its line items, tags, and exchange rates.",
    schemaObjects: ["transactions", "line_items", "accounts", "currencies", "tags", "lineitems_tags_join", "xrates"],
    fields: {
      transactions: ["transaction_id", "TransactionDate", "description", "TransactionState", "valuation_currency_id"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id"],
      accounts: ["account_id", "AccountName", "account_currency_id"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      tags: ["tag_id", "tag_key", "tag_value"],
      lineitems_tags_join: ["tagged_line_item_id", "tag_id"],
      xrates: ["xrate_id", "transaction_id", "from_units", "from_currency_id", "to_units", "to_currency_id"],
    },
  },
  createTransaction: {
    name: "create_transaction",
    purpose: "Create a balanced double-entry transaction and optionally post it.",
    schemaObjects: ["transactions", "line_items", "accounts", "currencies", "tags", "lineitems_tags_join", "xrates"],
    fields: {
      transactions: ["transaction_id", "description", "valuation_currency_id", "TransactionState", "TransactionDate", "source_system", "source_id"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id", "source_id"],
      accounts: ["account_id", "account_currency_id", "is_placeholder", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      tags: ["tag_id", "tag_key", "tag_value"],
      lineitems_tags_join: ["tagged_line_item_id", "tag_id"],
      xrates: ["xrate_id", "xrate_type", "transaction_id", "from_units", "from_currency_id", "to_units", "to_currency_id"],
    },
  },
  importTransactions: {
    name: "import_transactions",
    purpose: "Validate complete source-neutral transactions with nested line items and save a durable import plan.",
    schemaObjects: ["transactions", "line_items", "accounts", "currencies", "xrates"],
    fields: {
      transactions: ["transaction_id", "description", "valuation_currency_id", "TransactionState", "TransactionDate", "source_system", "source_id"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id", "source_id"],
      accounts: ["account_id", "AccountName", "parent_account_id", "account_currency_id", "is_placeholder", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      xrates: ["xrate_id", "transaction_id", "from_units", "from_currency_id", "to_units", "to_currency_id"],
    },
  },
  commitTransactionImport: {
    name: "commit_transaction_import",
    purpose: "Commit one previously validated transaction import plan.",
    schemaObjects: ["transactions", "line_items", "accounts", "currencies", "xrates"],
    fields: {
      transactions: ["transaction_id", "description", "valuation_currency_id", "TransactionState", "TransactionDate", "source_system", "source_id"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id", "source_id"],
      accounts: ["account_id", "account_currency_id", "is_placeholder", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      xrates: ["xrate_id", "transaction_id", "from_units", "from_currency_id", "to_units", "to_currency_id"],
    },
  },
  listBalanceAssertions: {
    name: "list_balance_assertions",
    purpose: "List known end-of-day account balances and compare them with the posted ledger.",
    schemaObjects: ["account_balance_assertions", "accounts", "currencies", "transactions", "line_items"],
    fields: {
      account_balance_assertions: ["account_balance_assertion_id", "account_id", "balance_date", "known_balance_units"],
      accounts: ["account_id", "AccountName", "account_currency_id", "is_placeholder"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      transactions: ["transaction_id", "TransactionDate", "TransactionState"],
      line_items: ["transaction_id", "amount_units", "account_id"],
    },
  },
  saveBalanceAssertion: {
    name: "save_balance_assertion",
    purpose: "Create or replace a known end-of-day account balance.",
    schemaObjects: ["account_balance_assertions", "accounts", "currencies", "transactions", "line_items"],
    fields: {
      account_balance_assertions: ["account_balance_assertion_id", "account_id", "balance_date", "known_balance_units"],
      accounts: ["account_id", "AccountName", "account_currency_id", "is_placeholder", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      transactions: ["transaction_id", "TransactionDate", "TransactionState"],
      line_items: ["transaction_id", "amount_units", "account_id"],
    },
  },
  verifyLedger: {
    name: "verify_ledger",
    purpose: "Re-run the accounting invariants for every posted transaction owned by this user.",
    schemaObjects: ["transactions", "line_items", "accounts", "xrates"],
    fields: {
      transactions: ["transaction_id", "owner_person_id", "valuation_currency_id", "TransactionState"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "account_id"],
      accounts: ["account_id", "owner_person_id", "account_currency_id", "is_placeholder"],
      xrates: ["transaction_id", "xrate_type", "from_units", "from_currency_id", "to_units", "to_currency_id"],
    },
  },
});

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolFailureResult(value) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function accountTreePlanToolResult(work, {
  schemaSemantics = null,
  operation = null,
  includeValidationRecovery = false,
} = {}) {
  try {
    const result = await work();
    return toolResult(schemaSemantics && operation
      ? withSchemaProjection(schemaSemantics, result, operation)
      : result);
  } catch (error) {
    const failure = accountTreeImportPlanFailure(error);
    if (failure) return toolFailureResult(failure);
    if (includeValidationRecovery && error?.code && [400, 409].includes(Number(error.status))) {
      return toolFailureResult({
        readyToCommit: false,
        status: "blocked",
        code: String(error.code),
        message: String(error.message),
        details: error.details ?? null,
        recoverable: true,
        requiredAction: "CORRECT_INPUT_AND_RUN_NEW_DRY_RUN",
        nextAction: {
          type: "correct_import_batch",
          retry: { tool: "import_account_tree", preserveEntireBatch: true },
        },
      });
    }
    throw error;
  }
}

function positiveInteger(label) {
  return z.number().int().positive().describe(label);
}

function accountingUnitKey(value) {
  return String(value ?? "").trim().toLocaleUpperCase("en-US");
}

function accountTreeCurrencyRequirements({ accounts, currencies, accessibleCurrencies }) {
  const accessibleCodes = new Set(accessibleCurrencies.map((currency) => accountingUnitKey(currency.code)));
  const definitions = new Map(currencies.map((currency) => [accountingUnitKey(currency.code), currency]));
  const references = new Map();
  for (const account of accounts) {
    const key = accountingUnitKey(account.currency_code);
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
    if (missingFields.includes("scale")) {
      userQuestions.push(`What decimal scale (0 through 18) should be used for ${code}?`);
    }
    if (missingFields.includes("display_name")) {
      userQuestions.push(`What display name should be used for ${code}?`);
    }
    if (missingFields.includes("currency_type")) {
      userQuestions.push(`Should ${code} be a crypto, security, commodity, or custom unit?`);
    }
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

function accountTreeNeedsInputWorkflow({ accounts, currencies, requirements }) {
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
    nextAction: {
      type: "collect_currency_details",
      askUser: requirements.flatMap((requirement) => requirement.userQuestions),
      retry: {
        tool: "import_account_tree",
        preserveEntireBatch: true,
        instruction: "Repeat import_account_tree with the entire original accounts array and completed currency definitions. Do not retry only the affected rows.",
      },
    },
  };
}

function accountTreeReadyWorkflow(result) {
  const { preview, ...identity } = result;
  return {
    ...identity,
    requiredAction: "REQUEST_USER_CONFIRMATION",
    nextAction: {
      type: "request_user_confirmation",
      instruction: "Report the numerical change preview and ask whether to commit this exact stored plan. Do not replay the import payload.",
      onApproval: {
        tool: "commit_account_tree_import",
        arguments: { import_plan_id: result.importPlanId },
      },
    },
    preview,
  };
}

function transactionPreviewWorkflow(result) {
  if (result.readyToCommit && result.importPlanId) {
    return {
      ...result,
      requiredAction: "REQUEST_USER_CONFIRMATION",
      nextAction: {
        type: "request_user_confirmation",
        instruction: "Report the numerical change preview and ask whether to commit this exact stored plan. Do not replay the transaction batch.",
        onApproval: { tool: "commit_transaction_import", arguments: { import_plan_id: result.importPlanId } },
      },
    };
  }
  return {
    ...result,
    requiredAction: "REVIEW_REJECTIONS_AND_RUN_NEW_DRY_RUN",
    nextAction: {
      type: "correct_rejected_transactions",
      instruction: "Report every rejection and unknown or ambiguous account path, correct the complete batch, then run a new dry run.",
      retry: { tool: "import_transactions", preserveEntireBatch: true },
    },
  };
}

export function createAccountingMcpServer({ personId, pool, schemaSemantics = new AccountingSchemaSemantics(), services = {} }) {
  const accounting = {
    listCurrencies: services.listCurrencies ?? listCurrencies,
    createCurrency: services.createCurrency ?? createCurrency,
    listAccounts: services.listAccounts ?? listAccounts,
    createAccount: services.createAccount ?? createAccount,
    previewAccountTreeImport: services.previewAccountTreeImport ?? services.importAccountTree ?? previewAccountTreeImport,
    commitAccountTreeImport: services.commitAccountTreeImport ?? commitAccountTreeImport,
    getAccountTreeImportPlan: services.getAccountTreeImportPlan ?? getAccountTreeImportPlan,
    listTransactions: services.listTransactions ?? listTransactions,
    getTransaction: services.getTransaction ?? getTransaction,
    createTransaction: services.createTransaction ?? createTransaction,
    previewTransactionImport: services.previewTransactionImport ?? previewTransactionImport,
    commitTransactionImportPlan: services.commitTransactionImportPlan ?? commitTransactionImportPlan,
    listBalanceAssertions: services.listBalanceAssertions ?? listBalanceAssertions,
    saveBalanceAssertion: services.saveBalanceAssertion ?? saveBalanceAssertion,
    verifyAllPostedTransactions: services.verifyAllPostedTransactions ?? verifyAllPostedTransactions,
  };
  const server = new McpServer({ name: "chapeaux-fous-accounting", version: "0.6.0" });

  server.registerTool("describe_accounting_schema", {
    title: "Describe accounting schema",
    description: "Return a small Schema Semantic Compiler projection for the accounting concepts named in the request. Use this before choosing accounting tools when the relevant entities or field meanings are unclear.",
    inputSchema: {
      request: z.string().trim().min(1).max(2000).describe("Natural-language description of the accounting data or operation to understand."),
    },
    annotations: readOnly,
  }, async ({ request }) => toolResult(schemaSemantics.route(request)));

  server.registerTool("list_currencies", {
    title: "List currencies",
    description: "List global and user-owned accounting units with ids, codes, display names, semantic types, and native-unit scales. Amounts elsewhere are integer native units, not decimal strings.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => toolResult(withSchemaProjection(schemaSemantics, {
    currencies: await accounting.listCurrencies(pool, personId),
  }, operations.listCurrencies)));

  server.registerTool("create_currency", {
    title: "Create currency or security",
    description: "Create a private accounting unit for the API-token owner. Use security for stocks and mutual funds. Scale is the number of fractional decimal places and cannot safely change after amounts have been recorded. Never guess or choose a default scale: when the source data does not specify it, ask the user for the scale before calling this tool.",
    inputSchema: {
      code: z.string().trim().min(1).max(50).describe("Short user-facing code or ticker, such as VTSAX."),
      display_name: z.string().trim().min(1).max(255),
      currency_type: z.enum(userCurrencyTypes),
      scale: z.number().int().min(0).max(18).describe("Decimal places retained for integer native-unit amounts. This must be supplied by source data or explicitly confirmed by the user; never infer a default."),
    },
    annotations: writesData,
  }, async ({ code, display_name, currency_type, scale }) => toolResult(withSchemaProjection(schemaSemantics, {
    currency: await accounting.createCurrency({
      pool,
      personId,
      code,
      displayName: display_name,
      type: currency_type,
      scale,
    }),
  }, operations.createCurrency)));

  server.registerTool("list_accounts", {
    title: "List accounts",
    description: "List all accounts belonging to the API-token owner, including descriptions, placeholder state, posted native-unit balances, and archived state.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => toolResult(withSchemaProjection(schemaSemantics, {
    accounts: await accounting.listAccounts(pool, personId),
  }, operations.listAccounts)));

  server.registerTool("create_account", {
    title: "Create account",
    description: "Create an account for the API-token owner. No root account, account type, or currency is inferred.",
    inputSchema: {
      name: z.string().trim().min(1).describe("Human-facing account name."),
      description: z.string().trim().max(16000).nullable().optional(),
      placeholder: z.boolean().default(false).describe("Placeholder accounts organize the tree and cannot receive transactions or balance assertions."),
      parent_account_id: positiveInteger("Optional parent account id owned by the same user.").nullable().optional(),
      account_type: z.enum(["asset", "liability", "equity", "income", "expense"]),
      currency_id: positiveInteger("Currency id returned by list_currencies."),
    },
    annotations: writesData,
  }, async ({ name, description, placeholder, parent_account_id, account_type, currency_id }) => {
    const created = await accounting.createAccount({
      personId,
      name,
      description,
      placeholder,
      parentAccountId: parent_account_id,
      type: account_type,
      currencyId: currency_id,
    });
    return toolResult(withSchemaProjection(schemaSemantics, { account: created }, operations.createAccount));
  });

  const importedAccountSchema = z.object({
    full_name: z.string().trim().min(1).max(4096).describe("Complete account path with colon-separated account names, such as Assets:Bank:Checking."),
    account_type: z.enum(["asset", "liability", "equity", "income", "expense"]),
    currency_code: z.string().trim().min(1).max(50).describe("Currency code returned by list_currencies."),
    description: z.string().trim().max(16000).nullable().optional(),
    placeholder: z.boolean().default(false).describe("Whether this is a non-postable organizational account."),
  });
  const importedCurrencySchema = z.object({
    code: z.string().trim().min(1).max(50),
    display_name: z.string().trim().min(1).max(255).optional()
      .describe("Display name for a new unit. It may be omitted on the first preflight call so the MCP can return an exact next-action response."),
    currency_type: z.enum(userCurrencyTypes).optional()
      .describe("Type for a new unit. It may be omitted on the first preflight call so the MCP can return an exact next-action response."),
    scale: z.number().int().min(0).max(18).nullable().optional()
      .describe("Decimal places retained for integer native-unit amounts. Omit this when unknown: import_account_tree will identify every missing scale and direct the agent to ask the user. Never infer a default."),
  });
  const accountTreePlanSummarySchema = z.object({
    accountsCreated: z.number().int().nonnegative(),
    accountsReused: z.number().int().nonnegative(),
    currenciesCreated: z.number().int().nonnegative(),
    currenciesReused: z.number().int().nonnegative(),
    rejectedRows: z.number().int().nonnegative(),
  });
  const accountTreePlanFailureSchema = z.object({
    code: z.enum(["IMPORT_PLAN_NOT_FOUND", "IMPORT_PLAN_EXPIRED", "IMPORT_PLAN_INVALIDATED",
      "IMPORT_PLAN_STATE_CONFLICT", "IMPORT_PLAN_OWNER_MISMATCH"]),
    recoverable: z.boolean(),
    requiredAction: z.literal("RUN_NEW_DRY_RUN"),
  });
  const accountTreePreviewOutputSchema = z.union([z.object({
    readyToCommit: z.literal(true),
    importPlanId: z.string().uuid(),
    status: z.literal("ready"),
    expiresAt: z.string().datetime(),
    previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    summary: accountTreePlanSummarySchema,
    requiredAction: z.literal("REQUEST_USER_CONFIRMATION"),
    nextAction: z.object({
      type: z.literal("request_user_confirmation"),
      instruction: z.string().min(1),
      onApproval: z.object({
        tool: z.literal("commit_account_tree_import"),
        arguments: z.object({ import_plan_id: z.string().uuid() }),
      }),
    }),
    preview: z.record(z.string(), z.unknown()),
    schemaProjection: z.unknown(),
  }), z.object({
    readyToCommit: z.literal(false),
    status: z.literal("needs_input"),
    code: z.enum(["CURRENCY_SCALES_REQUIRED", "CURRENCY_DETAILS_REQUIRED"]),
    requiredAction: z.enum(["ASK_USER_FOR_CURRENCY_SCALES", "COMPLETE_CURRENCY_DEFINITIONS"]),
    message: z.string().min(1),
    batchSummary: z.object({
      accountCount: z.number().int().positive(),
      suppliedCurrencyDefinitionCount: z.number().int().nonnegative(),
      unresolvedCurrencyCount: z.number().int().positive(),
    }),
    missingCurrencies: z.array(z.object({
      code: z.string().min(1),
      displayName: z.string().nullable(),
      currencyType: z.enum(userCurrencyTypes).nullable(),
      missingFields: z.array(z.enum(["display_name", "currency_type", "scale"])).min(1),
      referencedByAccountCount: z.number().int().nonnegative(),
      exampleAccountPaths: z.array(z.string()),
      userQuestions: z.array(z.string().min(1)).min(1),
    })).min(1),
    nextAction: z.object({
      type: z.literal("collect_currency_details"),
      askUser: z.array(z.string().min(1)).min(1),
      retry: z.object({
        tool: z.literal("import_account_tree"),
        preserveEntireBatch: z.literal(true),
        instruction: z.string().min(1),
      }),
    }),
    schemaProjection: z.unknown(),
  }), z.object({
    readyToCommit: z.literal(false),
    status: z.literal("blocked"),
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().nullable(),
    recoverable: z.literal(true),
    requiredAction: z.literal("CORRECT_INPUT_AND_RUN_NEW_DRY_RUN"),
    nextAction: z.object({
      type: z.literal("correct_import_batch"),
      retry: z.object({
        tool: z.literal("import_account_tree"),
        preserveEntireBatch: z.literal(true),
      }),
    }),
  }), accountTreePlanFailureSchema]);
  const accountTreeCommitOutputSchema = z.union([z.object({
    readyToCommit: z.literal(false),
    importPlanId: z.string().uuid(),
    status: z.literal("committed"),
    expiresAt: z.string().datetime(),
    previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    summary: accountTreePlanSummarySchema,
    commitResult: z.record(z.string(), z.unknown()),
    schemaProjection: z.unknown(),
  }), accountTreePlanFailureSchema]);
  const accountTreePlanStatusOutputSchema = z.union([
    z.object({ readyToCommit: z.literal(true), status: z.literal("ready"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema }),
    z.object({ readyToCommit: z.literal(false), status: z.literal("committed"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema, commitResult: z.record(z.string(), z.unknown()) }),
    z.object({ readyToCommit: z.literal(false), status: z.literal("expired"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema }),
    z.object({ readyToCommit: z.literal(false), status: z.literal("invalidated"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema, invalidationCode: z.string().min(1) }),
    accountTreePlanFailureSchema,
  ]);
  server.registerTool("import_account_tree", {
    title: "Preview account tree import",
    description: "Start or continue a complete account-tree import workflow. Call this tool with the entire intended batch even when new currency details or scales are unknown; omit unknown fields and the MCP will return status=needs_input, exact questions for the user, and a machine-readable retry instruction. Do not inspect historical receipts or guess missing values instead of calling this tool. Testing only previously blocked rows is partial validation and must be explicitly labeled incomplete. Use currency_type=security for mutual funds and stocks. A successful dry run saves the exact normalized input as a durable owner-scoped plan and returns status=ready, numerical created/reused summaries, and nextAction.onApproval containing the exact commit tool and plan ID. Report the preview and ask for confirmation. After approval, call commit_account_tree_import once with that plan ID; never replay the large batch.",
    inputSchema: {
      currencies: z.array(importedCurrencySchema).max(500).default([]),
      accounts: z.array(importedAccountSchema).min(1).max(1000),
      dry_run: z.literal(true).default(true).describe("Run the entire intended batch as a dry run and save a durable confirmation plan without changing ledger data. Never reduce a file retry to only previously blocked rows."),
    },
    outputSchema: accountTreePreviewOutputSchema,
    annotations: idempotentWrite,
  }, async ({ currencies, accounts }) => accountTreePlanToolResult(async () => {
    const accessibleCurrencies = await accounting.listCurrencies(pool, personId);
    const requirements = accountTreeCurrencyRequirements({ accounts, currencies, accessibleCurrencies });
    if (requirements.length) {
      return accountTreeNeedsInputWorkflow({ accounts, currencies, requirements });
    }
    const accessibleCodes = new Set(accessibleCurrencies.map((currency) => accountingUnitKey(currency.code)));
    const result = await accounting.previewAccountTreeImport({
      pool,
      personId,
      currencies: currencies.filter((currency) => !accessibleCodes.has(accountingUnitKey(currency.code)))
        .map((currency) => ({
          code: currency.code,
          displayName: currency.display_name,
          type: currency.currency_type,
          scale: currency.scale,
        })),
      accounts: accounts.map((account) => ({
        fullName: account.full_name,
        type: account.account_type,
        currencyCode: account.currency_code,
        description: account.description,
        placeholder: account.placeholder,
      })),
    });
    return accountTreeReadyWorkflow(result);
  }, {
    schemaSemantics,
    operation: operations.importAccountTree,
    includeValidationRecovery: true,
  }));

  server.registerTool("get_account_tree_import_plan", {
    title: "Get account tree import plan",
    description: "Read the durable status of an account-tree import plan without changing it. Returns ready, committed, expired, or invalidated with the opaque plan ID, expiration, preview digest, compact numerical summary, and the original commit result when committed. Plans persist across MCP connections, agent turns, blank interactions, and unrelated tool calls.",
    inputSchema: {
      import_plan_id: z.string().trim().uuid().describe("Exact opaque importPlanId returned by import_account_tree."),
    },
    outputSchema: accountTreePlanStatusOutputSchema,
    annotations: readOnly,
  }, async ({ import_plan_id }) => accountTreePlanToolResult(() => accounting.getAccountTreeImportPlan({
    pool, personId, importPlanId: import_plan_id,
  })));

  server.registerTool("commit_account_tree_import", {
    title: "Commit account tree import",
    description: "After the user explicitly approves a successful account-tree dry run, commit that exact durable plan using only import_plan_id. The server revalidates current database state, imports all currencies and accounts atomically, scopes the plan to its owner, rejects expired plans, and returns the original stored result on repeated confirmation calls.",
    inputSchema: {
      import_plan_id: z.string().trim().uuid().describe("importPlanId returned by import_account_tree."),
    },
    outputSchema: accountTreeCommitOutputSchema,
    annotations: idempotentWrite,
  }, async ({ import_plan_id }) => accountTreePlanToolResult(
    () => accounting.commitAccountTreeImport({ pool, personId, importPlanId: import_plan_id }),
    { schemaSemantics, operation: operations.commitAccountTreeImport },
  ));

  server.registerTool("list_transactions", {
    title: "List transactions",
    description: "List recent transactions belonging to the API-token owner, newest first.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: readOnly,
  }, async ({ limit }) => toolResult(withSchemaProjection(schemaSemantics, {
    transactions: await accounting.listTransactions(pool, personId, limit),
  }, operations.listTransactions)));

  server.registerTool("get_transaction", {
    title: "Get transaction",
    description: "Get one transaction belonging to the API-token owner, including its line items, tags, and transaction exchange rates.",
    inputSchema: { transaction_id: positiveInteger("Transaction id.") },
    annotations: readOnly,
  }, async ({ transaction_id }) => toolResult(withSchemaProjection(schemaSemantics, {
    transaction: await accounting.getTransaction(pool, personId, transaction_id),
  }, operations.getTransaction)));

  const lineItemSchema = z.object({
    account_id: positiveInteger("Account id owned by the token owner."),
    amount_units: z.string().regex(/^-?\d+$/).describe("Signed integer amount in the account currency's native units."),
    memo: z.string().trim().nullable().optional(),
    source_id: z.string().trim().nullable().optional(),
    tags: z.array(z.object({
      key: z.string().trim().min(1).max(50),
      value: z.string().trim().min(1),
    })).optional(),
  });
  const rateSchema = z.object({
    from_units: z.string().regex(/^\d+$/).describe("Positive integer units in the source currency."),
    from_currency_id: positiveInteger("Source currency id."),
    to_units: z.string().regex(/^\d+$/).describe("Positive integer units in the valuation currency."),
    to_currency_id: positiveInteger("Must equal valuation_currency_id."),
  });
  server.registerTool("create_transaction", {
    title: "Create transaction",
    description: "Atomically create and validate a double-entry transaction using non-placeholder accounts. Values must balance in valuation_currency_id; provide a positive-unit exchange rate for each foreign account currency.",
    inputSchema: {
      description: z.string().trim().nullable().optional(),
      transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar date in YYYY-MM-DD form."),
      valuation_currency_id: positiveInteger("Currency in which transaction balance is evaluated."),
      line_items: z.array(lineItemSchema).min(2),
      rates: z.array(rateSchema).optional(),
      post: z.boolean().default(true).describe("Post after validation; false leaves a validated draft."),
      source_system: z.string().trim().max(32).nullable().optional(),
      source_id: z.string().trim().max(128).nullable().optional(),
    },
    annotations: writesData,
  }, async (input) => {
    const created = await accounting.createTransaction({
      personId,
      description: input.description,
      transactionDate: input.transaction_date,
      valuationCurrencyId: input.valuation_currency_id,
      lineItems: input.line_items.map((line) => ({
        accountId: line.account_id,
        amountUnits: line.amount_units,
        memo: line.memo,
        sourceId: line.source_id,
        tags: line.tags,
      })),
      rates: input.rates?.map((rate) => ({
        fromUnits: rate.from_units,
        fromCurrencyId: rate.from_currency_id,
        toUnits: rate.to_units,
        toCurrencyId: rate.to_currency_id,
      })),
      post: input.post,
      sourceSystem: input.source_system,
      sourceId: input.source_id,
    });
    return toolResult(withSchemaProjection(schemaSemantics, { transaction: created }, operations.createTransaction));
  });

  const importedLineItemSchema = z.object({
    external_id: z.string().trim().min(1).max(128).nullable().optional()
      .describe("Optional stable line identifier within the source transaction; this is source-neutral."),
    account_full_name: z.string().trim().min(1).max(4096)
      .describe("Exact colon-delimited path of an existing account."),
    amount_decimal: z.string().trim().regex(/^[+-]?\d+(?:\.\d+)?$/)
      .describe("Signed decimal amount in the matched account's native currency. The server converts it using that currency's established scale."),
    value_decimal: z.string().trim().max(128).regex(/^[+-]?\d+(?:\.\d+)?$/).nullable().optional()
      .describe("Signed value in the transaction valuation currency. Optional only when the account uses the valuation currency; required for foreign-currency lines."),
    memo: z.string().trim().max(16000).nullable().optional(),
  });
  const importedTransactionSchema = z.object({
    external_id: z.string().trim().min(1).max(128)
      .describe("Stable transaction identifier within source_system. Group flat source rows by this generic identifier before submitting one nested transaction."),
    transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().trim().max(16000).nullable().optional(),
    valuation_currency_code: z.string().trim().min(1).max(50),
    line_items: z.array(importedLineItemSchema).min(2).max(1000),
  });
  server.registerTool("import_transactions", {
    title: "Preview transaction import",
    description: "Validate and preview an atomic source-neutral batch of up to 250 complete transactions and 5,000 nested line items. source_system plus each generic external_id provides idempotency; this tool is not specific to GnuCash. Exact full account paths are resolved against the existing tree. Decimal amounts use established currency scales. Foreign line values are used to validate one consistent positive exchange rate per currency, and every transaction must balance in its valuation currency. The result lists unknown or ambiguous paths, rejected transactions, numerical create/reuse/reject counts, and summaries by status, currency, year, and top-level branch. A rejection-free result saves a durable owner-scoped plan and returns readyToCommit=true plus importPlanId. Report that preview before noting that ledger data was unchanged, then ask for approval. After approval call commit_transaction_import with only the plan ID; never replay the batch.",
    inputSchema: {
      source_system: z.string().trim().min(1).max(32)
        .describe("Stable, source-neutral namespace for external IDs, such as an application or dataset name."),
      transactions: z.array(importedTransactionSchema).min(1).max(250),
      dry_run: z.literal(true).default(true)
        .describe("Validate the complete batch and save a durable confirmation plan without changing ledger data."),
    },
    annotations: idempotentWrite,
  }, async ({ source_system, transactions }) => toolResult(withSchemaProjection(schemaSemantics, {
    import: transactionPreviewWorkflow(await accounting.previewTransactionImport({
      pool,
      personId,
      sourceSystem: source_system,
      transactions: transactions.map((transaction) => ({
        externalId: transaction.external_id,
        transactionDate: transaction.transaction_date,
        description: transaction.description,
        valuationCurrencyCode: transaction.valuation_currency_code,
        lineItems: transaction.line_items.map((line) => ({
          externalId: line.external_id,
          accountFullName: line.account_full_name,
          amountDecimal: line.amount_decimal,
          valueDecimal: line.value_decimal,
          memo: line.memo,
        })),
      })),
    })),
  }, operations.importTransactions)));

  server.registerTool("commit_transaction_import", {
    title: "Commit transaction import",
    description: "After the user explicitly approves a successful transaction dry run, commit that exact durable plan using only import_plan_id. The server revalidates account paths, currencies, scales, balance, exchange rates, and source-ID conflicts; then it atomically creates the planned batch and returns actual created/reused counts. Plans are owner-scoped and expiring, and repeated confirmation is idempotent.",
    inputSchema: {
      import_plan_id: z.string().trim().uuid().describe("importPlanId returned by import_transactions."),
    },
    annotations: idempotentWrite,
  }, async ({ import_plan_id }) => toolResult(withSchemaProjection(schemaSemantics, {
    import: await accounting.commitTransactionImportPlan({ pool, personId, importPlanId: import_plan_id }),
  }, operations.commitTransactionImport)));

  server.registerTool("list_balance_assertions", {
    title: "List balance assertions",
    description: "List known end-of-day balances and their differences from the posted ledger for the API-token owner.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => toolResult(withSchemaProjection(schemaSemantics, {
    assertions: await accounting.listBalanceAssertions(pool, personId),
  }, operations.listBalanceAssertions)));

  server.registerTool("save_balance_assertion", {
    title: "Save balance assertion",
    description: "Create or replace the known end-of-day native-unit balance for one account and date.",
    inputSchema: {
      account_id: positiveInteger("Account id owned by the token owner."),
      balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      known_balance_units: z.string().regex(/^-?\d+$/).describe("Signed integer native units in the account currency."),
    },
    annotations: { ...writesData, idempotentHint: true },
  }, async ({ account_id, balance_date, known_balance_units }) => toolResult(withSchemaProjection(schemaSemantics, {
    assertion: await accounting.saveBalanceAssertion({
      personId,
      accountId: account_id,
      balanceDate: balance_date,
      knownBalanceUnits: known_balance_units,
    }),
  }, operations.saveBalanceAssertion)));

  server.registerTool("verify_ledger", {
    title: "Verify ledger",
    description: "Check every posted transaction belonging to the API-token owner against the central double-entry and exchange-rate invariants.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => toolResult(withSchemaProjection(schemaSemantics,
    await accounting.verifyAllPostedTransactions(pool, personId), operations.verifyLedger)));

  return server;
}

export function mountAccountingMcp(app, { pool }) {
  const authenticate = requireApiToken(pool);
  const handler = createAccountingMcpHandler({ pool });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => console.error("Accounting MCP HTTP adapter error:", error),
  });

  app.all("/mcp", authenticate, async (req, res) => {
    const accountingAuth = req.auth ?? {};
    const personId = Number(accountingAuth.personId);
    if (!Number.isInteger(personId) || personId <= 0) {
      return res.status(403).json({ error: "ACCOUNTING_AUTH_REQUIRED" });
    }

    req.auth = {
      token: `cfacct-token-${accountingAuth.tokenId}`,
      clientId: "chapeaux-fous-accounting",
      scopes: ["accounting"],
      extra: { accountingAuth },
    };

    await nodeHandler(req, res, req.body);
  });
}

export function createAccountingMcpHandler({ pool }) {
  return createMcpHandler(
    (requestContext) => {
      const accountingAuth = requestContext.authInfo?.extra?.accountingAuth ?? {};
      const personId = Number(accountingAuth.personId);
      if (!Number.isInteger(personId) || personId <= 0) {
        throw new Error("Authenticated accounting user is required.");
      }
      return createAccountingMcpServer({ personId, pool });
    },
    {
      legacy: "stateless",
      onerror: (error) => console.error("Accounting MCP protocol error:", error),
    },
  );
}
