import { createHash, randomUUID } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { requireApiToken } from "./api-tokens.js";
import {
  mountArtifactUploadRoutes,
  parseCanonicalStatementArtifact,
  readCompleteArtifact,
} from "./artifact-upload.js";
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
  accountingQuestionSchema,
  accountingCapabilityManifest,
  accountSchema,
  balanceAssertionSchema,
  CAPABILITY_MANIFEST_URI,
  currencySchema,
  effectReceiptSchema,
  makeRetryDescriptor,
  MCP_CONTRACT_VERSION,
  MCP_SERVER_VERSION,
  referenceRateArtifactUpload,
  referenceRateSchema,
  retryDescriptorSchema,
  resultMetadataSchema,
  SINGLE_ACCOUNT_STATEMENT_IMPORT_SCHEMA_URI,
  singleAccountStatementArtifactUpload,
  singleAccountStatementImportCanonicalJsonSchema,
  statementObservationAnalysisSchema,
  statementReconciliationContextSchema,
  structuredErrorSchema,
  successOutputSchema,
  toolMetadata,
  transactionImportArtifactUpload,
  transactionListItemSchema,
  transactionSearchItemSchema,
  transactionSchema,
} from "./mcp-contracts.js";
import { accountingToolDescriptions } from "./mcp-tool-descriptions.js";
import {
  accountObjectDescription,
  accountingQuestionObjectDescription,
  balanceAssertionObjectDescription,
  currencyObjectDescription,
  lineItemObjectDescription,
  transactionImportJobObjectDescription,
  transactionObjectDescription,
} from "./mcp-object-descriptions.js";
import {
  accountingQuestionObject,
  balanceAssertionObject,
  loadAccountObjectPaths,
  listLineItemObjectsPage,
  listTransactionObjectsPage,
  listTransactionImportJobObjectsPage,
} from "./accounting-objects.js";
import {
  accountingQuestionTags,
  getAccountingQuestion,
  listAccountingQuestionsPage,
  openAccountingQuestion,
  resolveAccountingQuestion,
} from "./accounting-questions.js";
import { previewSingleAccountStatementImport } from "./single-account-import.js";
import { reconcileAccountThroughDate } from "./account-reconciliation.js";
import { normalBalanceSign } from "./account-balances.js";
import { decimalToUnits, unitsToDecimal } from "./money.js";
import { databaseName } from "./db.js";
import { describeAccountingSchema } from "./schema-description.js";
import { commitTransactionImportPlan, getTransactionImportPlan, previewTransactionImport } from "./transaction-import.js";
import {
  commitTransactionImportJob,
  createTransactionImportJob,
  excludeTransactionImportException,
  getTransactionImportJob,
  listTransactionImportJobs,
  listTransactionImportExceptions,
  previewTransactionImportJob,
  retryTransactionImportException,
  stageTransactionImportArtifact,
  stageTransactionImportChunk,
  TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI,
  transactionImportCanonicalJsonSchema,
} from "./transaction-import-job.js";
import {
  createReferenceRates, getReferenceRate, importReferenceRatesArtifact,
  listReferenceRatesPage, referenceRateCanonicalJsonSchema,
  REFERENCE_RATE_BATCH_MAX, REFERENCE_RATE_INLINE_MAX,
} from "./reference-rates.js";
import { analyzeStatementObservations } from "./statement-analysis.js";
import { getStatementReconciliationContext } from "./statement-reconciliation.js";
import {
  TRANSACTION_IMPORT_MAX_LINE_ITEMS,
  TRANSACTION_IMPORT_MAX_TRANSACTIONS,
} from "./transaction-import-limits.js";
import { searchTransactionsPage } from "./transaction-search.js";

const readOnly = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const writesData = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const idempotentWrite = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const destructiveWrite = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });

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
  accounting_question: "questions",
  balance_assertion: "balance-assertions",
  currency: "currencies",
  reference_rate: "reference-rates",
  transaction: "transactions",
  transaction_delete_plan: "transaction-delete-plans",
  transaction_import_plan: "transaction-import-plans",
});

function entityUri({ type, id }) {
  return `accounting://${entityCollections[type] ?? type}/${encodeURIComponent(String(id))}`;
}

function accountPathContext(accounts, { includeArchived = false } = {}) {
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
  return accounts.filter((account) => includeArchived || account.archivedAt == null).map((account) => ({
    sourceRef: `accounting://accounts/${account.id}`,
    accountId: account.id,
    fullName: pathFor(account),
    accountType: account.type,
    currencyCode: account.currencyCode,
    placeholder: account.placeholder,
    suspense: account.suspense,
  }));
}

function accountObjectContext(accounts, pathAccounts = accounts) {
  const paths = new Map(accountPathContext(pathAccounts, { includeArchived: true })
    .map((item) => [item.accountId, item.fullName]));
  return accounts.map((account) => ({
    objectType: "accounting.account",
    id: account.id,
    sourceRef: `accounting://accounts/${account.id}`,
    displayName: paths.get(account.id) ?? account.name,
    parentAccountId: account.parentAccountId,
    accountType: account.type,
    currencyId: account.currencyId,
    currencyCode: account.currencyCode,
    scale: account.scale,
    postable: !account.placeholder && account.archivedAt == null,
    suspense: account.suspense,
    archived: account.archivedAt != null,
    actions: !account.placeholder && account.archivedAt == null ? [{
      id: "import_statement",
      label: "Import statement",
      tool: "start_single_account_statement_import",
    }] : [],
  }));
}

function currencyObject(currency) {
  return {
    objectType: "accounting.currency",
    id: currency.id,
    sourceRef: `accounting://currencies/${currency.id}`,
    displayName: currency.code === currency.displayName
      ? currency.code
      : `${currency.code} — ${currency.displayName}`,
    code: currency.code,
    currencyType: currency.type,
    scale: currency.scale,
    userDefined: currency.userDefined,
  };
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
    description: "Stable Accounting MCP reference for this result.",
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

async function accountTreePlanToolResult(work, { includeValidationRecovery = false } = {}) {
  try {
    return toolResult(await work());
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

function previousCalendarDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
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

export function createAccountingMcpServer({ personId, pool, artifactRoot, services = {} }) {
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
    loadAccountObjectPaths: services.loadAccountObjectPaths ?? loadAccountObjectPaths,
    getAccount: services.getAccount ?? getAccount,
    createAccount: services.createAccount ?? createAccount,
    updateAccount: services.updateAccount ?? updateAccount,
    previewAccountTreeImport: services.previewAccountTreeImport ?? services.importAccountTree ?? previewAccountTreeImport,
    commitAccountTreeImport: services.commitAccountTreeImport ?? commitAccountTreeImport,
    getAccountTreeImportPlan: services.getAccountTreeImportPlan ?? getAccountTreeImportPlan,
    listTransactions: services.listTransactions ?? listTransactions,
    listTransactionsPage: services.listTransactionsPage ?? (services.listTransactions ? injectedPage(services.listTransactions, "transactions") : listTransactionsPage),
    searchTransactionsPage: services.searchTransactionsPage ?? searchTransactionsPage,
    listTransactionObjectsPage: services.listTransactionObjectsPage ?? listTransactionObjectsPage,
    listLineItemObjectsPage: services.listLineItemObjectsPage ?? listLineItemObjectsPage,
    getTransaction: services.getTransaction ?? getTransaction,
    createTransaction: services.createTransaction ?? createTransaction,
    getAccountingQuestion: services.getAccountingQuestion ?? getAccountingQuestion,
    listAccountingQuestionsPage: services.listAccountingQuestionsPage ?? listAccountingQuestionsPage,
    openAccountingQuestion: services.openAccountingQuestion ?? openAccountingQuestion,
    resolveAccountingQuestion: services.resolveAccountingQuestion ?? resolveAccountingQuestion,
    previewSingleAccountStatementImport: services.previewSingleAccountStatementImport
      ?? previewSingleAccountStatementImport,
    readCompleteArtifact: services.readCompleteArtifact ?? readCompleteArtifact,
    reconcileAccountThroughDate: services.reconcileAccountThroughDate ?? reconcileAccountThroughDate,
    previewTransactionImport: services.previewTransactionImport ?? previewTransactionImport,
    getTransactionImportPlan: services.getTransactionImportPlan ?? getTransactionImportPlan,
    commitTransactionImportPlan: services.commitTransactionImportPlan ?? commitTransactionImportPlan,
    createTransactionImportJob: services.createTransactionImportJob ?? createTransactionImportJob,
    stageTransactionImportChunk: services.stageTransactionImportChunk ?? stageTransactionImportChunk,
    stageTransactionImportArtifact: services.stageTransactionImportArtifact ?? stageTransactionImportArtifact,
    retryTransactionImportException: services.retryTransactionImportException ?? retryTransactionImportException,
    excludeTransactionImportException: services.excludeTransactionImportException ?? excludeTransactionImportException,
    getTransactionImportJob: services.getTransactionImportJob ?? getTransactionImportJob,
    listTransactionImportJobs: services.listTransactionImportJobs ?? listTransactionImportJobs,
    listTransactionImportJobObjectsPage: services.listTransactionImportJobObjectsPage ?? listTransactionImportJobObjectsPage,
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
    getStatementReconciliationContext: services.getStatementReconciliationContext ?? getStatementReconciliationContext,
    analyzeStatementObservations: services.analyzeStatementObservations ?? analyzeStatementObservations,
    listReferenceRatesPage: services.listReferenceRatesPage ?? listReferenceRatesPage,
    getReferenceRate: services.getReferenceRate ?? getReferenceRate,
    createReferenceRates: services.createReferenceRates ?? createReferenceRates,
    importReferenceRatesArtifact: services.importReferenceRatesArtifact ?? importReferenceRatesArtifact,
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
  const registerTool = (name, definition, handler) => {
    const selection = accountingToolDescriptions[name];
    if (!selection) throw new Error(`Missing Accounting tool description: ${name}`);
    return server.registerTool(name, {
      ...definition,
      _meta: { ...definition._meta, "agent-slayer/selection": selection },
    }, handler);
  };

  server.registerResource("accounting-capability-manifest", CAPABILITY_MANIFEST_URI, {
    title: "Accounting capability manifest",
    description: "Versioned capabilities, dependencies, attachment guidance, and bounded context views for the Accounting MCP.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(accountingCapabilityManifest) }] }));

  server.registerResource("accounting-transaction-import-canonical-schema", TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI, {
    title: "Canonical transaction import line-record JSON Schema",
    description: "The exact authoritative JSON Schema accepted in canonical JSON Lines artifacts, inline JSON chunks, and exception retries.",
    mimeType: "application/schema+json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/schema+json",
    text: JSON.stringify(transactionImportCanonicalJsonSchema) }] }));

  server.registerResource("accounting-single-account-statement-import-canonical-schema",
    SINGLE_ACCOUNT_STATEMENT_IMPORT_SCHEMA_URI, {
      title: "Canonical single-account statement line-record JSON Schema",
      description: "The exact JSON Schema for each row in a complete single-account statement JSON Lines artifact.",
      mimeType: "application/schema+json",
    }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/schema+json",
      text: JSON.stringify(singleAccountStatementImportCanonicalJsonSchema) }] }));

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

  server.registerResource("accounting-account-objects", "accounting://context/objects/accounts", {
    title: "Accounting account objects",
    description: "First 500 owner-scoped account objects for agent object pickers; use list_account_objects for complete pagination.",
    mimeType: "application/json",
  }, async (uri) => {
    const page = await accounting.listAccountsPage(pool, personId, { limit: 500 });
    const pathAccounts = await accounting.loadAccountObjectPaths(pool, personId, page.accounts);
    const objects = accountObjectContext(page.accounts, pathAccounts);
    const value = {
      contractVersion: MCP_CONTRACT_VERSION,
      status: page.nextCursor == null ? "complete" : "partial",
      contextView: "accounting.objects.accounts",
      objects,
      summary: { ...pageMetadata(objects, page.nextCursor, "accounts"),
        sourceRefs: objects.map((item) => item.sourceRef) },
    };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
  });

  const entityResource = (uri, value) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }],
  });
  const resourceTemplate = (uri) => new ResourceTemplate(uri, { list: undefined });

  server.registerResource("accounting-currency", resourceTemplate("accounting://currencies/{currencyId}"), {
    title: "Accounting currency or unit",
    description: "One currently accessible global or owner-scoped accounting unit by stable Accounting ID.",
    mimeType: "application/json",
  }, async (uri, { currencyId }) => entityResource(uri, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    currency: await accounting.getCurrency(pool, personId, currencyId),
  }));

  server.registerResource("accounting-account", resourceTemplate("accounting://accounts/{accountId}"), {
    title: "Accounting account",
    description: "One current owner-scoped account and posted native-unit balance by stable Accounting ID.",
    mimeType: "application/json",
  }, async (uri, { accountId }) => entityResource(uri, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    account: await accounting.getAccount(pool, personId, accountId),
  }));

  server.registerResource("accounting-line-item", resourceTemplate("accounting://line-items/{lineItemId}"), {
    title: "Accounting line item",
    description: "One current owner-scoped transaction posting by stable Accounting line-item ID.",
    mimeType: "application/json",
  }, async (uri, { lineItemId }) => {
    const page = await accounting.listLineItemObjectsPage(pool, personId, { lineItemId: Number(lineItemId), limit: 1 });
    return entityResource(uri, {
      contractVersion: MCP_CONTRACT_VERSION,
      status: "success",
      lineItem: page.objects[0] ?? null,
    });
  });

  server.registerResource("accounting-transaction", resourceTemplate("accounting://transactions/{transactionId}"), {
    title: "Accounting transaction",
    description: "One current owner-scoped transaction with line amounts, valuation values, tags, and legacy transaction rates by stable Accounting ID.",
    mimeType: "application/json",
  }, async (uri, { transactionId }) => entityResource(uri, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    transaction: await accounting.getTransaction(pool, personId, transactionId),
  }));

  server.registerResource("accounting-question", resourceTemplate("accounting://questions/{lineItemId}"), {
    title: "Accounting classification question",
    description: "One durable open or resolved question identified by the posted suspense line it reclassifies.",
    mimeType: "application/json",
  }, async (uri, { lineItemId }) => entityResource(uri, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    question: await accounting.getAccountingQuestion(pool, personId, lineItemId),
  }));

  server.registerResource("accounting-balance-assertion", resourceTemplate("accounting://balance-assertions/{assertionId}"), {
    title: "Accounting balance assertion",
    description: "One current owner-scoped known-balance assertion and calculated ledger difference by stable Accounting ID.",
    mimeType: "application/json",
  }, async (uri, { assertionId }) => entityResource(uri, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    assertion: await accounting.getBalanceAssertion(pool, personId, assertionId),
  }));

  server.registerResource("accounting-reference-rate", resourceTemplate("accounting://reference-rates/{rateId}"), {
    title: "Accounting reference rate",
    description: "One owner-scoped timestamped reference price by stable Accounting ID.",
    mimeType: "application/json",
  }, async (uri, { rateId }) => entityResource(uri, {
    contractVersion: MCP_CONTRACT_VERSION,
    status: "success",
    referenceRate: await accounting.getReferenceRate(pool, personId, rateId),
  }));

  server.registerResource("accounting-account-tree-import-plan",
    resourceTemplate("accounting://account-tree-import-plans/{planId}"), {
      title: "Account-tree import plan",
      description: "Current owner-scoped status for one durable account-tree import plan.",
      mimeType: "application/json",
    }, async (uri, { planId }) => entityResource(uri, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...await accounting.getAccountTreeImportPlan({ pool, personId, importPlanId: planId }),
    }));

  server.registerResource("accounting-account-delete-plan",
    resourceTemplate("accounting://account-delete-plans/{planId}"), {
      title: "Account-deletion plan",
      description: "Current owner-scoped status for one durable verified account-deletion plan.",
      mimeType: "application/json",
    }, async (uri, { planId }) => entityResource(uri, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...await accounting.getAccountDeletionPlan({ pool, personId, deletionPlanId: planId }),
    }));

  server.registerResource("accounting-transaction-import-plan",
    resourceTemplate("accounting://transaction-import-plans/{planId}"), {
      title: "Transaction import plan",
      description: "Current owner-scoped status for one durable transaction-import plan.",
      mimeType: "application/json",
    }, async (uri, { planId }) => entityResource(uri, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...await accounting.getTransactionImportPlan({ pool, personId, importPlanId: planId }),
    }));

  server.registerResource("accounting-transaction-import-job",
    resourceTemplate("accounting://transaction-import-jobs/{jobId}"), {
      title: "Resumable transaction import job",
      description: "Current owner-scoped progress and lifecycle state for one logical source-file import.",
      mimeType: "application/json",
    }, async (uri, { jobId }) => entityResource(uri, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...await accounting.getTransactionImportJob({ pool, personId, importJobId: jobId }),
    }));

  server.registerResource("accounting-transaction-delete-plan",
    resourceTemplate("accounting://transaction-delete-plans/{planId}"), {
      title: "Transaction-deletion plan",
      description: "Current owner-scoped status for one exact permanent transaction-deletion plan.",
      mimeType: "application/json",
    }, async (uri, { planId }) => entityResource(uri, {
      contractVersion: MCP_CONTRACT_VERSION,
      ...transactionDeletionStatusRecovery(
        await accounting.getTransactionDeletionPlan({ pool, personId, deletionPlanId: planId }), planId),
    }));

  const schemaDescriptionOutput = successOutputSchema({
    request: z.string().min(1).describe("Exact schema question supplied by the caller."),
    tables: z.array(z.object({
      name: z.string().min(1).describe("MariaDB table name."),
      comment: z.string().describe("Current source-of-truth table COMMENT from MariaDB."),
      columns: z.array(z.object({
        name: z.string().min(1).describe("MariaDB column name."),
        type: z.string().min(1).describe("Current MariaDB COLUMN_TYPE."),
        nullable: z.boolean().describe("Whether MariaDB permits NULL in this column."),
        comment: z.string().describe("Current source-of-truth column COMMENT from MariaDB."),
      })).describe("Columns in stored order for the matched table."),
    })).describe("Accounting-owned tables matching the request; an empty array means no storage comment matched."),
  });
  const currencyListOutput = successOutputSchema({
    currencies: z.array(currencySchema), resultMetadata: resultMetadataSchema,
  });
  const currencyObjectOutput = successOutputSchema({
    objects: z.array(z.object({
      objectType: z.literal("accounting.currency"),
      id: z.number().int().positive(),
      sourceRef: z.string().min(1),
      displayName: z.string().min(1),
      code: z.string().min(1),
      currencyType: z.enum(["iso_4217", "crypto", "security", "commodity", "custom"]),
      scale: z.number().int().min(0).max(18),
      userDefined: z.boolean(),
    })),
    resultMetadata: resultMetadataSchema,
  });
  const currencyMutationOutput = successOutputSchema({
    currency: currencySchema, effectReceipt: effectReceiptSchema,
  });
  const accountListOutput = successOutputSchema({
    accounts: z.array(accountSchema), resultMetadata: resultMetadataSchema,
  });
  const accountObjectOutput = successOutputSchema({
    objects: z.array(z.object({
      objectType: z.literal("accounting.account").describe("First-class Accounting object type."),
      id: z.number().int().positive().describe("Stable owner-scoped account ID."),
      sourceRef: z.string().min(1).describe("Stable accounting://accounts/{id} reference for this account."),
      displayName: z.string().min(1).describe("Full account path in the user's chart of accounts."),
      parentAccountId: z.number().int().positive().nullable().describe("Parent account ID, or null for a root account."),
      accountType: z.enum(["asset", "liability", "equity", "income", "expense"])
        .describe("User-chosen accounting classification."),
      currencyId: z.number().int().positive().describe("Native accounting-unit ID of this account."),
      currencyCode: z.string().min(1).describe("Native accounting-unit code of this account."),
      scale: z.number().int().min(0).max(18).describe("Decimal places for native-unit amounts."),
      postable: z.boolean().describe("Whether this account currently accepts postings."),
      suspense: z.boolean().describe("Whether this account is the designated suspense account for its native currency."),
      archived: z.boolean().describe("Whether this account is archived."),
      actions: z.array(z.object({
        id: z.literal("import_statement"), label: z.literal("Import statement"),
        tool: z.literal("start_single_account_statement_import"),
      })).describe("Provider-declared actions available for this account object."),
    })).describe("Owner-scoped account objects returned by this page."),
    resultMetadata: resultMetadataSchema,
  });
  const transactionObjectOutput = successOutputSchema({
    objects: z.array(z.object({
      objectType: z.literal("accounting.transaction").describe("First-class transaction object type."),
      id: z.number().int().positive().describe("Stable owner-scoped transaction ID."),
      sourceRef: z.string().min(1).describe("Stable accounting://transactions/{id} reference."),
      displayName: z.string().min(1).describe("Compact date and transaction description."),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Accounting calendar date."),
      state: z.enum(["draft", "posted", "voided"]).describe("Transaction lifecycle state."),
      valuationCurrencyCode: z.string().min(1).describe("Currency in which transaction values balance."),
      accountIds: z.array(z.number().int().positive()).describe("Accounts receiving this transaction's postings."),
      matchedFields: z.array(z.string().min(1)).describe("Fields matched by the selected search filters."),
    })).describe("Owner-scoped transactions in this page."),
    resultMetadata: resultMetadataSchema,
  });
  const lineItemObjectOutput = successOutputSchema({
    objects: z.array(z.object({
      objectType: z.literal("accounting.line_item"),
      id: z.number().int().positive(),
      sourceRef: z.string().min(1),
      displayName: z.string().min(1),
      transactionId: z.number().int().positive(),
      accountId: z.number().int().positive(),
      accountFullName: z.string().min(1),
      transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      amountUnits: z.string().regex(/^-?\d+$/),
      currencyCode: z.string().min(1),
      memo: z.string().nullable(),
      reconciliationState: z.enum(["unreconciled", "cleared", "reconciled"]),
    })),
    resultMetadata: resultMetadataSchema,
  });
  const accountingQuestionObjectOutput = successOutputSchema({
    objects: z.array(z.object({
      objectType: z.literal("accounting.question").describe("First-class accounting question object type."),
      id: z.number().int().positive().describe("Stable ID of the suspense posting that carries this question."),
      sourceRef: z.string().min(1).describe("Stable accounting://questions/{id} reference."),
      displayName: z.string().min(1).describe("Compact transaction date and question prompt."),
      transactionId: z.number().int().positive().describe("Transaction containing the question's posting."),
      accountId: z.number().int().positive().describe("Account currently receiving the question's posting."),
      accountFullName: z.string().min(1).describe("Full current path of that account."),
      transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Accounting date of the transaction."),
      amountUnits: z.string().regex(/^-?\d+$/).describe("Signed amount in the posting account's native units."),
      currencyCode: z.string().min(1).describe("Native currency of the posting account."),
      status: z.enum(["open", "resolved"]).describe("Current question resolution state."),
      audience: z.string().min(1).describe("Person or role expected to answer the question."),
      prompt: z.string().min(1).describe("Complete stored question text."),
    })).describe("Owner-scoped accounting questions in this page."),
    resultMetadata: resultMetadataSchema,
  });
  const transactionImportJobObjectOutput = successOutputSchema({
    objects: z.array(z.object({
      objectType: z.literal("accounting.transaction_import_job").describe("First-class import-job object type."),
      id: z.string().uuid().describe("Stable provider-owned import-job ID."),
      sourceRef: z.string().min(1).describe("Stable accounting://transaction-import-jobs/{id} reference."),
      displayName: z.string().min(1).describe("Compact source name, creation date, and job state."),
      sourceSystem: z.string().min(1).describe("External-system namespace of the source records."),
      fileName: z.string().nullable().describe("Optional informational source filename."),
      jobStatus: z.enum(["receiving", "review_ready", "committed"]).describe("Current durable job state."),
      expectedRecordCount: z.number().int().nonnegative().describe("Total original source records expected."),
      createdAt: z.string().min(1).describe("UTC time the job was created."),
      updatedAt: z.string().min(1).describe("UTC time the job last changed."),
    })).describe("Owner-scoped import jobs in this page."),
    resultMetadata: resultMetadataSchema,
  });
  const balanceAssertionObjectOutput = successOutputSchema({
    objects: z.array(z.object({
      objectType: z.literal("accounting.balance_assertion").describe("First-class balance assertion object type."),
      id: z.number().int().positive().describe("Stable owner-scoped balance assertion ID."),
      sourceRef: z.string().min(1).describe("Stable accounting://balance-assertions/{id} reference."),
      displayName: z.string().min(1).describe("Compact date, account name, and known native-currency balance."),
      accountId: z.number().int().positive().describe("Account whose end-of-day balance was asserted."),
      accountName: z.string().min(1).describe("Current local name of that account."),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End-of-day accounting calendar date."),
      knownBalanceUnits: z.string().regex(/^-?\d+$/).describe("Signed known balance in the account's native units."),
      currencyCode: z.string().min(1).describe("Native accounting-unit code of the balance."),
      matches: z.boolean().describe("Whether the known and calculated ledger balances match at read time."),
    })).describe("Owner-scoped balance assertions in this page."),
    resultMetadata: resultMetadataSchema,
  });
  const accountCreateOutput = successOutputSchema({
    account: z.object({ id: z.number().int().positive() }),
    effectReceipt: effectReceiptSchema,
  });
  const accountUpdateOutput = successOutputSchema({
    account: z.object({ accountId: z.number().int().positive(), updated: z.literal(true) }),
    effectReceipt: effectReceiptSchema,
  });
  const transactionListOutput = successOutputSchema({
    transactions: z.array(transactionListItemSchema), resultMetadata: resultMetadataSchema,
  });
  const transactionSearchFiltersSchema = z.object({
    text: z.string().nullable(),
    accountId: z.number().int().positive().nullable(),
    includeAccountDescendants: z.boolean(),
    counterAccountId: z.number().int().positive().nullable(),
    includeCounterAccountDescendants: z.boolean(),
    date: z.string().nullable(),
    dateFrom: z.string().nullable(),
    dateTo: z.string().nullable(),
    amount: z.string().nullable(),
    amountTolerance: z.string().nullable(),
    minimumAmount: z.string().nullable(),
    maximumAmount: z.string().nullable(),
    amountSign: z.enum(["positive", "negative", "either"]),
    transactionId: z.number().int().positive().nullable(),
    externalId: z.string().nullable(),
    reference: z.string().nullable(),
    currencyCode: z.string().nullable(),
    source: z.string().nullable(),
    hasIssues: z.boolean().nullable(),
    sortBy: z.enum(["date", "amount", "description"]),
    sortDirection: z.enum(["asc", "desc"]),
  });
  const transactionSearchOutput = successOutputSchema({
    filters: transactionSearchFiltersSchema,
    transactions: z.array(transactionSearchItemSchema),
    totalMatches: z.number().int().nonnegative(),
    resultMetadata: resultMetadataSchema,
  });
  const transactionReadOutput = successOutputSchema({ transaction: transactionSchema });
  const transactionMutationOutput = successOutputSchema({
    transaction: z.object({
      transactionId: z.number().int().positive(),
      state: z.enum(["draft", "posted"]),
      validation: z.object({
        valid: z.literal(true),
        lineItemCount: z.number().int().min(1),
        valuationCurrencyId: z.number().int().positive(),
        foreignCurrencyIds: z.array(z.number().int().positive()),
      }),
    }),
    effectReceipt: effectReceiptSchema,
  });
  const accountingQuestionListOutput = successOutputSchema({
    questions: z.array(accountingQuestionSchema), resultMetadata: resultMetadataSchema,
  });
  const accountingQuestionMutationOutput = successOutputSchema({
    question: accountingQuestionSchema, changed: z.boolean().optional(),
    effectReceipt: effectReceiptSchema,
  });
  const accountReconciliationOutput = successOutputSchema({
    reconciliation: z.object({
      accountId: z.number().int().positive(), accountName: z.string().min(1),
      currencyId: z.number().int().positive(), currencyCode: z.string().min(1),
      scale: z.number().int().min(0).max(18), balanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      assertionId: z.number().int().positive(), knownBalanceUnits: z.string().regex(/^-?\d+$/),
      calculatedBalanceUnits: z.string().regex(/^-?\d+$/), matches: z.literal(true),
      totalLineCount: z.number().int().nonnegative(), newlyReconciledLineCount: z.number().int().nonnegative(),
      alreadyReconciledLineCount: z.number().int().nonnegative(),
    }),
    effectReceipt: effectReceiptSchema,
  });
  const assertionListOutput = successOutputSchema({
    assertions: z.array(balanceAssertionSchema), resultMetadata: resultMetadataSchema,
  });
  const assertionMutationOutput = successOutputSchema({
    assertion: balanceAssertionSchema,
    investigationQuestion: z.object({
      status: z.literal("needs_explanation"),
      prompt: z.string().min(1),
      accountId: z.number().int().positive(),
      balanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      unexplainedDifferenceUnits: z.string().regex(/^-?\d+$/),
      currencyCode: z.string().min(1),
      scale: z.number().int().min(0).max(18),
      nextTool: z.literal("get_statement_reconciliation_context"),
    }).nullable(),
    effectReceipt: effectReceiptSchema,
  });
  const statementReconciliationOutput = successOutputSchema({
    reconciliation: statementReconciliationContextSchema,
    resultMetadata: resultMetadataSchema,
  });
  const statementObservationAnalysisOutput = successOutputSchema({
    analysis: statementObservationAnalysisSchema,
    resultMetadata: resultMetadataSchema,
  });
  const singleAccountStatementGuideOutput = successOutputSchema({
    workflow: z.literal("single_account_statement"),
    workflowState: z.literal("instructions_only"),
    completionNote: z.string().min(1),
    account: z.object({
      objectType: z.literal("accounting.account"), id: z.number().int().positive(),
      sourceRef: z.string().min(1), displayName: z.string().min(1), currencyCode: z.string().min(1),
      scale: z.number().int().min(0).max(18),
    }),
    suspenseAccount: z.object({ id: z.number().int().positive(), sourceRef: z.string().min(1),
      displayName: z.string().min(1), currencyCode: z.string().min(1) }).nullable(),
    orderedQuestions: z.array(z.object({
      order: z.number().int().min(1).max(4), key: z.string().min(1), prompt: z.string().min(1),
      answerShape: z.json(),
    })).length(4),
    canonicalArtifactSchema: z.json(),
    artifactUpload: z.json(),
    nextTool: z.literal("import_single_account_statement_artifact"),
    inlineNextTool: z.literal("import_single_account_statement"),
    rules: z.array(z.string().min(1)),
  });
  const referenceRateListOutput = successOutputSchema({
    referenceRates: z.array(referenceRateSchema), resultMetadata: resultMetadataSchema,
  });
  const referenceRateMutationOutput = successOutputSchema({
    submittedCount: z.number().int().positive(), createdCount: z.number().int().nonnegative(),
    reusedCount: z.number().int().nonnegative(),
    roundedCount: z.number().int().nonnegative(),
    outcomeRuns: z.array(z.object({
      startIndex: z.number().int().nonnegative(), endIndex: z.number().int().nonnegative(),
      status: z.enum(["created", "reused"]),
    })),
    artifactSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    effectReceipt: effectReceiptSchema,
  });
  const ledgerVerificationOutput = successOutputSchema({
    valid: z.boolean(), checked: z.number().int().nonnegative(),
    failures: z.array(z.object({
      transactionId: z.number().int().positive(), code: z.string().min(1), message: z.string().min(1),
      details: z.json().optional(),
    })),
    resultMetadata: resultMetadataSchema,
  });
  const countMapSchema = z.record(z.string(), z.number().int().nonnegative());
  const importIssueSchema = z.object({ code: z.string().min(1), message: z.string().min(1), details: z.json().optional() });
  const transactionImportSummarySchema = z.object({
    transactionsCreated: z.number().int().nonnegative(), transactionsReused: z.number().int().nonnegative(),
    transactionsExcluded: z.number().int().nonnegative().optional(),
    lineItemsCreated: z.number().int().nonnegative(), lineItemsReused: z.number().int().nonnegative(),
    rejectedTransactions: z.number().int().nonnegative(),
  });
  const reconciliationValidationSchema = z.object({
    passed: z.boolean(),
    openingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    closingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    accounts: z.array(z.object({
      accountId: z.number().int().positive(), accountFullName: z.string().min(1),
      currencyCode: z.string().min(1), scale: z.number().int().min(0).max(18),
      requiredRemainingUnits: z.string().regex(/^-?\d+$/).nullable(),
      proposedNewLineItemUnits: z.string().regex(/^-?\d+$/),
      residualUnits: z.string().regex(/^-?\d+$/).nullable(), matches: z.boolean(),
    })),
    issues: z.array(importIssueSchema),
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
    excludedTransactionCount: z.number().int().nonnegative().optional(),
    rejectedLineItemCount: z.number().int().nonnegative(), unknownAccountPaths: z.array(z.string()),
    ambiguousAccountPaths: z.array(z.string()),
    transactionSummary: z.object({
      byStatus: z.object({ planned: z.number().int().nonnegative(), existing: z.number().int().nonnegative(),
        excluded: z.number().int().nonnegative().optional(), created: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative() }),
      byValuationCurrency: countMapSchema, byYear: countMapSchema,
    }),
    lineItemSummary: z.object({ byAccountCurrency: countMapSchema, byTopLevelBranch: countMapSchema }),
    questionSummary: z.object({
      openQuestionCount: z.number().int().nonnegative(),
      byAudience: countMapSchema,
      bySuspenseAccount: countMapSchema,
    }),
    transactions: z.array(z.object({
      externalId: z.string().min(1), transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      transactionAt: z.string().datetime().nullable(),
      description: z.string().nullable(), valuationCurrencyCode: z.string().min(1),
      lineItemCount: z.number().int().min(1), status: z.enum(["planned", "existing", "excluded", "created", "rejected"]),
      transactionId: z.number().int().positive().nullable(), errors: z.array(importIssueSchema),
      importDecision: z.object({
        externalId: z.string().min(1), decision: z.enum(["include", "exclude"]),
        confidence: z.string().nullable(), reason: z.string().nullable(), sourceRecordId: z.string().nullable(),
        matchedTransactionIds: z.array(z.number().int().positive()),
      }).optional(),
    })),
    expiresAt: z.string().datetime().optional(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    summary: transactionImportSummarySchema.optional(), committed: z.boolean().optional(), alreadyCommitted: z.boolean().optional(),
    reconciliationValidation: reconciliationValidationSchema.optional(),
    balanceAssertions: z.array(z.object({
      accountId: z.number().int().positive(), balanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      sourceKnownBalanceUnits: z.string().regex(/^-?\d+$/),
      storedKnownBalanceUnits: z.string().regex(/^-?\d+$/).nullable(),
      status: z.enum(["planned", "created", "preserved"]),
    })).optional(),
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
      effectReceipt: effectReceiptSchema.optional(),
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.enum(["ready", "expired", "invalidated", "committed"]),
      readyToCommit: z.boolean(), importPlanId: z.string().uuid(), expiresAt: z.string().datetime(),
      previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), summary: transactionImportSummarySchema,
      invalidationCode: z.string().min(1).optional(), alreadyCommitted: z.boolean().optional(),
      commitResult: transactionImportSchema.optional(),
    }),
    structuredErrorSchema,
  ]);
  const statementArtifactImportSchema = transactionImportSchema.omit({ transactions: true }).extend({
    transactions: transactionImportSchema.shape.transactions.optional(),
  });
  const statementArtifactWorkflowOutput = z.union([
    statementArtifactImportSchema.extend({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), import: statementArtifactImportSchema,
      effectReceipt: effectReceiptSchema.optional(),
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
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.enum(["ready", "expired", "invalidated"]),
      readyToCommit: z.boolean(), ...deletionIdentityShape, invalidationCode: z.string().min(1).optional(),
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.literal("committed"), readyToCommit: z.literal(false),
      ...deletionIdentityShape,
      deleted: z.object({ deleted: z.literal(true), accountId: z.number().int().positive(), name: z.string().min(1) }),
      verifiedAbsent: z.literal(true), alreadyCommitted: z.boolean(), effectReceipt: effectReceiptSchema.optional(),
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
  const transactionDeletionPreviewInputSchema = z.object({
    scope: z.enum(["all", "selected"]),
    transaction_ids: z.array(z.number().int().positive()).min(1).max(1000).optional(),
  }).strict().refine(
    (value) => value.scope === "selected" ? value.transaction_ids != null : value.transaction_ids == null,
    { message: "transaction_ids is required only when scope is selected." },
  );
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
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.literal("ready"),
      readyToCommit: z.literal(true), ...transactionDeletionIdentityShape,
    }),
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION), status: z.enum(["expired", "invalidated"]),
      readyToCommit: z.literal(false), ...transactionDeletionIdentityShape,
      invalidationCode: z.string().min(1).optional(),
      requiredAction: z.literal("RUN_NEW_DELETE_PREVIEW"), nextAction: transactionDeletionRecoverySchema,
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
      alreadyCommitted: z.boolean(), effectReceipt: effectReceiptSchema.optional(),
    }),
    structuredErrorSchema,
  ]);

  registerTool("describe_accounting_schema", {
    title: "Describe accounting schema",
    description: "Read live MariaDB table and column comments for the accounting domain when storage fields are unclear. Comments describe storage; the owning tools enforce access and business rules. This tool returns no ledger rows.",
    inputSchema: {
      request: z.string().trim().min(1).max(2000).describe("Natural-language description of the accounting data or operation to understand."),
    },
    outputSchema: schemaDescriptionOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.schema"),
  }, async ({ request }) => safeToolResult(async () =>
    (services.describeAccountingSchema ?? describeAccountingSchema)(pool, databaseName, request)));

  registerTool("list_currencies", {
    title: "List currencies",
    description: "Read the accessible currency catalog and native-unit scales for reporting. This result does not establish a first-class currency binding for another tool's numeric ID input; use list_currency_objects for that. Follow nextCursor until complete.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: currencyListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.currencies"),
  }, async ({ limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listCurrenciesPage(pool, personId, { limit, afterCurrencyId: cursor });
    return {
      currencies: page.currencies,
      resultMetadata: pageMetadata(page.currencies, page.nextCursor, "currencies"),
    };
  }));

  registerTool("list_currency_objects", {
    title: "List currency objects",
    description: "Return stable accessible accounting.currency objects. Omit currency_id to search the returned page with result_filter. Supply currency_id only to verify an exact user- or application-supplied accounting-unit ID. A missing exact unit returns an empty object list. Follow nextCursor until complete.",
    inputSchema: {
      currency_id: positiveInteger("Exact accessible accounting-unit ID to verify.").optional(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: currencyObjectOutput,
    annotations: readOnly,
    _meta: {
      ...toolMetadata("accounting.currencies", { objectInputs: [
        { path: "/currency_id", objectType: "accounting.currency", value: "id", allowUnbound: true },
      ] }),
      "agent-slayer/objects": currencyObjectDescription,
    },
  }, async ({ currency_id, limit, cursor }) => safeToolResult(async () => {
    let page;
    if (currency_id == null) {
      page = await accounting.listCurrenciesPage(pool, personId, { limit, afterCurrencyId: cursor });
    } else {
      try {
        page = { currencies: [await accounting.getCurrency(pool, personId, currency_id)], nextCursor: null };
      } catch (error) {
        if (error?.code !== "CURRENCY_NOT_FOUND") throw error;
        page = { currencies: [], nextCursor: null };
      }
    }
    const objects = page.currencies.map(currencyObject);
    return { objects, resultMetadata: {
      ...pageMetadata(objects, page.nextCursor, "currencies"),
      sourceRefs: objects.map((object) => object.sourceRef),
    } };
  }));

  registerTool("create_currency", {
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
    return {
      currency,
      effectReceipt: effectReceipt("create_currency", args, "created", [{ type: "currency", id: currency.id }]),
    };
  }));

  registerTool("list_accounts", {
    title: "List accounts",
    description: "Read the owner's chart of accounts and posted native-unit balances for reporting. This result does not establish a first-class account binding for another tool's account_id input; use list_account_objects for that. Follow nextCursor until complete.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: accountListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.accounts"),
  }, async ({ limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listAccountsPage(pool, personId, { limit, afterAccountId: cursor });
    return {
      accounts: page.accounts,
      resultMetadata: pageMetadata(page.accounts, page.nextCursor, "accounts"),
    };
  }));

  registerTool("list_account_objects", {
    title: "List account objects",
    description: "Return stable owner-scoped accounting.account objects for an agent's first-class object picker. Omit account_id to search the returned page with result_filter. Supply account_id only to verify an exact user- or application-supplied Accounting account ID; never substitute a user, currency, or conventional ID. A missing exact account returns an empty object list. Follow nextCursor until complete. Use returned IDs and sourceRefs to bind an uploaded statement to a candidate account; confirm the account with the user before committing an import.",
    inputSchema: {
      account_id: positiveInteger("Verify one exact user- or application-supplied owner-scoped Accounting account ID. Omit this field when searching by name.").optional(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: accountObjectOutput,
    annotations: readOnly,
    _meta: {
      ...toolMetadata("accounting.accounts", { attachmentHints: [
        "A statement attachment should carry a confirmed accounting.account sourceRef before import.",
      ], objectInputs: [
        { path: "/account_id", objectType: "accounting.account", value: "id", allowUnbound: true },
      ] }),
      "agent-slayer/objects": accountObjectDescription,
    },
  }, async ({ account_id, limit, cursor }) => safeToolResult(async () => {
    let page;
    if (account_id == null) {
      page = await accounting.listAccountsPage(pool, personId, { limit, afterAccountId: cursor });
    } else {
      try {
        page = { accounts: [await accounting.getAccount(pool, personId, account_id)], nextCursor: null };
      } catch (error) {
        if (error?.code !== "ACCOUNT_NOT_FOUND") throw error;
        page = { accounts: [], nextCursor: null };
      }
    }
    const pathAccounts = await accounting.loadAccountObjectPaths(pool, personId, page.accounts);
    const objects = accountObjectContext(page.accounts, pathAccounts);
    return {
      objects,
      resultMetadata: { ...pageMetadata(objects, page.nextCursor, "accounts"),
        sourceRefs: objects.map((item) => item.sourceRef) },
    };
  }));

  registerTool("create_account", {
    title: "Create account",
    description: "Use to create one owner-scoped account after every required accounting choice is known. A successful result and receipt prove creation of the returned account ID; no root, type, or currency is inferred.",
    inputSchema: {
      name: z.string().trim().min(1).describe("Human-facing account name."),
      description: z.string().trim().max(16000).nullable().optional(),
      placeholder: z.boolean().default(false).describe("Placeholder accounts organize the tree and cannot receive transactions or balance assertions."),
      suspense: z.boolean().default(false).describe("Mark this postable account as the one suspense account for its currency."),
      parent_account_id: positiveInteger("Optional parent account id owned by the same user.").nullable().optional(),
      account_type: z.enum(["asset", "liability", "equity", "income", "expense"]),
      currency_id: positiveInteger("Verified accounting-unit ID returned by list_currency_objects."),
    },
    outputSchema: accountCreateOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.accounts", {
      dependencies: ["list_currency_objects"],
      objectInputs: [
        { path: "/parent_account_id", objectType: "accounting.account", value: "id" },
        { path: "/currency_id", objectType: "accounting.currency", value: "id" },
      ],
    }),
  }, async ({ name, description, placeholder, suspense, parent_account_id, account_type, currency_id }) => safeToolResult(async () => {
    const args = { name, description, placeholder, suspense, parent_account_id, account_type, currency_id };
    const created = await accounting.createAccount({
      personId,
      name,
      description,
      placeholder,
      suspense,
      parentAccountId: parent_account_id,
      type: account_type,
      currencyId: currency_id,
    });
    return {
      account: created,
      effectReceipt: effectReceipt("create_account", args, "created", [{ type: "account", id: created.id }]),
    };
  }));

  registerTool("update_account", {
    title: "Update account",
    description: "Use to change one existing owner-scoped account. A successful result and receipt prove the named account was updated after parent-cycle, ownership, placeholder, currency, transaction, and balance-assertion checks.",
    inputSchema: {
      account_id: positiveInteger("Account id owned by the token owner."),
      name: z.string().trim().min(1),
      description: z.string().trim().max(16000).nullable().optional(),
      placeholder: z.boolean().default(false),
      suspense: z.boolean().optional().describe("Set or clear this account's suspense designation; omission preserves the current value."),
      parent_account_id: positiveInteger("Optional parent account id owned by the same user.").nullable().optional(),
      account_type: z.enum(["asset", "liability", "equity", "income", "expense"]),
      currency_id: positiveInteger("Verified accounting-unit ID returned by list_currency_objects."),
    },
    outputSchema: accountUpdateOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.accounts", {
      dependencies: ["list_account_objects", "list_currency_objects"],
      objectInputs: [
        { path: "/account_id", objectType: "accounting.account", value: "id" },
        { path: "/parent_account_id", objectType: "accounting.account", value: "id" },
        { path: "/currency_id", objectType: "accounting.currency", value: "id" },
      ],
    }),
  }, async (input) => safeToolResult(async () => {
    const updated = await accounting.updateAccount({
      personId,
      accountId: input.account_id,
      name: input.name,
      description: input.description,
      placeholder: input.placeholder,
      suspense: input.suspense,
      parentAccountId: input.parent_account_id,
      type: input.account_type,
      currencyId: input.currency_id,
    });
    return {
      account: updated,
      effectReceipt: effectReceipt("update_account", input, "updated", [{ type: "account", id: updated.accountId }]),
    };
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
  }), accountTreePlanFailureSchema]);
  const accountTreePlanStatusOutputSchema = z.union([
    z.object({ contractVersion: z.literal(MCP_CONTRACT_VERSION), readyToCommit: z.literal(true), status: z.literal("ready"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema }),
    z.object({ contractVersion: z.literal(MCP_CONTRACT_VERSION), readyToCommit: z.literal(false), status: z.literal("committed"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema, commitResult: accountTreeDetailedPreviewSchema }),
    z.object({ contractVersion: z.literal(MCP_CONTRACT_VERSION), readyToCommit: z.literal(false), status: z.literal("expired"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema }),
    z.object({ contractVersion: z.literal(MCP_CONTRACT_VERSION), readyToCommit: z.literal(false), status: z.literal("invalidated"), importPlanId: z.string().uuid(),
      expiresAt: z.string().datetime(), previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      summary: accountTreePlanSummarySchema, invalidationCode: z.string().min(1) }),
    accountTreePlanFailureSchema,
  ]);
  registerTool("import_account_tree", {
    title: "Preview account tree import",
    description: "Start or continue a complete account-tree import workflow. Call this tool with the entire intended batch even when new currency details or scales are unknown; omit unknown fields and the MCP will return status=needs_input, exact questions for the user, and a machine-readable retry instruction. Do not inspect historical receipts or guess missing values instead of calling this tool. Testing only previously blocked rows is partial validation and must be explicitly labeled incomplete. Use currency_type=security for mutual funds and stocks. A successful dry run saves the exact normalized input as a durable owner-scoped plan and returns status=ready, numerical created/reused summaries, and nextAction.onApproval containing the exact commit tool and plan ID. Present its one final confirmation question. After confirmation, call commit_account_tree_import once with that plan ID; never replay the large batch.",
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
  }, { includeValidationRecovery: true }));

  registerTool("get_account_tree_import_plan", {
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
  })));

  registerTool("commit_account_tree_import", {
    title: "Commit account tree import",
    description: "After the user confirms a successful account-tree dry run, commit that exact durable plan using only import_plan_id. The server revalidates current database state, imports all currencies and accounts atomically, scopes the plan to its owner, rejects expired plans, and returns the original stored result on repeated calls.",
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
    {},
  ));

  registerTool("preview_delete_account", {
    title: "Preview account deletion",
    description: "Use before deleting an account. A successful result proves the account was owner-scoped, empty, leaf-only, and unreferenced when checked, and returns a 15-minute opaque plan for explicit confirmation; it does not delete data.",
    inputSchema: { account_id: positiveInteger("Owner-scoped account id to verify for permanent deletion.") },
    outputSchema: accountDeletionWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.accounts", {
      dependencies: ["list_account_objects"],
      objectInputs: [{ path: "/account_id", objectType: "accounting.account", value: "id" }],
    }),
  }, async ({ account_id }) => safeWorkflowResult(async () => {
    const result = await accounting.previewAccountDeletion({ pool, personId, accountId: account_id });
    return {
      ...result,
      requiredAction: "REQUEST_USER_CONFIRMATION",
      nextAction: {
        type: "request_user_confirmation",
        instruction: `Permanently delete account ${result.summary.accountName}?`,
        onApproval: {
          tool: "commit_delete_account",
          arguments: { deletion_plan_id: result.deletionPlanId },
        },
      },
    };
  }, { defaultStatus: "ready", retryTool: "preview_delete_account", failureMapper: accountDeletePlanFailure }));

  registerTool("get_account_delete_plan", {
    title: "Get account deletion plan",
    description: "Use to inspect a durable account-deletion preview across connections. A successful result proves whether the owner-scoped plan is ready, expired, invalidated, or committed and returns the stored commit result when available.",
    inputSchema: { deletion_plan_id: z.string().trim().uuid() },
    outputSchema: accountDeletionWorkflowOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.accounts"),
  }, async ({ deletion_plan_id }) => safeWorkflowResult(async () =>
    await accounting.getAccountDeletionPlan({ pool, personId, deletionPlanId: deletion_plan_id }),
  { retryTool: "preview_delete_account", failureMapper: accountDeletePlanFailure }));

  registerTool("commit_delete_account", {
    title: "Commit account deletion",
    description: "Use only after the user confirms the exact preview. A successful committed result and receipt prove the plan was owner-scoped, unexpired, revalidated, deleted atomically, and verified absent; repeated calls return the stored result.",
    inputSchema: { deletion_plan_id: z.string().trim().uuid() },
    outputSchema: accountDeletionWorkflowOutput,
    annotations: destructiveWrite,
    _meta: toolMetadata("accounting.accounts", { dependencies: ["preview_delete_account"] }),
  }, async ({ deletion_plan_id }) => safeWorkflowResult(async () => {
    const result = await accounting.commitAccountDeletion({ pool, personId, deletionPlanId: deletion_plan_id });
    return {
      ...result,
      effectReceipt: effectReceipt("commit_delete_account", { deletion_plan_id },
        result.alreadyCommitted ? "unchanged" : "deleted", [
          { type: "account", id: result.deleted.accountId },
          { type: "account_delete_plan", id: deletion_plan_id },
        ]),
    };
  }, { defaultStatus: "committed", retryTool: "preview_delete_account", failureMapper: accountDeletePlanFailure }));

  registerTool("preview_delete_transactions", {
    title: "Preview permanent transaction deletion",
    description: "Required before permanently deleting transactions. scope=all freezes the exact current owner-scoped transaction IDs; it is never reinterpreted dynamically during commit. selected deletes only the supplied IDs. The durable 15-minute preview reports transaction, line-item, exchange-rate, tag-assignment, affected-account, state, and date totals, proves the account tree is outside the deletion scope, and requests explicit user confirmation. No ledger data is deleted by this tool.",
    inputSchema: transactionDeletionPreviewInputSchema,
    outputSchema: transactionDeletionWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["list_transaction_objects"],
      objectInputs: [{ path: "/transaction_ids/*", objectType: "accounting.transaction", value: "id" }],
    }),
  }, async ({ scope, transaction_ids }) => safeWorkflowResult(async () => {
    const result = await accounting.previewTransactionDeletion({ pool, personId, scope,
      transactionIds: transaction_ids ?? [] });
    return {
      ...result,
      requiredAction: "REQUEST_USER_CONFIRMATION",
      nextAction: {
        type: "request_user_confirmation",
        instruction: `Permanently delete exactly ${result.summary.transactionCount} transactions and ${result.summary.lineItemCount} line items? The account tree will remain unchanged.`,
        onApproval: { tool: "commit_delete_transactions",
          arguments: { deletion_plan_id: result.deletionPlanId, preview_digest: result.previewDigest } },
      },
    };
  }, { defaultStatus: "ready", retryTool: "preview_delete_transactions",
    failureMapper: transactionDeletePlanFailure }));

  registerTool("refresh_transaction_delete_plan", {
    title: "Refresh transaction-deletion plan",
    description: "Use only when a prior transaction-deletion plan expired or was invalidated. The MCP recovers the opaque owner-scoped selection, re-reads current ledger state, and creates a new 15-minute preview requiring fresh explicit confirmation. It never deletes ledger data.",
    inputSchema: { deletion_plan_id: z.string().trim().uuid() },
    outputSchema: transactionDeletionWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["preview_delete_transactions"] }),
  }, async ({ deletion_plan_id }) => safeWorkflowResult(async () => {
    const result = await accounting.refreshTransactionDeletionPlan({ pool, personId,
      deletionPlanId: deletion_plan_id });
    return {
      ...result,
      requiredAction: "REQUEST_USER_CONFIRMATION",
      nextAction: {
        type: "request_user_confirmation",
        instruction: `Permanently delete exactly ${result.summary.transactionCount} transactions and ${result.summary.lineItemCount} line items? The account tree will remain unchanged.`,
        onApproval: { tool: "commit_delete_transactions",
          arguments: { deletion_plan_id: result.deletionPlanId, preview_digest: result.previewDigest } },
      },
    };
  }, { defaultStatus: "ready", retryTool: "refresh_transaction_delete_plan",
    failureMapper: transactionDeletePlanFailure }));

  registerTool("get_transaction_delete_plan", {
    title: "Get transaction-deletion plan",
    description: "Recover a durable owner-scoped transaction-deletion preview across turns or connections. Returns its exact digest and bounded numerical summary, an exact MCP refresh action when expired or invalidated, or the original verified result after commit.",
    inputSchema: { deletion_plan_id: z.string().trim().uuid() },
    outputSchema: transactionDeletionWorkflowOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ deletion_plan_id }) => safeWorkflowResult(async () => {
    const result = await accounting.getTransactionDeletionPlan({ pool, personId, deletionPlanId: deletion_plan_id });
    return transactionDeletionStatusRecovery(result, deletion_plan_id);
  },
  { retryTool: "preview_delete_transactions", failureMapper: transactionDeletePlanFailure }));

  registerTool("commit_delete_transactions", {
    title: "Commit permanent transaction deletion",
    description: "Use only after the user confirms the exact preview. Accepts the opaque plan ID and matching preview digest, revalidates the frozen transaction contents and—for scope=all—the complete owner transaction set, blocks unplanned reversal references, deletes dependent tag assignments, line items, transaction rates, and exact transactions atomically, preserves accounts, updates resumable-import audit references, verifies absence and account-tree identity, and returns the stored result idempotently on retry.",
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
    return {
      ...result,
      effectReceipt: effectReceipt("commit_delete_transactions", { deletion_plan_id, preview_digest },
        result.alreadyCommitted ? "unchanged" : "deleted", [
          { type: "transaction_delete_plan", id: deletion_plan_id },
        ]),
    };
  }, { defaultStatus: "committed", retryTool: "preview_delete_transactions",
    failureMapper: transactionDeletePlanFailure }));

  const decimalAmount = z.string().trim().regex(/^\d+(?:\.\d{1,18})?$/)
    .describe("Nonnegative decimal magnitude with no more than 18 fractional digits.");
  registerTool("search_transactions", {
    title: "Search transactions",
    description: "Search complete owner-scoped ledger transactions deterministically. text is one case-insensitive substring search across transaction descriptions and source identifiers, line memos and source identifiers, full account paths and descriptions, tags, currencies, and linked import source/error text. Account and counter-account filters include descendants by default; when both are supplied they must match different postings. Amounts are decimal magnitudes of matching account postings: either sign matches by default, tolerance is inclusive around one amount, and minimum/maximum are inclusive. Use amount+tolerance or minimum/maximum, not both. date is exact and cannot be combined with date_from/date_to. has_issues refers only to retained import exception/error evidence actually linked to a ledger transaction. Results contain complete transactions, identify matching fields and postings, and use a filter-bound stable cursor.",
    inputSchema: {
      text: z.string().trim().min(1).max(16000).optional(),
      account_id: positiveInteger("Exact owner-scoped account id. Descendants are included by default.").optional(),
      include_account_descendants: z.boolean().default(true),
      counter_account_id: positiveInteger("Account id that must appear on another posting in the same transaction. Descendants are included by default.").optional(),
      include_counter_account_descendants: z.boolean().default(true),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      amount: decimalAmount.optional(),
      amount_tolerance: decimalAmount.default("0"),
      minimum_amount: decimalAmount.optional(),
      maximum_amount: decimalAmount.optional(),
      amount_sign: z.enum(["positive", "negative", "either"]).default("either"),
      transaction_id: positiveInteger("Exact internal transaction id.").optional(),
      external_id: z.string().trim().min(1).max(128).optional()
        .describe("Exact case-insensitive transaction or linked-import external id."),
      reference: z.string().trim().min(1).max(128).optional()
        .describe("Exact case-insensitive transaction or line source identifier, including an imported reference when stored there."),
      currency_code: z.string().trim().min(1).max(50).optional()
        .describe("Case-insensitive posting currency code; without an amount it may also match the valuation currency."),
      source: z.string().trim().min(1).max(255).optional()
        .describe("Exact case-insensitive source system, import job id, or source file name."),
      has_issues: z.boolean().optional(),
      sort_by: z.enum(["date", "amount", "description"]).default("date"),
      sort_direction: z.enum(["asc", "desc"]).default("desc"),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().trim().min(1).max(2048).nullable().optional(),
    },
    outputSchema: transactionSearchOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions", { objectInputs: [
      { path: "/account_id", objectType: "accounting.account", value: "id" },
      { path: "/counter_account_id", objectType: "accounting.account", value: "id" },
      { path: "/transaction_id", objectType: "accounting.transaction", value: "id" },
    ] }),
  }, async (input) => safeToolResult(async () => {
    const page = await accounting.searchTransactionsPage(pool, personId, {
      text: input.text,
      accountId: input.account_id,
      includeAccountDescendants: input.include_account_descendants,
      counterAccountId: input.counter_account_id,
      includeCounterAccountDescendants: input.include_counter_account_descendants,
      date: input.date,
      dateFrom: input.date_from,
      dateTo: input.date_to,
      amount: input.amount,
      amountTolerance: input.amount_tolerance,
      minimumAmount: input.minimum_amount,
      maximumAmount: input.maximum_amount,
      amountSign: input.amount_sign,
      transactionId: input.transaction_id,
      externalId: input.external_id,
      reference: input.reference,
      currencyCode: input.currency_code,
      source: input.source,
      hasIssues: input.has_issues,
      sortBy: input.sort_by,
      sortDirection: input.sort_direction,
      limit: input.limit,
      cursor: input.cursor,
    });
    return {
      filters: page.filters,
      transactions: page.transactions,
      totalMatches: page.totalMatches,
      resultMetadata: pageMetadata(page.transactions, page.nextCursor, "transactions"),
    };
  }));

  registerTool("list_transaction_objects", {
    title: "List transaction objects",
    description: "Find owner-scoped accounting.transaction objects by description, posting memo, account name, account ID, date range, or exact transaction ID. The compact result identifies real transactions and participating account IDs; call get_transaction for complete postings. An exact transaction_id cannot be combined with other filters. Follow nextCursor until complete.",
    inputSchema: {
      text: z.string().trim().min(1).max(255).optional()
        .describe("Case-insensitive text in transaction description, posting memo, or account name."),
      account_id: positiveInteger("Include transactions posting directly to this owner-scoped account.").optional(),
      date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      transaction_id: positiveInteger("Read one exact owner-scoped transaction object when known.").optional(),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: transactionObjectOutput,
    annotations: readOnly,
    _meta: {
      ...toolMetadata("accounting.transactions", { objectInputs: [
        { path: "/account_id", objectType: "accounting.account", value: "id" },
        { path: "/transaction_id", objectType: "accounting.transaction", value: "id", allowUnbound: true },
      ] }),
      "agent-slayer/objects": transactionObjectDescription,
    },
  }, async (input) => safeToolResult(async () => {
    const page = await accounting.listTransactionObjectsPage(pool, personId, {
      transactionId: input.transaction_id,
      text: input.text, accountId: input.account_id, dateFrom: input.date_from, dateTo: input.date_to,
      limit: input.limit, cursor: input.cursor,
    });
    return { objects: page.objects, resultMetadata: pageMetadata(page.objects, page.nextCursor, "transactions") };
  }));

  registerTool("list_line_item_objects", {
    title: "List line-item objects",
    description: "Find owner-scoped accounting.line_item posting objects by text, account, transaction, or exact line-item ID. Supply line_item_id without other filters to verify an exact user- or application-supplied posting ID. Follow nextCursor until complete.",
    inputSchema: {
      line_item_id: positiveInteger("Read one exact owner-scoped line-item object when known.").optional(),
      text: z.string().trim().min(1).max(255).optional(),
      account_id: positiveInteger("Include postings in this owner-scoped account.").optional(),
      transaction_id: positiveInteger("Include postings in this owner-scoped transaction.").optional(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: lineItemObjectOutput,
    annotations: readOnly,
    _meta: {
      ...toolMetadata("accounting.transactions", { objectInputs: [
        { path: "/line_item_id", objectType: "accounting.line_item", value: "id", allowUnbound: true },
        { path: "/account_id", objectType: "accounting.account", value: "id" },
        { path: "/transaction_id", objectType: "accounting.transaction", value: "id" },
      ] }),
      "agent-slayer/objects": lineItemObjectDescription,
    },
  }, async (input) => safeToolResult(async () => {
    const page = await accounting.listLineItemObjectsPage(pool, personId, {
      lineItemId: input.line_item_id,
      text: input.text,
      accountId: input.account_id,
      transactionId: input.transaction_id,
      limit: input.limit,
      cursor: input.cursor,
    });
    return { objects: page.objects,
      resultMetadata: pageMetadata(page.objects, page.nextCursor, "line-items") };
  }));

  registerTool("list_transactions", {
    title: "List transactions",
    description: "Read recent owner-scoped transactions newest first for reporting. This result does not establish a first-class transaction binding for another tool's transaction_id input; use list_transaction_objects for that. Follow nextCursor until complete.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: transactionListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listTransactionsPage(pool, personId, { limit, beforeTransactionId: cursor });
    return {
      transactions: page.transactions,
      resultMetadata: pageMetadata(page.transactions, page.nextCursor, "transactions"),
    };
  }));

  registerTool("get_transaction", {
    title: "Get transaction",
    description: "Use to inspect one transaction after its owner-scoped ID is known. A successful result proves the current header, line amounts and valuation values, tags, and any legacy transaction exchange rates.",
    inputSchema: { transaction_id: positiveInteger("Transaction id.") },
    outputSchema: transactionReadOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions", { objectInputs: [
      { path: "/transaction_id", objectType: "accounting.transaction", value: "id" },
    ] }),
  }, async ({ transaction_id }) => safeToolResult(async () => ({
    transaction: await accounting.getTransaction(pool, personId, transaction_id),
  })));

  const accountingQuestionInputSchema = z.object({
    audience: z.string().trim().min(1).max(50)
      .describe("Who should answer, such as accountant, human, user, or tax-advisor."),
    prompt: z.string().trim().min(1).max(16000)
      .describe("Concrete unresolved classification or evidence question."),
  }).strict();
  const lineItemSchema = z.object({
    account_id: positiveInteger("Account id owned by the token owner."),
    amount_units: z.string().regex(/^-?\d+$/).describe("Signed integer amount in the account currency's native units."),
    value_units: z.string().regex(/^-?\d+$/).optional()
      .describe("Signed value in valuation-currency units. Supply this for every foreign line; zero with a nonzero amount records a quantity-only adjustment without an exchange rate."),
    memo: z.string().trim().max(16000).nullable().optional(),
    source_id: z.string().trim().max(128).nullable().optional(),
    tags: z.array(z.object({
      key: z.string().trim().min(1).max(50)
        .refine((key) => !key.toLocaleLowerCase("en-US").startsWith("accounting.question."),
          "accounting.question.* tags are reserved; use the question field."),
      value: z.string().trim().min(1),
    })).optional(),
    question: accountingQuestionInputSchema.optional()
      .describe("Marks this posting line as unresolved while keeping the transaction balanced and posted."),
  });
  const rateSchema = z.object({
    from_units: z.string().regex(/^\d+$/).describe("Positive integer units in the source currency."),
    from_currency_id: positiveInteger("Source currency id."),
    to_units: z.string().regex(/^\d+$/).describe("Positive integer units in the valuation currency."),
    to_currency_id: positiveInteger("Must equal valuation_currency_id."),
  });
  registerTool("create_transaction", {
    title: "Create transaction",
    description: "Use to atomically create one complete double-entry transaction. Prefer a value_units field on every foreign line so each nonzero value can carry its own implied exchange rate; a nonzero amount with zero value is a quantity-only adjustment. When an exact known-balance residual has unknown classification, post its counterline to a user-selected ordinary suspense account of the same currency and add question metadata to that suspense line. rates remains available for legacy transaction-wide conversion. A successful result proves the owner-scoped accounts, currency, values, and exact balance were validated.",
    inputSchema: {
      description: z.string().trim().max(16000).nullable().optional(),
      transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar date in YYYY-MM-DD form."),
      transaction_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/).nullable().optional()
        .describe("Optional exact source event time in UTC ending in Z; independent of the accounting date."),
      valuation_currency_id: positiveInteger("Currency in which transaction balance is evaluated."),
      line_items: z.array(lineItemSchema).min(1),
      rates: z.array(rateSchema).optional(),
      post: z.boolean().default(true).describe("Post after validation; false leaves a validated draft."),
      source_system: z.string().trim().max(32).nullable().optional(),
      source_id: z.string().trim().max(128).nullable().optional(),
    },
    outputSchema: transactionMutationOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["list_account_objects", "list_currency_objects"],
      objectInputs: [
        { path: "/valuation_currency_id", objectType: "accounting.currency", value: "id" },
        { path: "/line_items/*/account_id", objectType: "accounting.account", value: "id" },
        { path: "/rates/*/from_currency_id", objectType: "accounting.currency", value: "id" },
        { path: "/rates/*/to_currency_id", objectType: "accounting.currency", value: "id" },
      ],
    }),
  }, async (input) => safeToolResult(async () => {
    if (!input.post && input.line_items.some((line) => line.question != null)) {
      throw Object.assign(new Error("Accounting questions require a posted transaction."), {
        status: 400, code: "QUESTION_LINE_NOT_POSTED",
      });
    }
    const created = await accounting.createTransaction({
      personId,
      description: input.description,
      transactionDate: input.transaction_date,
      transactionAt: input.transaction_at,
      valuationCurrencyId: input.valuation_currency_id,
      lineItems: input.line_items.map((line) => ({
        accountId: line.account_id,
        amountUnits: line.amount_units,
        valueUnits: line.value_units,
        memo: line.memo,
        sourceId: line.source_id,
        tags: [...(line.tags ?? []), ...accountingQuestionTags(line.question)],
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
    return {
      transaction: created,
      effectReceipt: effectReceipt("create_transaction", input, "created", [
        { type: "transaction", id: created.transactionId },
      ]),
    };
  }));

  registerTool("list_accounting_questions", {
    title: "List accounting questions",
    description: "Read suspense lines that are still waiting for a receipt, human decision, accountant review, or other classification. These are posted ledger lines, not failed imports: their statement-side amounts already contribute to the known balance. This result is for reporting; use list_accounting_question_objects to bind a question before supplying its lineItemId to another tool.",
    inputSchema: {
      status: z.enum(["open", "resolved"]).default("open"),
      audience: z.string().trim().min(1).max(50).nullable().optional(),
      account_id: positiveInteger("Optional suspense account id.").nullable().optional(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: accountingQuestionListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.reconciliation", { objectInputs: [
      { path: "/account_id", objectType: "accounting.account", value: "id" },
    ] }),
  }, async ({ status, audience, account_id, limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listAccountingQuestionsPage(pool, personId, {
      status, audience, accountId: account_id, limit, afterLineItemId: cursor,
    });
    return {
      questions: page.questions,
      resultMetadata: {
        complete: page.nextCursor == null,
        returned: page.questions.length,
        nextCursor: page.nextCursor,
        sourceRefs: page.questions.map((question) => `accounting://questions/${question.lineItemId}`),
      },
    };
  }));

  registerTool("list_accounting_question_objects", {
    title: "List accounting question objects",
    description: "Read owner-scoped accounting.question objects for posted suspense lines. line_item_id reads one exact question; otherwise query open or resolved questions separately and follow nextCursor until complete. Use the question reference to verify the exact posting before resolving it.",
    inputSchema: {
      line_item_id: positiveInteger("Read one exact owner-scoped question object when known.").optional(),
      status: z.enum(["open", "resolved"]).default("open"),
      audience: z.string().trim().min(1).max(50).nullable().optional(),
      account_id: positiveInteger("Optional suspense account ID.").nullable().optional(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: accountingQuestionObjectOutput,
    annotations: readOnly,
    _meta: {
      ...toolMetadata("accounting.reconciliation", { objectInputs: [
        { path: "/line_item_id", objectType: "accounting.question", value: "id", allowUnbound: true },
        { path: "/account_id", objectType: "accounting.account", value: "id" },
      ] }),
      "agent-slayer/objects": accountingQuestionObjectDescription,
    },
  }, async ({ line_item_id, status, audience, account_id, limit, cursor }) => safeToolResult(async () => {
    let page;
    if (line_item_id == null) {
      page = await accounting.listAccountingQuestionsPage(pool, personId, {
        status, audience, accountId: account_id, limit, afterLineItemId: cursor,
      });
    } else {
      try {
        page = { questions: [await accounting.getAccountingQuestion(pool, personId, line_item_id)], nextCursor: null };
      } catch (error) {
        if (error?.code !== "ACCOUNTING_QUESTION_NOT_FOUND") throw error;
        page = { questions: [], nextCursor: null };
      }
    }
    const objects = page.questions.map(accountingQuestionObject);
    return { objects, resultMetadata: {
      ...pageMetadata(objects, page.nextCursor, "questions"),
      sourceRefs: objects.map((object) => object.sourceRef),
    } };
  }));

  registerTool("open_accounting_question", {
    title: "Open accounting question",
    description: "Mark one existing posted suspense line as needing later classification. Use this to recover an older limbo line that was created without question metadata. The line and its transaction amounts are not changed.",
    inputSchema: {
      line_item_id: positiveInteger("Posted suspense line to track."),
      audience: z.string().trim().min(1).max(50),
      prompt: z.string().trim().min(1).max(16000),
    },
    outputSchema: accountingQuestionMutationOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["list_line_item_objects"],
      objectInputs: [{ path: "/line_item_id", objectType: "accounting.line_item", value: "id" }],
    }),
  }, async ({ line_item_id, audience, prompt }) => safeToolResult(async () => {
    const question = await accounting.openAccountingQuestion({
      pool, personId, lineItemId: line_item_id, audience, prompt,
    });
    return {
      question,
      effectReceipt: effectReceipt("open_accounting_question", { line_item_id, audience, prompt }, "upserted", [
        { type: "accounting_question", id: line_item_id },
        { type: "transaction", id: question.transactionId },
      ]),
    };
  }));

  registerTool("resolve_accounting_question", {
    title: "Assign accounting question",
    description: "Resolve one open question by moving only its suspense line to an active postable account of the same currency. The native amount and valuation value remain byte-for-byte unchanged, the original transaction stays balanced, and the known statement-account balance is not disturbed. If the evidence requires another currency or a changed amount/value, create a separately reviewed correcting transaction instead.",
    inputSchema: {
      line_item_id: positiveInteger("Stable question ID and suspense line item ID."),
      target_account_id: positiveInteger("Final active postable classification account with the same currency."),
      resolution: z.string().trim().max(16000).nullable().optional(),
    },
    outputSchema: accountingQuestionMutationOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["list_accounting_question_objects", "list_account_objects"],
      objectInputs: [
        { path: "/line_item_id", objectType: "accounting.question", value: "id" },
        { path: "/target_account_id", objectType: "accounting.account", value: "id" },
      ],
    }),
  }, async ({ line_item_id, target_account_id, resolution }) => safeToolResult(async () => {
    const resolved = await accounting.resolveAccountingQuestion({
      pool, personId, lineItemId: line_item_id, targetAccountId: target_account_id, resolution,
    });
    return {
      question: resolved.question,
      changed: resolved.changed,
      effectReceipt: effectReceipt("resolve_accounting_question", { line_item_id, target_account_id, resolution },
        resolved.changed ? "updated" : "unchanged", [
          { type: "accounting_question", id: line_item_id },
          { type: "transaction", id: resolved.question.transactionId },
          { type: "account", id: target_account_id },
        ]),
    };
  }));

  registerTool("start_single_account_statement_import", {
    title: "Read single-account statement requirements",
    description: "Canonical first call whenever an attachment lists dated movements for one bank, card, exchange, wallet, brokerage, or other account. A CSV transaction list and a request to bring one account to a known balance both qualify as a statement. Use this instead of get_transaction_import_schema or create_transaction_import_job. This read-only call returns the extraction requirements and canonical artifact schema; it does not start, save, or preview an import and must not be reported as completion. For an attachment, continue in the same request: transform every source row, upload the complete generated JSON Lines artifact, and call import_single_account_statement_artifact. Mark missing balances absent. Complete ingestion is internal; present a compact preview summary rather than every row unless the user asks. Do not guess counteraccounts.",
    inputSchema: {
      account_id: positiveInteger("The accounting.account object linked to the uploaded statement."),
    },
    outputSchema: singleAccountStatementGuideOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["list_account_objects"],
      attachmentHints: ["Attach exactly one statement and bind it to one confirmed accounting.account object."],
      objectInputs: [{ path: "/account_id", objectType: "accounting.account", value: "id" }],
    }),
  }, async ({ account_id }) => safeToolResult(async () => {
    const accounts = await accounting.listAccounts(pool, personId);
    const account = accounts.find((candidate) => candidate.id === account_id);
    if (!account) throw Object.assign(new Error("Statement account not found."), {
      status: 404, code: "ACCOUNT_NOT_FOUND",
    });
    const paths = new Map(accountPathContext(accounts, { includeArchived: true })
      .map((item) => [item.accountId, item.fullName]));
    const designated = accounts.find((candidate) => candidate.suspense && candidate.currencyId === account.currencyId
      && !candidate.placeholder && candidate.archivedAt == null);
    return {
      workflow: "single_account_statement",
      workflowState: "instructions_only",
      completionNote: "No import workflow or preview has been saved by this read-only call. Continue to the preview tool in the same request.",
      account: {
        objectType: "accounting.account", id: account.id, sourceRef: `accounting://accounts/${account.id}`,
        displayName: paths.get(account.id) ?? account.name, currencyCode: account.currencyCode, scale: account.scale,
      },
      suspenseAccount: designated == null ? null : {
        id: designated.id, sourceRef: `accounting://accounts/${designated.id}`,
        displayName: paths.get(designated.id) ?? designated.name, currencyCode: designated.currencyCode,
      },
      orderedQuestions: [
        { order: 1, key: "beginning_balance",
          prompt: "Does the statement contain a beginning balance and a date? Extract both exactly, then identify whether the printed date is the first included transaction date or an explicit end-of-day balance date. A beginning balance at the start of a period is normally the end-of-day balance immediately before the first included date.",
          answerShape: { found: "boolean", date: "YYYY-MM-DD or null",
            date_meaning: "first_included_transaction_date | explicit_end_of_day_balance_date | null",
            amount_decimal: "string or null", available_text: "string or null" } },
        { order: 2, key: "ending_balance",
          prompt: "Does the statement contain an ending balance with a date? If yes, extract the date and amount exactly as printed.",
          answerShape: { found: "boolean", date: "YYYY-MM-DD or null", amount_decimal: "string or null", available_text: "string or null" } },
        { order: 3, key: "line_items",
          prompt: "What are all line items into or out of this account? Extract each date and signed change to the statement balance; positive increases the displayed balance and negative decreases it.",
          answerShape: [{ source_record_id: "stable row id", transaction_date: "YYYY-MM-DD", amount_decimal: "signed string" }] },
        { order: 4, key: "available_text",
          prompt: "For every extracted line item, copy the available payee, description, memo, reference, or other transaction text from the document without inventing a category.",
          answerShape: [{ source_record_id: "same row id as question 3", available_text: "string or null" }] },
      ],
      canonicalArtifactSchema: singleAccountStatementImportCanonicalJsonSchema,
      artifactUpload: singleAccountStatementArtifactUpload,
      nextTool: "import_single_account_statement_artifact",
      inlineNextTool: "import_single_account_statement",
      rules: [
        "Use only evidence visible in this one statement.",
        "Do not guess the other side of any line item; Accounting places it in the designated same-currency suspense account.",
        "Preserve every printed amount and all useful transaction text.",
        "When the beginning date is the statement's first included date, Accounting records the balance on the previous calendar day. Use explicit_end_of_day_balance_date only when the document clearly gives the balance's end-of-day effective date.",
        "Opening and closing balances are optional. Record a dated balance when the source supplies one, then continue importing the transaction rows when either or both are absent.",
        "A previously saved known balance that still matches the recorded account balance is a verified checkpoint; rows on or before that date default to Imported exclude in the review.",
        "Accounting selects the one user-designated suspense account in this currency. If none is designated, mark an existing postable account with update_account before importing.",
        "The statement account and suspense account must be different accounts.",
      ],
    };
  }));

  const statementBalanceAnswerFields = {
    found: z.boolean(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    amount_decimal: z.string().trim().regex(/^[+-]?\d+(?:\.\d+)?$/).nullable(),
    available_text: z.string().trim().max(16000).nullable().optional(),
  };
  const beginningBalanceAnswerSchema = z.object({
    ...statementBalanceAnswerFields,
    date_meaning: z.enum(["first_included_transaction_date", "explicit_end_of_day_balance_date"]).nullable(),
  }).strict();
  const endingBalanceAnswerSchema = z.object(statementBalanceAnswerFields).strict();
  const oneSidedStatementLineSchema = z.object({
    source_record_id: z.string().trim().min(1).max(96)
      .describe("Stable row identifier within this statement; reuse it when the same attachment is processed again."),
    transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount_decimal: z.string().trim().regex(/^[+-]?\d+(?:\.\d+)?$/)
      .describe("Signed change to the displayed statement balance: positive increases it and negative decreases it."),
    available_text: z.string().trim().max(16000).nullable()
      .describe("All useful transaction text copied from the document, or null when the row has none."),
  }).strict();
  const oneSidedStatementLinesSchema = z.array(oneSidedStatementLineSchema)
    .min(1).max(TRANSACTION_IMPORT_MAX_TRANSACTIONS);
  const previewSingleAccountStatement = async ({ statement_id, account_id, suspense_account_id,
    beginning_balance, ending_balance, line_items }) => {
    const openingBalanceDate = beginning_balance.found && beginning_balance.date != null
      && beginning_balance.amount_decimal != null && beginning_balance.date_meaning != null
      ? (beginning_balance.date_meaning === "first_included_transaction_date"
        ? previousCalendarDate(beginning_balance.date) : beginning_balance.date) : null;
    const closingBalanceDate = ending_balance.found && ending_balance.date != null
      && ending_balance.amount_decimal != null ? ending_balance.date : null;
    const accounts = await accounting.listAccounts(pool, personId);
    const account = accounts.find((candidate) => candidate.id === account_id);
    if (!account) throw Object.assign(new Error("Statement account not found."), {
      status: 404, code: "ACCOUNT_NOT_FOUND",
    });
    const knownBalanceAssertions = [
      ...(openingBalanceDate == null || openingBalanceDate === closingBalanceDate ? []
        : [{ accountId: account_id, balanceDate: openingBalanceDate,
        knownBalanceUnits: decimalToUnits(beginning_balance.amount_decimal, account.scale) }]),
      ...(closingBalanceDate == null ? []
        : [{ accountId: account_id, balanceDate: closingBalanceDate,
          knownBalanceUnits: decimalToUnits(ending_balance.amount_decimal, account.scale) }]),
    ];
    const rows = line_items.map((line) => ({
      externalId: `sha256:${createHash("sha256").update(`${statement_id}\u0000${line.source_record_id}`, "utf8").digest("hex")}`,
      transactionDate: line.transaction_date, description: line.available_text,
      amountDecimal: unitsToDecimal(BigInt(decimalToUnits(line.amount_decimal, account.scale))
        * normalBalanceSign(account.type), account.scale),
    }));
    const analysis = await accounting.analyzeStatementObservations({
      pool, personId,
      openingBalanceDate: openingBalanceDate
        ?? previousCalendarDate(rows.map((line) => line.transactionDate).sort()[0]),
      closingBalanceDate: closingBalanceDate ?? rows.map((line) => line.transactionDate).sort().at(-1),
      knownBalanceAssertions,
      observations: rows.map((line, index) => ({
        sourceDocumentId: statement_id, sourceRecordId: line_items[index].source_record_id,
        accountId: account_id, transactionDate: line.transactionDate, amountDecimal: line.amountDecimal,
        description: line.description, reference: line.externalId,
      })),
    });
    const decisionsByObservation = new Map((analysis.importDecisions ?? analysis.observations.map((observation) => ({
      observationId: observation.id, decision: "include", confidence: "tentative",
      reason: "No conclusive duplicate evidence was found.", matchedTransactionIds: [],
    })))
      .map((decision) => [decision.observationId, decision]));
    const candidatesByObservation = new Map(analysis.duplicateAnalysis.ledgerCandidates
      .map((item) => [item.observationId, item.candidates]));
    const reviewedRows = rows.map((line, index) => {
      const observationId = analysis.observations[index].id;
      const decision = decisionsByObservation.get(observationId);
      const possible = candidatesByObservation.get(observationId) ?? [];
      const possibleTransactionIds = [...new Set(possible.map((candidate) => candidate.transactionId))];
      return { ...line, ...(decision?.decision === "include" && possibleTransactionIds.length ? {
        questionPrompt: `Review possible duplicate ledger transaction${possibleTransactionIds.length === 1 ? "" : "s"} ${possibleTransactionIds.join(", ")} for source row ${JSON.stringify(line_items[index].source_record_id)}. Confirm whether this is a distinct entry, then identify or match its other side.`,
      } : {}) };
    });
    const imported = transactionPreviewWorkflow(await accounting.previewSingleAccountStatementImport({
      pool, personId, sourceSystem: "single_account_statement", accountId: account_id,
      suspenseAccountId: suspense_account_id, valuationCurrencyCode: account.currencyCode,
      questionAudience: "human", lines: reviewedRows,
      knownBalanceAssertions,
      importReview: {
        accountId: account_id,
        statementId: statement_id,
        decisions: rows.map((line, index) => {
          const decision = decisionsByObservation.get(analysis.observations[index].id);
          return {
            externalId: line.externalId,
            decision: decision?.decision ?? "include",
            confidence: decision?.confidence ?? "tentative",
            reason: decision?.reason ?? "No conclusive duplicate evidence was found.",
            sourceRecordId: line_items[index].source_record_id,
            matchedTransactionIds: decision?.matchedTransactionIds ?? [],
          };
        }),
      },
    }));
    return { ...imported, import: imported };
  };
  const statementImportFailureOptions = (retryTool) => ({ retryTool, preserveEntireBatch: true,
    failureMapper: (error) => error?.code === "SUSPENSE_ACCOUNT_NOT_CONFIGURED"
      ? { requiredAction: "MARK_SUSPENSE_ACCOUNT" } : null });

  registerTool("import_single_account_statement", {
    title: "Preview inline single-account statement",
    description: "Submit the four answers from start_single_account_statement_import when the bounded line records are already present directly in the interaction. Accounting first marks rows through a matching known-balance checkpoint Imported exclude, then ranks exact amounts and tests small exclusions. It creates the balancing line in the designated suspense account. Balances are optional. Present compact counts, balance findings, exclusions, and open questions plus the exact confirmation question; do not enumerate every row unless the user asks. Do not run an LLM deduplication pass.",
    inputSchema: {
      statement_id: z.string().trim().min(1).max(128)
        .describe("Stable attachment identifier or SHA-256 supplied by the agent host; reuse it for the same file."),
      account_id: positiveInteger("The single authoritative statement account."),
      suspense_account_id: positiveInteger("Optional compatibility check; when supplied it must be the designated suspense account for this currency.").optional(),
      beginning_balance: beginningBalanceAnswerSchema,
      ending_balance: endingBalanceAnswerSchema,
      line_items: oneSidedStatementLinesSchema,
      dry_run: z.literal(true).default(true),
    },
    outputSchema: transactionWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["start_single_account_statement_import", "list_account_objects"],
      attachmentHints: ["Use this inline path only for bounded records already present directly in the interaction."],
      objectInputs: [
        { path: "/account_id", objectType: "accounting.account", value: "id" },
        { path: "/suspense_account_id", objectType: "accounting.account", value: "id" },
      ],
    }),
  }, async (answers) => safeWorkflowResult(
    () => previewSingleAccountStatement(answers), statementImportFailureOptions("import_single_account_statement"),
  ));

  registerTool("import_single_account_statement_artifact", {
    title: "Preview uploaded single-account statement",
    description: "Consume one complete, verified canonical JSON Lines artifact produced from the selected statement and create a fresh preview without copying every row into model context. Submit optional printed balances separately. Accounting performs known-balance checkpoint, duplicate, and small-exclusion analysis and creates designated suspense counterlines. Complete ingestion does not require a row dump in chat: present compact counts, balance findings, exclusions, and open questions plus the exact confirmation question. Row details remain available in the account register. Do not run an LLM deduplication pass.",
    inputSchema: {
      artifact_id: z.string().trim().uuid(),
      statement_id: z.string().trim().min(1).max(128)
        .describe("Stable original attachment identifier or SHA-256; reuse it for the same source statement."),
      account_id: positiveInteger("The single authoritative statement account."),
      suspense_account_id: positiveInteger("Optional compatibility check; when supplied it must be the designated suspense account for this currency.").optional(),
      beginning_balance: beginningBalanceAnswerSchema,
      ending_balance: endingBalanceAnswerSchema,
      include_row_details: z.boolean().default(false)
        .describe("Return row-level preview details only when the user explicitly asked to see them; otherwise return the compact summary."),
      dry_run: z.literal(true).default(true),
    },
    outputSchema: statementArtifactWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["start_single_account_statement_import", "list_account_objects"],
      attachmentHints: [
        "Transform the complete source to the canonical schema returned by start_single_account_statement_import, then upload that generated JSON Lines file.",
        "The artifact contains every source row for validation; the user-facing response should summarize the preview unless row details are requested.",
      ],
      artifactUpload: singleAccountStatementArtifactUpload,
      objectInputs: [
        { path: "/account_id", objectType: "accounting.account", value: "id" },
        { path: "/suspense_account_id", objectType: "accounting.account", value: "id" },
      ],
    }),
  }, async ({ artifact_id, include_row_details, ...answers }) => safeWorkflowResult(async () => {
    const uploaded = await accounting.readCompleteArtifact({ artifactRoot, personId, artifactId: artifact_id });
    const parsed = oneSidedStatementLinesSchema.safeParse(
      parseCanonicalStatementArtifact(uploaded.bytes, uploaded.artifact.media_type),
    );
    if (!parsed.success) throw Object.assign(new Error("The statement artifact does not match the canonical line schema."), {
      code: "INVALID_SINGLE_ACCOUNT_STATEMENT_ARTIFACT",
      details: parsed.error.issues,
    });
    const preview = await previewSingleAccountStatement({ ...answers, line_items: parsed.data });
    if (include_row_details) return preview;
    const { transactions: _transactions, import: fullImport, ...compactPreview } = preview;
    const { transactions: _importTransactions, ...compactImport } = fullImport;
    return { ...compactPreview, import: compactImport };
  }, statementImportFailureOptions("import_single_account_statement_artifact")));

  registerTool("reconcile_account_through_date", {
    title: "Reconcile account through known balance",
    description: "Mark only the selected account's posted lines reconciled through a statement closing date. The exact known-balance assertion for that account and date must already match the calculated posted balance. Suspense counterlines are in another account and remain open and unreconciled for later assignment.",
    inputSchema: {
      account_id: positiveInteger("Authoritative account to reconcile."),
      balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
    outputSchema: accountReconciliationOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["save_balance_assertion"],
      objectInputs: [{ path: "/account_id", objectType: "accounting.account", value: "id" }],
    }),
  }, async ({ account_id, balance_date }) => safeToolResult(async () => {
    const reconciliation = await accounting.reconcileAccountThroughDate({
      pool, personId, accountId: account_id, balanceDate: balance_date,
    });
    return {
      reconciliation,
      effectReceipt: effectReceipt("reconcile_account_through_date", { account_id, balance_date },
        reconciliation.newlyReconciledLineCount ? "updated" : "unchanged", [
          { type: "account", id: account_id },
          { type: "balance_assertion", id: reconciliation.assertionId },
        ]),
    };
  }));

  const canonicalImportRecordSchema = z.object({
    transaction_external_id: z.string().trim().min(1).max(128),
    line_external_id: z.string().trim().min(1).max(128).nullable().optional(),
    transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    transaction_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/).nullable().optional(),
    description: z.string().max(16000).nullable().optional(),
    valuation_currency_code: z.string().trim().min(1).max(50),
    fee_account_full_name: z.string().trim().min(1).max(4096).nullable().optional(),
    account_full_name: z.string().trim().min(1).max(4096),
    amount_decimal: z.string().trim().max(128).regex(/^[+-]?\d+(?:\.\d+)?$/),
    value_decimal: z.string().trim().max(128).regex(/^[+-]?\d+(?:\.\d+)?$/).nullable().optional(),
    memo: z.string().max(16000).nullable().optional(),
    question_audience: z.string().trim().min(1).max(50).nullable().optional(),
    question_prompt: z.string().trim().min(1).max(16000).nullable().optional(),
    reconciliation_state: z.enum(["unreconciled", "cleared"]).optional(),
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
    pending_commit_records: z.number().int().nonnegative(),
    previously_committed_records: z.number().int().nonnegative(),
    exception_record_totals: z.object({
      unresolved: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
    }),
    transaction_totals: z.object({
      staged: z.number().int().nonnegative(),
      pending_commit: z.number().int().nonnegative(),
      previously_committed: z.number().int().nonnegative(),
      reused: z.number().int().nonnegative(),
      exceptions: z.number().int().nonnegative(),
      unresolved_exceptions: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
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
      unresolved_exceptions: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
    }),
    line_items: z.object({
      created: z.number().int().nonnegative(),
      reused: z.number().int().nonnegative(),
      exceptions: z.number().int().nonnegative(),
      unresolved_exceptions: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
    }),
  });
  const transactionImportPreviewJobSchema = z.object({
    ...transactionImportJobIdentityShape,
    job_status: z.literal("review_ready"),
    progress: transactionImportProgressSchema,
    preview_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    ready_to_commit: z.boolean(),
    unresolved_exceptions: z.number().int().nonnegative(),
    excluded_exceptions: z.number().int().nonnegative(),
    user_outcome: z.object({
      import_status: z.literal("succeeded"),
      all_source_data_in_system: z.literal(true),
      source_records_imported: z.number().int().positive(),
      transactions_ready_for_ledger: z.number().int().nonnegative(),
      transactions_already_in_ledger: z.number().int().nonnegative(),
      transactions_in_import_misfits: z.number().int().nonnegative(),
    }),
    exception_handling: z.object({
      retained_in: z.literal("import_misfits"),
      retained_after_ledger_addition: z.literal(true),
      correctable_in_system: z.literal(true),
      list_with: z.object({
        tool: z.literal("list_transaction_import_exceptions"),
        arguments: z.object({ import_job_id: z.string().uuid() }),
      }),
      correct_with: z.object({
        tool: z.literal("retry_transaction_import_exception"),
        arguments: z.object({ import_job_id: z.string().uuid() }),
      }),
    }),
    commit_scope: z.string().min(1),
    requiredAction: z.enum(["REQUEST_USER_CONFIRMATION", "CORRECT_IMPORT_MISFITS", "NONE"]),
    nextAction: z.union([z.object({
      type: z.literal("request_user_confirmation"),
      instruction: z.string().min(1),
      onApproval: z.object({
        tool: z.literal("commit_transaction_import_job"),
        arguments: z.object({
          import_job_id: z.string().uuid(),
          preview_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        }),
      }),
    }), z.object({
      type: z.enum(["correct_import_misfits", "none"]),
      instruction: z.string().min(1),
    })]),
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

  registerTool("get_transaction_import_schema", {
    title: "Get canonical transaction import schema",
    description: "Generic import schema for sources that already supply enough account sides to assemble complete balanced transactions. Do not use it for a bank, card, exchange, wallet, brokerage, or other statement listing movements in one account, even when that statement is CSV or should reach a known balance; use start_single_account_statement_import for that case. For a qualifying generic source, return the exact authoritative draft-2020-12 JSON Schema and resumable artifact-upload contract. Group source rows into complete transactions by transaction_external_id. Preserve account quantities exactly and map source UTC time to transaction_at. Accounting selects the nearest owner-scoped reference rate in either direction and calculates each foreign line's signed valuation, rounded half-up to the valuation currency scale. A supplied source value is only a fallback when no rate exists. Preserve exact cash proceeds as a separate line and supply fee_account_full_name for Accounting to derive a cash-conversion residual fee.",
    inputSchema: {},
    outputSchema: transactionImportSchemaOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async () => safeToolResult(async () => ({
    schema_uri: TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI,
    canonical_schema: transactionImportCanonicalJsonSchema,
    artifact_upload: transactionImportArtifactUpload,
  })));

  registerTool("create_transaction_import_job", {
    title: "Create resumable transaction import job",
    description: "Create one durable logical import job for a source of complete balanced multi-account transactions. Do not create this job for a statement listing movements in one account; start_single_account_statement_import automatically supplies its designated suspense sides. For a qualifying generic source, source_file_sha256 and source_file_name identify the original source before transformation, not the generated canonical JSONL artifact; the artifact upload records its own checksum and name. client_request_id makes retries idempotent. All later chunks retain the returned import_job_id, source_system, original source-file identity, and expected count.",
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

  registerTool("stage_transaction_import_artifact", {
    title: "Stage a complete canonical transaction artifact",
    description: "Consume one completed, SHA-256-verified canonical artifact of complete balanced transactions without placing its records or transport chunks in model context. File-originated generic imports should use application/x-ndjson with one canonical line record per nonblank line. Before upload, group all account and counterpart lines for each transaction under the same transaction_external_id. A one-account source row alone cannot balance and belongs in start_single_account_statement_import, where Accounting supplies the designated suspense counterline automatically. The host uploads raw bytes through the advertised resumable artifact contract, then calls this tool with only import_job_id and artifact_id. Accounting waits for the complete artifact, binds it to the logical job, groups every record by transaction_external_id across the whole file, applies internal idempotent batches, owns all accounting validation and deduplication, checkpoints progress, and exposes isolated invalid transactions through list_transaction_import_exceptions.",
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      artifact_id: z.string().trim().uuid(),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["create_transaction_import_job"],
      artifactUpload: transactionImportArtifactUpload,
      objectInputs: [{ path: "/import_job_id", objectType: "accounting.transaction_import_job", value: "id" }],
    }),
  }, async ({ import_job_id, artifact_id }) => safeWorkflowResult(async () => ({
    job: await accounting.stageTransactionImportArtifact({ pool, artifactRoot, personId,
      importJobId: import_job_id, artifactId: artifact_id }),
  }), { retryTool: "stage_transaction_import_artifact" }));

  registerTool("stage_transaction_import_chunk", {
    title: "Stage canonical transaction records",
    description: `Ordinary inline-JSON path for bounded transactions created directly by the agent. File-originated or unusually large data must use the advertised artifact upload and stage_transaction_import_artifact so records and transport chunks do not enter model context. Each inline chunk may contain any number of complete transaction groups up to ${TRANSACTION_IMPORT_MAX_LINE_ITEMS.toLocaleString("en-US")} records; Accounting groups by transaction_external_id and owns all validation, deduplication, staging, and exceptions. A stable chunk_id makes an exact retry idempotent. Progress always reconciles expected_source_records = newly_staged_records + previously_staged_or_reused_records + exception_records + remaining_records.`,
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      chunk_id: z.string().trim().min(1).max(128),
      records: z.array(canonicalImportRecordSchema).min(1).max(TRANSACTION_IMPORT_MAX_LINE_ITEMS),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["create_transaction_import_job"],
      objectInputs: [{ path: "/import_job_id", objectType: "accounting.transaction_import_job", value: "id" }],
    }),
  }, async ({ import_job_id, chunk_id, records }) => safeWorkflowResult(async () => ({
    job: await accounting.stageTransactionImportChunk({ pool, personId, importJobId: import_job_id, chunkId: chunk_id, records }),
  }), { retryTool: "stage_transaction_import_chunk" }));

  registerTool("retry_transaction_import_exception", {
    title: "Retry one corrected import exception",
    description: "Replace and revalidate one isolated exception in an otherwise complete multi-account import. If every row of a one-account statement failed with TOO_FEW_LINE_ITEMS and UNBALANCED_TRANSACTION, stop repairing that generic job row by row and rerun the original attachment with start_single_account_statement_import followed by import_single_account_statement. For a qualifying isolated correction, records may add or remove accounting lines while Accounting preserves the original source-record count used by job reconciliation. Successful staged, committed, or reused transactions are not resubmitted or changed. The stable retry_id makes exact retries idempotent and transaction_external_id must remain unchanged.",
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      retry_id: z.string().trim().min(1).max(128),
      transaction_external_id: z.string().trim().min(1).max(128),
      records: z.array(canonicalImportRecordSchema).min(1).max(1000),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["stage_transaction_import_chunk"],
      objectInputs: [{ path: "/import_job_id", objectType: "accounting.transaction_import_job", value: "id" }],
    }),
  }, async ({ import_job_id, retry_id, transaction_external_id, records }) => safeWorkflowResult(async () => ({
      job: await accounting.retryTransactionImportException({ pool, personId, importJobId: import_job_id,
        retryId: retry_id, transactionExternalId: transaction_external_id, records }),
    }), { retryTool: "retry_transaction_import_exception" }));

  registerTool("exclude_transaction_import_exception", {
    title: "Explicitly exclude one import exception",
    description: "Record the user's explicit decision that one current source transaction should remain outside the ledger. The reason and decision time stay attached to the structured exception; the original source identity and canonical context are preserved. This may be used before or after earlier valid transactions were committed, invalidates the prior preview, and never changes successful transactions.",
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      exclusion_id: z.string().trim().min(1).max(110),
      transaction_external_id: z.string().trim().min(1).max(128),
      reason: z.string().trim().min(1).max(2000),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["list_transaction_import_exceptions"],
      objectInputs: [{ path: "/import_job_id", objectType: "accounting.transaction_import_job", value: "id" }],
    }),
  }, async ({ import_job_id, exclusion_id, transaction_external_id, reason }) => safeWorkflowResult(async () => ({
    job: await accounting.excludeTransactionImportException({ pool, personId, importJobId: import_job_id,
      exclusionId: exclusion_id, transactionExternalId: transaction_external_id, reason }),
  }), { retryTool: "exclude_transaction_import_exception" }));

  registerTool("list_transaction_import_jobs", {
    title: "List transaction import jobs",
    description: "Read this owner's recent durable transaction-import jobs with source identity, lifecycle status, pending commit totals, previously committed totals, unresolved exceptions, explicitly excluded exceptions, and the reconcilable source-record equation. Use list_transaction_import_job_objects to bind a job before supplying import_job_id to another tool.",
    inputSchema: { limit: z.number().int().min(1).max(500).default(100) },
    outputSchema: successOutputSchema({ jobs: z.array(z.json()) }),
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ limit }) => safeWorkflowResult(async () => ({
    jobs: await accounting.listTransactionImportJobs({ pool, personId, limit }),
  })));

  registerTool("list_transaction_import_job_objects", {
    title: "List transaction import job objects",
    description: "Read durable owner-scoped accounting.transaction_import_job objects directly from stored job identity and lifecycle fields. Filter by source system or filename, read one exact ID, or follow nextCursor until complete. Use get_transaction_import_job for full progress and exception details.",
    inputSchema: {
      import_job_id: z.string().uuid().optional().describe("Read one exact owner-scoped import job object when known."),
      text: z.string().trim().min(1).max(255).optional()
        .describe("Case-insensitive substring in source system or source filename."),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().uuid().nullable().optional(),
    },
    outputSchema: transactionImportJobObjectOutput,
    annotations: readOnly,
    _meta: {
      ...toolMetadata("accounting.transactions", { objectInputs: [
        { path: "/import_job_id", objectType: "accounting.transaction_import_job", value: "id", allowUnbound: true },
      ] }),
      "agent-slayer/objects": transactionImportJobObjectDescription,
    },
  }, async ({ import_job_id, text, limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listTransactionImportJobObjectsPage(pool, personId, {
      importJobId: import_job_id, text, limit, cursor,
    });
    return { objects: page.objects,
      resultMetadata: pageMetadata(page.objects, page.nextCursor, "transaction-import-jobs") };
  }));

  registerTool("get_transaction_import_job", {
    title: "Get transaction import job",
    description: "Read the durable owner-scoped state and reconcilable progress of one logical import job across connections, chunks, and retries.",
    inputSchema: { import_job_id: z.string().trim().uuid() },
    outputSchema: transactionImportJobOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions", { objectInputs: [
      { path: "/import_job_id", objectType: "accounting.transaction_import_job", value: "id" },
    ] }),
  }, async ({ import_job_id }) => safeWorkflowResult(async () => ({
    job: await accounting.getTransactionImportJob({ pool, personId, importJobId: import_job_id }),
  })));

  registerTool("list_transaction_import_exceptions", {
    title: "List transaction import exceptions",
    description: "Page through current invalid transactions, including explicit user exclusions. Every exception includes its unresolved or excluded resolution status, error codes, complete source identity, canonical records, and complete transaction context so only unresolved exceptions need to return to the LLM for correction.",
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().max(128).nullable().optional(),
    },
    outputSchema: transactionImportJobOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions", { objectInputs: [
      { path: "/import_job_id", objectType: "accounting.transaction_import_job", value: "id" },
    ] }),
  }, async ({ import_job_id, limit, cursor }) => safeWorkflowResult(async () => ({
    job: await accounting.listTransactionImportExceptions({ pool, personId, importJobId: import_job_id,
      limit, afterExternalId: cursor }),
  })));

  registerTool("preview_transaction_import_job", {
    title: "Create final transaction import preview",
    description: "After every source record is in Accounting, report separately how many transactions are ready to add to the ledger, already in the ledger, and held in Import misfits. Source ingestion does not mean ledger posting. Ask for confirmation to add ready transactions only when at least one is ready. When none is ready, direct correction of unresolved misfits without offering to add zero transactions.",
    inputSchema: { import_job_id: z.string().trim().uuid() },
    outputSchema: transactionImportPreviewOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["stage_transaction_import_chunk"],
      objectInputs: [{ path: "/import_job_id", objectType: "accounting.transaction_import_job", value: "id" }],
    }),
  }, async ({ import_job_id }) => safeWorkflowResult(async () => ({
    job: await accounting.previewTransactionImportJob({ pool, personId, importJobId: import_job_id }),
  }), { retryTool: "preview_transaction_import_job" }));

  registerTool("commit_transaction_import_job", {
    title: "Add imported transactions to the ledger",
    description: "After the user confirms, add the ready imported transactions to the ledger. All other imported data remains available in Import misfits for correction. Report Import succeeded and give the Import misfits correction path for every transaction that still needs attention. Do not expose internal commit, staging, or validation terminology to the user.",
    inputSchema: {
      import_job_id: z.string().trim().uuid(),
      preview_digest: z.string().trim().regex(/^sha256:[0-9a-f]{64}$/),
    },
    outputSchema: transactionImportJobOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["preview_transaction_import_job"],
      objectInputs: [{ path: "/import_job_id", objectType: "accounting.transaction_import_job", value: "id" }],
    }),
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
      .describe("Optional source value in the transaction valuation currency. Accounting replaces it with the nearest reference-rate valuation for a foreign line when a rate exists; supply it as fallback when no rate exists. Native-currency lines use their exact amount."),
    memo: z.string().trim().max(16000).nullable().optional(),
    question: accountingQuestionInputSchema.optional()
      .describe("Attach a durable unresolved question to this suspense line when exact statement movement is known but classification is not."),
    reconciliation_state: z.enum(["unreconciled", "cleared"]).default("unreconciled")
      .describe("Use cleared only when this exact line appears on the authoritative account statement."),
  });
  const importedTransactionSchema = z.object({
    external_id: z.string().trim().min(1).max(128)
      .describe("Stable transaction identifier within source_system. Group flat source rows by this generic identifier before submitting one nested transaction."),
    transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    transaction_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/).nullable().optional(),
    description: z.string().trim().max(16000).nullable().optional(),
    valuation_currency_code: z.string().trim().min(1).max(50),
    fee_account_full_name: z.string().trim().min(1).max(4096).nullable().optional(),
    line_items: z.array(importedLineItemSchema).min(1).max(1000),
  });
  registerTool("import_transactions", {
    title: "Preview transaction import",
    description: `Generic complete-transaction assembly workflow. Do not use this for initial intake of one account statement or a CSV listing movements in one account; start_single_account_statement_import and import_single_account_statement handle that case and add designated suspense counterlines. Validate and preview an atomic source-neutral batch of up to ${TRANSACTION_IMPORT_MAX_TRANSACTIONS} complete transactions and ${TRANSACTION_IMPORT_MAX_LINE_ITEMS.toLocaleString("en-US")} nested line items. The caller, normally the LLM, must parse source files and group flat rows into complete nested transactions; this MCP does not parse CSV. When multiple statements contain counterpart rows for the same transfer, call analyze_statement_observations and analyze all statements before submitting either side. Join the evidence into one complete transaction, use a stable composite external_id, and preserve each source row identifier on its corresponding line. Do not require sent and received native amounts to match: represent the difference as an explicit fee when the evidence supports it. For statement imports, reconciliation is optional and reports any difference between proposed movement and known balances without blocking a valid transaction plan. When exact opening and closing balances prove residual movement but its category remains unknown, use that exact balance-derived residual in a balanced transaction against a user-selected ordinary postable suspense account of the same currency, and add question metadata to the suspense line. This records uncertainty without pretending it came from a source row. For larger datasets, split only between complete transactions, keep the same stable source_system across every batch, and preview and confirm each plan sequentially. Commit a confirmed plan before submitting the next batch. Stable external IDs make repeated or resumed batches idempotent. source_system plus each generic external_id provides idempotency; this tool is not specific to GnuCash. Exact full account paths are resolved against the existing tree. Account-currency amounts retain their exact established scale. Accounting selects the nearest owner-scoped reference rate at transaction_at (or midnight UTC on transaction_date) in either currency direction and derives each foreign line valuation from its exact amount; a supplied source value is only a fallback when no rate exists. Keep exact matched cash consideration as its own native-currency line. When the reference-rate value and exact cash differ, Accounting derives the residual fee in fee_account_full_name, which must name an existing postable expense account in the valuation currency. An unmatched account side is never treated as a fee. A single-line nonzero quantity with explicit zero value remains a quantity-only adjustment only when no reference rate is available. The transaction must balance in its valuation currency. The result lists unknown or ambiguous paths, rejected transactions, numerical create/reuse/reject counts, and summaries by status, currency, year, and top-level branch. A rejection-free result saves a durable owner-scoped plan and returns readyToCommit=true plus importPlanId. Present the preview and its one final confirmation question. After confirmation call commit_transaction_import with only the plan ID; never replay the batch.`,
    inputSchema: {
      source_system: z.string().trim().min(1).max(32)
        .describe("Stable, source-neutral namespace for external IDs, such as an application or dataset name."),
      transactions: z.array(importedTransactionSchema).min(1).max(TRANSACTION_IMPORT_MAX_TRANSACTIONS),
      reconciliation: z.object({
        account_ids: z.array(positiveInteger("Statement-backed account to compare with known balances.")).min(1).max(25),
        opening_balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        closing_balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }).optional().describe("Optional native-unit balance comparison for statement imports."),
      dry_run: z.literal(true).default(true)
        .describe("Validate the complete batch and save a durable confirmation plan without changing ledger data."),
    },
    outputSchema: transactionWorkflowOutput,
    annotations: writesData,
    _meta: toolMetadata("accounting.transactions", {
      dependencies: ["list_account_objects", "list_currencies"],
      attachmentHints: ["Submit the complete transaction batch on every preview retry.",
        "For counterpart statements, finish cross-statement matching before importing either statement."],
      objectInputs: [{ path: "/reconciliation/account_ids/*", objectType: "accounting.account", value: "id" }],
    }),
  }, async ({ source_system, transactions, reconciliation }) => safeWorkflowResult(async () => {
    const imported = transactionPreviewWorkflow(await accounting.previewTransactionImport({
      pool,
      personId,
      sourceSystem: source_system,
      transactions: transactions.map((transaction) => ({
        externalId: transaction.external_id,
        transactionDate: transaction.transaction_date,
        transactionAt: transaction.transaction_at,
        description: transaction.description,
        valuationCurrencyCode: transaction.valuation_currency_code,
        feeAccountFullName: transaction.fee_account_full_name,
        lineItems: transaction.line_items.map((line) => ({
          externalId: line.external_id,
          accountFullName: line.account_full_name,
          amountDecimal: line.amount_decimal,
          valueDecimal: line.value_decimal,
          memo: line.memo,
          ...(line.question == null ? {} : { question: line.question }),
          reconciliationState: line.reconciliation_state,
        })),
      })),
      reconciliation: reconciliation == null ? null : {
        accountIds: reconciliation.account_ids,
        openingBalanceDate: reconciliation.opening_balance_date,
        closingBalanceDate: reconciliation.closing_balance_date,
      },
    }));
    return { ...imported, import: imported };
  }, { retryTool: "import_transactions", preserveEntireBatch: true }));

  registerTool("get_transaction_import_plan", {
    title: "Get transaction import plan",
    description: "Use to inspect a durable transaction-import plan across connections. A successful result proves whether the owner-scoped plan is ready, expired, invalidated, or committed and returns its preview binding and stored commit result.",
    inputSchema: { import_plan_id: z.string().trim().uuid() },
    outputSchema: transactionWorkflowOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.transactions"),
  }, async ({ import_plan_id }) => safeWorkflowResult(async () =>
    await accounting.getTransactionImportPlan({ pool, personId, importPlanId: import_plan_id }),
  { retryTool: "import_transactions", preserveEntireBatch: true }));

  registerTool("commit_transaction_import", {
    title: "Commit transaction import",
    description: "After the user confirms a successful transaction dry run, commit that exact durable plan using only import_plan_id. The server revalidates account paths, currencies, scales, per-line valuation values, balance, and source-ID conflicts; then it atomically creates the planned batch and returns actual created/reused counts. Plans are owner-scoped and expiring, and repeated calls are idempotent.",
    inputSchema: {
      import_plan_id: z.string().trim().uuid().describe("importPlanId returned by import_transactions."),
    },
    outputSchema: transactionWorkflowOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.transactions", { dependencies: ["import_transactions"] }),
  }, async ({ import_plan_id }) => safeWorkflowResult(async () => {
    const imported = await accounting.commitTransactionImportPlan({ pool, personId, importPlanId: import_plan_id });
    return {
      ...imported,
      import: imported,
      effectReceipt: effectReceipt("commit_transaction_import", { import_plan_id },
        imported.alreadyCommitted ? "unchanged" : "committed", [
          { type: "transaction_import_plan", id: import_plan_id },
        ]),
    };
  }, { defaultStatus: "committed", retryTool: "import_transactions", preserveEntireBatch: true }));

  registerTool("list_balance_assertions", {
    title: "List balance assertions",
    description: "Inspect owner-scoped known end-of-day balances and ledger differences for reporting. Use list_balance_assertion_objects to bind an assertion before supplying assertion_id to another tool. Follow nextCursor until complete.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: assertionListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.reconciliation"),
  }, async ({ limit, cursor }) => safeToolResult(async () => {
    const page = await accounting.listBalanceAssertionsPage(pool, personId, { limit, beforeAssertionId: cursor });
    return {
      assertions: page.assertions,
      resultMetadata: pageMetadata(page.assertions, page.nextCursor, "balance-assertions"),
    };
  }));

  registerTool("list_balance_assertion_objects", {
    title: "List balance assertion objects",
    description: "Read owner-scoped accounting.balance_assertion objects for dated known account balances. assertion_id reads one exact assertion; otherwise follow nextCursor until complete. The matches qualifier reflects the ledger at read time and can change after postings change.",
    inputSchema: {
      assertion_id: positiveInteger("Read one exact owner-scoped balance assertion object when known.").optional(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: balanceAssertionObjectOutput,
    annotations: readOnly,
    _meta: {
      ...toolMetadata("accounting.reconciliation", { objectInputs: [
        { path: "/assertion_id", objectType: "accounting.balance_assertion", value: "id", allowUnbound: true },
      ] }),
      "agent-slayer/objects": balanceAssertionObjectDescription,
    },
  }, async ({ assertion_id, limit, cursor }) => safeToolResult(async () => {
    let page;
    if (assertion_id == null) {
      page = await accounting.listBalanceAssertionsPage(pool, personId, { limit, beforeAssertionId: cursor });
    } else {
      try {
        page = { assertions: [await accounting.getBalanceAssertion(pool, personId, assertion_id)], nextCursor: null };
      } catch (error) {
        if (error?.code !== "BALANCE_ASSERTION_NOT_FOUND") throw error;
        page = { assertions: [], nextCursor: null };
      }
    }
    const objects = page.assertions.map(balanceAssertionObject);
    return { objects, resultMetadata: pageMetadata(objects, page.nextCursor, "balance-assertions") };
  }));

  registerTool("save_balance_assertion", {
    title: "Save balance assertion",
    description: "Use to create or replace one known owner-scoped end-of-day native-unit balance. A successful result and receipt prove the assertion stored for the exact account and date and show its current ledger difference. A mismatch returns a structured 'How did we get here?' investigation question; it does not silently create an adjustment. Pair opening and closing assertions in get_statement_reconciliation_context before choosing evidence-backed lines or an explicit question-bearing suspense adjustment.",
    inputSchema: {
      account_id: positiveInteger("Account id owned by the token owner."),
      balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      known_balance_units: z.string().regex(/^-?\d+$/).describe("Signed integer native units in the account currency."),
    },
    outputSchema: assertionMutationOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["list_account_objects"],
      objectInputs: [{ path: "/account_id", objectType: "accounting.account", value: "id" }],
    }),
  }, async ({ account_id, balance_date, known_balance_units }) => safeToolResult(async () => {
    const args = { account_id, balance_date, known_balance_units };
    const assertion = await accounting.saveBalanceAssertion({
      personId,
      accountId: account_id,
      balanceDate: balance_date,
      knownBalanceUnits: known_balance_units,
    });
    return {
      assertion,
      investigationQuestion: assertion.matches ? null : {
        status: "needs_explanation",
        prompt: `How did ${assertion.accountName} reach its known ${assertion.currencyCode} balance on ${assertion.date}? Explain the ${assertion.differenceUnits}-unit difference using source evidence or an explicitly labeled suspense adjustment.`,
        accountId: assertion.accountId,
        balanceDate: assertion.date,
        unexplainedDifferenceUnits: assertion.differenceUnits,
        currencyCode: assertion.currencyCode,
        scale: assertion.scale,
        nextTool: "get_statement_reconciliation_context",
      },
      effectReceipt: effectReceipt("save_balance_assertion", args, "upserted", [
        { type: "balance_assertion", id: assertion.id },
      ]),
    };
  }));

  registerTool("get_statement_reconciliation_context", {
    title: "Ground a multi-statement reconciliation",
    description: "Read known balance and movement context for a selected interval. Opening and closing assertions may be missing; when both exist, the result reports required movement and remaining movement. Analyze related statements together; match counterpart rows by provider ID, transaction hash, timestamp, direction, and quantity even when network fees make sent and received quantities differ. Preserve actual statement quantities, use one valuation currency, value foreign lines at transaction time, and separate explicit fees from inferred spread or margin. A nonzero residual invites review for missing or misclassified evidence but does not block transaction import.",
    inputSchema: {
      account_ids: z.array(positiveInteger("Owner-scoped postable account to inspect.")).min(1).max(25),
      opening_balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End-of-day date immediately before the imported interval; an assertion need not exist."),
      closing_balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End-of-day date at the end of the imported interval; an assertion need not exist."),
    },
    outputSchema: statementReconciliationOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["list_account_objects", "list_balance_assertions"],
      attachmentHints: ["Inspect all statements in the reconciliation set before mapping either side of a transfer."],
      objectInputs: [{ path: "/account_ids/*", objectType: "accounting.account", value: "id" }],
    }),
  }, async ({ account_ids, opening_balance_date, closing_balance_date }) => safeToolResult(async () => {
    const reconciliation = await accounting.getStatementReconciliationContext({
        pool, personId, accountIds: account_ids, openingBalanceDate: opening_balance_date,
        closingBalanceDate: closing_balance_date,
      });
    return {
      reconciliation,
      resultMetadata: { complete: true, returned: reconciliation.evidenceRefs.length,
        nextCursor: null, sourceRefs: reconciliation.evidenceRefs },
    };
  }));

  registerTool("analyze_statement_observations", {
    title: "Analyze extracted statement observations",
    description: "Analyze format-neutral statement rows. The latest matching known-balance checkpoint makes rows on or before it default to exclude. Then Accounting ranks stable references, exact amounts within two days, transfer candidates, and small exclusion combinations against known balances. It returns reviewable include/exclude decisions; missing or mismatched balances do not block import.",
    inputSchema: {
      opening_balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End-of-day date immediately before the first included transaction; an assertion need not exist."),
      closing_balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End-of-day date at or after the last included transaction; an assertion need not exist."),
      observations: z.array(z.object({
        source_document_id: z.string().trim().min(1).max(128)
          .describe("Stable file hash, attachment ID, or screenshot ID. Reuse it when reprocessing the same source."),
        source_record_id: z.string().trim().min(1).max(128)
          .describe("Stable row, transaction, or image-region ID within the source document."),
        account_id: positiveInteger("Statement-backed owner-scoped account."),
        transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        occurred_at: z.string().datetime({ offset: false }).nullable().optional()
          .describe("Exact UTC timestamp when visible; null when the source shows only a date."),
        amount_decimal: z.string().trim().regex(/^[+-]?\d+(?:\.\d+)?$/).max(128)
          .describe("Actual signed native-currency amount visible in the source: into an asset is positive and out is negative."),
        description: z.string().max(16000).nullable().optional(),
        reference: z.string().trim().min(1).max(128).nullable().optional()
          .describe("Provider transaction ID, blockchain hash, or other stable source reference when visible. Do not invent one."),
      })).min(1).max(500),
    },
    outputSchema: statementObservationAnalysisOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["get_statement_reconciliation_context"],
      attachmentHints: ["Extract visible facts from any format into observations; keep document and record identities stable across retries."],
      objectInputs: [{ path: "/observations/*/account_id", objectType: "accounting.account", value: "id" }],
    }),
  }, async ({ opening_balance_date, closing_balance_date, observations }) => safeToolResult(async () => {
    const analysis = await accounting.analyzeStatementObservations({
      pool, personId, openingBalanceDate: opening_balance_date, closingBalanceDate: closing_balance_date,
      observations: observations.map((item) => ({
        sourceDocumentId: item.source_document_id, sourceRecordId: item.source_record_id,
        accountId: item.account_id, transactionDate: item.transaction_date, occurredAt: item.occurred_at,
        amountDecimal: item.amount_decimal, description: item.description, reference: item.reference,
      })),
    });
    const sourceRefs = [...new Set([
      ...analysis.reconciliation.evidenceRefs,
      ...analysis.duplicateAnalysis.ledgerCandidates.flatMap((item) =>
        item.candidates.map((candidate) => `accounting://transactions/${candidate.transactionId}`)),
    ])];
    return {
      analysis,
      resultMetadata: { complete: true, returned: sourceRefs.length, nextCursor: null, sourceRefs },
    };
  }));

  registerTool("list_reference_rates", {
    title: "List timestamped reference rates",
    description: "Read owner-scoped timestamped reference prices as positive native-unit ratios for inspection and audit. Transaction import automatically chooses the nearest rate in either currency direction and derives each foreign line's signed valuation from its exact account-currency quantity. A rate is a unit price, not a line value; cash proceeds remain exact separate lines, and valuation residuals become fees only when an exact cash counterpart and expense fee account are supplied. Never let a price replace an account's actual statement quantity.",
    inputSchema: {
      from_currency_id: positiveInteger("Optional source currency or asset.").optional(),
      to_currency_id: positiveInteger("Optional valuation currency.").optional(),
      valid_at_from: z.string().datetime({ offset: false }).optional(),
      valid_at_to: z.string().datetime({ offset: false }).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^\d+$/).nullable().optional(),
    },
    outputSchema: referenceRateListOutput,
    annotations: readOnly,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["list_currency_objects"],
      objectInputs: [
        { path: "/from_currency_id", objectType: "accounting.currency", value: "id" },
        { path: "/to_currency_id", objectType: "accounting.currency", value: "id" },
      ],
    }),
  }, async ({ from_currency_id, to_currency_id, valid_at_from, valid_at_to, limit, cursor }) =>
    safeToolResult(async () => {
      const page = await accounting.listReferenceRatesPage(pool, personId, {
        fromCurrencyId: from_currency_id, toCurrencyId: to_currency_id,
        validAtFrom: valid_at_from, validAtTo: valid_at_to, limit, beforeRateId: cursor,
      });
      return {
        referenceRates: page.rates,
        resultMetadata: pageMetadata(page.rates, page.nextCursor, "reference-rates"),
      };
    }));

  registerTool("get_reference_rate_import_schema", {
    title: "Get reference rate import schema",
    description: "Read the authoritative JSON Schema for one canonical reference-rate record. For a dated price file, use file_table_transform to create application/x-ndjson without putting every row in model context; map source_record_number for error correlation. For OHLC historical bars, use close as the price unless the user or source specifies another measure. A date-only valid_at means 00:00:00 UTC on that date. from_decimal and to_decimal are positive quantities in the currencies' displayed units; for a USD price of one BTC, use from_decimal=1 and to_decimal equal to the USD close price. Accounting converts to native units and rounds the target price half-up to its currency scale (cents for USD), reporting roundedCount. The transform's exceptions file retains invalid or blank source rows for reporting.",
    inputSchema: {},
    outputSchema: successOutputSchema({
      canonical_schema: z.json(), artifact_upload: z.json(), maximum_records: z.number().int().positive(),
    }),
    annotations: readOnly,
    _meta: toolMetadata("accounting.reconciliation"),
  }, async () => safeToolResult(async () => ({
    canonical_schema: referenceRateCanonicalJsonSchema,
    artifact_upload: referenceRateArtifactUpload,
    maximum_records: REFERENCE_RATE_BATCH_MAX,
  })));

  const referenceRateItemInput = z.object({
    valid_at: z.string().describe("UTC ISO timestamp ending in Z, or YYYY-MM-DD for midnight UTC."),
    from_currency_id: positiveInteger("Source currency or asset."),
    to_currency_id: positiveInteger("Target valuation currency."),
    from_decimal: z.string().max(256).regex(/^\d+(?:\.\d+)?$/)
      .describe("Positive source quantity in displayed currency units; usually 1 for a daily price."),
    to_decimal: z.string().max(256).regex(/^\d+(?:\.\d+)?$/)
      .describe("Positive target quantity in displayed currency units; for BTC/USD, the USD price of the source quantity."),
    source_record_number: z.number().int().positive().optional()
      .describe("Original one-based source data row number, when this rate came from a file."),
  });
  registerTool("create_reference_rates", {
    title: "Create timestamped reference rates",
    description: `Atomically store 1 through ${REFERENCE_RATE_INLINE_MAX} owner-scoped reference prices created directly in this interaction. One item uses the same collection. Duplicate pair-and-time targets in the request are rejected; exact existing native-unit ratios are reused; a different existing value causes the entire batch to fail without inserts. The target quote is rounded half-up to its currency scale and roundedCount reports affected input prices. Outcomes are run-length encoded by zero-based input index, with one effect receipt for the whole call. File-originated data must use get_reference_rate_import_schema, file_table_transform, artifact upload, and import_reference_rates_artifact. Rates are evidence only and do not post ledger entries.`,
    inputSchema: { rates: z.array(referenceRateItemInput).min(1).max(REFERENCE_RATE_INLINE_MAX) },
    outputSchema: referenceRateMutationOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["list_currency_objects"],
      objectInputs: [
        { path: "/rates/*/from_currency_id", objectType: "accounting.currency", value: "id" },
        { path: "/rates/*/to_currency_id", objectType: "accounting.currency", value: "id" },
      ],
    }),
  }, async ({ rates }) => safeWorkflowResult(async () => {
    const result = await accounting.createReferenceRates({ pool, personId, rates });
    return { ...result, effectReceipt: effectReceipt("create_reference_rates", { rates },
      result.createdCount ? "created" : "unchanged", []) };
  }, { retryTool: "create_reference_rates", preserveEntireBatch: true }));

  registerTool("import_reference_rates_artifact", {
    title: "Import complete reference rate artifact",
    description: `Atomically consume one completed, SHA-256-verified canonical application/x-ndjson artifact of 1 through ${REFERENCE_RATE_BATCH_MAX} reference-rate records. For an uploaded price file, use get_reference_rate_import_schema and file_table_transform to transform the full file to canonical JSON Lines. Compare transformedRecordCount with maximum_records; if larger, use file_jsonl_partition with records_per_file no greater than maximum_records to make bounded parts. Upload each part through the advertised resumable artifact tool and import each part by calling this tool with only artifact_id; use the whole artifact as one part when it fits. On resumption, recover successful per-part import receipts and continue with parts lacking a successful receipt. Verify aggregate submittedCount equals transformedRecordCount and aggregate createdCount plus reusedCount equals aggregate submittedCount. Accounting validates every record before writing, reuses exact pair-and-time matches including partial earlier imports, rejects conflicts, and returns counts and compact per-item outcome ranges. Transform exceptions remain a separate generated file and must be reported. An exact replay is safe.`,
    inputSchema: { artifact_id: z.string().trim().uuid() },
    outputSchema: referenceRateMutationOutput,
    annotations: idempotentWrite,
    _meta: toolMetadata("accounting.reconciliation", {
      dependencies: ["get_reference_rate_import_schema", "list_currencies"],
      artifactUpload: referenceRateArtifactUpload,
    }),
  }, async ({ artifact_id }) => safeWorkflowResult(async () => {
    const result = await accounting.importReferenceRatesArtifact({ pool, artifactRoot, personId,
      artifactId: artifact_id });
    return { ...result, effectReceipt: effectReceipt("import_reference_rates_artifact",
      { artifact_id, artifact_sha256: result.artifactSha256 },
      result.createdCount ? "created" : "unchanged", []) };
  }, { retryTool: "import_reference_rates_artifact", preserveEntireBatch: true }));

  registerTool("verify_ledger", {
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
    return { ...result, resultMetadata };
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
