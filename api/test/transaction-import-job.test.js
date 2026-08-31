import test from "node:test";
import assert from "node:assert/strict";
import {
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
    "value_decimal",
  ]);
  assert.deepEqual(transactionImportCanonicalJsonSchema.properties.line_external_id.type, ["string", "null"]);
  assert.doesNotMatch(JSON.stringify(transactionImportCanonicalJsonSchema), /csv|gnucash/i);
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
        reused_records: 1,
        exception_records: 1,
        received_records: 4,
        staged_transactions: 1,
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
  assert.match(result.nextAction.instruction, /^Commit \d+ pending staged transactions from this preview now\?/);
  assert.doesNotMatch(result.nextAction.instruction, /ask the user|explicitly confirm/i);
  assert.deepEqual(result.nextAction.onApproval, {
    tool: "commit_transaction_import_job",
    arguments: { import_job_id: importJobId, preview_digest: result.preview_digest },
  });
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
