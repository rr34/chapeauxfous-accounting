import test from "node:test";
import assert from "node:assert/strict";
import {
  groupCanonicalTransactionRecords,
  TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI,
  transactionImportCanonicalJsonSchema,
} from "../src/transaction-import-job.js";
import {
  parseCanonicalTransactionArtifact,
  TRANSACTION_IMPORT_ARTIFACT_MEDIA_TYPES,
} from "../src/artifact-upload.js";

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
