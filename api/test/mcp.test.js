import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { createAccountingMcpHandler, createAccountingMcpServer } = await import("../src/mcp.js");
const { accountingToolDescriptions } = await import("../src/mcp-tool-descriptions.js");
const { extractDeferredActionReference } = await import(
  "../../../agent-chapeaux-fous/src/deferred-actions.mjs"
);
const { catalogToolDescription } = await import(
  "../../../agent-chapeaux-fous/src/tool-description.mjs"
);
const { validateObjectDescription } = await import(
  "../../../agent-chapeaux-fous/src/object-description.mjs"
);
const { validateDiscoveredMcpTools } = await import(
  "../../../agent-chapeaux-fous/src/tools/mcp-tools.mjs"
);

test("the MCP exposes scoped tool and object contracts", async () => {
  const seen = [];
  let imported;
  let committedAccountPlan;
  let readAccountPlan;
  let importedTransactions;
  let committedTransactionPlan;
  let previewedTransactionDeletion;
  let committedTransactionDeletion;
  let createdCurrency;
  let createdImportJob;
  let previewedImportJob;
  let searchedTransactionFilters;
  let oneSidedImport;
  const savedStatementBalances = [];
  let reconciledAccount;
  const transactionImportFixture = ({ status, readyToCommit, ledgerChanged, importPlanId, transactionCount = 1 }) => ({
    status,
    dryRun: !ledgerChanged,
    ledgerChanged,
    readyToCommit,
    importPlanId,
    importPlanExpiresAt: importPlanId ? "2026-08-25T18:42:00.000Z" : null,
    sourceSystem: "source_app",
    submittedTransactionCount: transactionCount,
    uniqueTransactionCount: transactionCount,
    duplicateInputTransactionCount: 0,
    submittedLineItemCount: transactionCount * 2,
    wouldCreateTransactionCount: ledgerChanged ? 0 : transactionCount,
    wouldReuseTransactionCount: 0,
    wouldCreateLineItemCount: ledgerChanged ? 0 : transactionCount * 2,
    wouldReuseLineItemCount: 0,
    createdTransactionCount: ledgerChanged ? transactionCount : 0,
    reusedTransactionCount: 0,
    createdLineItemCount: ledgerChanged ? transactionCount * 2 : 0,
    reusedLineItemCount: 0,
    rejectedTransactionCount: 0,
    rejectedLineItemCount: 0,
    unknownAccountPaths: [],
    ambiguousAccountPaths: [],
    transactionSummary: {
      byStatus: { planned: ledgerChanged ? 0 : transactionCount, existing: 0,
        created: ledgerChanged ? transactionCount : 0, rejected: 0 },
      byValuationCurrency: { USD: transactionCount },
      byYear: { 2026: transactionCount },
    },
    lineItemSummary: { byAccountCurrency: { USD: transactionCount * 2 }, byTopLevelBranch: { Assets: transactionCount } },
    questionSummary: { openQuestionCount: 0, byAudience: {}, bySuspenseAccount: {} },
    transactions: [{ externalId: "tx-1", transactionDate: "2026-01-01", transactionAt: null,
      description: "Test",
      valuationCurrencyCode: "USD", lineItemCount: 2, status: ledgerChanged ? "created" : "planned",
      transactionId: ledgerChanged ? 91 : null, errors: [] }],
  });
  const services = {
    async describeAccountingSchema(_pool, _databaseName, request) {
      return { request, tables: [{ name: "accounts", comment: "Owner-scoped ledger accounts", columns: [
        { name: "AccountName", type: "text", nullable: false, comment: "Name of this ledger account" },
      ] }] };
    },
    async createTransactionImportJob(input) {
      createdImportJob = input;
      return {
        import_job_id: "0ed8cb57-efb5-419e-b4e5-59b73724f224",
        source_system: input.sourceSystem,
        source_file: { sha256: input.sourceFileSha256.replace(/^sha256:/, ""), name: input.sourceFileName },
        expected_record_count: input.expectedRecordCount,
        job_status: "receiving",
        progress: {
          expected_source_records: input.expectedRecordCount,
          newly_staged_records: 0,
          previously_staged_or_reused_records: 0,
          exception_records: 0,
          remaining_records: input.expectedRecordCount,
          equation: `${input.expectedRecordCount} = 0 + 0 + 0 + ${input.expectedRecordCount}`,
        },
      };
    },
    async previewTransactionImportJob(input) {
      previewedImportJob = input;
      const previewDigest = `sha256:${"e".repeat(64)}`;
      return {
        import_job_id: input.importJobId,
        source_system: "gnucash_csv_20260827",
        source_file: { sha256: "7".repeat(64), name: "source.csv" },
        expected_record_count: 17275,
        job_status: "review_ready",
        progress: {
          expected_source_records: 17275,
          newly_staged_records: 0,
          previously_staged_or_reused_records: 17224,
          exception_records: 51,
          remaining_records: 0,
          equation: "17275 = 0 + 17224 + 51 + 0",
          pending_commit_records: 17224,
          previously_committed_records: 0,
          exception_record_totals: { unresolved: 51, excluded: 0 },
          transaction_totals: { staged: 7987, pending_commit: 7987, previously_committed: 0,
            reused: 0, exceptions: 23, unresolved_exceptions: 23, excluded: 0 },
        },
        preview_digest: previewDigest,
        ready_to_commit: true,
        unresolved_exceptions: 23,
        excluded_exceptions: 0,
        user_outcome: {
          import_status: "succeeded",
          all_source_data_in_system: true,
          source_records_imported: 17275,
          transactions_ready_for_ledger: 7987,
          transactions_already_in_ledger: 0,
          transactions_in_import_misfits: 23,
        },
        exception_handling: {
          retained_in: "import_misfits",
          retained_after_ledger_addition: true,
          correctable_in_system: true,
          list_with: { tool: "list_transaction_import_exceptions", arguments: { import_job_id: input.importJobId } },
          correct_with: { tool: "retry_transaction_import_exception", arguments: { import_job_id: input.importJobId } },
        },
        commit_scope: "Import succeeded. All source records are in Accounting; Misfits can be corrected.",
        requiredAction: "REQUEST_USER_CONFIRMATION",
        nextAction: {
          type: "request_user_confirmation",
          instruction: "Import succeeded. All source records are in Accounting. Add ready transactions to the ledger now? Misfits can be corrected there.",
          onApproval: {
            tool: "commit_transaction_import_job",
            arguments: { import_job_id: input.importJobId, preview_digest: previewDigest },
          },
        },
      };
    },
    async listCurrencies(_pool, personId) {
      seen.push(`currencies:${personId}`);
      return [
        { id: 2, code: "BTC", displayName: "Bitcoin", type: "crypto", scale: 8, ownerPersonId: 7, userDefined: true },
        { id: 1, code: "USD", displayName: "US Dollar", type: "iso_4217", scale: 2, ownerPersonId: null, userDefined: false },
      ];
    },
    async createCurrency(input) {
      createdCurrency = input;
      return { id: 12, code: input.code, displayName: input.displayName, type: input.type, scale: input.scale,
        ownerPersonId: input.personId, userDefined: true };
    },
    async getCurrency(_pool, personId, currencyId) {
      return { id: Number(currencyId), code: "VTSAX", displayName: "Vanguard Total Stock Market Index Fund Admiral Shares",
        type: "security", scale: 4, ownerPersonId: personId, userDefined: true };
    },
    async listAccounts(_pool, personId) {
      seen.push(personId);
      return [{ id: 10, name: "Wallet", description: null, placeholder: false, parentAccountId: null,
        type: "asset", currencyId: 1, currencyCode: "USD", scale: 2, balanceUnits: "123", archivedAt: null }];
    },
    async searchTransactionsPage(_pool, personId, options) {
      searchedTransactionFilters = { personId, options };
      return {
        filters: {
          text: null, accountId: null, includeAccountDescendants: true,
          counterAccountId: null, includeCounterAccountDescendants: true,
          date: null, dateFrom: null, dateTo: null,
          amount: null, amountTolerance: null, minimumAmount: "10.00", maximumAmount: "20.00",
          amountSign: "either", transactionId: null, externalId: null, reference: null,
          currencyCode: "USD", source: null, hasIssues: null, sortBy: "date", sortDirection: "desc",
        },
        transactions: [], totalMatches: 0, nextCursor: null,
      };
    },
    async importAccountTree(input) {
      imported = input;
      return {
        readyToCommit: true,
        importPlanId: "11111111-1111-4111-8111-111111111111",
        status: "ready",
        expiresAt: "2026-08-25T18:42:00.000Z",
        previewDigest: `sha256:${"a".repeat(64)}`,
        summary: { accountsCreated: 1, accountsReused: 0, currenciesCreated: 1, currenciesReused: 0, rejectedRows: 0 },
        preview: {
          dryRun: true, ledgerChanged: false, totalCount: input.accounts.length,
          createdCount: 0, existingCount: 0, plannedCount: input.accounts.length,
          currencyCreatedCount: 0, currencyExistingCount: 0, currencyPlannedCount: 1,
          wouldCreateAccountCount: input.accounts.length, wouldReuseAccountCount: 0,
          wouldCreateCurrencyCount: 1, wouldReuseCurrencyCount: 0,
          accountSummary: {
            byStatus: { planned: input.accounts.length, existing: 0, created: 0 },
            byAccountType: { asset: input.accounts.length }, byCurrencyCode: { USD: input.accounts.length },
            byPlaceholderStatus: { placeholder: input.accounts.filter((account) => account.placeholder).length,
              postable: input.accounts.filter((account) => !account.placeholder).length },
            byTopLevelBranch: { Assets: input.accounts.length },
          },
          currencies: [{ id: null, ownerPersonId: 7, userDefined: true, code: "VTSAX",
            displayName: "Vanguard Total Stock Market Index Fund Admiral Shares", type: "security", scale: 4,
            status: "planned" }],
          accounts: input.accounts.map((account) => ({
            fullName: account.fullName, accountType: account.type, currencyCode: account.currencyCode,
            description: account.description ?? null, placeholder: account.placeholder,
            parentFullName: account.fullName.includes(":") ? account.fullName.split(":").slice(0, -1).join(":") : null,
            topLevelBranch: account.fullName.split(":")[0], status: "planned", accountId: null,
          })),
        },
      };
    },
    async commitAccountTreeImport(input) {
      committedAccountPlan = input;
      if (input.importPlanId.startsWith("3333")) {
        throw Object.assign(new Error("expired"), { code: "IMPORT_PLAN_EXPIRED" });
      }
      if (input.importPlanId.startsWith("4444")) {
        throw Object.assign(new Error("state conflict"), { code: "IMPORT_PLAN_STATE_CONFLICT" });
      }
      return {
        readyToCommit: false,
        importPlanId: input.importPlanId,
        status: "committed",
        expiresAt: "2026-08-25T18:42:00.000Z",
        previewDigest: `sha256:${"a".repeat(64)}`,
        summary: { accountsCreated: 1, accountsReused: 0, currenciesCreated: 1, currenciesReused: 0, rejectedRows: 0 },
        commitResult: { createdCount: 1 },
      };
    },
    async getAccountTreeImportPlan(input) {
      readAccountPlan = input;
      if (input.importPlanId.startsWith("2222")) {
        throw Object.assign(new Error("not found"), { code: "IMPORT_PLAN_NOT_FOUND" });
      }
      return {
        readyToCommit: true,
        importPlanId: input.importPlanId,
        status: "ready",
        expiresAt: "2026-08-25T18:42:00.000Z",
        previewDigest: `sha256:${"a".repeat(64)}`,
        summary: { accountsCreated: 1, accountsReused: 0, currenciesCreated: 1, currenciesReused: 0, rejectedRows: 0 },
      };
    },
    async previewTransactionImport(input) {
      importedTransactions = input;
      const result = transactionImportFixture({ status: "ready", readyToCommit: true, ledgerChanged: false,
        importPlanId: "11111111-1111-4111-8111-111111111111", transactionCount: input.transactions.length });
      return input.reconciliation == null ? result : { ...result, reconciliationValidation: {
        passed: true, openingBalanceDate: input.reconciliation.openingBalanceDate,
        closingBalanceDate: input.reconciliation.closingBalanceDate,
        accounts: [{ accountId: 10, accountFullName: "Assets:Checking", currencyCode: "USD", scale: 2,
          requiredRemainingUnits: "-1234", proposedNewLineItemUnits: "-1234", residualUnits: "0", matches: true }],
        issues: [],
      } };
    },
    async previewSingleAccountStatementImport(input) {
      oneSidedImport = input;
      return { ...transactionImportFixture({ status: "ready", readyToCommit: true, ledgerChanged: false,
        importPlanId: "55555555-5555-4555-8555-555555555555", transactionCount: input.lines.length }),
        questionSummary: { openQuestionCount: input.lines.length,
          byAudience: { [input.questionAudience]: input.lines.length },
          bySuspenseAccount: { "Assets:Ask Human": input.lines.length } } };
    },
    async saveBalanceAssertion(input) {
      savedStatementBalances.push(input);
      return { id: savedStatementBalances.length, accountId: input.accountId, accountName: "Wallet",
        date: input.balanceDate, knownBalanceUnits: input.knownBalanceUnits,
        calculatedBalanceUnits: input.knownBalanceUnits, differenceUnits: "0", matches: true,
        currencyId: 1, currencyCode: "USD", scale: 2 };
    },
    async analyzeStatementObservations(input) {
      const observations = input.observations.map((item, index) => ({ ...item, id: `observation-${index + 1}` }));
      return { observations, proposedNewObservationIds: observations.map((item) => item.id),
        duplicateAnalysis: { unresolvedCandidateCount: 0, ledgerCandidates: [], inputCandidates: [],
          exactLedgerDuplicateObservationIds: [], ambiguousExactLedgerObservationIds: [],
          exactInputDuplicateObservationIds: [] }, coverage: [] };
    },
    async reconcileAccountThroughDate(input) {
      reconciledAccount = input;
      return { accountId: input.accountId, accountName: "Checking", currencyId: 1, currencyCode: "USD",
        scale: 2, balanceDate: input.balanceDate, assertionId: 77, knownBalanceUnits: "10000",
        calculatedBalanceUnits: "10000", matches: true, totalLineCount: 4,
        newlyReconciledLineCount: 3, alreadyReconciledLineCount: 1 };
    },
    async commitTransactionImportPlan(input) {
      committedTransactionPlan = input;
      return { ...transactionImportFixture({ status: "committed", readyToCommit: false, ledgerChanged: true,
        importPlanId: input.importPlanId }), committed: true, alreadyCommitted: false,
        expiresAt: "2026-08-25T18:42:00.000Z", previewDigest: `sha256:${"b".repeat(64)}`,
        summary: { transactionsCreated: 1, transactionsReused: 0, lineItemsCreated: 2,
          lineItemsReused: 0, rejectedTransactions: 0 } };
    },
    async getTransactionImportPlan(input) {
      const commitResult = { ...transactionImportFixture({
        status: "committed", readyToCommit: false, ledgerChanged: true, importPlanId: input.importPlanId,
      }), committed: true, alreadyCommitted: true };
      return {
        readyToCommit: false,
        status: "committed",
        importPlanId: input.importPlanId,
        expiresAt: "2026-08-25T18:42:00.000Z",
        previewDigest: `sha256:${"b".repeat(64)}`,
        summary: { transactionsCreated: 1, transactionsReused: 0, lineItemsCreated: 2,
          lineItemsReused: 0, rejectedTransactions: 0 },
        commitResult,
        alreadyCommitted: true,
      };
    },
    async previewTransactionDeletion(input) {
      previewedTransactionDeletion = input;
      const summary = { scope: input.scope, transactionCount: 13, lineItemCount: 31,
        exchangeRateCount: 0, tagAssignmentCount: 0, affectedAccountCount: 9,
        transactionStates: { draft: 0, posted: 13, voided: 0 },
        dateRange: { first: "2025-04-11", last: "2026-07-29" } };
      return { readyToCommit: true, deletionPlanId: "55555555-5555-4555-8555-555555555555",
        status: "ready", expiresAt: "2026-08-27T23:35:00.000Z", previewDigest: `sha256:${"c".repeat(64)}`,
        summary, preview: { ...summary, targetDigest: `sha256:${"d".repeat(64)}`,
          effect: "permanently_delete_exact_transactions_and_dependent_postings",
          accountsPreserved: true, accountTreeChanged: false } };
    },
    async refreshTransactionDeletionPlan(input) {
      return this.previewTransactionDeletion({ ...input, scope: "all" });
    },
    async getTransactionDeletionPlan(input) {
      return { readyToCommit: false, deletionPlanId: input.deletionPlanId, status: "invalidated",
        expiresAt: "2026-08-27T23:35:00.000Z", previewDigest: `sha256:${"c".repeat(64)}`,
        invalidationCode: "DATABASE_STATE_CHANGED",
        summary: { scope: "all", transactionCount: 13, lineItemCount: 31,
          exchangeRateCount: 0, tagAssignmentCount: 0, affectedAccountCount: 9,
          transactionStates: { draft: 0, posted: 13, voided: 0 },
          dateRange: { first: "2025-04-11", last: "2026-07-29" } } };
    },
    async commitTransactionDeletion(input) {
      if (input.previewDigest === `sha256:${"0".repeat(64)}`) {
        throw Object.assign(new Error("The supplied preview digest does not match this deletion plan."), {
          code: "TRANSACTION_DELETE_PREVIEW_MISMATCH", status: 409,
        });
      }
      committedTransactionDeletion = input;
      return { readyToCommit: false, deletionPlanId: input.deletionPlanId, status: "committed",
        expiresAt: "2026-08-27T23:35:00.000Z", previewDigest: input.previewDigest,
        summary: { scope: "all", transactionCount: 13, lineItemCount: 31,
          exchangeRateCount: 0, tagAssignmentCount: 0, affectedAccountCount: 9,
          transactionStates: { draft: 0, posted: 13, voided: 0 },
          dateRange: { first: "2025-04-11", last: "2026-07-29" } },
        deleted: { transactionCount: 13, lineItemCount: 31, exchangeRateCount: 0, tagAssignmentCount: 0 },
        importReferences: { deletedAuditReferences: 0, reopenedImportJobs: 0 },
        verification: { targetTransactionsAbsent: true, accountTreeUnchanged: true, accountCount: 273 },
        alreadyCommitted: false };
    },
  };
  const server = createAccountingMcpServer({ personId: 7, pool: {}, services });
  assert.equal(server.server.getCapabilities().tools.listChanged, true);
  const client = new Client({ name: "accounting-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), Object.keys(accountingToolDescriptions).sort());
  assert.deepEqual(validateDiscoveredMcpTools(tools.tools, {
    serverName: "Accounting",
    serverInfo: { name: "chapeaux-fous-accounting" },
  }), { owned: true, objectTypeCount: 5 });
  for (const tool of tools.tools) {
    assert.equal(catalogToolDescription({ ...tool, metadata: tool._meta }).status, "validated", tool.name);
  }
  const objectTools = tools.tools.filter((tool) => tool._meta?.["agent-slayer/objects"]);
  assert.deepEqual(objectTools.map(({ name }) => name), [
    "list_account_objects", "list_transaction_objects", "list_accounting_question_objects",
    "list_transaction_import_job_objects", "list_balance_assertion_objects",
  ]);
  const describedTypes = new Map();
  for (const tool of objectTools) {
    const description = validateObjectDescription(tool._meta["agent-slayer/objects"], {
      annotations: tool.annotations,
      selection: tool._meta["agent-slayer/selection"],
      label: tool.name,
    });
    for (const type of description.types) {
      assert.equal(describedTypes.has(type.id), false);
      describedTypes.set(type.id, type);
    }
  }
  assert.deepEqual([...describedTypes.keys()], [
    "accounting.account", "accounting.transaction", "accounting.question",
    "accounting.transaction_import_job", "accounting.balance_assertion",
  ]);
  const schemaDescription = await client.callTool({
    name: "describe_accounting_schema", arguments: { request: "accounts" },
  });
  assert.equal(schemaDescription.structuredContent.tables[0].columns[0].comment, "Name of this ledger account");
  assert.equal(Object.hasOwn(schemaDescription.structuredContent, "schemaProjection"), false);
  assert.match(catalogToolDescription({
    ...tools.tools.find(({ name }) => name === "list_accounts"),
    metadata: tools.tools.find(({ name }) => name === "list_accounts")._meta,
  }).summary, /Coinbase Bitcoin account/);
  assert.equal(tools.tools.some((tool) => tool.name === "describe_accounting_schema"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "create_transaction"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_account_tree_import"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_account_tree_import_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "import_transactions"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_transaction_import"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_transaction_import_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_transaction_import_schema"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "create_transaction_import_job"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "stage_transaction_import_artifact"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "stage_transaction_import_chunk"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "retry_transaction_import_exception"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "exclude_transaction_import_exception"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "list_transaction_import_jobs"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_transaction_import_job"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "list_transaction_import_exceptions"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "preview_transaction_import_job"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_transaction_import_job"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_statement_reconciliation_context"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "analyze_statement_observations"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "list_reference_rates"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "create_reference_rates"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_reference_rate_import_schema"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "import_reference_rates_artifact"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "create_reference_rate"), false);
  assert.equal(tools.tools.find((tool) => tool.name === "import_reference_rates_artifact")
    ._meta["agent-slayer/artifactUpload"].transportId, "reference_rate_import");
  assert.equal(tools.tools.some((tool) => tool.name === "start_single_account_statement_import"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "import_single_account_statement"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "reconcile_account_through_date"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "search_transactions"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "preview_delete_transactions"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "refresh_transaction_delete_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_transaction_delete_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_delete_transactions"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "update_account"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "preview_delete_account"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "get_account_delete_plan"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "commit_delete_account"), true);
  assert.equal(tools.tools.every((tool) => tool.outputSchema?.type === "object"), true);
  assert.equal(tools.tools.every((tool) => ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]
    .every((annotation) => typeof tool.annotations?.[annotation] === "boolean")), true);
  assert.equal(tools.tools.find((tool) => tool.name === "list_accounts").annotations.readOnlyHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "list_account_objects").annotations.readOnlyHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "create_account").annotations.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "create_currency").annotations.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "import_account_tree").annotations.idempotentHint, false);
  assert.match(tools.tools.find((tool) => tool.name === "create_currency").description, /Never guess or choose a default scale/);
  assert.match(tools.tools.find((tool) => tool.name === "get_statement_reconciliation_context").description,
    /network fees make sent and received quantities differ/);
  assert.match(tools.tools.find((tool) => tool.name === "get_statement_reconciliation_context").description,
    /separate explicit fees from inferred spread or margin/);
  assert.match(tools.tools.find((tool) => tool.name === "analyze_statement_observations").description,
    /CSV, PDF, OCR, or a screenshot/);
  assert.match(tools.tools.find((tool) => tool.name === "analyze_statement_observations").description,
    /Same date and amount without stable identity remains a review candidate/);
  assert.match(tools.tools.find((tool) => tool.name === "list_reference_rates").description,
    /Never let a price replace an account's actual statement quantity/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /even when new currency details or scales are unknown/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /entire intended batch/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /status=needs_input/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /numerical created\/reused summaries/);
  assert.match(tools.tools.find((tool) => tool.name === "import_account_tree").description, /nextAction\.onApproval/);
  assert.match(tools.tools.find((tool) => tool.name === "commit_account_tree_import").description, /only import_plan_id/);
  const accountTreeOutputSchema = tools.tools.find((tool) => tool.name === "import_account_tree").outputSchema;
  assert.match(JSON.stringify(accountTreeOutputSchema), /readyToCommit/);
  assert.match(JSON.stringify(accountTreeOutputSchema), /previewDigest/);
  assert.match(JSON.stringify(accountTreeOutputSchema), /expiresAt/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /source-neutral/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /unknown or ambiguous paths/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /does not parse CSV/);
  assert.match(tools.tools.find((tool) => tool.name === "import_transactions").description, /confirm each plan sequentially/);
  assert.equal(
    tools.tools.find((tool) => tool.name === "import_transactions").inputSchema.properties.transactions.maxItems,
    1000,
  );
  assert.equal(tools.tools.find((tool) => tool.name === "commit_transaction_import").annotations.idempotentHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "stage_transaction_import_chunk").annotations.idempotentHint, true);
  const transactionSearchTool = tools.tools.find((tool) => tool.name === "search_transactions");
  assert.equal(transactionSearchTool.annotations.readOnlyHint, true);
  assert.equal(transactionSearchTool.inputSchema.properties.include_account_descendants.default, true);
  assert.equal(transactionSearchTool.inputSchema.properties.amount_sign.default, "either");
  assert.equal(Object.hasOwn(transactionSearchTool.inputSchema.properties, "minimum_amount"), true);
  assert.equal(Object.hasOwn(transactionSearchTool.inputSchema.properties, "maximum_amount"), true);
  assert.match(transactionSearchTool.description, /complete owner-scoped ledger transactions/);
  assert.deepEqual(transactionSearchTool._meta["agent-slayer/selection"], {
    protocol: "agent-slayer.tool-description",
    version: 1,
    summary: "Search complete owner-scoped ledger transactions by text, accounts, dates, decimal amount or range, identifiers, currency, source, or retained issue evidence. Select this instead of list_transactions whenever any filter is needed.",
    actionClasses: ["READ"],
    effectClassifications: ["READ-ONLY"],
  });
  const artifactImportTool = tools.tools.find((tool) => tool.name === "stage_transaction_import_artifact");
  const createImportJobTool = tools.tools.find((tool) => tool.name === "create_transaction_import_job");
  assert.equal(artifactImportTool.annotations.idempotentHint, true);
  assert.deepEqual(artifactImportTool._meta["agent-slayer/artifactUpload"], {
    contractVersion: 1,
    transportId: "transaction_import",
    endpointPath: "/mcp/artifacts",
    acceptedMediaTypes: ["application/x-ndjson"],
    maximumChunkBytes: 1024 * 1024,
    maximumBytes: 64 * 1024 * 1024,
  });
  assert.equal(artifactImportTool._meta["agent-slayer/artifactInput"], undefined);
  assert.match(createImportJobTool.inputSchema.properties.source_file_sha256.description,
    /original source file before canonical transformation/);
  assert.match(artifactImportTool.description, /without placing its records or transport chunks in model context/);
  assert.equal(tools.tools.find((tool) => tool.name === "retry_transaction_import_exception").annotations.idempotentHint, true);
  assert.match(tools.tools.find((tool) => tool.name === "stage_transaction_import_chunk").description,
    /expected_source_records = newly_staged_records \+ previously_staged_or_reused_records \+ exception_records \+ remaining_records/);
  assert.equal(tools.tools.find((tool) => tool.name === "import_transactions").annotations.idempotentHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "commit_delete_account").annotations.destructiveHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "commit_delete_transactions").annotations.destructiveHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "commit_delete_transactions").annotations.idempotentHint, true);
  assert.match(tools.tools.find((tool) => tool.name === "preview_delete_transactions").description,
    /freezes the exact current owner-scoped transaction IDs/);
  assert.match(tools.tools.find((tool) => tool.name === "commit_delete_transactions").description,
    /verifies absence and account-tree identity/);
  const deletionPreviewInput = tools.tools.find((tool) => tool.name === "preview_delete_transactions").inputSchema;
  assert.match(JSON.stringify(deletionPreviewInput), /anyOf|oneOf/);
  const invalidAllDeletionPreview = await client.callTool({ name: "preview_delete_transactions",
    arguments: { scope: "all", transaction_ids: [1] } });
  assert.equal(invalidAllDeletionPreview.isError, true);
  assert.match(invalidAllDeletionPreview.content[0].text, /Invalid arguments/);
  const invalidSelectedDeletionPreview = await client.callTool({ name: "preview_delete_transactions",
    arguments: { scope: "selected" } });
  assert.equal(invalidSelectedDeletionPreview.isError, true);
  assert.match(invalidSelectedDeletionPreview.content[0].text, /Invalid arguments/);

  const resources = await client.listResources();
  assert.equal(resources.resources.some((resource) => resource.uri === "accounting://manifest/capabilities/v1"), true);
  assert.equal(resources.resources.some((resource) => resource.uri === "accounting://context/currencies/active"), true);
  assert.equal(resources.resources.some((resource) => resource.uri === "accounting://context/objects/accounts"), true);
  assert.equal(resources.resources.some((resource) =>
    resource.uri === "accounting://schemas/transaction-import-record/v1"), true);
  const resourceTemplates = await client.listResourceTemplates();
  assert.equal(resourceTemplates.resourceTemplates.some((template) =>
    template.uriTemplate === "accounting://currencies/{currencyId}"), true);
  assert.equal(resourceTemplates.resourceTemplates.some((template) =>
    template.uriTemplate === "accounting://transaction-delete-plans/{planId}"), true);
  const manifestResource = await client.readResource({ uri: "accounting://manifest/capabilities/v1" });
  const manifest = JSON.parse(manifestResource.contents[0].text);
  assert.equal(manifest.contractVersion, 2);
  assert.equal(manifest.capabilities.some((capability) => capability.id === "accounting.accounts"), true);
  assert.equal(manifest.capabilities.find((capability) => capability.id === "accounting.accounts")
    .aliases.includes("exchange accounts"), true);
  const referenceRateCapability = manifest.capabilities.find((capability) =>
    capability.id === "accounting.reconciliation");
  const referenceRateSchemaTool = tools.tools.find((tool) => tool.name === "get_reference_rate_import_schema");
  const referenceRateImportTool = tools.tools.find((tool) => tool.name === "import_reference_rates_artifact");
  assert.match(referenceRateSchemaTool.description,
    /OHLC historical bars.*close as the price unless the user or source specifies another measure/);
  assert.match(referenceRateSchemaTool.description, /USD close price/);
  assert.match(referenceRateCapability.attachmentHints[0],
    /OHLC historical bars.*close as the price unless the user or source specifies another measure/);
  const referenceRateSchema = await client.callTool({ name: "get_reference_rate_import_schema", arguments: {} });
  assert.equal(referenceRateSchema.structuredContent.maximum_records, 10000);
  for (const guidance of [referenceRateCapability.attachmentHints[0], referenceRateImportTool.description]) {
    assert.match(guidance, /Compare transformedRecordCount with maximum_records/);
    assert.match(guidance, /file_jsonl_partition.*records_per_file.*maximum_records/);
    assert.match(guidance, /Upload (?:and import each part|each part.*import each part)/i);
    assert.match(guidance, /whole artifact(?: as one part)? when it fits/);
    assert.match(guidance, /recover successful per-part import receipts/);
    assert.match(guidance, /continue with parts lacking a successful receipt/);
    assert.match(guidance, /aggregate submittedCount equals transformedRecordCount/);
    assert.match(guidance, /aggregate createdCount plus reusedCount equals aggregate submittedCount/);
  }
  const transactionCapability = manifest.capabilities.find((capability) => capability.id === "accounting.transactions");
  assert.match(transactionCapability.attachmentHints.join(" "), /accounting\.accounts\.active_paths.*resolve its full path and currency once/);
  assert.match(transactionCapability.attachmentHints.join(" "), /one-account source row is not a complete double-entry transaction/);
  assert.match(transactionCapability.attachmentHints.join(" "), /known balances.*get_statement_reconciliation_context.*analyze_statement_observations/);
  assert.match(transactionCapability.attachmentHints.join(" "), /Accounting automatically chooses the nearest owner-scoped reference rate in either currency direction/);
  assert.match(transactionCapability.attachmentHints.join(" "), /A missing counterpart is not a fee/);
  assert.match(tools.tools.find((tool) => tool.name === "get_transaction_import_schema").description,
    /Preserve account quantities exactly.*Accounting selects the nearest owner-scoped reference rate in either direction/);
  assert.match(tools.tools.find((tool) => tool.name === "stage_transaction_import_artifact").description,
    /one-account source row alone cannot balance/);
  assert.match(tools.tools.find((tool) => tool.name === "list_reference_rates").description,
    /Transaction import automatically chooses the nearest rate in either currency direction/);
  assert.match(tools.tools.find((tool) => tool.name === "preview_transaction_import_job").description,
    /When none is ready, direct correction.*without offering to add zero transactions/);
  assert.match(transactionCapability.summary, /permanently delete/);
  assert.equal(transactionCapability.tools.includes("refresh_transaction_delete_plan"), true);
  assert.equal(transactionCapability.tools.includes("stage_transaction_import_artifact"), true);
  assert.equal(manifest.server.artifactUpload.endpointPath, "/mcp/artifacts");
  assert.equal(manifest.server.artifactUpload.maximumChunkBytes, 1024 * 1024);
  const canonicalSchemaResource = await client.readResource({
    uri: "accounting://schemas/transaction-import-record/v1",
  });
  const canonicalSchema = JSON.parse(canonicalSchemaResource.contents[0].text);
  assert.equal(canonicalSchema.additionalProperties, false);
  assert.equal(canonicalSchema.properties.transaction_external_id.type, "string");
  assert.deepEqual(canonicalSchema.properties.transaction_at.type, ["string", "null"]);
  assert.equal(canonicalSchema.required.includes("value_decimal"), false);
  const canonicalSchemaToolResult = await client.callTool({ name: "get_transaction_import_schema", arguments: {} });
  assert.deepEqual(canonicalSchemaToolResult.structuredContent.artifact_upload,
    artifactImportTool._meta["agent-slayer/artifactUpload"]);
  const importJobResult = await client.callTool({
    name: "create_transaction_import_job",
    arguments: {
      source_system: "gnucash_csv_20260827",
      source_file_sha256: `sha256:${"7".repeat(64)}`,
      source_file_name: "source.csv",
      expected_record_count: 17275,
      client_request_id: "file-216-import-v1",
    },
  });
  assert.equal(importJobResult.structuredContent.job.import_job_id,
    "0ed8cb57-efb5-419e-b4e5-59b73724f224");
  assert.equal(Object.hasOwn(importJobResult.structuredContent, "schemaProjection"), false);
  assert.ok(JSON.stringify(importJobResult.structuredContent).length < 2000);
  assert.deepEqual(createdImportJob, {
    pool: {}, personId: 7, sourceSystem: "gnucash_csv_20260827",
    sourceFileSha256: `sha256:${"7".repeat(64)}`, sourceFileName: "source.csv",
    expectedRecordCount: 17275, clientRequestId: "file-216-import-v1",
  });
  const importJobPreviewTool = tools.tools.find((tool) => tool.name === "preview_transaction_import_job");
  assert.match(JSON.stringify(importJobPreviewTool.outputSchema), /request_user_confirmation/);
  assert.match(JSON.stringify(importJobPreviewTool.outputSchema), /commit_transaction_import_job/);
  const importJobPreview = await client.callTool({
    name: "preview_transaction_import_job",
    arguments: { import_job_id: "0ed8cb57-efb5-419e-b4e5-59b73724f224" },
  });
  assert.equal(importJobPreview.structuredContent.job.nextAction.type, "request_user_confirmation");
  assert.match(importJobPreview.structuredContent.job.nextAction.instruction, /^Import succeeded\./);
  assert.doesNotMatch(importJobPreview.structuredContent.job.nextAction.instruction,
    /commit|uncommitted|staged|validat/i);
  assert.doesNotMatch(importJobPreview.structuredContent.job.nextAction.instruction, /ask the user/i);
  assert.deepEqual(previewedImportJob, {
    pool: {}, personId: 7, importJobId: "0ed8cb57-efb5-419e-b4e5-59b73724f224",
  });
  const importJobCommitTool = tools.tools.find((tool) => tool.name === "commit_transaction_import_job");
  const importJobDeferredReference = extractDeferredActionReference({
    tool: "accounting_preview_transaction_import_job",
    toolDefinition: { name: "accounting_preview_transaction_import_job", source: "mcp:accounting",
      upstreamName: "preview_transaction_import_job", parameters: importJobPreviewTool.inputSchema },
    result: importJobPreview.structuredContent,
    requestId: "request-import-preview",
    resolveProviderTool(name) {
      if (name !== "commit_transaction_import_job") return null;
      return { name: "accounting_commit_transaction_import_job", source: "mcp:accounting",
        upstreamName: name, parameters: importJobCommitTool.inputSchema };
    },
  });
  assert.deepEqual(importJobDeferredReference.arguments,
    importJobPreview.structuredContent.job.nextAction.onApproval.arguments);
  assert.match(
    tools.tools.find((tool) => tool.name === "import_account_tree").inputSchema.properties.dry_run.description,
    /Never reduce a file retry/,
  );
  assert.match(
    tools.tools.find((tool) => tool.name === "import_account_tree").inputSchema.properties.currencies.items.properties.scale.description,
    /Omit this when unknown/,
  );

  const currenciesResult = await client.callTool({ name: "list_currencies", arguments: {} });
  assert.equal(currenciesResult.structuredContent.currencies[0].displayName, "Bitcoin");

  const transactionSearch = await client.callTool({
    name: "search_transactions",
    arguments: { minimum_amount: "10.00", maximum_amount: "20.00", currency_code: "usd" },
  });
  assert.equal(transactionSearch.structuredContent.status, "success");
  assert.equal(transactionSearch.structuredContent.totalMatches, 0);
  assert.equal(transactionSearch.structuredContent.resultMetadata.complete, true);
  assert.deepEqual(searchedTransactionFilters, {
    personId: 7,
    options: {
      text: undefined, accountId: undefined, includeAccountDescendants: true,
      counterAccountId: undefined, includeCounterAccountDescendants: true,
      date: undefined, dateFrom: undefined, dateTo: undefined,
      amount: undefined, amountTolerance: "0", minimumAmount: "10.00", maximumAmount: "20.00",
      amountSign: "either", transactionId: undefined, externalId: undefined, reference: undefined,
      currencyCode: "usd", source: undefined, hasIssues: undefined,
      sortBy: "date", sortDirection: "desc", limit: 25, cursor: undefined,
    },
  });

  const createCurrencyResult = await client.callTool({
    name: "create_currency",
    arguments: {
      code: "VTSAX",
      display_name: "Vanguard Total Stock Market Index Fund Admiral Shares",
      currency_type: "security",
      scale: 4,
    },
  });
  assert.deepEqual(createdCurrency, {
    pool: {}, personId: 7, code: "VTSAX",
    displayName: "Vanguard Total Stock Market Index Fund Admiral Shares",
    type: "security", scale: 4,
  });
  assert.equal(createCurrencyResult.structuredContent.contractVersion, 2);
  assert.equal(createCurrencyResult.structuredContent.status, "success");
  assert.equal(createCurrencyResult.structuredContent.effectReceipt.tool, "create_currency");
  assert.match(createCurrencyResult.structuredContent.effectReceipt.argumentsSha256, /^sha256:/);
  const currencyLink = createCurrencyResult.content.find((item) => item.type === "resource_link");
  assert.equal(currencyLink.uri, "accounting://currencies/12");
  const currencyResource = await client.readResource({ uri: currencyLink.uri });
  assert.equal(JSON.parse(currencyResource.contents[0].text).currency.id, 12);

  const result = await client.callTool({ name: "list_accounts", arguments: {} });
  assert.deepEqual(seen, ["currencies:7", 7]);
  assert.equal(result.structuredContent.contractVersion, 2);
  assert.equal(result.structuredContent.accounts[0].name, "Wallet");
  assert.equal(Object.hasOwn(result.structuredContent, "schemaProjection"), false);

  const importResult = await client.callTool({
    name: "import_account_tree",
    arguments: {
      currencies: [{
        code: "VTSAX",
        display_name: "Vanguard Total Stock Market Index Fund Admiral Shares",
        currency_type: "security",
        scale: 4,
      }],
      accounts: [{
        full_name: "Assets:Bank",
        account_type: "asset",
        currency_code: "USD",
        description: "Primary bank grouping",
        placeholder: true,
      }],
      dry_run: true,
    },
  });
  assert.deepEqual(imported.accounts, [{
    fullName: "Assets:Bank",
    type: "asset",
    currencyCode: "USD",
    description: "Primary bank grouping",
    placeholder: true,
  }]);
  assert.deepEqual(imported.currencies, [{
    code: "VTSAX",
    displayName: "Vanguard Total Stock Market Index Fund Admiral Shares",
    type: "security",
    scale: 4,
  }]);
  assert.equal(importResult.structuredContent.readyToCommit, true);
  assert.equal(importResult.structuredContent.preview.plannedCount, 1);
  assert.equal(importResult.structuredContent.summary.accountsCreated, 1);
  assert.equal(importResult.structuredContent.requiredAction, "REQUEST_USER_CONFIRMATION");
  assert.deepEqual(importResult.structuredContent.nextAction.onApproval, {
    tool: "commit_account_tree_import",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.deepEqual(seen, ["currencies:7", 7, "currencies:7"]);
  const accountObjects = await client.callTool({ name: "list_account_objects", arguments: {} });
  assert.deepEqual(accountObjects.structuredContent.objects[0], {
    objectType: "accounting.account", id: 10, sourceRef: "accounting://accounts/10",
    displayName: "Wallet", parentAccountId: null, accountType: "asset", currencyId: 1,
    currencyCode: "USD", scale: 2, postable: true, archived: false,
    actions: [{ id: "import_statement", label: "Import statement",
      tool: "start_single_account_statement_import" }],
  });
  assert.deepEqual(accountObjects.structuredContent.resultMetadata.sourceRefs, ["accounting://accounts/10"]);
  for (const object of accountObjects.structuredContent.objects) {
    const type = describedTypes.get(object.objectType);
    assert.ok(type);
    assert.equal(typeof object[type.reference.field], "string");
    assert.ok(object[type.reference.field]);
    assert.equal(typeof object[type.display.field], "string");
    assert.ok(object[type.display.field]);
    for (const qualifier of type.qualifiers) assert.equal(Object.hasOwn(object, qualifier.field), true);
  }
  const accountObjectResource = await client.readResource({ uri: "accounting://context/objects/accounts" });
  const objectIndex = JSON.parse(accountObjectResource.contents[0].text);
  assert.equal(objectIndex.contextView, "accounting.objects.accounts");
  assert.equal(objectIndex.objects[0].sourceRef, "accounting://accounts/10");

  const missingScales = await client.callTool({
    name: "import_account_tree",
    arguments: {
      currencies: [
        { code: "VIGIX", display_name: "Vanguard Growth Index Fund", currency_type: "security" },
        { code: "S5L", display_name: "Shiloh's Five Loaves", currency_type: "security", scale: null },
      ],
      accounts: [
        { full_name: "Assets:VIGIX", account_type: "asset", currency_code: "VIGIX" },
        { full_name: "Assets:S5L", account_type: "asset", currency_code: "S5L" },
      ],
      dry_run: true,
    },
  });
  assert.equal(missingScales.structuredContent.status, "needs_input");
  assert.equal(missingScales.structuredContent.requiredAction, "ASK_USER_FOR_CURRENCY_SCALES");
  assert.equal(missingScales.structuredContent.batchSummary.accountCount, 2);
  assert.deepEqual(missingScales.structuredContent.missingCurrencies.map((currency) => currency.code), ["S5L", "VIGIX"]);
  assert.equal(missingScales.structuredContent.nextAction.tool, "import_account_tree");
  assert.equal(missingScales.structuredContent.retry.protocol, "agent-slayer.retry-descriptor");
  assert.equal(missingScales.structuredContent.retry.preserve_complete_original_batch, true);
  assert.equal(imported.accounts.length, 1);

  const planStatus = await client.callTool({
    name: "get_account_tree_import_plan",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.equal(planStatus.structuredContent.status, "ready");
  assert.deepEqual(readAccountPlan, {
    pool: {}, personId: 7, importPlanId: "11111111-1111-4111-8111-111111111111",
  });

  const missingPlan = await client.callTool({
    name: "get_account_tree_import_plan",
    arguments: { import_plan_id: "22222222-2222-4222-8222-222222222222" },
  });
  assert.equal(missingPlan.isError, true);
  assert.equal(missingPlan.structuredContent.contractVersion, 2);
  assert.equal(missingPlan.structuredContent.status, "error");
  assert.equal(missingPlan.structuredContent.code, "IMPORT_PLAN_NOT_FOUND");
  assert.equal(missingPlan.structuredContent.recoverable, true);
  assert.equal(missingPlan.structuredContent.requiredAction, "RUN_NEW_DRY_RUN");

  await client.callTool({
    name: "commit_account_tree_import",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.deepEqual(committedAccountPlan, {
    pool: {}, personId: 7, importPlanId: "11111111-1111-4111-8111-111111111111",
  });

  for (const [planId, code] of [
    ["33333333-3333-4333-8333-333333333333", "IMPORT_PLAN_EXPIRED"],
    ["44444444-4444-4444-8444-444444444444", "IMPORT_PLAN_STATE_CONFLICT"],
  ]) {
    const failure = await client.callTool({
      name: "commit_account_tree_import", arguments: { import_plan_id: planId },
    });
    assert.equal(failure.isError, true);
    assert.equal(failure.structuredContent.status, "error");
    assert.equal(failure.structuredContent.code, code);
    assert.equal(failure.structuredContent.recoverable, true);
    assert.equal(failure.structuredContent.requiredAction, "RUN_NEW_DRY_RUN");
  }

  const transactionPreview = await client.callTool({
    name: "import_transactions",
    arguments: {
      source_system: "source_app",
      transactions: [{
        external_id: "tx-1",
        transaction_date: "2026-01-01",
        description: "Test",
        valuation_currency_code: "USD",
        line_items: [
          { external_id: "1", account_full_name: "Assets:Cash", amount_decimal: "-1.00" },
          { external_id: "2", account_full_name: "Expenses:Food", amount_decimal: "1.00" },
        ],
      }],
      dry_run: true,
    },
  });
  assert.equal(transactionPreview.structuredContent.import.wouldCreateTransactionCount, 1);
  assert.equal(transactionPreview.structuredContent.import.requiredAction, "REQUEST_USER_CONFIRMATION");
  assert.match(transactionPreview.structuredContent.import.nextAction.instruction, /^Commit .+\?/);
  assert.deepEqual(importedTransactions.transactions[0].lineItems[0], {
    externalId: "1", accountFullName: "Assets:Cash", amountDecimal: "-1.00",
    valueDecimal: undefined, memo: undefined, reconciliationState: "unreconciled",
  });

  const reconciledPreview = await client.callTool({
    name: "import_transactions",
    arguments: {
      source_system: "source_app",
      transactions: [{
        external_id: "tx-1", transaction_date: "2026-01-01", description: "Test",
        valuation_currency_code: "USD",
        line_items: [
          { external_id: "1", account_full_name: "Assets:Cash", amount_decimal: "-1.00" },
          { external_id: "2", account_full_name: "Expenses:Food", amount_decimal: "1.00" },
        ],
      }],
      reconciliation: { account_ids: [10], opening_balance_date: "2025-12-31",
        closing_balance_date: "2026-01-31" },
      dry_run: true,
    },
  });
  assert.equal(reconciledPreview.structuredContent.import.reconciliationValidation.passed, true);
  assert.deepEqual(importedTransactions.reconciliation, { accountIds: [10],
    openingBalanceDate: "2025-12-31", closingBalanceDate: "2026-01-31" });

  const statementGuide = await client.callTool({
    name: "start_single_account_statement_import", arguments: { account_id: 10 },
  });
  assert.deepEqual(statementGuide.structuredContent.orderedQuestions.map((question) => question.key),
    ["beginning_balance", "ending_balance", "line_items", "available_text"]);
  assert.match(statementGuide.structuredContent.orderedQuestions[0].prompt,
    /end-of-day balance immediately before the first included date/);
  const missingStatementBalance = await client.callTool({
    name: "import_single_account_statement",
    arguments: {
      statement_id: "missing-balance", account_id: 10, suspense_account_id: 11,
      beginning_balance: { found: false, date: null, date_meaning: null, amount_decimal: null },
      ending_balance: { found: true, date: "2026-01-31", amount_decimal: "87.50" },
      line_items: [{ source_record_id: "row-1", transaction_date: "2026-01-05",
        available_text: "ACME", amount_decimal: "-12.50" }],
      dry_run: true,
    },
  });
  assert.equal(missingStatementBalance.isError, true);
  assert.equal(missingStatementBalance.structuredContent.requiredAction, "ASK_USER_FOR_MISSING_DATED_BALANCE");
  assert.deepEqual(savedStatementBalances, []);

  const oneSidedPreview = await client.callTool({
    name: "import_single_account_statement",
    arguments: {
      statement_id: "bank-statement-2026-01", account_id: 10, suspense_account_id: 11,
      beginning_balance: { found: true, date: "2026-01-01",
        date_meaning: "first_included_transaction_date", amount_decimal: "100.00",
        available_text: "Statement period begins January 1" },
      ending_balance: { found: true, date: "2026-01-31", amount_decimal: "87.50", available_text: "Ending balance" },
      line_items: [{ source_record_id: "row-1", transaction_date: "2026-01-05",
        available_text: "ACME", amount_decimal: "-12.50" }],
      dry_run: true,
    },
  });
  assert.equal(oneSidedPreview.structuredContent.import.questionSummary.openQuestionCount, 1);
  assert.deepEqual(savedStatementBalances.map((item) => ({ date: item.balanceDate, units: item.knownBalanceUnits })), [
    { date: "2025-12-31", units: "10000" }, { date: "2026-01-31", units: "8750" },
  ]);
  assert.deepEqual({ ...oneSidedImport, lines: oneSidedImport.lines.map((line) => ({ ...line,
    externalId: line.externalId.replace(/^sha256:[0-9a-f]{64}$/, "sha256:<digest>") })) }, {
    pool: {}, personId: 7, sourceSystem: "single_account_statement", accountId: 10, suspenseAccountId: 11,
    valuationCurrencyCode: "USD", questionAudience: "human",
    lines: [{ externalId: "sha256:<digest>", transactionDate: "2026-01-05", description: "ACME",
      amountDecimal: "-12.5" }],
    reconciliation: { openingBalanceDate: "2025-12-31", closingBalanceDate: "2026-01-31" },
  });

  const marked = await client.callTool({ name: "reconcile_account_through_date", arguments: {
    account_id: 10, balance_date: "2026-01-31",
  } });
  assert.equal(marked.structuredContent.reconciliation.newlyReconciledLineCount, 3);
  assert.deepEqual(reconciledAccount, { pool: {}, personId: 7, accountId: 10,
    balanceDate: "2026-01-31" });

  await client.callTool({
    name: "commit_transaction_import",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.deepEqual(committedTransactionPlan, {
    pool: {}, personId: 7, importPlanId: "11111111-1111-4111-8111-111111111111",
  });

  const transactionPlanStatus = await client.callTool({
    name: "get_transaction_import_plan",
    arguments: { import_plan_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.equal(transactionPlanStatus.structuredContent.status, "committed");
  assert.equal(transactionPlanStatus.structuredContent.commitResult.alreadyCommitted, true);

  const deletionPreview = await client.callTool({
    name: "preview_delete_transactions", arguments: { scope: "all" },
  });
  assert.equal(deletionPreview.structuredContent.requiredAction, "REQUEST_USER_CONFIRMATION");
  assert.match(deletionPreview.structuredContent.nextAction.instruction, /^Permanently delete .+\?/);
  assert.equal(deletionPreview.structuredContent.preview.targetDigest, `sha256:${"d".repeat(64)}`);
  assert.equal("transactionIds" in deletionPreview.structuredContent.preview, false);
  assert.equal(deletionPreview.structuredContent.nextAction.onApproval.tool, "commit_delete_transactions");
  assert.equal(Object.hasOwn(deletionPreview.structuredContent, "schemaProjection"), false);
  assert.deepEqual(previewedTransactionDeletion, { pool: {}, personId: 7, scope: "all", transactionIds: [] });

  const previewTool = tools.tools.find((tool) => tool.name === "preview_delete_transactions");
  const commitTool = tools.tools.find((tool) => tool.name === "commit_delete_transactions");
  const deferredReference = extractDeferredActionReference({
    tool: "accounting_preview_delete_transactions",
    toolDefinition: { name: "accounting_preview_delete_transactions", source: "mcp:accounting",
      upstreamName: "preview_delete_transactions", parameters: previewTool.inputSchema },
    result: deletionPreview.structuredContent,
    requestId: "request-1",
    resolveProviderTool(name) {
      if (name !== "commit_delete_transactions") return null;
      return { name: "accounting_commit_delete_transactions", source: "mcp:accounting",
        upstreamName: name, parameters: commitTool.inputSchema };
    },
  });
  assert.deepEqual(deferredReference.arguments, deletionPreview.structuredContent.nextAction.onApproval.arguments);
  assert.equal(deferredReference.targetUpstreamTool, "commit_delete_transactions");

  const invalidatedDeletionPlan = await client.callTool({
    name: "get_transaction_delete_plan",
    arguments: { deletion_plan_id: "55555555-5555-4555-8555-555555555555" },
  });
  assert.equal(invalidatedDeletionPlan.structuredContent.requiredAction, "RUN_NEW_DELETE_PREVIEW");
  assert.deepEqual(invalidatedDeletionPlan.structuredContent.nextAction, {
    type: "run_provider_tool", tool: "refresh_transaction_delete_plan",
    arguments: { deletion_plan_id: "55555555-5555-4555-8555-555555555555" },
  });

  const mismatchedDeletionCommit = await client.callTool({
    name: "commit_delete_transactions",
    arguments: { deletion_plan_id: "55555555-5555-4555-8555-555555555555",
      preview_digest: `sha256:${"0".repeat(64)}` },
  });
  assert.equal(mismatchedDeletionCommit.isError, true);
  assert.equal(mismatchedDeletionCommit.structuredContent.code, "TRANSACTION_DELETE_PREVIEW_MISMATCH");
  assert.equal(mismatchedDeletionCommit.structuredContent.requiredAction, "USE_BOUND_PREVIEW_ARGUMENTS");

  const deletionCommit = await client.callTool({
    name: "commit_delete_transactions",
    arguments: { deletion_plan_id: "55555555-5555-4555-8555-555555555555",
      preview_digest: `sha256:${"c".repeat(64)}` },
  });
  assert.equal(deletionCommit.structuredContent.verification.accountTreeUnchanged, true);
  assert.deepEqual(committedTransactionDeletion, { pool: {}, personId: 7,
    deletionPlanId: "55555555-5555-4555-8555-555555555555", previewDigest: `sha256:${"c".repeat(64)}` });

  await client.close();
  await server.close();
});

test("the HTTP MCP handler advertises modern tool-list refresh support", async () => {
  const handler = createAccountingMcpHandler({ pool: {} });
  const protocolVersion = "2026-07-28";
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  };
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "server/discover",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify(body),
  }), {
    authInfo: {
      token: "test-token",
      clientId: "accounting-mcp-test",
      scopes: ["accounting"],
      extra: { accountingAuth: { personId: 7, tokenId: 1 } },
    },
    parsedBody: body,
  });

  assert.equal(response.status, 200);
  const discovery = await response.json();
  assert.deepEqual(discovery.result.supportedVersions, [protocolVersion]);
  assert.equal(discovery.result.capabilities.tools.listChanged, true);
  assert.equal(discovery.result._meta["io.modelcontextprotocol/serverInfo"].version, "0.12.0");

  await handler.close();
});
