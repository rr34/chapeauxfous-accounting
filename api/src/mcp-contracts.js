import * as z from "zod/v4";
import {
  TRANSACTION_IMPORT_MAX_LINE_ITEMS,
} from "./transaction-import-limits.js";
import {
  artifactUploadContract,
} from "./artifact-upload.js";

export const MCP_CONTRACT_VERSION = 1;
export const MCP_SERVER_VERSION = "0.2.0";

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
  balanceUnits: z.string().regex(/^-?\d+$/),
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

export const balanceAssertionSchema = z.object({
  id: z.number().int().positive(),
  accountId: z.number().int().positive(),
  accountName: z.string().min(1),
  date: z.string(),
  knownBalanceUnits: z.string().regex(/^-?\d+$/),
  calculatedBalanceUnits: z.string().regex(/^-?\d+$/),
  differenceUnits: z.string().regex(/^-?\d+$/),
  matches: z.boolean(),
  currencyId: z.number().int().positive(),
  currencyCode: z.string().min(1),
  scale: z.number().int().min(0).max(18),
});

export const CAPABILITY_MANIFEST_URI = "accounting://manifest/capabilities/v1";

export const transactionImportArtifactUpload = artifactUploadContract;

export const accountingCapabilityManifest = Object.freeze({
  contractVersion: MCP_CONTRACT_VERSION,
  server: {
    name: "chapeaux-fous-accounting",
    title: "Chapeaux Fous Accounting",
    version: MCP_SERVER_VERSION,
    instructions: "Use owner-scoped read tools for evidence. Mutations return effect receipts. Import and deletion workflows require an exact provider plan followed by the matching commit tool.",
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
      tools: ["list_accounts", "create_account", "update_account", "import_account_tree", "get_account_tree_import_plan", "commit_account_tree_import", "preview_delete_account", "get_account_delete_plan", "commit_delete_account"],
      dependencies: ["accounting.currencies"],
      attachmentHints: ["Account-tree files must be converted to one complete batch; preserve the complete batch on retry."],
      contextViews: ["accounting.accounts.active_paths"],
    },
    {
      id: "accounting.transactions",
      title: "Double-entry transactions",
      summary: "Read, create, import, permanently delete, and verify owner-scoped double-entry transactions.",
      aliases: ["transactions", "journal entries", "ledger entries"],
      guidance: "Every posted transaction must balance in its valuation currency. Permanent deletion requires a provider-owned preview, explicit confirmation, and the exact matching commit operation.",
      tools: ["list_transactions", "get_transaction", "create_transaction", "get_transaction_import_schema",
        "create_transaction_import_job", "stage_transaction_import_artifact", "stage_transaction_import_chunk", "retry_transaction_import_exception",
        "get_transaction_import_job", "list_transaction_import_exceptions", "preview_transaction_import_job",
        "commit_transaction_import_job", "import_transactions", "get_transaction_import_plan",
        "commit_transaction_import", "preview_delete_transactions", "refresh_transaction_delete_plan", "get_transaction_delete_plan",
        "commit_delete_transactions", "verify_ledger"],
      dependencies: ["accounting.accounts", "accounting.currencies"],
      attachmentHints: [
        "Fetch the authoritative canonical line-record JSON Schema before mapping a source file.",
        "For a file-originated import, persist canonical application/x-ndjson and use the advertised resumable artifact upload; byte chunks are host-managed transport and must not enter model context.",
        `Inline JSON is reserved for direct agent-created transactions and bounded calls of at most ${TRANSACTION_IMPORT_MAX_LINE_ITEMS} line items.`,
        "Retry only structured exceptions; successful transaction groups remain staged and must not be resubmitted.",
      ],
      contextViews: ["accounting.accounts.active_paths", "accounting.currencies.active"],
    },
    {
      id: "accounting.reconciliation",
      title: "Balance assertions and reconciliation",
      summary: "Record known balances and compare them with the posted ledger.",
      aliases: ["reconciliation", "balance checks"],
      guidance: "Amounts are signed integer native units in the account currency.",
      tools: ["list_balance_assertions", "save_balance_assertion"],
      dependencies: ["accounting.accounts"],
      attachmentHints: [],
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
