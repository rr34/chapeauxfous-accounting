import * as z from "zod/v4";
import {
  TRANSACTION_IMPORT_MAX_LINE_ITEMS,
} from "./transaction-import-limits.js";
import {
  artifactUploadContract,
} from "./artifact-upload.js";

export const MCP_CONTRACT_VERSION = 2;
export const MCP_SERVER_VERSION = "0.8.0";

const jsonObjectSchema = z.record(z.string(), z.json());

export const schemaProjectionSchema = z.object({
  product: z.literal("schema-semantic-compiler/schema-semantic-projection"),
  productContractVersion: z.literal(2),
  projectionId: z.string().regex(/^[0-9a-f]{64}$/),
  compiledAt: z.string().datetime(),
  compiler: jsonObjectSchema,
  source: jsonObjectSchema,
  operation: jsonObjectSchema,
  schemaProjection: jsonObjectSchema,
  compilerTrace: jsonObjectSchema,
}).describe("Schema Semantic Compiler version-2 projection product for the exact database objects and fields used by this result.");

export const entityReferenceSchema = z.object({
  type: z.string().min(1),
  id: z.union([z.string().min(1), z.number().int().nonnegative()]),
});

export const resultMetadataSchema = z.object({
  complete: z.boolean(),
  returned: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  sourceRefs: z.array(z.string().min(1)),
});

export const effectReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  tool: z.string().min(1),
  argumentsSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  outcome: z.enum(["created", "updated", "upserted", "deleted", "committed", "unchanged"]),
  entityRefs: z.array(entityReferenceSchema),
  observedAt: z.string().datetime(),
});

export const retryDescriptorSchema = z.object({
  protocol: z.literal("agent-slayer.retry-descriptor"),
  version: z.literal(1),
  retryable: z.boolean(),
  reason_code: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  requires_new_client_request_id: z.boolean(),
  preserve_complete_original_batch: z.boolean(),
  retry_after_ms: z.number().int().nonnegative().nullable(),
});

export function makeRetryDescriptor(reasonCode, {
  retryable = true,
  preserveCompleteOriginalBatch = false,
  retryAfterMs = null,
} = {}) {
  const normalizedReason = String(reasonCode ?? "provider_error").toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 100) || "provider_error";
  return {
    protocol: "agent-slayer.retry-descriptor",
    version: 1,
    retryable,
    reason_code: normalizedReason,
    requires_new_client_request_id: false,
    preserve_complete_original_batch: preserveCompleteOriginalBatch,
    retry_after_ms: retryAfterMs,
  };
}

export const structuredErrorSchema = z.object({
  contractVersion: z.literal(MCP_CONTRACT_VERSION),
  status: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.json().nullable(),
  recoverable: z.boolean(),
  retry: retryDescriptorSchema.nullable(),
  requiredAction: z.string().min(1).optional(),
});

export function successOutputSchema(shape, statuses = ["success"]) {
  return z.union([
    z.object({
      contractVersion: z.literal(MCP_CONTRACT_VERSION),
      status: z.enum(statuses),
      ...shape,
    }),
    structuredErrorSchema,
  ]);
}

export const currencySchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(1),
  displayName: z.string().min(1),
  type: z.enum(["iso_4217", "crypto", "security", "commodity", "custom"]),
  scale: z.number().int().min(0).max(18),
  ownerPersonId: z.number().int().positive().nullable(),
  userDefined: z.boolean(),
});

export const accountSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().nullable(),
  placeholder: z.boolean(),
  parentAccountId: z.number().int().positive().nullable(),
  type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  currencyId: z.number().int().positive(),
  currencyCode: z.string().min(1),
  scale: z.number().int().min(0).max(18),
  balanceUnits: z.string().regex(/^-?\d+$/).describe("Normal account balance in native units: debit minus credit for assets and expenses; credit minus debit for liabilities, income, and equity."),
  archivedAt: z.string().nullable(),
});

export const transactionListItemSchema = z.object({
  id: z.number().int().positive(),
  date: z.string(),
  description: z.string().nullable(),
  state: z.enum(["draft", "posted", "voided"]),
  valuationCurrencyId: z.number().int().positive(),
  valuationCurrencyCode: z.string().min(1),
  scale: z.number().int().min(0).max(18),
  lineItemCount: z.number().int().nonnegative(),
});

const transactionLineSchema = z.object({
  id: z.number().int().positive(),
  amountUnits: z.string().regex(/^-?\d+$/),
  valueUnits: z.string().regex(/^-?\d+$/).nullable(),
  reconciliationState: z.enum(["unreconciled", "cleared", "reconciled"]),
  reconciledAt: z.string().nullable(),
  memo: z.string().nullable(),
  accountId: z.number().int().positive(),
  accountName: z.string().min(1),
  currencyId: z.number().int().positive(),
  currencyCode: z.string().min(1),
  scale: z.number().int().min(0).max(18),
  tags: z.array(z.object({ key: z.string().min(1), value: z.string().min(1) })),
});

export const transactionSchema = z.object({
  id: z.number().int().positive(),
  date: z.string(),
  description: z.string().nullable(),
  state: z.enum(["draft", "posted", "voided"]),
  valuationCurrencyId: z.number().int().positive(),
  lineItems: z.array(transactionLineSchema),
  rates: z.array(z.object({
    id: z.number().int().positive(),
    fromUnits: z.string().regex(/^\d+$/),
    fromCurrencyId: z.number().int().positive(),
    toUnits: z.string().regex(/^\d+$/),
    toCurrencyId: z.number().int().positive(),
  })),
});

export const accountingQuestionSchema = z.object({
  lineItemId: z.number().int().positive().describe("Stable question identity and the suspense posting line to reclassify."),
  transactionId: z.number().int().positive(),
  transactionDate: z.string(),
  transactionDescription: z.string().nullable(),
  transactionState: z.enum(["draft", "posted", "voided"]),
  accountId: z.number().int().positive(),
  accountName: z.string().min(1),
  accountFullName: z.string().min(1),
  currencyId: z.number().int().positive(),
  currencyCode: z.string().min(1),
  scale: z.number().int().min(0).max(18),
  amountUnits: z.string().regex(/^-?\d+$/),
  valueUnits: z.string().regex(/^-?\d+$/).nullable(),
  memo: z.string().nullable(),
  status: z.enum(["open", "resolved"]),
  audience: z.string().min(1),
  prompt: z.string().min(1),
  resolution: z.string().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  targetAccountId: z.number().int().positive().nullable(),
});

const transactionSearchLineSchema = z.object({
  id: z.number().int().positive(),
  amountUnits: z.string().regex(/^-?\d+$/),
  amountDecimal: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  valueUnits: z.string().regex(/^-?\d+$/).nullable(),
  memo: z.string().nullable(),
  sourceId: z.string().nullable(),
  reconciliationState: z.enum(["unreconciled", "cleared", "reconciled"]),
  reconciledAt: z.string().nullable(),
  accountId: z.number().int().positive(),
  accountName: z.string().min(1),
  accountFullName: z.string().min(1),
  accountDescription: z.string().nullable(),
  currencyId: z.number().int().positive(),
  currencyCode: z.string().min(1),
  scale: z.number().int().min(0).max(18),
  tags: z.array(z.object({ key: z.string().min(1), value: z.string().min(1) })),
});

const transactionSearchImportSourceSchema = z.object({
  importJobId: z.string().uuid(),
  sourceSystem: z.string().min(1),
  sourceFileName: z.string().min(1),
  externalId: z.string().min(1),
  status: z.enum(["staged", "reused", "exception", "committed"]),
  issues: z.array(z.object({ code: z.string().min(1), message: z.string().min(1), details: z.json().nullable() })),
});

export const transactionSearchItemSchema = z.object({
  id: z.number().int().positive(),
  date: z.string(),
  description: z.string().nullable(),
  state: z.enum(["draft", "posted", "voided"]),
  valuationCurrencyId: z.number().int().positive(),
  valuationCurrencyCode: z.string().min(1),
  valuationScale: z.number().int().min(0).max(18),
  sourceSystem: z.string().nullable(),
  externalId: z.string().nullable(),
  hasIssues: z.boolean(),
  issueCodes: z.array(z.string().min(1)),
  matchedFields: z.array(z.string().min(1)),
  matchedLineItemIds: z.array(z.number().int().positive()),
  lineItems: z.array(transactionSearchLineSchema),
  importSources: z.array(transactionSearchImportSourceSchema),
});

export const balanceAssertionSchema = z.object({
  id: z.number().int().positive(),
  accountId: z.number().int().positive(),
  accountName: z.string().min(1),
  date: z.string(),
  knownBalanceUnits: z.string().regex(/^-?\d+$/).describe("User-entered normal account balance in native units."),
  calculatedBalanceUnits: z.string().regex(/^-?\d+$/).describe("Calculated normal account balance in native units."),
  differenceUnits: z.string().regex(/^-?\d+$/).describe("Known normal balance minus calculated normal balance."),
  matches: z.boolean(),
  currencyId: z.number().int().positive(),
  currencyCode: z.string().min(1),
  scale: z.number().int().min(0).max(18),
});

export const referenceRateSchema = z.object({
  id: z.number().int().positive(),
  validAt: z.string().datetime(),
  fromUnits: z.string().regex(/^\d+$/),
  fromCurrencyId: z.number().int().positive(),
  fromCurrencyCode: z.string().min(1),
  fromScale: z.number().int().min(0).max(18),
  toUnits: z.string().regex(/^\d+$/),
  toCurrencyId: z.number().int().positive(),
  toCurrencyCode: z.string().min(1),
  toScale: z.number().int().min(0).max(18),
});

const reconciliationAnchorSchema = z.object({
  assertionId: z.number().int().positive().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  knownBalanceUnits: z.string().regex(/^-?\d+$/).nullable(),
  calculatedBalanceUnits: z.string().regex(/^-?\d+$/),
});

export const statementReconciliationContextSchema = z.object({
  interval: z.object({
    openingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    closingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    includedTransactionDates: z.string().min(1),
  }),
  accounts: z.array(z.object({
    accountId: z.number().int().positive(),
    accountFullName: z.string().min(1),
    accountType: z.enum(["asset", "liability", "equity", "income", "expense"]),
    currencyId: z.number().int().positive(),
    currencyCode: z.string().min(1),
    scale: z.number().int().min(0).max(18),
    opening: reconciliationAnchorSchema,
    closing: reconciliationAnchorSchema,
    requiredNormalMovementUnits: z.string().regex(/^-?\d+$/).nullable()
      .describe("Closing known balance minus opening known balance, expressed in the account's normal-balance sign."),
    postedLineItemMovementUnits: z.string().regex(/^-?\d+$/)
      .describe("Sum of already-posted debit-positive line-item units in the interval."),
    remainingLineItemMovementUnits: z.string().regex(/^-?\d+$/).nullable()
      .describe("Exact debit-positive native-unit total that not-yet-posted imported lines must contribute for this account."),
    grounded: z.boolean(),
    postable: z.boolean(),
  })),
  grounded: z.boolean(),
  evidenceRefs: z.array(z.string().min(1)),
  missingAssertions: z.array(z.object({
    accountId: z.number().int().positive(),
    balanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })),
  workflow: z.object({
    evidenceOrder: z.array(z.string().min(1)),
    rules: z.array(z.string().min(1)),
  }),
});

const statementObservationIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const statementObservationAnalysisSchema = z.object({
  reconciliation: statementReconciliationContextSchema,
  observations: z.array(z.object({
    id: statementObservationIdSchema,
    sourceDocumentId: z.string().min(1),
    sourceRecordId: z.string().min(1),
    accountId: z.number().int().positive(),
    accountFullName: z.string().min(1),
    currencyId: z.number().int().positive(),
    currencyCode: z.string().min(1),
    scale: z.number().int().min(0).max(18),
    transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    occurredAt: z.string().datetime().nullable(),
    amountDecimal: z.string().min(1),
    amountUnits: z.string().regex(/^-?\d+$/),
    description: z.string().nullable(),
    reference: z.string().nullable(),
  })),
  duplicateAnalysis: z.object({
    ledgerCandidates: z.array(z.object({
      observationId: statementObservationIdSchema,
      candidates: z.array(z.object({
        transactionId: z.number().int().positive(),
        lineItemId: z.number().int().positive(),
        classification: z.enum(["exact_source_duplicate", "strong_duplicate_candidate",
          "possible_duplicate", "source_reference_conflict"]),
        recommendation: z.enum(["exclude_from_new_import", "review_candidate",
          "do_not_import_until_resolved"]),
        score: z.number().int().nonnegative(),
        reasons: z.array(z.string().min(1)),
        existing: z.object({
          transactionDate: z.string(), amountUnits: z.string().regex(/^-?\d+$/),
          description: z.string().nullable(), lineMemo: z.string().nullable(),
          transactionSourceId: z.string().nullable(), transactionSourceSystem: z.string().nullable(),
          transactionState: z.enum(["draft", "posted"]), lineSourceId: z.string().nullable(),
        }),
      })),
    })),
    inputCandidates: z.array(z.object({
      observationIds: z.array(statementObservationIdSchema).length(2),
      classification: z.enum(["exact_cross_document_duplicate", "overlapping_source_candidate"]),
      recommendation: z.enum(["keep_one_observation", "review_candidate"]),
      reasons: z.array(z.string().min(1)),
    })),
    exactLedgerDuplicateObservationIds: z.array(statementObservationIdSchema),
    ambiguousExactLedgerObservationIds: z.array(statementObservationIdSchema),
    exactInputDuplicateObservationIds: z.array(statementObservationIdSchema),
    unresolvedCandidateCount: z.number().int().nonnegative(),
  }),
  transferCandidates: z.array(z.object({
    outgoingObservationId: statementObservationIdSchema,
    incomingObservationId: statementObservationIdSchema,
    classification: z.enum(["strong_transfer_candidate", "possible_transfer_candidate"]),
    score: z.number().int().nonnegative(),
    reasons: z.array(z.string().min(1)),
    nativeCurrencyCode: z.string().min(1),
    outgoingUnits: z.string().regex(/^\d+$/),
    incomingUnits: z.string().regex(/^\d+$/),
    possibleFeeUnits: z.string().regex(/^\d+$/).nullable(),
  })),
  ambiguousTransferObservationIds: z.array(statementObservationIdSchema),
  proposedNewObservationIds: z.array(statementObservationIdSchema),
  coverage: z.array(z.object({
    accountId: z.number().int().positive(), accountFullName: z.string().min(1),
    currencyCode: z.string().min(1), scale: z.number().int().min(0).max(18),
    requiredRemainingUnits: z.string().regex(/^-?\d+$/).nullable(),
    allExtractedObservationUnits: z.string().regex(/^-?\d+$/),
    proposedNewObservationUnits: z.string().regex(/^-?\d+$/),
    residualAfterProposedUnits: z.string().regex(/^-?\d+$/).nullable(),
    balanced: z.boolean(),
  })),
  readyForTransactionAssembly: z.boolean(),
  rules: z.array(z.string().min(1)),
});

export const CAPABILITY_MANIFEST_URI = "accounting://manifest/capabilities/v1";

export const transactionImportArtifactUpload = artifactUploadContract;

export const accountingCapabilityManifest = Object.freeze({
  contractVersion: MCP_CONTRACT_VERSION,
  server: {
    name: "chapeaux-fous-accounting",
    title: "Chapeaux Fous Accounting",
    version: MCP_SERVER_VERSION,
    instructions: "For an uploaded account statement, use one canonical workflow. First identify and confirm exactly one accounting.account object. Call start_single_account_statement_import, then answer its four questions in order from the attachment: (1) beginning balance and date, including whether the date is the first included statement date or an explicit end-of-day balance date, (2) ending balance and date, (3) every signed line-item amount and date, and (4) all available text for each line. A beginning balance shown for the first included date is an end-of-day balance for the previous calendar day; the server derives that effective date. Ask the user only when the statement does not provide an answer. Submit the complete answers to import_single_account_statement. Do not guess counteraccounts, categories, fees, prices, or transfers during this initial workflow; Accounting puts every unknown other side into the user-selected same-currency suspense account. Present the returned preview for confirmation, commit its exact plan only after approval, and reconcile only the statement account after the known closing balance matches. Later evidence can resolve suspense questions without changing reconciled statement lines. Mutations return effect receipts. Import and deletion workflows require an exact provider plan followed by the matching commit tool.",
    artifactUpload: artifactUploadContract,
  },
  capabilities: [
    {
      id: "accounting.schema",
      title: "Accounting schema semantics",
      summary: "Retrieve bounded field meanings and relationships for accounting data.",
      aliases: ["ledger schema", "accounting semantics"],
      guidance: "Use when a field, unit, relationship, or invariant is unclear.",
      tools: ["describe_accounting_schema"],
      dependencies: [],
      attachmentHints: [],
      contextViews: [],
    },
    {
      id: "accounting.currencies",
      title: "Currencies and accounting units",
      summary: "Read and create owner-accessible currencies, securities, commodities, and custom units.",
      aliases: ["currencies", "commodities", "securities"],
      guidance: "Never infer an unknown native-unit scale.",
      tools: ["list_currencies", "create_currency"],
      dependencies: [],
      attachmentHints: [],
      contextViews: ["accounting.currencies.active"],
    },
    {
      id: "accounting.accounts",
      title: "Chart of accounts",
      summary: "Read, create, update, import, and safely delete owner-scoped accounts.",
      aliases: ["accounts", "account tree", "chart of accounts"],
      guidance: "Deletion requires preview, explicit confirmation, commit, and post-commit verification.",
      tools: ["list_accounts", "list_account_objects", "create_account", "update_account", "import_account_tree", "get_account_tree_import_plan", "commit_account_tree_import", "preview_delete_account", "get_account_delete_plan", "commit_delete_account"],
      dependencies: ["accounting.currencies"],
      attachmentHints: ["Account-tree files must be converted to one complete batch; preserve the complete batch on retry."],
      contextViews: ["accounting.accounts.active_paths", "accounting.objects.accounts"],
    },
    {
      id: "accounting.transactions",
      title: "Double-entry transactions",
      summary: "Read, create, import, permanently delete, and verify owner-scoped double-entry transactions.",
      aliases: ["transactions", "journal entries", "ledger entries"],
      guidance: "Every posted transaction must balance in its valuation currency. Permanent deletion requires an MCP preview, one explicit confirmation, and the exact matching commit operation.",
      tools: ["search_transactions", "list_transactions", "get_transaction", "create_transaction", "get_transaction_import_schema",
        "create_transaction_import_job", "stage_transaction_import_artifact", "stage_transaction_import_chunk", "retry_transaction_import_exception",
        "exclude_transaction_import_exception", "list_transaction_import_jobs", "get_transaction_import_job",
        "list_transaction_import_exceptions", "preview_transaction_import_job",
        "commit_transaction_import_job", "import_transactions", "get_transaction_import_plan",
        "commit_transaction_import", "list_accounting_questions", "open_accounting_question", "resolve_accounting_question",
        "preview_delete_transactions", "refresh_transaction_delete_plan", "get_transaction_delete_plan",
        "commit_delete_transactions", "verify_ledger"],
      dependencies: ["accounting.accounts", "accounting.currencies"],
      attachmentHints: [
        "Fetch the authoritative canonical line-record JSON Schema before mapping a source file.",
        "For a file-originated import, persist canonical application/x-ndjson and use the advertised resumable artifact upload; byte chunks are host-managed transport and must not enter model context.",
        `Inline JSON is reserved for direct agent-created transactions and bounded calls of at most ${TRANSACTION_IMPORT_MAX_LINE_ITEMS} line items.`,
        "Retry only structured exceptions; successful transaction groups remain staged or committed and must not be resubmitted.",
        "Corrected exceptions may add accounting lines without changing the immutable count of original source records represented by the job.",
        "A user may explicitly exclude an exception with a durable reason while preserving its source identity and canonical context.",
      ],
      contextViews: ["accounting.accounts.active_paths", "accounting.currencies.active"],
    },
    {
      id: "accounting.reconciliation",
      title: "Balance assertions and reconciliation",
      summary: "Import one statement into one confirmed account using four ordered extraction answers and known balances.",
      aliases: ["reconciliation", "balance checks", "statement import", "account statement"],
      guidance: "The canonical attachment path is start_single_account_statement_import followed by import_single_account_statement. Extract only beginning balance/date and its date meaning, ending balance/date, signed line items, and available line text. When the beginning date is the statement's first included date, the server records that balance on the previous calendar day; an explicit end-of-day balance date is used directly. Do not classify the unknown sides during intake. The server stores the balance anchors, screens duplicates, builds balanced suspense counterlines, and refuses a commit plan when the statement does not ground the selected account.",
      tools: ["list_balance_assertions", "save_balance_assertion", "get_statement_reconciliation_context",
        "analyze_statement_observations",
        "list_reference_rates", "create_reference_rate", "list_accounting_questions",
        "open_accounting_question", "resolve_accounting_question",
        "start_single_account_statement_import", "import_single_account_statement", "reconcile_account_through_date"],
      dependencies: ["accounting.accounts", "accounting.currencies", "accounting.transactions"],
      attachmentHints: [
        "Bind one CSV, PDF, image, OCR result, or screenshot to one confirmed accounting.account object.",
        "Call start_single_account_statement_import before extracting or importing the attachment.",
        "Answer its four questions in order and preserve printed balances, dates, signed amounts, and text exactly.",
        "Do not infer transfers, prices, fees, or final categories during initial statement intake.",
        "Use statement balances as native-unit anchors; never alter a source quantity to manufacture a match.",
        "Ask Accountant and Ask Human are user-created ordinary postable suspense accounts, usually one per currency; do not create them silently and do not make them placeholders.",
        "When a later receipt is uploaded, list open accounting questions before creating another transaction. Compare currency, exact amount, date, merchant text, and source identity; resolve only a unique supported match and ask the user when candidates remain ambiguous.",
        "import_single_account_statement preserves each statement line, marks that side cleared, and creates the opposite posting in one selected same-currency suspense bucket.",
        "Mark an account reconciled through a closing date only with reconcile_account_through_date; it requires the exact known balance to match first and never marks the suspense counterlines reconciled.",
      ],
      contextViews: [],
    },
  ],
  contextViews: [
    {
      id: "accounting.currencies.active",
      title: "Accessible accounting units",
      uri: "accounting://context/currencies/active",
      readOnly: true,
      maximumRecords: 500,
      source: "currencies domain service",
    },
    {
      id: "accounting.accounts.active_paths",
      title: "Active account path index",
      uri: "accounting://context/accounts/active-paths",
      readOnly: true,
      maximumRecords: 500,
      source: "accounts domain service",
    },
    {
      id: "accounting.objects.accounts",
      title: "Accounting account objects",
      uri: "accounting://context/objects/accounts",
      readOnly: true,
      maximumRecords: 500,
      source: "accounts domain service",
    },
  ],
});

export function toolMetadata(capabilityId, { dependencies = [], attachmentHints = [], artifactUpload = null } = {}) {
  return {
    "agent-slayer/capabilityId": capabilityId,
    "agent-slayer/dependencies": dependencies,
    "agent-slayer/attachmentHints": attachmentHints,
    "agent-slayer/contractVersion": MCP_CONTRACT_VERSION,
    ...(artifactUpload == null ? {} : { "agent-slayer/artifactUpload": artifactUpload }),
  };
}
