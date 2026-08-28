import { createHash, randomUUID } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { requireApiToken } from "./api-tokens.js";
import { mountArtifactUploadRoutes } from "./artifact-upload.js";
import {
  getBalanceAssertion,
  listBalanceAssertions,
  listBalanceAssertionsPage,
  saveBalanceAssertion,
} from "./balance-assertions.js";
import {
  createAccount,
  createTransaction,
  getAccount,
  getTransaction,
  listAccounts, listAccountsPage,
  listTransactions, listTransactionsPage,
  updateAccount,
  verifyAllPostedTransactions, verifyPostedTransactionsPage,
} from "./accounting.js";
import {
  accountDeletePlanFailure,
  commitAccountDeletion,
  getAccountDeletionPlan,
  previewAccountDeletion,
} from "./account-delete.js";
import {
  commitTransactionDeletion,
  getTransactionDeletionPlan,
  previewTransactionDeletion,
  refreshTransactionDeletionPlan,
  transactionDeletePlanFailure,
} from "./transaction-delete.js";
import {
  accountTreeImportPlanFailure,
  commitAccountTreeImport,
  getAccountTreeImportPlan,
  previewAccountTreeImport,
} from "./account-tree.js";
import {
  accountTreeCurrencyRequirements,
  accountTreeNeedsInputWorkflow,
  accountTreeReadyWorkflow,
  transactionPreviewWorkflow,
} from "./account-tree-workflow.js";
import {
  createCurrency,
  currencyKey,
  getCurrency,
  listCurrencies,
  listCurrenciesPage,
  userCurrencyTypes,
} from "./currencies.js";
import {
  accountingCapabilityManifest,
  accountSchema,
  balanceAssertionSchema,
  CAPABILITY_MANIFEST_URI,
  currencySchema,
  effectReceiptSchema,
  makeRetryDescriptor,
  MCP_CONTRACT_VERSION,
  MCP_SERVER_VERSION,
  retryDescriptorSchema,
  resultMetadataSchema,
  schemaProjectionSchema,
  structuredErrorSchema,
  successOutputSchema,
  toolMetadata,
  transactionImportArtifactUpload,
  transactionListItemSchema,
  transactionSchema,
} from "./mcp-contracts.js";
import { AccountingSchemaSemantics, withSchemaProjection } from "./schema-semantics.js";
import { commitTransactionImportPlan, getTransactionImportPlan, previewTransactionImport } from "./transaction-import.js";
import {
  commitTransactionImportJob,
  createTransactionImportJob,
  getTransactionImportJob,
  listTransactionImportExceptions,
  previewTransactionImportJob,
  retryTransactionImportException,
  stageTransactionImportArtifact,
  stageTransactionImportChunk,
  TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI,
  transactionImportCanonicalJsonSchema,
} from "./transaction-import-job.js";
import {
  TRANSACTION_IMPORT_MAX_LINE_ITEMS,
  TRANSACTION_IMPORT_MAX_TRANSACTIONS,
} from "./transaction-import-limits.js";

const readOnly = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const writesData = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const idempotentWrite = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const destructiveWrite = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
const planPreviewFields = Object.freeze([
  "import_plan_id", "owner_person_id", "import_kind", "plan_status", "preview_sha256",
  "summary_json", "expires_at", "created_at",
]);
const planCommitFields = Object.freeze([
  "import_plan_id", "owner_person_id", "import_kind", "plan_status", "source_system",
  "payload_sha256", "preview_sha256", "payload_json", "summary_json", "expires_at",
  "committed_at", "invalidated_at", "invalidation_code", "result_json", "created_at",
]);

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
  updateAccount: {
    name: "update_account",
    purpose: "Update one owner-scoped accounting account after enforcing account invariants.",
    schemaObjects: ["accounts", "currencies", "line_items", "account_balance_assertions"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      line_items: ["line_item_id", "account_id"],
      account_balance_assertions: ["account_balance_assertion_id", "account_id"],
    },
  },
  deleteAccount: {
    name: "delete_account",
    purpose: "Preview, commit, and verify deletion of one empty owner-scoped leaf account.",
    schemaObjects: ["accounts", "line_items", "account_balance_assertions", "accounting_import_plans"],
    fields: {
      accounts: ["account_id", "AccountName", "parent_account_id", "owner_person_id"],
      line_items: ["line_item_id", "account_id"],
      account_balance_assertions: ["account_balance_assertion_id", "account_id"],
      accounting_import_plans: planCommitFields,
    },
  },
  importAccountTree: {
    name: "import_account_tree",
    purpose: "Validate a colon-delimited account hierarchy and save a durable owner-scoped commit plan.",
    schemaObjects: ["accounts", "currencies", "accounting_import_plans"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id", "archived_at", "source_system", "source_id"],
      currencies: ["currency_id", "owner_person_id", "CurrencyAbbreviation", "display_name", "currency_type", "scale"],
      accounting_import_plans: planPreviewFields,
    },
  },
  commitAccountTreeImport: {
    name: "commit_account_tree_import",
    purpose: "Commit one previously validated account-tree import plan.",
    schemaObjects: ["accounts", "currencies", "accounting_import_plans"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id", "source_system", "source_id"],
      currencies: ["currency_id", "owner_person_id", "CurrencyAbbreviation", "display_name", "currency_type", "scale"],
      accounting_import_plans: planCommitFields,
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
    schemaObjects: ["transactions", "line_items", "accounts", "currencies", "xrates", "accounting_import_plans"],
    fields: {
      transactions: ["transaction_id", "description", "valuation_currency_id", "TransactionState", "TransactionDate", "source_system", "source_id"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id", "source_id"],
      accounts: ["account_id", "AccountName", "parent_account_id", "account_currency_id", "is_placeholder", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      xrates: ["xrate_id", "transaction_id", "from_units", "from_currency_id", "to_units", "to_currency_id"],
      accounting_import_plans: planPreviewFields,
    },
  },
  commitTransactionImport: {
    name: "commit_transaction_import",
    purpose: "Commit one previously validated transaction import plan.",
    schemaObjects: ["transactions", "line_items", "accounts", "currencies", "xrates", "accounting_import_plans"],
    fields: {
      transactions: ["transaction_id", "description", "valuation_currency_id", "TransactionState", "TransactionDate", "source_system", "source_id"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id", "source_id"],
      accounts: ["account_id", "account_currency_id", "is_placeholder", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      xrates: ["xrate_id", "transaction_id", "from_units", "from_currency_id", "to_units", "to_currency_id"],
      accounting_import_plans: planCommitFields,
    },
  },
  transactionImportJob: {
    name: "transaction_import_job",
    purpose: "Receive, validate, stage, preview, and commit one resumable source-file transaction import job.",
    schemaObjects: ["transactions", "line_items", "accounts", "currencies", "xrates",
      "accounting_transaction_import_jobs", "accounting_transaction_import_items",
      "accounting_transaction_import_requests"],
    fields: {
      transactions: ["transaction_id", "description", "valuation_currency_id", "TransactionState", "TransactionDate", "source_system", "source_id", "source_fingerprint"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id", "source_id"],
      accounts: ["account_id", "AccountName", "parent_account_id", "account_currency_id", "is_placeholder", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      xrates: ["xrate_id", "transaction_id", "from_units", "from_currency_id", "to_units", "to_currency_id"],
      accounting_transaction_import_jobs: ["import_job_id", "owner_person_id", "client_request_id",
        "source_system", "source_file_sha256", "source_file_name", "expected_record_count", "job_status",
        "preview_sha256", "result_json", "committed_at", "created_at", "updated_at"],
      accounting_transaction_import_items: ["import_job_id", "transaction_external_id", "canonical_sha256",
        "canonical_json", "resolved_json", "source_record_count", "item_status", "ledger_transaction_id",
        "errors_json", "created_at", "updated_at"],
      accounting_transaction_import_requests: ["import_job_id", "request_kind", "request_id",
        "payload_sha256", "record_count", "created_at"],
    },
  },
  deleteTransactions: {
    name: "delete_transactions",
    purpose: "Preview, commit, and verify permanent deletion of an exact owner-scoped transaction set.",
    schemaObjects: ["transactions", "line_items", "lineitems_tags_join", "xrates", "accounts",
      "accounting_import_plans", "accounting_transaction_import_jobs", "accounting_transaction_import_items"],
    fields: {
      transactions: ["transaction_id", "owner_person_id", "TransactionDate", "description", "valuation_currency_id", "TransactionState", "reversal_of_transaction_id", "source_system", "source_id", "source_fingerprint"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id", "reconciliation_state", "reconciled_at", "source_id"],
      lineitems_tags_join: ["tagged_line_item_id", "tag_id"],
      xrates: ["xrate_id", "owner_person_id", "transaction_id", "xrate_type", "ValidAt", "from_units", "from_currency_id", "to_units", "to_currency_id"],
      accounts: ["account_id", "owner_person_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id", "archived_at", "source_system", "source_id"],
      accounting_import_plans: planCommitFields,
      accounting_transaction_import_jobs: ["import_job_id", "job_status", "preview_sha256", "updated_at"],
      accounting_transaction_import_items: ["import_job_id", "transaction_external_id", "item_status",
        "ledger_transaction_id", "errors_json", "updated_at"],
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function effectReceipt(tool, args, outcome, entityRefs = []) {
  const argumentsDigest = createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
  return {
    receiptId: randomUUID(),
    tool,
    argumentsSha256: `sha256:${argumentsDigest}`,
    outcome,
    entityRefs,
    observedAt: new Date().toISOString(),
  };
}

function pageMetadata(items, nextCursor, type) {
  return {
    complete: nextCursor == null,
    returned: items.length,
    nextCursor,
    sourceRefs: items.map((item) => `accounting://${type}/${item.id}`),
  };
}

const entityCollections = Object.freeze({
  account: "accounts",
  account_delete_plan: "account-delete-plans",
  account_tree_import_plan: "account-tree-import-plans",
  balance_assertion: "balance-assertions",
  currency: "currencies",
  transaction: "transactions",
  transaction_delete_plan: "transaction-delete-plans",
  transaction_import_plan: "transaction-import-plans",
});

function entityUri({ type, id }) {
  return `accounting://${entityCollections[type] ?? type}/${encodeURIComponent(String(id))}`;
}

function accountPathContext(accounts) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const paths = new Map();
  function pathFor(account, visiting = new Set()) {
    if (paths.has(account.id)) return paths.get(account.id);
    if (visiting.has(account.id)) return null;
    visiting.add(account.id);
    const parent = account.parentAccountId == null ? null : byId.get(account.parentAccountId);
    const parentPath = parent ? pathFor(parent, visiting) : null;
    const path = account.parentAccountId != null && !parentPath ? null : [parentPath, account.name].filter(Boolean).join(":");
    paths.set(account.id, path);
    return path;
  }
  return accounts.filter((account) => account.archivedAt == null).map((account) => ({
    sourceRef: `accounting://accounts/${account.id}`,
    accountId: account.id,
    fullName: pathFor(account),
    accountType: account.type,
    currencyCode: account.currencyCode,
    placeholder: account.placeholder,
  }));
}

function toolResult(value, defaultStatus = "success") {
  const structuredContent = JSON.parse(JSON.stringify({
    contractVersion: MCP_CONTRACT_VERSION,
    status: value?.status ?? defaultStatus,
    ...value,
  }));
  const sourceRefs = new Set(structuredContent.resultMetadata?.sourceRefs ?? []);
  for (const entity of structuredContent.effectReceipt?.entityRefs ?? []) {
    if (structuredContent.effectReceipt.outcome === "deleted" && entity.type === "account") continue;
    sourceRefs.add(entityUri(entity));
  }
  const resourceLinks = [...sourceRefs].map((uri) => ({
    type: "resource_link",
    uri,
    name: uri.replace("accounting://", ""),
    description: "Stable accounting provider reference for this result.",
    mimeType: "application/json",
  }));
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }, ...resourceLinks],
    structuredContent,
  };
}

function toolFailureResult(value) {
  const structuredContent = {
    contractVersion: MCP_CONTRACT_VERSION,
    status: value?.status ?? "error",
    code: String(value?.code ?? "ACCOUNTING_ERROR"),
    message: String(value?.message ?? "The accounting operation failed."),
    details: value?.details ?? null,
    recoverable: value?.recoverable ?? Number(value?.status) < 500,
    retry: value?.retry ?? null,
    ...value,
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

async function safeToolResult(work, defaultStatus = "success") {
  try {
    return toolResult(await work(), defaultStatus);
  } catch (error) {
    return toolFailureResult({
      code: error?.code ?? "ACCOUNTING_ERROR",
      message: Number(error?.status) >= 500 ? "Unexpected accounting service error." : error?.message,
      details: error?.details ?? null,
      recoverable: Number(error?.status) < 500,
      retry: Number(error?.status) < 500
        ? makeRetryDescriptor(error?.code ?? "accounting_validation_failed")
        : null,
    });
  }
}

async function safeWorkflowResult(work, { defaultStatus = "success", retryTool, preserveEntireBatch = false,
  failureMapper = null } = {}) {
  try {
    return toolResult(await work(), defaultStatus);
  } catch (error) {
    const mapped = failureMapper?.(error);
    return toolFailureResult({
      code: mapped?.code ?? error?.code ?? "ACCOUNTING_WORKFLOW_ERROR",
      message: Number(error?.status) >= 500 ? "Unexpected accounting workflow error." : mapped?.message ?? error?.message,
      details: mapped?.details ?? error?.details ?? null,
      recoverable: mapped?.recoverable ?? Number(error?.status) < 500,
      requiredAction: mapped?.requiredAction,
      retry: retryTool ? makeRetryDescriptor(mapped?.code ?? error?.code ?? "workflow_retry_required", {
        retryable: mapped?.recoverable ?? Number(error?.status) < 500,
        preserveCompleteOriginalBatch: preserveEntireBatch,
      }) : null,
    });
  }
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
    if (failure) return toolFailureResult({
      ...failure,
      retry: makeRetryDescriptor("new_account_tree_dry_run_required", { preserveCompleteOriginalBatch: true }),
    });
    if (includeValidationRecovery && error?.code && [400, 409].includes(Number(error.status))) {
      return toolFailureResult({
        readyToCommit: false,
        status: "blocked",
        code: String(error.code),
        message: String(error.message),
        details: error.details ?? null,
        recoverable: true,
        retry: makeRetryDescriptor("invalid_account_tree_batch", { preserveCompleteOriginalBatch: true }),
        requiredAction: "CORRECT_INPUT_AND_RUN_NEW_DRY_RUN",
        nextAction: {
          type: "correct_import_batch",
          tool: "import_account_tree",
        },
      });
    }
    throw error;
  }
}

function positiveInteger(label) {
  return z.number().int().positive().describe(label);
}

function transactionDeletionStatusRecovery(result, deletionPlanId) {
  if (!["expired", "invalidated"].includes(result.status)) return result;
  return {
    ...result,
    requiredAction: "RUN_NEW_DELETE_PREVIEW",
    nextAction: { type: "run_provider_tool", tool: "refresh_transaction_delete_plan",
      arguments: { deletion_plan_id: deletionPlanId } },
  };
}

export function createAccountingMcpServer({ personId, pool, artifactRoot, schemaSemantics = new AccountingSchemaSemantics(), services = {} }) {
  const injectedPage = (list, key) => async (...args) => {
    const options = args.at(-1) ?? {};
    const limit = Number(options.limit) || 100;
    const items = await list(...args.slice(0, -1));
    return { [key]: items.slice(0, limit), nextCursor: items.length > limit ? String(items[limit - 1]?.id) : null };
  };
  const accounting = {
    listCurrencies: services.listCurrencies ?? listCurrencies,
    getCurrency: services.getCurrency ?? getCurrency,
    createCurrency: services.createCurrency ?? createCurrency,
    listAccounts: services.listAccounts ?? listAccounts,
    listAccountsPage: services.listAccountsPage ?? (services.listAccounts ? injectedPage(services.listAccounts, "accounts") : listAccountsPage),
    getAccount: services.getAccount ?? getAccount,
    createAccount: services.createAccount ?? createAccount,
    updateAccount: services.updateAccount ?? updateAccount,
    previewAccountTreeImport: services.previewAccountTreeImport ?? services.importAccountTree ?? previewAccountTreeImport,
    commitAccountTreeImport: services.commitAccountTreeImport ?? commitAccountTreeImport,
    getAccountTreeImportPlan: services.getAccountTreeImportPlan ?? getAccountTreeImportPlan,
    listTransactions: services.listTransactions ?? listTransactions,
    listTransactionsPage: services.listTransactionsPage ?? (services.listTransactions ? injectedPage(services.listTransactions, "transactions") : listTransactionsPage),
    getTransaction: services.getTransaction ?? getTransaction,
    createTransaction: services.createTransaction ?? createTransaction,
    previewTransactionImport: services.previewTransactionImport ?? previewTransactionImport,
    getTransactionImportPlan: services.getTransactionImportPlan ?? getTransactionImportPlan,
    commitTransactionImportPlan: services.commitTransactionImportPlan ?? commitTransactionImportPlan,
    createTransactionImportJob: services.createTransactionImportJob ?? createTransactionImportJob,
    stageTransactionImportChunk: services.stageTransactionImportChunk ?? stageTransactionImportChunk,
    stageTransactionImportArtifact: services.stageTransactionImportArtifact ?? stageTransactionImportArtifact,
    retryTransactionImportException: services.retryTransactionImportException ?? retryTransactionImportException,
    getTransactionImportJob: services.getTransactionImportJob ?? getTransactionImportJob,
    listTransactionImportExceptions: services.listTransactionImportExceptions ?? listTransactionImportExceptions,
    previewTransactionImportJob: services.previewTransactionImportJob ?? previewTransactionImportJob,
    commitTransactionImportJob: services.commitTransactionImportJob ?? commitTransactionImportJob,
    previewTransactionDeletion: services.previewTransactionDeletion ?? previewTransactionDeletion,
    refreshTransactionDeletionPlan: services.refreshTransactionDeletionPlan ?? refreshTransactionDeletionPlan,
    getTransactionDeletionPlan: services.getTransactionDeletionPlan ?? getTransactionDeletionPlan,
    commitTransactionDeletion: services.commitTransactionDeletion ?? commitTransactionDeletion,
    listBalanceAssertions: services.listBalanceAssertions ?? listBalanceAssertions,
    listBalanceAssertionsPage: services.listBalanceAssertionsPage ?? (services.listBalanceAssertions ? injectedPage(services.listBalanceAssertions, "assertions") : listBalanceAssertionsPage),
    getBalanceAssertion: services.getBalanceAssertion ?? getBalanceAssertion,
    saveBalanceAssertion: services.saveBalanceAssertion ?? saveBalanceAssertion,
    verifyAllPostedTransactions: services.verifyAllPostedTransactions ?? verifyAllPostedTransactions,
    verifyPostedTransactionsPage: services.verifyPostedTransactionsPage ?? verifyPostedTransactionsPage,
    listCurrenciesPage: services.listCurrenciesPage ?? (services.listCurrencies ? injectedPage(services.listCurrencies, "currencies") : listCurrenciesPage),
    previewAccountDeletion: services.previewAccountDeletion ?? previewAccountDeletion,
    getAccountDeletionPlan: services.getAccountDeletionPlan ?? getAccountDeletionPlan,
    commitAccountDeletion: services.commitAccountDeletion ?? commitAccountDeletion,
  };
  const server = new McpServer({
    name: "chapeaux-fous-accounting",
    title: "Chapeaux Fous Accounting",
    version: MCP_SERVER_VERSION,
  }, {
    instructions: accountingCapabilityManifest.server.instructions,
  });

  server.registerResource("accounting-capability-manifest", CAPABILITY_MANIFEST_URI, {
    title: "Accounting capability manifest",
    description: "Versioned capabilities, dependencies, attachment guidance, and bounded context views for this accounting provider.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(accountingCapabilityManifest) }] }));

  server.registerResource("accounting-transaction-import-canonical-schema", TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI, {
    title: "Canonical transaction import line-record JSON Schema",
    description: "The exact authoritative JSON Schema accepted in canonical JSON Lines artifacts, inline JSON chunks, and exception retries.",
    mimeType: "application/schema+json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/schema+json",
    text: JSON.stringify(transactionImportCanonicalJsonSchema) }] }));

  server.registerResource("accounting-currencies-active", "accounting://context/currencies/active", {
    title: "Accessible accounting units",
    description: "At most 500 global or owner-scoped currencies and accounting units for execution context.",
    mimeType: "application/json",
  }, async (uri) => {
    const page = await accounting.listCurrenciesPage(pool, personId, { limit: 500 });
    const value = {
      contractVersion: MCP_CONTRACT_VERSION,
      status: page.nextCursor == null ? "complete" : "partial",
      contextView: "accounting.currencies.active",
      evidence: page.currencies.map((currency) => ({
        sourceRef: `accounting://currencies/${currency.id}`,
        data: currency,
      })),
      summary: pageMetadata(page.currencies, page.nextCursor, "currencies"),
    };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
  });

  server.registerResource("accounting-accounts-active-paths", "accounting://context/accounts/active-paths", {
    title: "Active account path index",
    description: "At most 500 active account paths with types, currencies, and placeholder state.",
    mimeType: "application/json",
  }, async (uri) => {
    const page = await accounting.listAccountsPage(pool, personId, { limit: 500 });
    const evidence = accountPathContext(page.accounts);
    const value = {
      contractVersion: MCP_CONTRACT_VERSION,
      status: page.nextCursor == null ? "complete" : "partial",
      contextView: "accounting.accounts.active_paths",
      evidence,
      summary: { ...pageMetadata(evidence.map((item) => ({ id: item.accountId })), page.nextCursor, "accounts") },
    };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
  });

  const entityResource = (uri, value) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }],
  });
  const resourceTemplate = (uri) => new ResourceTemplate(uri, { list: undefined });

  server.registerResource("accounting-currency", resourceTemplate("accounting://currencies/{currencyId}"), {
    title: "Accounting currency or unit",
    description: "One currently accessible global or owner-scoped accounting unit by stable provider ID.",
    mimeType: "application/json",
  }, async (uri, { currencyId }) => entityResource(uri, withSchemaProjection(schemaSemantics, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    currency: await accounting.getCurrency(pool, personId, currencyId),
  }, operations.listCurrencies)));

  server.registerResource("accounting-account", resourceTemplate("accounting://accounts/{accountId}"), {
    title: "Accounting account",
    description: "One current owner-scoped account and posted native-unit balance by stable provider ID.",
    mimeType: "application/json",
  }, async (uri, { accountId }) => entityResource(uri, withSchemaProjection(schemaSemantics, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    account: await accounting.getAccount(pool, personId, accountId),
  }, operations.listAccounts)));

  server.registerResource("accounting-transaction", resourceTemplate("accounting://transactions/{transactionId}"), {
    title: "Accounting transaction",
    description: "One current owner-scoped transaction with line items, tags, and transaction rates by stable provider ID.",
    mimeType: "application/json",
  }, async (uri, { transactionId }) => entityResource(uri, withSchemaProjection(schemaSemantics, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    transaction: await accounting.getTransaction(pool, personId, transactionId),
  }, operations.getTransaction)));

  server.registerResource("accounting-balance-assertion", resourceTemplate("accounting://balance-assertions/{assertionId}"), {
    title: "Accounting balance assertion",
    description: "One current owner-scoped known-balance assertion and calculated ledger difference by stable provider ID.",
    mimeType: "application/json",
  }, async (uri, { assertionId }) => entityResource(uri, withSchemaProjection(schemaSemantics, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    assertion: await accounting.getBalanceAssertion(pool, personId, assertionId),
  }, operations.listBalanceAssertions)));

  server.registerResource("accounting-account-tree-import-plan",
    resourceTemplate("accounting://account-tree-import-plans/{planId}"), {
      title: "Account-tree import plan",
      description: "Current owner-scoped provider status for one durable account-tree import plan.",
      mimeType: "application/json",
    }, async (uri, { planId }) => entityResource(uri, withSchemaProjection(schemaSemantics, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...await accounting.getAccountTreeImportPlan({ pool, personId, importPlanId: planId }),
    }, operations.importAccountTree)));

  server.registerResource("accounting-account-delete-plan",
    resourceTemplate("accounting://account-delete-plans/{planId}"), {
      title: "Account-deletion plan",
      description: "Current owner-scoped provider status for one durable verified account-deletion plan.",
      mimeType: "application/json",
    }, async (uri, { planId }) => entityResource(uri, withSchemaProjection(schemaSemantics, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...await accounting.getAccountDeletionPlan({ pool, personId, deletionPlanId: planId }),
    }, operations.deleteAccount)));

  server.registerResource("accounting-transaction-import-plan",
    resourceTemplate("accounting://transaction-import-plans/{planId}"), {
      title: "Transaction import plan",
      description: "Current owner-scoped provider status for one durable transaction-import plan.",
      mimeType: "application/json",
    }, async (uri, { planId }) => entityResource(uri, withSchemaProjection(schemaSemantics, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...await accounting.getTransactionImportPlan({ pool, personId, importPlanId: planId }),
    }, operations.commitTransactionImport)));

  server.registerResource("accounting-transaction-import-job",
    resourceTemplate("accounting://transaction-import-jobs/{jobId}"), {
      title: "Resumable transaction import job",
      description: "Current owner-scoped progress and lifecycle state for one logical source-file import.",
      mimeType: "application/json",
    }, async (uri, { jobId }) => entityResource(uri, withSchemaProjection(schemaSemantics, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...await accounting.getTransactionImportJob({ pool, personId, importJobId: jobId }),
    }, operations.transactionImportJob)));

  server.registerResource("accounting-transaction-delete-plan",
    resourceTemplate("accounting://transaction-delete-plans/{planId}"), {
      title: "Transaction-deletion plan",
      description: "Current owner-scoped provider status for one exact permanent transaction-deletion plan.",
      mimeType: "application/json",
    }, async (uri, { planId }) => entityResource(uri, withSchemaProjection(schemaSemantics, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...transactionDeletionStatusRecovery(
        await accounting.getTransactionDeletionPlan({ pool, personId, deletionPlanId: planId }), planId),
    }, operations.deleteTransactions)));

  const schemaDescriptionOutput = successOutputSchema({ projection: schemaProjectionSchema });
  const currencyListOutput = successOutputSchema({
    currencies: z.array(currencySchema), resultMetadata: resultMetadataSchema, schemaProjection: schemaProjectionSchema,
  });
  const currencyMutationOutput = successOutputSchema({
    currency: currencySchema, effectReceipt: effectReceiptSchema, schemaProjection: schemaProjectionSchema,
  });
  const accountListOutput = successOutputSchema({
    accounts: z.array(accountSchema), resultMetadata: resultMetadataSchema, schemaProjection: schemaProjectionSchema,
  });
  const accountCreateOutput = successOutputSchema({
    account: z.object({ id: z.number().int().positive() }),
    effectReceipt: effectReceiptSchema,
    schemaProjection: schemaProjectionSchema,
  });
  const accountUpdateOutput = successOutputSchema({
    account: z.object({ accountId: z.number().int().positive(), updated: z.literal(true) }),
    effectReceipt: effectReceiptSchema,
    schemaProjection: schemaProjectionSchema,
  });
  const transactionListOutput = successOutputSchema({
    transactions: z.array(transactionListItemSchema), resultMetadata: resultMetadataSchema,
    schemaProjection: schemaProjectionSchema,
  });
  const transactionReadOutput = successOutputSchema({ transaction: transactionSchema, schemaProjection: schemaProjectionSchema });
  const transactionMutationOutput = successOutputSchema({
    transaction: z.object({
      transactionId: z.number().int().positive(),
      state: z.enum(["draft", "posted"]),
      validation: z.object({
        valid: z.literal(true),
        lineItemCount: z.number().int().min(2),
        valuationCurrencyId: z.number().int().positive(),
        foreignCurrencyIds: z.array(z.number().int().positive()),
      }),
    }),
    effectReceipt: effectReceiptSchema,
    schemaProjection: schemaProjectionSchema,
  });
  const assertionListOutput = successOutputSchema({
    assertions: z.array(balanceAssertionSchema), resultMetadata: resultMetadataSchema,
    schemaProjection: schemaProjectionSchema,
  });
  const assertionMutationOutput = successOutputSchema({
    assertion: balanceAssertionSchema, effectReceipt: effectReceiptSchema, schemaProjection: schemaProjectionSchema,
  });
  const ledgerVerificationOutput = successOutputSchema({
    valid: z.boolean(), checked: z.number().int().nonnegative(),
    failures: z.array(z.object({
      transactionId: z.number().int().positive(), code: z.string().min(1), message: z.string().min(1),
      details: z.json().optional(),
    })),
    resultMetadata: resultMetadataSchema,
    schemaProjection: schemaProjectionSchema,
  });
  const countMapSchema = z.record(z.string(), z.number().int().nonnegative());
  const importIssueSchema = z.object({ code: z.string().min(1), message: z.string().min(1), details: z.json().optional() });
  const transactionImportSummarySchema = z.object({
    transactionsCreated: z.number().int().nonnegative(), transactionsReused: z.number().int().nonnegative(),
    lineItemsCreated: z.number().int().nonnegative(), lineItemsReused: z.number().int().nonnegative(),
    rejectedTransactions: z.number().int().nonnegative(),
  });
  const transactionImportSchema = z.object({
    status: z.enum(["ready", "incomplete", "committed"]),
    dryRun: z.boolean(), ledgerChanged: z.boolean(), readyToCommit: z.boolean(),
    importPlanId: z.string().uuid().nullable(), importPlanExpiresAt: z.string().datetime().nullable(),
    sourceSystem: z.string().min(1), submittedTransactionCount: z.number().int().nonnegative(),
    uniqueTransactionCount: z.number().int().nonnegative(), duplicateInputTransactionCount: z.number().int().nonnegative(),
    submittedLineItemCount: z.number().int().nonnegative(), wouldCreateTransactionCount: z.number().int().nonnegative(),
    wouldReuseTransactionCount: z.number().int().nonnegative(), wouldCreateLineItemCount: z.number().int().nonnegative(),
    wouldReuseLineItemCount: z.number().int().nonnegative(), createdTransactionCount: z.number().int().nonnegative(),
    reusedTransactionCount: z.number().int().nonnegative(), createdLineItemCount: z.number().int().nonnegative(),
    reusedLineItemCount: z.number().int().nonnegative(), rejectedTransactionCount: z.number().int().nonnegative(),
    rejectedLineItemCount: z.number().int().nonnegative(), unknownAccountPaths: z.array(z.string()),
    ambiguousAccountPaths: z.array(z.string()),
    transactionSummary: z.object({
      byStatus: z.object({ planned: z.number().int().nonnegative(), existing: z.number().int().nonnegative(),
        created: z.number().int().nonnegative(), rejected: z.number().int().nonnegative() }),
      byValuationCurrency: countMapSchema, byYear: countMapSchema,
    }),
    lineItemSummary: z.object({ byAccountCurrency: countMapSchema, byTopLevelBranch: countMapSchema }),
    transactions: z.array(z.object({
      externalId: z.string().min(1), transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      description: z.string().nullable(), valuationCurrencyCode: z.string().min(1),
      lineItemCount: z.number().int().min(2), status: z.enum(["planned", "existing", "created", "rejected"]),
      transactionId: z.number().int().positive().nullable(), errors: z.array(importIssueSchema),
    })),
    expiresAt: z.string().datetime().optional(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    summary: transactionImportSummarySchema.optional(), committed: z.boolean().optional(), alreadyCommitted: z.boolean().optional(),
    requiredAction: z.enum(["REQUEST_USER_CONFIRMATION", "REVIEW_REJECTIONS_AND_RUN_NEW_DRY_RUN"]).optional(),
    nextAction: z.union([
      z.object({ type: z.literal("request_user_confirmation"), instruction: z.string().min(1),
        onApproval: z.object({ tool: z.literal("commit_transaction_import"), arguments: z.object({ import_plan_id: z.string().uuid() }) }) }),
      z.object({ type: z.literal("correct_rejected_transactions"), instruction: z.string().min(1),
        tool: z.literal("import_transactions") }),
    ]).optional(),
    retry: retryDescriptorSchema.optional(),
  });
  const transactionWorkflowOutput = z.union([
    transactionImportSchema.extend({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), import: transactionImportSchema,
      schemaProjection: schemaProjectionSchema, effectReceipt: effectReceiptSchema.optional(),
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.enum(["ready", "expired", "invalidated", "committed"]),
      readyToCommit: z.boolean(), importPlanId: z.string().uuid(), expiresAt: z.string().datetime(),
      previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), summary: transactionImportSummarySchema,
      invalidationCode: z.string().min(1).optional(), alreadyCommitted: z.boolean().optional(),
      commitResult: transactionImportSchema.optional(),
      schemaProjection: schemaProjectionSchema,
    }),
    structuredErrorSchema,
  ]);
  const deletionSummarySchema = z.object({ accountId: z.number().int().positive(), accountName: z.string().min(1) });
  const deletionIdentityShape = {
    deletionPlanId: z.string().uuid(), expiresAt: z.string().datetime(),
    previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), summary: deletionSummarySchema,
  };
  const accountDeletionWorkflowOutput = z.union([
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.literal("ready"), readyToCommit: z.literal(true),
      ...deletionIdentityShape,
      preview: z.object({ accountId: z.number().int().positive(), accountName: z.string().min(1),
        effect: z.literal("permanently_delete_empty_leaf_account") }),
      requiredAction: z.literal("REQUEST_USER_CONFIRMATION"),
      nextAction: z.object({ type: z.literal("request_user_confirmation"), instruction: z.string().min(1),
        onApproval: z.object({ tool: z.literal("commit_delete_account"),
          arguments: z.object({ deletion_plan_id: z.string().uuid() }) }) }),
      schemaProjection: schemaProjectionSchema,
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.enum(["ready", "expired", "invalidated"]),
      readyToCommit: z.boolean(), ...deletionIdentityShape, invalidationCode: z.string().min(1).optional(),
      schemaProjection: schemaProjectionSchema,
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.literal("committed"), readyToCommit: z.literal(false),
      ...deletionIdentityShape,
      deleted: z.object({ deleted: z.literal(true), accountId: z.number().int().positive(), name: z.string().min(1) }),
      verifiedAbsent: z.literal(true), alreadyCommitted: z.boolean(), effectReceipt: effectReceiptSchema.optional(),
      schemaProjection: schemaProjectionSchema,
    }),
    structuredErrorSchema,
  ]);
  const transactionDeletionSummarySchema = z.object({
    scope: z.enum(["all", "selected"]),
    transactionCount: z.number().int().positive(),
    lineItemCount: z.number().int().nonnegative(),
    exchangeRateCount: z.number().int().nonnegative(),
    tagAssignmentCount: z.number().int().nonnegative(),
    affectedAccountCount: z.number().int().nonnegative(),
    transactionStates: z.object({ draft: z.number().int().nonnegative(), posted: z.number().int().nonnegative(),
      voided: z.number().int().nonnegative() }),
    dateRange: z.object({ first: z.string().nullable(), last: z.string().nullable() }),
  });
  const transactionDeletionIdentityShape = {
    deletionPlanId: z.string().uuid(), expiresAt: z.string().datetime(),
    previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), summary: transactionDeletionSummarySchema,
  };
  const transactionDeletionPreviewInputSchema = z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("all") }).strict(),
    z.object({
      scope: z.literal("selected"),
      transaction_ids: z.array(z.number().int().positive()).min(1).max(1000),
    }).strict(),
  ]);
  const transactionDeletionRecoverySchema = z.object({
    type: z.literal("run_provider_tool"),
    tool: z.literal("refresh_transaction_delete_plan"),
    arguments: z.object({ deletion_plan_id: z.string().uuid() }),
  });
  const transactionDeletionWorkflowOutput = z.union([
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.literal("ready"), readyToCommit: z.literal(true),
      ...transactionDeletionIdentityShape,
      preview: transactionDeletionSummarySchema.extend({
        targetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        effect: z.literal("permanently_delete_exact_transactions_and_dependent_postings"),
        accountsPreserved: z.literal(true), accountTreeChanged: z.literal(false),
      }),
      requiredAction: z.literal("REQUEST_USER_CONFIRMATION"),
      nextAction: z.object({ type: z.literal("request_user_confirmation"), instruction: z.string().min(1),
        onApproval: z.object({ tool: z.literal("commit_delete_transactions"),
          arguments: z.object({ deletion_plan_id: z.string().uuid(),
            preview_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }) }) }),
      schemaProjection: schemaProjectionSchema,
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.literal("ready"),
      readyToCommit: z.literal(true), ...transactionDeletionIdentityShape, schemaProjection: schemaProjectionSchema,
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.enum(["expired", "invalidated"]),
      readyToCommit: z.literal(false), ...transactionDeletionIdentityShape,
      invalidationCode: z.string().min(1).optional(),
      requiredAction: z.literal("RUN_NEW_DELETE_PREVIEW"), nextAction: transactionDeletionRecoverySchema,
      schemaProjection: schemaProjectionSchema,
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.literal("committed"), readyToCommit: z.literal(false),
      ...transactionDeletionIdentityShape,
      deleted: z.object({ transactionCount: z.number().int().positive(), lineItemCount: z.number().int().nonnegative(),
        exchangeRateCount: z.number().int().nonnegative(), tagAssignmentCount: z.number().int().nonnegative() }),
      importReferences: z.object({ deletedAuditReferences: z.number().int().nonnegative(),
        reopenedImportJobs: z.number().int().nonnegative() }),
      verification: z.object({ targetTransactionsAbsent: z.literal(true), accountTreeUnchanged: z.literal(true),
        accountCount: z.number().int().nonnegative() }),
      alreadyCommitted: z.boolean(), effectReceipt: effectReceiptSchema.optional(), schemaProjection: schemaProjectionSchema,
    }),
    structuredErrorSchema,
  ]);

  server.registerTool("describe_accounting_schema", {
    title: "Describe accounting schema",
    description: "Use when accounting entities, fields, units, relationships, or invariants are unclear. A successful result proves only the meanings present in the returned bounded compiler projection.",
    inputSchema: {
      request: z.string().trim().min(1).max(2000).describe("Natural-language description of the accounting data or operation to understand."),
    },
    outputSchema: schemaDescriptionOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.schema"),
  }, async ({ request }) => safeToolResult(async () => ({ projection: schemaSemantics.route(request) })));

  server.registerTool("list_currencies", {
    title: "List currencies",
    description: "Use to resolve currency or commodity IDs and native-unit scales. A successful page proves which global and owner-scoped units were visible at read time; follow nextCursor until complete.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: currencyListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.currencies"),
  }, async ({ limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listCurrenciesPage(pool, personId, { limit, afterCurrencyId: cursor });
    return withSchemaProjection(schemaSemantics, {
      currencies: page.currencies,
      resultMetadata: pageMetadata(page.currencies, page.nextCursor, "currencies"),
    }, operations.listCurrencies);
  }));

  server.registerTool("create_currency", {
    title: "Create currency or security",
    description: "Use after the user or authoritative source supplies every field, including scale, to create one private accounting unit. Never guess or choose a default scale. A successful result and receipt prove the owner-scoped unit was created with the returned ID.",
    inputSchema: {
      code: z.string().trim().min(1).max(50).describe("Short user-facing code or ticker, such as VTSAX."),
      display_name: z.string().trim().min(1).max(255),
      currency_type: z.enum(userCurrencyTypes),
      scale: z.number().int().min(0).max(18).describe("Decimal places retained for integer native-unit amounts. This must be supplied by source data or explicitly confirmed by the user; never infer a default."),
    },
    outputSchema: currencyMutationOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.currencies"),
  }, async ({ code, display_name, currency_type, scale }) => safeToolResult(async () => {
    const args = { code, display_name, currency_type, scale };
    const currency = await accounting.createCurrency({
      pool,
      personId,
      code,
      displayName: display_name,
      type: currency_type,
      scale,
    });
    return withSchemaProjection(schemaSemantics, {
      currency,
      effectReceipt: effectReceipt("create_currency", args, "created", [{ type: "currency", id: currency.id }]),
    }, operations.createCurrency);
  }));

  server.registerTool("list_accounts", {
    title: "List accounts",
    description: "Use to read the owner's chart of accounts and posted native-unit balances. A successful page proves the returned owner-scoped account state at read time; follow nextCursor until complete.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: accountListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.accounts"),
  }, async ({ limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listAccountsPage(pool, personId, { limit, afterAccountId: cursor });
    return withSchemaProjection(schemaSemantics, {
      accounts: page.accounts,
      resultMetadata: pageMetadata(page.accounts, page.nextCursor, "accounts"),
    }, operations.listAccounts);
  }));

  server.registerTool("create_account", {
    title: "Create account",
    description: "Use to create one owner-scoped account after every required accounting choice is known. A successful result and receipt prove creation of the returned account ID; no root, type, or currency is inferred.",
    inputSchema: {
      name: z.string().trim().min(1).describe("Human-facing account name."),
      description: z.string().trim().max(16000).nullable().optional(),
      placeholder: z.boolean().default(false).describe("Placeholder accounts organize the tree and cannot receive transactions or balance assertions."),
      parent_account_id: positiveInteger("Optional parent account id owned by the same user.").nullable().optional(),
      account_type: z.enum(["asset", "liability", "equity", "income", "expense"]),
      currency_id: positiveInteger("Currency id returned by list_currencies."),
    },
    outputSchema: accountCreateOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.accounts", { dependencies: ["list_currencies"] }),
  }, async ({ name, description, placeholder, parent_account_id, account_type, currency_id }) => safeToolResult(async () => {
    const args = { name, description, placeholder, parent_account_id, account_type, currency_id };
    const created = await accounting.createAccount({
      personId,
      name,
      description,
      placeholder,
      parentAccountId: parent_account_id,
      type: account_type,
      currencyId: currency_id,
    });
    return withSchemaProjection(schemaSemantics, {
      account: created,
      effectReceipt: effectReceipt("create_account", args, "created", [{ type: "account", id: created.id }]),
    }, operations.createAccount);
  }));

  server.registerTool("update_account", {
    title: "Update account",
    description: "Use to change one existing owner-scoped account. A successful result and receipt prove the named account was updated after parent-cycle, ownership, placeholder, currency, transaction, and balance-assertion checks.",
    inputSchema: {
      account_id: positiveInteger("Account id owned by the token owner."),
      name: z.string().trim().min(1),
      description: z.string().trim().max(16000).nullable().optional(),
      placeholder: z.boolean().default(false),
      parent_account_id: positiveInteger("Optional parent account id owned by the same user.").nullable().optional(),
      account_type: z.enum(["asset", "liability", "equity", "income", "expense"]),
      currency_id: positiveInteger("Currency id returned by list_currencies."),
    },
    outputSchema: accountUpdateOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.accounts", { dependencies: ["list_accounts", "list_currencies"] }),
  }, async (input) => safeToolResult(async () => {
    const updated = await accounting.updateAccount({
      personId,
      accountId: input.account_id,
      name: input.name,
      description: input.description,
      placeholder: input.placeholder,
      parentAccountId: input.parent_account_id,
      type: input.account_type,
      currencyId: input.currency_id,
    });
    return withSchemaProjection(schemaSemantics, {
      account: updated,
      effectReceipt: effectReceipt("update_account", input, "updated", [{ type: "account", id: updated.accountId }]),
    }, operations.updateAccount);
  }));

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
  const accountTreeCurrencyResultSchema = z.object({
    id: z.number().int().positive().nullable(),
    ownerPersonId: z.number().int().positive().nullable(),
    userDefined: z.boolean(),
    code: z.string().min(1),
    displayName: z.string().min(1),
    type: z.enum(["iso_4217", "crypto", "security", "commodity", "custom"]),
    scale: z.number().int().min(0).max(18),
    status: z.enum(["planned", "existing", "created"]),
  });
  const accountTreeDetailedPreviewSchema = z.object({
    dryRun: z.boolean(), ledgerChanged: z.boolean(), totalCount: z.number().int().nonnegative(),
    createdCount: z.number().int().nonnegative(), existingCount: z.number().int().nonnegative(),
    plannedCount: z.number().int().nonnegative(), currencyCreatedCount: z.number().int().nonnegative(),
    currencyExistingCount: z.number().int().nonnegative(), currencyPlannedCount: z.number().int().nonnegative(),
    wouldCreateAccountCount: z.number().int().nonnegative(), wouldReuseAccountCount: z.number().int().nonnegative(),
    wouldCreateCurrencyCount: z.number().int().nonnegative(), wouldReuseCurrencyCount: z.number().int().nonnegative(),
    accountSummary: z.object({
      byStatus: z.object({ planned: z.number().int().nonnegative(), existing: z.number().int().nonnegative(), created: z.number().int().nonnegative() }),
      byAccountType: countMapSchema, byCurrencyCode: countMapSchema,
      byPlaceholderStatus: z.object({ placeholder: z.number().int().nonnegative(), postable: z.number().int().nonnegative() }),
      byTopLevelBranch: countMapSchema,
    }),
    currencies: z.array(accountTreeCurrencyResultSchema),
    accounts: z.array(z.object({
      fullName: z.string().min(1), accountType: z.enum(["asset", "liability", "equity", "income", "expense"]),
      currencyCode: z.string().min(1), description: z.string().nullable(), placeholder: z.boolean(),
      parentFullName: z.string().nullable(), topLevelBranch: z.string().min(1),
      status: z.enum(["planned", "existing", "created"]), accountId: z.number().int().positive().nullable(),
    })),
  });
  const accountTreePlanFailureSchema = z.object({
    contractVersion: z.literal(MCP_CONTRACT_VERSION),
    status: z.literal("error"),
    code: z.enum(["IMPORT_PLAN_NOT_FOUND", "IMPORT_PLAN_EXPIRED", "IMPORT_PLAN_INVALIDATED",
      "IMPORT_PLAN_STATE_CONFLICT", "IMPORT_PLAN_OWNER_MISMATCH"]),
    message: z.string().min(1),
    details: z.json().nullable(),
    recoverable: z.boolean(),
    retry: retryDescriptorSchema,
    requiredAction: z.literal("RUN_NEW_DRY_RUN"),
  });
  const accountTreePreviewOutputSchema = z.union([z.object({
    contractVersion: z.literal(MCP_CONTRACT_VERSION),
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
    preview: accountTreeDetailedPreviewSchema,
    schemaProjection: schemaProjectionSchema,
  }), z.object({
    contractVersion: z.literal(MCP_CONTRACT_VERSION),
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
    retry: retryDescriptorSchema,
    nextAction: z.object({
      type: z.literal("collect_currency_details"),
      askUser: z.array(z.string().min(1)).min(1),
      tool: z.literal("import_account_tree"),
      instruction: z.string().min(1),
    }),
    schemaProjection: schemaProjectionSchema,
  }), z.object({
    contractVersion: z.literal(MCP_CONTRACT_VERSION),
    readyToCommit: z.literal(false),
    status: z.literal("blocked"),
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.json().nullable(),
    recoverable: z.literal(true),
    retry: retryDescriptorSchema,
    requiredAction: z.literal("CORRECT_INPUT_AND_RUN_NEW_DRY_RUN"),
    nextAction: z.object({
      type: z.literal("correct_import_batch"),
      tool: z.literal("import_account_tree"),
    }),
  }), accountTreePlanFailureSchema]);
  const accountTreeCommitOutputSchema = z.union([z.object({
    contractVersion: z.literal(MCP_CONTRACT_VERSION),
    readyToCommit: z.literal(false),
    importPlanId: z.string().uuid(),
    status: z.literal("committed"),
    expiresAt: z.string().datetime(),
    previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    summary: accountTreePlanSummarySchema,
    commitResult: accountTreeDetailedPreviewSchema,
    effectReceipt: effectReceiptSchema,
    schemaProjection: schemaProjectionSchema,
  }), accountTreePlanFailureSchema]);
  const accountTreePlanStatusOutputSchema = z.union([
    z.object({ contractVersion: z.literal(MCP_CONTRACT_VERSION), readyToCommit: z.literal(true), status: z.literal("ready"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema, schemaProjection: schemaProjectionSchema }),
    z.object({ contractVersion: z.literal(MCP_CONTRACT_VERSION), readyToCommit: z.literal(false), status: z.literal("committed"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema, commitResult: accountTreeDetailedPreviewSchema,
      schemaProjection: schemaProjectionSchema }),
    z.object({ contractVersion: z.literal(MCP_CONTRACT_VERSION), readyToCommit: z.literal(false), status: z.literal("expired"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema, schemaProjection: schemaProjectionSchema }),
    z.object({ contractVersion: z.literal(MCP_CONTRACT_VERSION), readyToCommit: z.literal(false), status: z.literal("invalidated"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema, invalidationCode: z.string().min(1),
      schemaProjection: schemaProjectionSchema }),
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
    annotations: writesData,
    _meta: toolMetadata("accounting.accounts", {
      dependencies: ["list_currencies"],
      attachmentHints: ["Submit the complete account-tree batch on every preview retry."],
    }),
  }, async ({ currencies, accounts }) => accountTreePlanToolResult(async () => {
    const accessibleCurrencies = await accounting.listCurrencies(pool, personId);
    const requirements = accountTreeCurrencyRequirements({ accounts, currencies, accessibleCurrencies });
    if (requirements.length) {
      return accountTreeNeedsInputWorkflow({ accounts, currencies, requirements });
    }
    const accessibleCodes = new Set(accessibleCurrencies.map((currency) => currencyKey(currency.code)));
    const result = await accounting.previewAccountTreeImport({
      pool,
      personId,
      currencies: currencies.filter((currency) => !accessibleCodes.has(currencyKey(currency.code)))
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
    _meta: toolMetadata("accounting.accounts"),
  }, async ({ import_plan_id }) => accountTreePlanToolResult(() => accounting.getAccountTreeImportPlan({
    pool, personId, importPlanId: import_plan_id,
  }), { schemaSemantics, operation: operations.importAccountTree }));

  server.registerTool("commit_account_tree_import", {
    title: "Commit account tree import",
    description: "After the user explicitly approves a successful account-tree dry run, commit that exact durable plan using only import_plan_id. The server revalidates current database state, imports all currencies and accounts atomically, scopes the plan to its owner, rejects expired plans, and returns the original stored result on repeated confirmation calls.",
    inputSchema: {
      import_plan_id: z.string().trim().uuid().describe("importPlanId returned by import_account_tree."),
    },
    outputSchema: accountTreeCommitOutputSchema,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.accounts", { dependencies: ["import_account_tree"] }),
  }, async ({ import_plan_id }) => accountTreePlanToolResult(
    async () => {
      const result = await accounting.commitAccountTreeImport({ pool, personId, importPlanId: import_plan_id });
      return {
        ...result,
        effectReceipt: effectReceipt("commit_account_tree_import", { import_plan_id }, "committed", [
          { type: "account_tree_import_plan", id: import_plan_id },
        ]),
      };
    },
    { schemaSemantics, operation: operations.commitAccountTreeImport },
  ));

  server.registerTool("preview_delete_account", {
    title: "Preview account deletion",
    description: "Use before deleting an account. A successful result proves the account was owner-scoped, empty, leaf-only, and unreferenced when checked, and returns a 15-minute opaque plan for explicit confirmation; it does not delete data.",
    inputSchema: { account_id: positiveInteger("Owner-scoped account id to verify for permanent deletion.") },
    outputSchema: accountDeletionWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.accounts", { dependencies: ["list_accounts"] }),
  }, async ({ account_id }) => safeWorkflowResult(async () => {
    const result = await accounting.previewAccountDeletion({ pool, personId, accountId: account_id });
    return withSchemaProjection(schemaSemantics, {
      ...result,
      requiredAction: "REQUEST_USER_CONFIRMATION",
      nextAction: {
        type: "request_user_confirmation",
        instruction: `Ask for explicit confirmation to permanently delete account ${result.summary.accountName}.`,
        onApproval: {
          tool: "commit_delete_account",
          arguments: { deletion_plan_id: result.deletionPlanId },
        },
      },
    }, operations.deleteAccount);
  }, { defaultStatus: "ready", retryTool: "preview_delete_account", failureMapper: accountDeletePlanFailure }));

  server.registerTool("get_account_delete_plan", {
    title: "Get account deletion plan",
    description: "Use to inspect a durable account-deletion preview across connections. A successful result proves whether the owner-scoped plan is ready, expired, invalidated, or committed and returns the stored commit result when available.",
    inputSchema: { deletion_plan_id: z.string().trim().uuid() },
    outputSchema: accountDeletionWorkflowOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.accounts"),
  }, async ({ deletion_plan_id }) => safeWorkflowResult(async () =>
    withSchemaProjection(schemaSemantics,
      await accounting.getAccountDeletionPlan({ pool, personId, deletionPlanId: deletion_plan_id }),
      operations.deleteAccount),
  { retryTool: "preview_delete_account", failureMapper: accountDeletePlanFailure }));

  server.registerTool("commit_delete_account", {
    title: "Commit account deletion",
    description: "Use only after explicit user approval of the exact preview. A successful committed result and receipt prove the plan was owner-scoped, unexpired, revalidated, deleted atomically, and verified absent; repeated calls return the stored result.",
    inputSchema: { deletion_plan_id: z.string().trim().uuid() },
    outputSchema: accountDeletionWorkflowOutput,
    annotations: destructiveWrite,
    _meta: toolMetadata("accounting.accounts", { dependencies: ["preview_delete_account"] }),
  }, async ({ deletion_plan_id }) => safeWorkflowResult(async () => {
    const result = await accounting.commitAccountDeletion({ pool, personId, deletionPlanId: deletion_plan_id });
    return withSchemaProjection(schemaSemantics, {
      ...result,
      effectReceipt: effectReceipt("commit_delete_account", { deletion_plan_id },
        result.alreadyCommitted ? "unchanged" : "deleted", [
          { type: "account", id: result.deleted.accountId },
          { type: "account_delete_plan", id: deletion_plan_id },
        ]),
    }, operations.deleteAccount);
  }, { defaultStatus: "committed", retryTool: "preview_delete_account", failureMapper: accountDeletePlanFailure }));

  server.registerTool("preview_delete_transactions", {
    title: "Preview permanent transaction deletion",
    description: "Required before permanently deleting transactions. scope=all freezes the exact current owner-scoped transaction IDs; it is never reinterpreted dynamically during commit. selected deletes only the supplied IDs. The durable 15-minute preview reports transaction, line-item, exchange-rate, tag-assignment, affected-account, state, and date totals, proves the account tree is outside the deletion scope, and requests explicit user confirmation. No ledger data is deleted by this tool.",
    inputSchema: transactionDeletionPreviewInputSchema,
    outputSchema: transactionDeletionWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["list_transactions"] }),
  }, async ({ scope, transaction_ids }) => safeWorkflowResult(async () => {
    const result = await accounting.previewTransactionDeletion({ pool, personId, scope,
      transactionIds: transaction_ids ?? [] });
    return withSchemaProjection(schemaSemantics, {
      ...result,
      requiredAction: "REQUEST_USER_CONFIRMATION",
      nextAction: {
        type: "request_user_confirmation",
        instruction: `Ask for explicit confirmation to permanently delete exactly ${result.summary.transactionCount} transactions and ${result.summary.lineItemCount} line items. The account tree will remain unchanged.`,
        onApproval: { tool: "commit_delete_transactions",
          arguments: { deletion_plan_id: result.deletionPlanId, preview_digest: result.previewDigest } },
      },
    }, operations.deleteTransactions);
  }, { defaultStatus: "ready", retryTool: "preview_delete_transactions",
    failureMapper: transactionDeletePlanFailure }));

  server.registerTool("refresh_transaction_delete_plan", {
    title: "Refresh transaction-deletion plan",
    description: "Use only when a prior transaction-deletion plan expired or was invalidated. The provider recovers its opaque owner-scoped selection, re-reads current ledger state, and creates a new 15-minute preview requiring fresh explicit confirmation. It never deletes ledger data.",
    inputSchema: { deletion_plan_id: z.string().trim().uuid() },
    outputSchema: transactionDeletionWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["preview_delete_transactions"] }),
  }, async ({ deletion_plan_id }) => safeWorkflowResult(async () => {
    const result = await accounting.refreshTransactionDeletionPlan({ pool, personId,
      deletionPlanId: deletion_plan_id });
    return withSchemaProjection(schemaSemantics, {
      ...result,
      requiredAction: "REQUEST_USER_CONFIRMATION",
      nextAction: {
        type: "request_user_confirmation",
        instruction: `Ask for explicit confirmation to permanently delete exactly ${result.summary.transactionCount} transactions and ${result.summary.lineItemCount} line items. The account tree will remain unchanged.`,
        onApproval: { tool: "commit_delete_transactions",
          arguments: { deletion_plan_id: result.deletionPlanId, preview_digest: result.previewDigest } },
      },
    }, operations.deleteTransactions);
  }, { defaultStatus: "ready", retryTool: "refresh_transaction_delete_plan",
    failureMapper: transactionDeletePlanFailure }));

  server.registerTool("get_transaction_delete_plan", {
    title: "Get transaction-deletion plan",
    description: "Recover a durable owner-scoped transaction-deletion preview across turns or connections. Returns its exact digest and bounded numerical summary, an exact provider refresh action when expired or invalidated, or the original verified result after commit.",
    inputSchema: { deletion_plan_id: z.string().trim().uuid() },
    outputSchema: transactionDeletionWorkflowOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ deletion_plan_id }) => safeWorkflowResult(async () => {
    const result = await accounting.getTransactionDeletionPlan({ pool, personId, deletionPlanId: deletion_plan_id });
    return withSchemaProjection(schemaSemantics,
      transactionDeletionStatusRecovery(result, deletion_plan_id), operations.deleteTransactions);
  },
  { retryTool: "preview_delete_transactions", failureMapper: transactionDeletePlanFailure }));

  server.registerTool("commit_delete_transactions", {
    title: "Commit permanent transaction deletion",
    description: "Use only after explicit user approval of the exact preview. Accepts the opaque plan ID and matching preview digest, revalidates the frozen transaction contents and—for scope=all—the complete owner transaction set, blocks unplanned reversal references, deletes dependent tag assignments, line items, transaction rates, and exact transactions atomically, preserves accounts, updates resumable-import audit references, verifies absence and account-tree identity, and returns the stored result idempotently on retry.",
    inputSchema: {
      deletion_plan_id: z.string().trim().uuid(),
      preview_digest: z.string().trim().regex(/^sha256:[0-9a-f]{64}$/),
    },
    outputSchema: transactionDeletionWorkflowOutput,
    annotations: destructiveWrite,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["preview_delete_transactions"] }),
  }, async ({ deletion_plan_id, preview_digest }) => safeWorkflowResult(async () => {
    const result = await accounting.commitTransactionDeletion({ pool, personId,
      deletionPlanId: deletion_plan_id, previewDigest: preview_digest });
    return withSchemaProjection(schemaSemantics, {
      ...result,
      effectReceipt: effectReceipt("commit_delete_transactions", { deletion_plan_id, preview_digest },
        result.alreadyCommitted ? "unchanged" : "deleted", [
          { type: "transaction_delete_plan", id: deletion_plan_id },
        ]),
    }, operations.deleteTransactions);
  }, { defaultStatus: "committed", retryTool: "preview_delete_transactions",
    failureMapper: transactionDeletePlanFailure }));

  server.registerTool("list_transactions", {
    title: "List transactions",
    description: "Use to read recent owner-scoped transactions newest first. A successful page proves the returned transaction summaries were visible at read time; follow nextCursor until complete.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: transactionListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listTransactionsPage(pool, personId, { limit, beforeTransactionId: cursor });
    return withSchemaProjection(schemaSemantics, {
      transactions: page.transactions,
      resultMetadata: pageMetadata(page.transactions, page.nextCursor, "transactions"),
    }, operations.listTransactions);
  }));

  server.registerTool("get_transaction", {
    title: "Get transaction",
    description: "Use to inspect one transaction after its owner-scoped ID is known. A successful result proves the current header, line items, tags, and transaction exchange rates for that transaction.",
    inputSchema: { transaction_id: positiveInteger("Transaction id.") },
    outputSchema: transactionReadOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ transaction_id }) => safeToolResult(async () => withSchemaProjection(schemaSemantics, {
    transaction: await accounting.getTransaction(pool, personId, transaction_id),
  }, operations.getTransaction)));

  const lineItemSchema = z.object({
    account_id: positiveInteger("Account id owned by the token owner."),
    amount_units: z.string().regex(/^-?\d+$/).describe("Signed integer amount in the account currency's native units."),
    memo: z.string().trim().max(16000).nullable().optional(),
    source_id: z.string().trim().max(128).nullable().optional(),
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
    description: "Use to atomically create one complete double-entry transaction. A successful result and receipt prove the owner-scoped accounts, currency, rates, and exact balance were validated and the returned transaction was created in the reported state.",
    inputSchema: {
      description: z.string().trim().max(16000).nullable().optional(),
      transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar date in YYYY-MM-DD form."),
      valuation_currency_id: positiveInteger("Currency in which transaction balance is evaluated."),
      line_items: z.array(lineItemSchema).min(2),
      rates: z.array(rateSchema).optional(),
      post: z.boolean().default(true).describe("Post after validation; false leaves a validated draft."),
      source_system: z.string().trim().max(32).nullable().optional(),
      source_id: z.string().trim().max(128).nullable().optional(),
    },
    outputSchema: transactionMutationOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["list_accounts", "list_currencies"] }),
  }, async (input) => safeToolResult(async () => {
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
    return withSchemaProjection(schemaSemantics, {
      transaction: created,
      effectReceipt: effectReceipt("create_transaction", input, "created", [
        { type: "transaction", id: created.transactionId },
      ]),
    }, operations.createTransaction);
  }));

  const canonicalImportRecordSchema = z.object({
    transaction_external_id: z.string().trim().min(1).max(128),
    line_external_id: z.string().trim().min(1).max(128).nullable().optional(),
    transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().max(16000).nullable().optional(),
    valuation_currency_code: z.string().trim().min(1).max(50),
    account_full_name: z.string().trim().min(1).max(4096),
    amount_decimal: z.string().trim().max(128).regex(/^[+-]?\d+(?:\.\d+)?$/),
    value_decimal: z.string().trim().max(128).regex(/^[+-]?\d+(?:\.\d+)?$/).nullable(),
    memo: z.string().max(16000).nullable().optional(),
  }).describe(`One record conforming exactly to ${TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI}.`);
  // Keep the repeated workflow control plane compact. The canonical schema is
  // fetched once above, and the job resource retains the database projection.
  const transactionImportJobOutput = successOutputSchema({
    job: z.json(),
  }, ["success", "receiving", "review_ready", "committed"]);
  const transactionImportProgressSchema = z.object({
    expected_source_records: z.number().int().positive(),
    newly_staged_records: z.number().int().nonnegative(),
    previously_staged_or_reused_records: z.number().int().nonnegative(),
    exception_records: z.number().int().nonnegative(),
    remaining_records: z.number().int().nonnegative(),
    equation: z.string().min(1),
    transaction_totals: z.object({
      staged: z.number().int().nonnegative(),
      reused: z.number().int().nonnegative(),
      exceptions: z.number().int().nonnegative(),
    }),
  });
  const transactionImportJobIdentityShape = {
    import_job_id: z.string().uuid(),
    source_system: z.string().min(1),
    source_file: z.object({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      name: z.string().nullable(),
    }),
    expected_record_count: z.number().int().positive(),
  };
  const transactionImportFinalSummarySchema = z.object({
    transactions: z.object({
      created: z.number().int().nonnegative(),
      reused: z.number().int().nonnegative(),
      exceptions: z.number().int().nonnegative(),
    }),
    line_items: z.object({
      created: z.number().int().nonnegative(),
      reused: z.number().int().nonnegative(),
      exceptions: z.number().int().nonnegative(),
    }),
  });
  const transactionImportPreviewJobSchema = z.object({
    ...transactionImportJobIdentityShape,
    job_status: z.literal("review_ready"),
    progress: transactionImportProgressSchema,
    preview_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    ready_to_commit: z.literal(true),
    unresolved_exceptions: z.number().int().nonnegative(),
    commit_scope: z.string().min(1),
    requiredAction: z.literal("REQUEST_USER_CONFIRMATION"),
    nextAction: z.object({
      type: z.literal("request_user_confirmation"),
      instruction: z.string().min(1),
      onApproval: z.object({
        tool: z.literal("commit_transaction_import_job"),
        arguments: z.object({
          import_job_id: z.string().uuid(),
          preview_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        }),
      }),
    }),
  });
  const transactionImportCommittedJobSchema = z.object({
    ...transactionImportJobIdentityShape,
    job_status: z.literal("committed"),
    committed: z.literal(true),
    already_committed: z.boolean(),
    preview_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    progress: transactionImportProgressSchema,
    final_summary: transactionImportFinalSummarySchema,
  });
  const transactionImportPreviewOutput = successOutputSchema({
    job: z.union([transactionImportPreviewJobSchema, transactionImportCommittedJobSchema]),
  });
  const transactionImportSchemaOutput = successOutputSchema({
    schema_uri: z.literal(TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI),
    canonical_schema: z.json(),
    artifact_upload: z.json(),
  });

  server.registerTool("get_transaction_import_schema", {
    title: "Get canonical transaction import schema",
    description: "Return the exact authoritative draft-2020-12 JSON Schema for every source-neutral line record and the complete resumable artifact-upload contract. Fetch this before creating a declarative CSV-to-canonical mapping; do not infer fields or artifact semantics from examples.",
    inputSchema: {},
    outputSchema: transactionImportSchemaOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async () => safeToolResult(async () => ({
    schema_uri: TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI,
    canonical_schema: transactionImportCanonicalJsonSchema,
    artifact_upload: transactionImportArtifactUpload,
  })));

  server.registerTool("create_transaction_import_job", {
    title: "Create resumable transaction import job",
    description: "Create one durable logical import job for one exact original source file and final expected canonical record count. source_file_sha256 and source_file_name identify the original source before transformation, not the generated canonical JSONL artifact; the artifact upload records its own checksum and name. client_request_id makes retries idempotent. All later chunks retain the returned import_job_id, source_system, original source-file identity, and expected count.",
    inputSchema: {
      source_system: z.string().trim().min(1).max(32),
      source_file_sha256: z.string().trim().regex(/^(?:sha256:)?[0-9a-fA-F]{64}$/)
        .describe("SHA-256 of the original source file before canonical transformation; never use the generated JSONL artifact checksum here."),
      source_file_name: z.string().trim().min(1).max(1024).nullable().optional()
        .describe("Original source filename before canonical transformation, or null when unavailable."),
      expected_record_count: z.number().int().positive(),
      client_request_id: z.string().trim().min(1).max(128),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["get_transaction_import_schema"] }),
  }, async (input) => safeWorkflowResult(async () => ({
    job: await accounting.createTransactionImportJob({ pool, personId,
      sourceSystem: input.source_system, sourceFileSha256: input.source_file_sha256,
      sourceFileName: input.source_file_name, expectedRecordCount: input.expected_record_count,
      clientRequestId: input.client_request_id }),
  }), { retryTool: "create_transaction_import_job" }));

  server.registerTool("stage_transaction_import_artifact", {
    title: "Stage a complete canonical transaction artifact",
    description: "Consume one completed, SHA-256-verified canonical artifact without placing its records or transport chunks in model context. File-originated imports should use application/x-ndjson with one canonical line record per nonblank line. The host uploads raw bytes through the advertised resumable artifact contract, then calls this tool with only import_job_id and artifact_id. Accounting waits for the complete artifact, binds it to the logical job, groups every record by transaction_external_id across the whole file, applies internal idempotent batches, owns all accounting validation and deduplication, checkpoints progress, and exposes invalid transactions only through list_transaction_import_exceptions.",
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      artifact_id: z.string().trim().uuid(),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["create_transaction_import_job"],
      artifactUpload: transactionImportArtifactUpload,
    }),
  }, async ({ import_job_id, artifact_id }) => safeWorkflowResult(async () => ({
    job: await accounting.stageTransactionImportArtifact({ pool, artifactRoot, personId,
      importJobId: import_job_id, artifactId: artifact_id }),
  }), { retryTool: "stage_transaction_import_artifact" }));

  server.registerTool("stage_transaction_import_chunk", {
    title: "Stage canonical transaction records",
    description: `Ordinary inline-JSON path for bounded transactions created directly by the agent. File-originated or unusually large data must use the advertised artifact upload and stage_transaction_import_artifact so records and transport chunks do not enter model context. Each inline chunk may contain any number of complete transaction groups up to ${TRANSACTION_IMPORT_MAX_LINE_ITEMS.toLocaleString("en-US")} records; Accounting groups by transaction_external_id and owns all validation, deduplication, staging, and exceptions. A stable chunk_id makes an exact retry idempotent. Progress always reconciles expected_source_records = newly_staged_records + previously_staged_or_reused_records + exception_records + remaining_records.`,
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      chunk_id: z.string().trim().min(1).max(128),
      records: z.array(canonicalImportRecordSchema).min(1).max(TRANSACTION_IMPORT_MAX_LINE_ITEMS),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["create_transaction_import_job"] }),
  }, async ({ import_job_id, chunk_id, records }) => safeWorkflowResult(async () => ({
    job: await accounting.stageTransactionImportChunk({ pool, personId, importJobId: import_job_id, chunkId: chunk_id, records }),
  }), { retryTool: "stage_transaction_import_chunk" }));

  server.registerTool("retry_transaction_import_exception", {
    title: "Retry one corrected import exception",
    description: "Replace and revalidate one current exception transaction using corrected canonical records. Successful staged or reused transactions are not resubmitted or changed. The stable retry_id makes exact retries idempotent; transaction identity and the job's final source-record count must remain unchanged.",
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      retry_id: z.string().trim().min(1).max(128),
      transaction_external_id: z.string().trim().min(1).max(128),
      records: z.array(canonicalImportRecordSchema).min(1).max(1000),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["stage_transaction_import_chunk"] }),
  }, async ({ import_job_id, retry_id, transaction_external_id, records }) => safeWorkflowResult(async () => ({
      job: await accounting.retryTransactionImportException({ pool, personId, importJobId: import_job_id,
        retryId: retry_id, transactionExternalId: transaction_external_id, records }),
    }), { retryTool: "retry_transaction_import_exception" }));

  server.registerTool("get_transaction_import_job", {
    title: "Get transaction import job",
    description: "Read the durable owner-scoped state and reconcilable progress of one logical import job across connections, chunks, and retries.",
    inputSchema: { import_job_id: z.string().trim().uuid() },
    outputSchema: transactionImportJobOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ import_job_id }) => safeWorkflowResult(async () => ({
    job: await accounting.getTransactionImportJob({ pool, personId, importJobId: import_job_id }),
  })));

  server.registerTool("list_transaction_import_exceptions", {
    title: "List transaction import exceptions",
    description: "Page through current invalid transactions. Every exception includes error codes, complete source identity, the canonical records, and complete transaction context so only exceptions need to return to the LLM for correction.",
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().max(128).nullable().optional(),
    },
    outputSchema: transactionImportJobOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ import_job_id, limit, cursor }) => safeWorkflowResult(async () => ({
    job: await accounting.listTransactionImportExceptions({ pool, personId, importJobId: import_job_id,
      limit, afterExternalId: cursor }),
  })));

  server.registerTool("preview_transaction_import_job", {
    title: "Create final transaction import preview",
    description: "After every expected source record is staged, reused, or represented by an exception, bind the current job state to one final preview digest. This changes no ledger data. The preview reports unresolved exceptions, exact commit scope, requiredAction=REQUEST_USER_CONFIRMATION, and nextAction.onApproval containing the exact commit tool arguments; present it to the user for approval.",
    inputSchema: { import_job_id: z.string().trim().uuid() },
    outputSchema: transactionImportPreviewOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["stage_transaction_import_chunk"] }),
  }, async ({ import_job_id }) => safeWorkflowResult(async () => ({
    job: await accounting.previewTransactionImportJob({ pool, personId, importJobId: import_job_id }),
  }), { retryTool: "preview_transaction_import_job" }));

  server.registerTool("commit_transaction_import_job", {
    title: "Commit final transaction import preview",
    description: "Explicitly commit the exact final job preview after user approval. The server revalidates staged accounting transactions, atomically creates only valid new transactions, reuses stable source-ID matches, leaves structured exceptions uncommitted, and returns one idempotent final job summary with transaction and line-item created/reused/exception totals.",
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      preview_digest: z.string().trim().regex(/^sha256:[0-9a-f]{64}$/),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["preview_transaction_import_job"] }),
  }, async ({ import_job_id, preview_digest }) => safeWorkflowResult(async () => ({
    job: await accounting.commitTransactionImportJob({ pool, personId, importJobId: import_job_id,
      previewDigest: preview_digest }),
  }), { defaultStatus: "committed", retryTool: "get_transaction_import_job" }));

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
    description: `Validate and preview an atomic source-neutral batch of up to ${TRANSACTION_IMPORT_MAX_TRANSACTIONS} complete transactions and ${TRANSACTION_IMPORT_MAX_LINE_ITEMS.toLocaleString("en-US")} nested line items. The caller, normally the LLM, must parse source files and group flat rows into complete nested transactions; this provider does not parse CSV. For larger datasets, split only between complete transactions, keep the same stable source_system across every batch, and preview and explicitly confirm each plan sequentially. Commit an approved plan before submitting the next batch. Stable external IDs make repeated or resumed batches idempotent. source_system plus each generic external_id provides idempotency; this tool is not specific to GnuCash. Exact full account paths are resolved against the existing tree. Decimal amounts use established currency scales. Foreign line values are used to validate one consistent positive exchange rate per currency, and every transaction must balance in its valuation currency. The result lists unknown or ambiguous paths, rejected transactions, numerical create/reuse/reject counts, and summaries by status, currency, year, and top-level branch. A rejection-free result saves a durable owner-scoped plan and returns readyToCommit=true plus importPlanId. Report that preview before noting that ledger data was unchanged, then ask for approval. After approval call commit_transaction_import with only the plan ID; never replay the batch.`,
    inputSchema: {
      source_system: z.string().trim().min(1).max(32)
        .describe("Stable, source-neutral namespace for external IDs, such as an application or dataset name."),
      transactions: z.array(importedTransactionSchema).min(1).max(TRANSACTION_IMPORT_MAX_TRANSACTIONS),
      dry_run: z.literal(true).default(true)
        .describe("Validate the complete batch and save a durable confirmation plan without changing ledger data."),
    },
    outputSchema: transactionWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["list_accounts", "list_currencies"],
      attachmentHints: ["Submit the complete transaction batch on every preview retry."],
    }),
  }, async ({ source_system, transactions }) => safeWorkflowResult(async () => {
    const imported = transactionPreviewWorkflow(await accounting.previewTransactionImport({
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
    }));
    return withSchemaProjection(schemaSemantics, { ...imported, import: imported }, operations.importTransactions);
  }, { retryTool: "import_transactions", preserveEntireBatch: true }));

  server.registerTool("get_transaction_import_plan", {
    title: "Get transaction import plan",
    description: "Use to inspect a durable transaction-import plan across connections. A successful result proves whether the owner-scoped plan is ready, expired, invalidated, or committed and returns its preview binding and stored commit result.",
    inputSchema: { import_plan_id: z.string().trim().uuid() },
    outputSchema: transactionWorkflowOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ import_plan_id }) => safeWorkflowResult(async () =>
    withSchemaProjection(schemaSemantics,
      await accounting.getTransactionImportPlan({ pool, personId, importPlanId: import_plan_id }),
      operations.commitTransactionImport),
  { retryTool: "import_transactions", preserveEntireBatch: true }));

  server.registerTool("commit_transaction_import", {
    title: "Commit transaction import",
    description: "After the user explicitly approves a successful transaction dry run, commit that exact durable plan using only import_plan_id. The server revalidates account paths, currencies, scales, balance, exchange rates, and source-ID conflicts; then it atomically creates the planned batch and returns actual created/reused counts. Plans are owner-scoped and expiring, and repeated confirmation is idempotent.",
    inputSchema: {
      import_plan_id: z.string().trim().uuid().describe("importPlanId returned by import_transactions."),
    },
    outputSchema: transactionWorkflowOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["import_transactions"] }),
  }, async ({ import_plan_id }) => safeWorkflowResult(async () => {
    const imported = await accounting.commitTransactionImportPlan({ pool, personId, importPlanId: import_plan_id });
    return withSchemaProjection(schemaSemantics, {
      ...imported,
      import: imported,
      effectReceipt: effectReceipt("commit_transaction_import", { import_plan_id },
        imported.alreadyCommitted ? "unchanged" : "committed", [
          { type: "transaction_import_plan", id: import_plan_id },
        ]),
    }, operations.commitTransactionImport);
  }, { defaultStatus: "committed", retryTool: "import_transactions", preserveEntireBatch: true }));

  server.registerTool("list_balance_assertions", {
    title: "List balance assertions",
    description: "Use to inspect owner-scoped known end-of-day balances and ledger differences. A successful page proves the returned reconciliation comparisons at read time; follow nextCursor until complete.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: assertionListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.reconciliation"),
  }, async ({ limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listBalanceAssertionsPage(pool, personId, { limit, beforeAssertionId: cursor });
    return withSchemaProjection(schemaSemantics, {
      assertions: page.assertions,
      resultMetadata: pageMetadata(page.assertions, page.nextCursor, "balance-assertions"),
    }, operations.listBalanceAssertions);
  }));

  server.registerTool("save_balance_assertion", {
    title: "Save balance assertion",
    description: "Use to create or replace one known owner-scoped end-of-day native-unit balance. A successful result and receipt prove the assertion stored for the exact account and date and show its current ledger difference.",
    inputSchema: {
      account_id: positiveInteger("Account id owned by the token owner."),
      balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      known_balance_units: z.string().regex(/^-?\d+$/).describe("Signed integer native units in the account currency."),
    },
    outputSchema: assertionMutationOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.reconciliation", { dependencies: ["list_accounts"] }),
  }, async ({ account_id, balance_date, known_balance_units }) => safeToolResult(async () => {
    const args = { account_id, balance_date, known_balance_units };
    const assertion = await accounting.saveBalanceAssertion({
      personId,
      accountId: account_id,
      balanceDate: balance_date,
      knownBalanceUnits: known_balance_units,
    });
    return withSchemaProjection(schemaSemantics, {
      assertion,
      effectReceipt: effectReceipt("save_balance_assertion", args, "upserted", [
        { type: "balance_assertion", id: assertion.id },
      ]),
    }, operations.saveBalanceAssertion);
  }));

  server.registerTool("verify_ledger", {
    title: "Verify ledger",
    description: "Use to audit posted transactions against the central double-entry and exchange-rate invariants. A successful page proves the reported transactions were revalidated at read time; follow nextCursor until complete.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: ledgerVerificationOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ limit, cursor }) => safeToolResult(async () => {
    const report = await accounting.verifyPostedTransactionsPage(pool, personId, { limit, afterTransactionId: cursor });
    const resultMetadata = {
      complete: report.nextCursor == null,
      returned: report.checked,
      nextCursor: report.nextCursor,
      sourceRefs: report.checkedTransactionIds.map((id) => `accounting://transactions/${id}`),
    };
    const { nextCursor: _nextCursor, checkedTransactionIds: _checkedTransactionIds, ...result } = report;
    return withSchemaProjection(schemaSemantics, { ...result, resultMetadata }, operations.verifyLedger);
  }));

  return server;
}

export function mountAccountingMcp(app, {
  pool, artifactRoot, jsonBodyParser, artifactJsonBodyParser, artifactRawBodyParser,
}) {
  const authenticate = requireApiToken(pool);
  mountArtifactUploadRoutes(app, {
    artifactRoot,
    authenticate,
    jsonBodyParser: artifactJsonBodyParser,
    rawBodyParser: artifactRawBodyParser,
  });
  const handler = createAccountingMcpHandler({ pool, artifactRoot });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => console.error("Accounting MCP HTTP adapter error:", error),
  });

  app.all("/mcp", authenticate, jsonBodyParser, async (req, res) => {
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

export function createAccountingMcpHandler({ pool, artifactRoot }) {
  return createMcpHandler(
    (requestContext) => {
      const accountingAuth = requestContext.authInfo?.extra?.accountingAuth ?? {};
      const personId = Number(accountingAuth.personId);
      if (!Number.isInteger(personId) || personId <= 0) {
        throw new Error("Authenticated accounting user is required.");
      }
      return createAccountingMcpServer({ personId, pool, artifactRoot });
    },
    {
      legacy: "stateless",
      onerror: (error) => console.error("Accounting MCP protocol error:", error),
    },
  );
}
