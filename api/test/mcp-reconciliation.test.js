import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { createAccountingMcpServer } = await import("../src/mcp.js");

const referenceRate = { id: 41, validAt: "2026-08-18T14:32:00.000Z", fromUnits: "100000000",
  fromCurrencyId: 2, fromCurrencyCode: "BTC", fromScale: 8, toUnits: "6123456",
  toCurrencyId: 1, toCurrencyCode: "USD", toScale: 2 };
const openQuestion = {
  lineItemId: 901, transactionId: 81, transactionDate: "2026-08-31",
  transactionDescription: "Balance-derived adjustment", transactionState: "posted",
  accountId: 30, accountName: "Ask Accountant", accountFullName: "Assets:Ask Accountant",
  currencyId: 1, currencyCode: "USD", scale: 2, amountUnits: "-1250", valueUnits: "-1250",
  reconciliationState: "unreconciled", reconciledAt: null,
  memo: "Unexplained statement movement", status: "open", audience: "accountant",
  prompt: "What caused this $12.50 deposit?", resolution: null, resolvedAt: null, targetAccountId: null,
};

test("the MCP exposes grounded multi-statement context and reference prices", async () => {
  const seen = {};
  const reconciliationContext = (input) => ({
    interval: { openingBalanceDate: input.openingBalanceDate, closingBalanceDate: input.closingBalanceDate,
      includedTransactionDates: ">2026-08-01 and <=2026-08-31" },
    accounts: [{ accountId: 10, accountFullName: "Assets:Coinbase BTC", accountType: "asset",
      currencyId: 2, currencyCode: "BTC", scale: 8,
      opening: { assertionId: 101, date: "2026-08-01", knownBalanceUnits: "200000000", calculatedBalanceUnits: "200000000" },
      closing: { assertionId: 102, date: "2026-08-31", knownBalanceUnits: "189900000", calculatedBalanceUnits: "190000000" },
      requiredNormalMovementUnits: "-10100000", postedLineItemMovementUnits: "-10000000",
      remainingLineItemMovementUnits: "-100000", grounded: true, postable: true }],
    grounded: true, evidenceRefs: ["accounting://accounts/10", "accounting://balance-assertions/101",
      "accounting://balance-assertions/102"], missingAssertions: [],
    workflow: { evidenceOrder: ["statement_native_amounts"],
      rules: ["Analyze all statements together before importing."] },
  });
  const services = {
    async getStatementReconciliationContext(input) {
      seen.reconciliation = input;
      return reconciliationContext(input);
    },
    async saveBalanceAssertion(input) {
      seen.saveAssertion = input;
      return { id: 102, accountId: 10, accountName: "Coinbase BTC", date: "2026-08-31",
        knownBalanceUnits: "189900000", calculatedBalanceUnits: "190000000",
        differenceUnits: "-100000", matches: false, currencyId: 2, currencyCode: "BTC", scale: 8 };
    },
    async analyzeStatementObservations(input) {
      seen.observations = input;
      const id = `sha256:${"a".repeat(64)}`;
      return {
        reconciliation: reconciliationContext(input),
        observations: [{ id, sourceDocumentId: "shot-1", sourceRecordId: "region-1", accountId: 10,
          accountFullName: "Assets:Coinbase BTC", currencyId: 2, currencyCode: "BTC", scale: 8,
          transactionDate: "2026-08-18", occurredAt: null, amountDecimal: "-0.00100000",
          amountUnits: "-100000", description: "Send", reference: "tx-abc" }],
        duplicateAnalysis: { ledgerCandidates: [], inputCandidates: [],
          exactLedgerDuplicateObservationIds: [], ambiguousExactLedgerObservationIds: [],
          exactInputDuplicateObservationIds: [],
          unresolvedCandidateCount: 0 },
        transferCandidates: [], ambiguousTransferObservationIds: [], balanceCheckpoints: [],
        importDecisions: [{ observationId: id, decision: "include", confidence: "tentative",
          reason: "No conclusive duplicate evidence was found.", matchedTransactionIds: [],
          balanceCheckpointDate: null }],
        proposedNewObservationIds: [id],
        coverage: [{ accountId: 10, accountFullName: "Assets:Coinbase BTC", currencyCode: "BTC", scale: 8,
          requiredRemainingUnits: "-100000", allExtractedObservationUnits: "-100000",
          proposedNewObservationUnits: "-100000", residualAfterProposedUnits: "0", balanced: true }],
        readyForTransactionAssembly: true,
        rules: ["Only stable source matches are automatically excluded."],
      };
    },
    async listReferenceRatesPage(_pool, personId, input) {
      seen.listRates = { personId, input };
      return { rates: [referenceRate], nextCursor: null };
    },
    async createReferenceRates(input) {
      seen.createRates = input;
      return { submittedCount: 1, createdCount: 1, reusedCount: 0, roundedCount: 0,
        outcomeRuns: [{ startIndex: 0, endIndex: 0, status: "created" }] };
    },
    async importReferenceRatesArtifact(input) {
      seen.importRates = input;
      return { submittedCount: 4889, createdCount: 4881, reusedCount: 8, roundedCount: 4546,
        artifactSha256: `sha256:${"a".repeat(64)}`,
        outcomeRuns: [
          { startIndex: 0, endIndex: 7, status: "reused" },
          { startIndex: 8, endIndex: 4888, status: "created" },
        ] };
    },
    async getReferenceRate(_pool, personId, rateId) {
      seen.getRate = { personId, rateId };
      return referenceRate;
    },
    async listAccountingQuestionsPage(_pool, personId, input) {
      seen.listQuestions = { personId, input };
      return { questions: [openQuestion], nextCursor: null };
    },
    async getAccountingQuestion(_pool, personId, lineItemId) {
      seen.getQuestion = { personId, lineItemId };
      return openQuestion;
    },
    async openAccountingQuestion(input) {
      seen.openQuestion = input;
      return openQuestion;
    },
    async resolveAccountingQuestion(input) {
      seen.resolveQuestion = input;
      return { changed: true, question: { ...openQuestion, accountId: 44, accountName: "Consulting Income",
        accountFullName: "Income:Consulting", status: "resolved", resolution: "Matched receipt",
        resolvedAt: "2026-09-14T12:00:00.000Z", targetAccountId: 44 } };
    },
  };
  const server = createAccountingMcpServer({ personId: 7, pool: {}, services });
  const client = new Client({ name: "accounting-reconciliation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const context = await client.callTool({ name: "get_statement_reconciliation_context", arguments: {
    account_ids: [10], opening_balance_date: "2026-08-01", closing_balance_date: "2026-08-31",
  } });
  assert.equal(context.structuredContent.reconciliation.accounts[0].remainingLineItemMovementUnits, "-100000");
  assert.equal(context.structuredContent.resultMetadata.returned, 3);
  assert.equal(context.content.filter((item) => item.type === "resource_link").length, 3);
  assert.deepEqual(seen.reconciliation, { pool: {}, personId: 7, accountIds: [10],
    openingBalanceDate: "2026-08-01", closingBalanceDate: "2026-08-31" });

  const assertion = await client.callTool({ name: "save_balance_assertion", arguments: {
    account_id: 10, balance_date: "2026-08-31", known_balance_units: "189900000",
  } });
  assert.equal(assertion.structuredContent.investigationQuestion.status, "needs_explanation");
  assert.equal(assertion.structuredContent.investigationQuestion.unexplainedDifferenceUnits, "-100000");
  assert.match(assertion.structuredContent.investigationQuestion.prompt, /How did Coinbase BTC reach/);

  const analysis = await client.callTool({ name: "analyze_statement_observations", arguments: {
    opening_balance_date: "2026-08-01", closing_balance_date: "2026-08-31",
    observations: [{ source_document_id: "shot-1", source_record_id: "region-1", account_id: 10,
      transaction_date: "2026-08-18", amount_decimal: "-0.00100000", description: "Send",
      reference: "tx-abc" }],
  } });
  assert.equal(analysis.structuredContent.analysis.readyForTransactionAssembly, true);
  assert.equal(analysis.structuredContent.analysis.coverage[0].residualAfterProposedUnits, "0");

  const listed = await client.callTool({ name: "list_reference_rates", arguments: {
    from_currency_id: 2, to_currency_id: 1,
    valid_at_from: "2026-08-18T00:00:00.000Z", valid_at_to: "2026-08-18T23:59:59.000Z",
  } });
  assert.equal(listed.structuredContent.referenceRates[0].fromCurrencyCode, "BTC");
  assert.equal(listed.structuredContent.resultMetadata.complete, true);

  const created = await client.callTool({ name: "create_reference_rates", arguments: { rates: [{
    valid_at: "2026-08-18T14:32:00.000Z", from_decimal: "1", from_currency_id: 2,
    to_decimal: "61234.56", to_currency_id: 1,
  }] } });
  assert.equal(created.structuredContent.effectReceipt.tool, "create_reference_rates");
  assert.equal(created.structuredContent.createdCount, 1);
  const schema = await client.callTool({ name: "get_reference_rate_import_schema", arguments: {} });
  assert.equal(schema.structuredContent.canonical_schema.required.includes("to_decimal"), true);
  assert.equal(schema.structuredContent.artifact_upload.transportId, "reference_rate_import");
  const importedRates = await client.callTool({ name: "import_reference_rates_artifact", arguments: {
    artifact_id: "11111111-1111-4111-8111-111111111111",
  } });
  assert.equal(importedRates.structuredContent.createdCount, 4881);
  assert.equal(importedRates.structuredContent.effectReceipt.tool, "import_reference_rates_artifact");
  assert.deepEqual(seen.importRates, { pool: {}, artifactRoot: undefined, personId: 7,
    artifactId: "11111111-1111-4111-8111-111111111111" });
  const resource = await client.readResource({ uri: "accounting://reference-rates/41" });
  assert.equal(JSON.parse(resource.contents[0].text).referenceRate.id, 41);
  assert.deepEqual(seen.getRate, { personId: 7, rateId: "41" });

  const questions = await client.callTool({ name: "list_accounting_questions", arguments: {
    status: "open", audience: "accountant",
  } });
  assert.equal(questions.structuredContent.questions[0].lineItemId, 901);
  assert.deepEqual(questions.structuredContent.resultMetadata.sourceRefs, ["accounting://questions/901"]);
  assert.deepEqual(seen.listQuestions, { personId: 7, input: {
    status: "open", audience: "accountant", accountId: undefined, limit: 100, afterLineItemId: undefined,
  } });

  const opened = await client.callTool({ name: "open_accounting_question", arguments: {
    line_item_id: 901, audience: "accountant", prompt: "What caused this $12.50 deposit?",
  } });
  assert.equal(opened.structuredContent.question.status, "open");
  assert.equal(opened.structuredContent.effectReceipt.entityRefs[0].id, 901);

  const resolved = await client.callTool({ name: "resolve_accounting_question", arguments: {
    line_item_id: 901, target_account_id: 44, resolution: "Matched receipt",
  } });
  assert.equal(resolved.structuredContent.question.status, "resolved");
  assert.equal(resolved.structuredContent.changed, true);
  assert.deepEqual(seen.resolveQuestion, { pool: {}, personId: 7, lineItemId: 901,
    targetAccountId: 44, resolution: "Matched receipt" });

  const questionResource = await client.readResource({ uri: "accounting://questions/901" });
  assert.equal(JSON.parse(questionResource.contents[0].text).question.lineItemId, 901);
  assert.deepEqual(seen.getQuestion, { personId: 7, lineItemId: "901" });

  await client.close();
  await server.close();
});
