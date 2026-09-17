import test from "node:test";
import assert from "node:assert/strict";
import {
  commitTransactionImportJob,
  excludeTransactionImportException,
  getTransactionImportJob,
  groupCanonicalTransactionRecords,
  previewTransactionImportJob,
  retryTransactionImportException,
  TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI,
  transactionImportCanonicalJsonSchema,
} from "../src/transaction-import-job.js";
import {
  parseCanonicalTransactionArtifact,
  TRANSACTION_IMPORT_ARTIFACT_MEDIA_TYPES,
} from "../src/artifact-upload.js";
import { analyzeTransactionImport, normalizeTransactionImport } from "../src/transaction-import.js";

test("a committed job keeps its current job shape when its stored result predates that shape", async () => {
  const importJobId = "0ed8cb57-efb5-419e-b4e5-59b73724f224";
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql) {
      if (sql.includes("FROM accounting_transaction_import_jobs")) return [[{
        import_job_id: importJobId, owner_person_id: 7, source_system: "source_app",
        source_file_sha256: "7".repeat(64), source_file_name: "source.csv",
        expected_record_count: 4, job_status: "committed", preview_sha256: "8".repeat(64),
        result_json: JSON.stringify({ committed: true, transactions_created: 1 }),
      }]];
      if (sql.includes("COALESCE(SUM(CASE")) return [[{
        staged_records: 2, committed_records: 2, exception_records: 2, received_records: 4,
        committed_transactions: 1, exception_transactions: 1,
      }]];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await getTransactionImportJob({
    pool: { async getConnection() { return connection; } }, personId: 7, importJobId,
  });
  assert.equal(result.import_job_id, importJobId);
  assert.equal(result.source_file.name, "source.csv");
  assert.equal(result.job_status, "committed");
  assert.equal(result.progress.expected_source_records, 4);
  assert.equal(result.transactions_created, 1);
  assert.equal(result.already_committed, true);
  assert.equal(result.ready_to_commit, false);
});

test("the canonical import schema is exact, source-neutral, and line-oriented", () => {
  assert.equal(transactionImportCanonicalJsonSchema.$id, TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI);
  assert.equal(transactionImportCanonicalJsonSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(transactionImportCanonicalJsonSchema.additionalProperties, false);
  assert.deepEqual(transactionImportCanonicalJsonSchema.required, [
    "transaction_external_id",
    "transaction_date",
    "valuation_currency_code",
    "account_full_name",
    "amount_decimal",
  ]);
  assert.equal(transactionImportCanonicalJsonSchema.required.includes("value_decimal"), false);
  assert.deepEqual(transactionImportCanonicalJsonSchema.properties.line_external_id.type, ["string", "null"]);
  assert.deepEqual(transactionImportCanonicalJsonSchema.properties.transaction_at.type, ["string", "null"]);
  assert.equal(transactionImportCanonicalJsonSchema.required.includes("transaction_at"), false);
  assert.deepEqual(transactionImportCanonicalJsonSchema.properties.fee_account_full_name.type, ["string", "null"]);
  assert.match(transactionImportCanonicalJsonSchema.properties.amount_decimal.description, /Exact signed account-currency quantity/);
  assert.match(transactionImportCanonicalJsonSchema.properties.value_decimal.description,
    /replaces it with the nearest reference-rate valuation/);
  assert.doesNotMatch(JSON.stringify(transactionImportCanonicalJsonSchema), /csv|gnucash/i);
  const [withoutSourceValue] = groupCanonicalTransactionRecords([{
    transaction_external_id: "source-value-omitted", transaction_date: "2026-09-01",
    transaction_at: "2026-09-01T23:00:00Z", valuation_currency_code: "USD",
    account_full_name: "Assets:Bitcoin", amount_decimal: "-0.01",
  }]);
  assert.deepEqual(withoutSourceValue.errors, []);
  assert.equal(withoutSourceValue.transaction.transactionAt, "2026-09-01T23:00:00Z");
});

test("canonical line records are grouped by stable transaction identity with complete context", () => {
  const records = [
    { transaction_external_id: "tx-2", line_external_id: "1", transaction_date: "2026-02-01",
      description: "Second", valuation_currency_code: "USD", account_full_name: "Assets:Bank",
      amount_decimal: "-2.00", value_decimal: "-2.00" },
    { transaction_external_id: "tx-1", line_external_id: null, transaction_date: "2026-01-01",
      description: "First", valuation_currency_code: "USD", account_full_name: "Assets:Bank",
      amount_decimal: "-1.00", value_decimal: "-1.00" },
    { transaction_external_id: "tx-2", line_external_id: "2", transaction_date: "2026-02-01",
      description: "Second", valuation_currency_code: "USD", account_full_name: "Expenses:Food",
      amount_decimal: "2.00", value_decimal: "2.00", memo: "lunch" },
    { transaction_external_id: "tx-1", line_external_id: null, transaction_date: "2026-01-01",
      description: "First", valuation_currency_code: "USD", account_full_name: "Expenses:Food",
      amount_decimal: "1.00", value_decimal: "1.00" },
  ];
  const groups = groupCanonicalTransactionRecords(records);
  assert.deepEqual(groups.map((group) => group.externalId), ["tx-2", "tx-1"]);
  assert.equal(groups[0].transaction.lineItems.length, 2);
  assert.equal(groups[0].transaction.lineItems[1].memo, "lunch");
  assert.deepEqual(groups[0].errors, []);
  assert.equal(Object.hasOwn(groups[0].canonicalRecords[0], "_sourceOrdinal"), false);
});

test("canonical records carry paired accounting-question fields into the suspense line", () => {
  const [group] = groupCanonicalTransactionRecords([{
    transaction_external_id: "balance-derived-1", line_external_id: "question-line",
    transaction_date: "2026-08-31", description: "Balance-derived adjustment",
    valuation_currency_code: "USD", account_full_name: "Assets:Ask Accountant",
    amount_decimal: "-12.50", value_decimal: "-12.50",
    question_audience: "accountant", question_prompt: "What caused this deposit?",
  }]);
  assert.deepEqual(group.errors, []);
  assert.deepEqual(group.transaction.lineItems[0].question, {
    audience: "accountant", prompt: "What caused this deposit?",
  });

  const [invalid] = groupCanonicalTransactionRecords([{
    transaction_external_id: "balance-derived-2", transaction_date: "2026-08-31",
    valuation_currency_code: "USD", account_full_name: "Assets:Ask Accountant",
    amount_decimal: "-1.00", value_decimal: "-1.00", question_audience: "human",
  }]);
  assert.equal(invalid.errors.some((error) => error.code === "INCOMPLETE_ACCOUNTING_QUESTION"), true);
});

test("inconsistent transaction-level fields become a group exception instead of aborting other groups", () => {
  const groups = groupCanonicalTransactionRecords([
    { transaction_external_id: "bad", transaction_date: "2026-01-01", valuation_currency_code: "USD",
      account_full_name: "Assets:Bank", amount_decimal: "-1", value_decimal: "-1" },
    { transaction_external_id: "bad", transaction_date: "2026-01-02", valuation_currency_code: "USD",
      account_full_name: "Expenses:Food", amount_decimal: "1", value_decimal: "1" },
    { transaction_external_id: "good", transaction_date: "2026-01-03", valuation_currency_code: "USD",
      account_full_name: "Assets:Bank", amount_decimal: "-2", value_decimal: "-2" },
    { transaction_external_id: "good", transaction_date: "2026-01-03", valuation_currency_code: "USD",
      account_full_name: "Expenses:Food", amount_decimal: "2", value_decimal: "2" },
  ]);
  assert.equal(groups[0].errors[0].code, "INCONSISTENT_TRANSACTION_CONTEXT");
  assert.deepEqual(groups[1].errors, []);
});

test("canonical artifacts package the canonical record model as JSON Lines", () => {
  const records = [{ transaction_external_id: "tx-1", transaction_date: "2026-01-01",
    valuation_currency_code: "USD", account_full_name: "Assets:Bank",
    amount_decimal: "-1.00", value_decimal: "-1.00" }];
  assert.deepEqual(parseCanonicalTransactionArtifact(
    Buffer.from(`${JSON.stringify(records[0])}\n`), "application/x-ndjson"), records);
  assert.equal(TRANSACTION_IMPORT_ARTIFACT_MEDIA_TYPES.includes("application/x-ndjson"), true);
});

test("canonical artifacts reject malformed packaging without confusing it with transaction validation", () => {
  assert.throws(() => parseCanonicalTransactionArtifact(Buffer.from("{bad}\n"), "application/x-ndjson"),
    (error) => error.code === "INVALID_CANONICAL_ARTIFACT_JSON" && error.details.line_number === 1);
  assert.throws(() => parseCanonicalTransactionArtifact(Buffer.from([0xc3, 0x28]), "application/x-ndjson"),
    (error) => error.code === "INVALID_CANONICAL_ARTIFACT_UTF8");
  assert.throws(() => parseCanonicalTransactionArtifact(Buffer.from("[]"), "text/csv"),
    (error) => error.code === "UNSUPPORTED_TRANSACTION_IMPORT_ARTIFACT" && error.status === 415);
});

test("records outside the authoritative schema become transaction exceptions", () => {
  const groups = groupCanonicalTransactionRecords([
    { transaction_external_id: "bad", transaction_date: "2026-01-01", valuation_currency_code: "USD",
      account_full_name: "Assets:Bank", amount_decimal: "-1", value_decimal: "-1", invented: true },
    { transaction_external_id: "good", transaction_date: "2026-01-01", valuation_currency_code: "USD",
      account_full_name: "Assets:Bank", amount_decimal: "-1", value_decimal: "-1" },
  ]);
  assert.equal(groups[0].errors.some((error) => error.code === "UNEXPECTED_CANONICAL_FIELDS"), true);
  assert.deepEqual(groups[1].errors, []);
});

test("the final job preview publishes an executable confirmation handoff", async () => {
  const importJobId = "0ed8cb57-efb5-419e-b4e5-59b73724f224";
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql) {
      if (sql.includes("FROM accounting_transaction_import_jobs")) return [[{
        import_job_id: importJobId,
        owner_person_id: 7,
        source_system: "source_app",
        source_file_sha256: "7".repeat(64),
        source_file_name: "source.csv",
        expected_record_count: 4,
        job_status: "receiving",
        preview_sha256: null,
        result_json: null,
      }]];
      if (sql.includes("COALESCE(SUM(CASE")) return [[{
        staged_records: 2,
        pending_staged_records: 2,
        reused_records: 1,
        exception_records: 1,
        received_records: 4,
        staged_transactions: 1,
        pending_staged_transactions: 1,
        reused_transactions: 1,
        exception_transactions: 1,
      }]];
      if (sql.includes("SELECT transaction_external_id, canonical_sha256, item_status")) return [[
        { transaction_external_id: "tx-1", canonical_sha256: "a".repeat(64), item_status: "staged" },
        { transaction_external_id: "tx-2", canonical_sha256: "b".repeat(64), item_status: "reused" },
        { transaction_external_id: "tx-3", canonical_sha256: "c".repeat(64), item_status: "exception" },
      ]];
      if (sql.includes("UPDATE accounting_transaction_import_jobs")) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await previewTransactionImportJob({
    pool: { async getConnection() { return connection; } },
    personId: 7,
    importJobId,
  });

  assert.equal(result.requiredAction, "REQUEST_USER_CONFIRMATION");
  assert.equal(result.nextAction.type, "request_user_confirmation");
  assert.match(result.nextAction.instruction, /^Import succeeded\./);
  assert.match(result.nextAction.instruction, /All \d+ source records are in Accounting\./);
  assert.match(result.nextAction.instruction, /in Import misfits and can be corrected there/i);
  assert.doesNotMatch(result.nextAction.instruction, /commit|uncommitted|staged|validat/i);
  assert.deepEqual(result.user_outcome, {
    import_status: "succeeded",
    all_source_data_in_system: true,
    source_records_imported: 4,
    transactions_ready_for_ledger: 1,
    transactions_already_in_ledger: 1,
    transactions_in_import_misfits: 1,
  });
  assert.deepEqual(result.exception_handling, {
    retained_in: "import_misfits",
    retained_after_ledger_addition: true,
    correctable_in_system: true,
    list_with: { tool: "list_transaction_import_exceptions", arguments: { import_job_id: importJobId } },
    correct_with: { tool: "retry_transaction_import_exception", arguments: { import_job_id: importJobId } },
  });
  assert.doesNotMatch(result.nextAction.instruction, /ask the user|explicitly confirm/i);
  assert.deepEqual(result.nextAction.onApproval, {
    tool: "commit_transaction_import_job",
    arguments: { import_job_id: importJobId, preview_digest: result.preview_digest },
  });
});

test("an import with only misfits offers correction and cannot commit zero transactions", async () => {
  const importJobId = "0ed8cb57-efb5-419e-b4e5-59b73724f224";
  const job = {
    import_job_id: importJobId, owner_person_id: 7, source_system: "source_app",
    source_file_sha256: "7".repeat(64), source_file_name: "source.csv",
    expected_record_count: 2, job_status: "receiving", preview_sha256: null, result_json: null,
  };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      if (sql.includes("FROM accounting_transaction_import_jobs")) return [[job]];
      if (sql.includes("COALESCE(SUM(CASE")) return [[{
        exception_records: 2, received_records: 2, exception_transactions: 2,
      }]];
      if (sql.includes("SELECT transaction_external_id, canonical_sha256, item_status")) return [[{
        transaction_external_id: "tx-1", canonical_sha256: "a".repeat(64), item_status: "exception",
      }]];
      if (sql.includes("UPDATE accounting_transaction_import_jobs")) {
        job.job_status = "review_ready";
        job.preview_sha256 = params[0];
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM accounting_transaction_import_items") && sql.includes("item_status = 'staged'")) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const pool = { async getConnection() { return connection; } };
  const preview = await previewTransactionImportJob({ pool, personId: 7, importJobId });
  assert.equal(preview.ready_to_commit, false);
  assert.equal(preview.requiredAction, "CORRECT_IMPORT_MISFITS");
  assert.equal(preview.nextAction.type, "correct_import_misfits");
  assert.equal(Object.hasOwn(preview.nextAction, "onApproval"), false);
  assert.match(preview.nextAction.instruction, /No transactions are ready/);
  await assert.rejects(
    commitTransactionImportJob({ pool, personId: 7, importJobId, previewDigest: preview.preview_digest }),
    (error) => error.code === "IMPORT_JOB_NOTHING_TO_COMMIT",
  );
});

test("a staged job rejects a changed reference valuation before ledger posting", async () => {
  const importJobId = "0ed8cb57-efb5-419e-b4e5-59b73724f224";
  const job = { import_job_id: importJobId, owner_person_id: 7, source_system: "coinbase",
    source_file_sha256: "7".repeat(64), source_file_name: "bitcoin.csv",
    expected_record_count: 2, job_status: "receiving", preview_sha256: null, result_json: null };
  const item = { transaction_external_id: "sale-1", canonical_sha256: "8".repeat(64),
    item_status: "staged", errors_json: null, source_record_count: 2, resolved_json: null };
  const accounts = [
    { account_id: 10, AccountName: "Assets", parent_account_id: null, AccountType: "asset",
      account_currency_id: 1, is_placeholder: 1, archived_at: null, CurrencyAbbreviation: "USD", scale: 2 },
    { account_id: 11, AccountName: "Checking", parent_account_id: 10, AccountType: "asset",
      account_currency_id: 1, is_placeholder: 0, archived_at: null, CurrencyAbbreviation: "USD", scale: 2 },
    { account_id: 12, AccountName: "Bitcoin", parent_account_id: 10, AccountType: "asset",
      account_currency_id: 2, is_placeholder: 0, archived_at: null, CurrencyAbbreviation: "BTC", scale: 8 },
    { account_id: 20, AccountName: "Expenses", parent_account_id: null, AccountType: "expense",
      account_currency_id: 1, is_placeholder: 1, archived_at: null, CurrencyAbbreviation: "USD", scale: 2 },
    { account_id: 21, AccountName: "Conversion Fees", parent_account_id: 20, AccountType: "expense",
      account_currency_id: 1, is_placeholder: 0, archived_at: null, CurrencyAbbreviation: "USD", scale: 2 },
  ];
  const currencies = [
    { currency_id: 1, CurrencyAbbreviation: "USD", scale: 2 },
    { currency_id: 2, CurrencyAbbreviation: "BTC", scale: 8 },
  ];
  const rates = [{ xrate_id: 1, ValidAt: "2026-09-01 00:00:00", from_currency_id: 2,
    to_currency_id: 1, from_units: "100000000", to_units: "8000000" }];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params = []) {
      if (sql.includes("FROM accounting_transaction_import_jobs")) return [[job]];
      if (sql.includes("COALESCE(SUM(CASE")) return [[{
        staged_records: item.item_status === "staged" ? 2 : 0,
        pending_staged_records: item.item_status === "staged" ? 2 : 0,
        exception_records: item.item_status === "exception" ? 2 : 0,
        received_records: 2,
        staged_transactions: item.item_status === "staged" ? 1 : 0,
        pending_staged_transactions: item.item_status === "staged" ? 1 : 0,
        exception_transactions: item.item_status === "exception" ? 1 : 0,
      }]];
      if (sql.includes("SELECT transaction_external_id, canonical_sha256, item_status")) return [[item]];
      if (sql.includes("SELECT transaction_external_id, resolved_json")) return [[item]];
      if (sql.includes("FROM accounts a") && sql.includes("JOIN currencies c")) return [accounts];
      if (sql.includes("FROM currencies")) return [currencies];
      if (sql.includes("FROM xrates") && sql.includes("xrate_type = 'reference'")) return [rates];
      if (sql.includes("FROM transactions t") && sql.includes("LEFT JOIN line_items")) return [[]];
      if (sql.includes("UPDATE accounting_transaction_import_items")) {
        item.item_status = "exception";
        item.errors_json = params[0];
        item.resolved_json = null;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE accounting_transaction_import_jobs")) {
        if (sql.includes("job_status = 'review_ready'")) {
          job.job_status = "review_ready";
          job.preview_sha256 = params[0];
        } else {
          job.job_status = "receiving";
          job.preview_sha256 = null;
        }
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const normalized = normalizeTransactionImport({ sourceSystem: "coinbase", transactions: [{
    externalId: "sale-1", transactionDate: "2026-09-01", transactionAt: "2026-09-01T01:00:00Z",
    valuationCurrencyCode: "USD", feeAccountFullName: "Expenses:Conversion Fees",
    lineItems: [
      { accountFullName: "Assets:Bitcoin", amountDecimal: "-0.01" },
      { accountFullName: "Assets:Checking", amountDecimal: "790" },
    ],
  }] });
  const [staged] = await analyzeTransactionImport(connection, 7, normalized);
  assert.equal(staged.status, "planned");
  item.resolved_json = JSON.stringify(staged.resolved);
  const pool = { async getConnection() { return connection; } };
  const preview = await previewTransactionImportJob({ pool, personId: 7, importJobId });
  assert.equal(preview.ready_to_commit, true);
  rates.push({ xrate_id: 2, ValidAt: "2026-09-01 01:00:00", from_currency_id: 2,
    to_currency_id: 1, from_units: "100000000", to_units: "9000000" });
  const result = await commitTransactionImportJob({ pool, personId: 7, importJobId,
    previewDigest: preview.preview_digest });
  assert.equal(result.code, "IMPORT_JOB_ACCOUNTING_CONTEXT_CHANGED");
  assert.equal(item.item_status, "exception");
  assert.equal(JSON.parse(item.errors_json)[0].code, "IMPORT_VALUATION_CHANGED");
  assert.equal(job.job_status, "receiving");
});

test("a committed job can retry one exception with supplemental accounting lines", async () => {
  const importJobId = "0ed8cb57-efb5-419e-b4e5-59b73724f224";
  let canonicalUpdate;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      if (sql.includes("FROM accounting_transaction_import_jobs")) return [[{
        import_job_id: importJobId, owner_person_id: 7, source_system: "source_app",
        source_file_sha256: "7".repeat(64), source_file_name: "source.csv",
        expected_record_count: 1, job_status: "committed", result_json: "{}",
      }]];
      if (sql.includes("FROM accounting_transaction_import_requests")) return [[]];
      if (sql.includes("SELECT transaction_external_id, source_record_count, item_status")) return [[{
        transaction_external_id: "tx-one-line", source_record_count: 1, item_status: "exception",
      }]];
      if (sql.includes("SET canonical_sha256")) { canonicalUpdate = params; return [{ affectedRows: 1 }]; }
      if (sql.includes("INSERT INTO accounting_transaction_import_requests")) return [{ affectedRows: 1 }];
      if (sql.includes("UPDATE accounting_transaction_import_jobs")) return [{ affectedRows: 1 }];
      if (sql.includes("COALESCE(SUM(CASE")) return [[{
        staged_records: 0, reused_records: 0, exception_records: 1, received_records: 1,
        exception_transactions: 1,
      }]];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const records = [
    { transaction_external_id: "tx-one-line", transaction_date: "2026-01-01",
      valuation_currency_code: "USD", account_full_name: "Assets:Bank", amount_decimal: "-1", value_decimal: "-1" },
    { transaction_external_id: "tx-one-line", transaction_date: "2026-01-02",
      valuation_currency_code: "USD", account_full_name: "Expenses:Food", amount_decimal: "1", value_decimal: "1" },
  ];
  const result = await retryTransactionImportException({
    pool: { async getConnection() { return connection; } }, personId: 7, importJobId,
    retryId: "retry-with-balancing-line", transactionExternalId: "tx-one-line", records,
  });

  assert.equal(result.job_status, "receiving");
  assert.equal(result.progress.expected_source_records, 1);
  assert.equal(JSON.parse(canonicalUpdate[1]).length, 2);
  assert.equal(result.exceptions[0].error_codes.includes("INCONSISTENT_TRANSACTION_CONTEXT"), true);
});

test("an explicit exclusion retains validation errors, source context, and the user's reason", async () => {
  const importJobId = "0ed8cb57-efb5-419e-b4e5-59b73724f224";
  const canonicalRecords = [{ transaction_external_id: "tx-ignore", transaction_date: "2026-01-01",
    valuation_currency_code: "USD", account_full_name: "Assets:Bank", amount_decimal: "1", value_decimal: "1" }];
  let storedErrors;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      if (sql.includes("FROM accounting_transaction_import_jobs")) return [[{
        import_job_id: importJobId, owner_person_id: 7, source_system: "source_app",
        source_file_sha256: "7".repeat(64), source_file_name: "source.csv",
        expected_record_count: 1, job_status: "committed", result_json: "{}",
      }]];
      if (sql.includes("FROM accounting_transaction_import_requests")) return [[]];
      if (sql.includes("SELECT transaction_external_id, canonical_json")) return [[{
        transaction_external_id: "tx-ignore", canonical_json: JSON.stringify(canonicalRecords),
        source_record_count: 1, item_status: "exception",
        errors_json: JSON.stringify([{ code: "TOO_FEW_LINE_ITEMS", message: "Two lines are required." }]),
      }]];
      if (sql.includes("SET errors_json")) { storedErrors = JSON.parse(params[0]); return [{ affectedRows: 1 }]; }
      if (sql.includes("INSERT INTO accounting_transaction_import_requests")) return [{ affectedRows: 1 }];
      if (sql.includes("UPDATE accounting_transaction_import_jobs")) return [{ affectedRows: 1 }];
      if (sql.includes("COALESCE(SUM(CASE")) return [[{
        staged_records: 0, reused_records: 0, exception_records: 1, excluded_records: 1,
        received_records: 1, exception_transactions: 1, excluded_transactions: 1,
      }]];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await excludeTransactionImportException({
    pool: { async getConnection() { return connection; } }, personId: 7, importJobId,
    exclusionId: "exclude-not-a-transaction", transactionExternalId: "tx-ignore",
    reason: "This source row is a price note, not a ledger transaction.",
  });

  assert.deepEqual(result.exception.error_codes, ["TOO_FEW_LINE_ITEMS"]);
  assert.equal(result.exception.resolution.status, "excluded");
  assert.match(result.exception.resolution.reason, /price note/);
  assert.equal(storedErrors.at(-1).code, "USER_EXCLUDED");
  assert.equal(result.progress.transaction_totals.unresolved_exceptions, 0);
  assert.equal(result.progress.transaction_totals.excluded, 1);
});
