import { createHash, randomUUID } from "node:crypto";
import { withPoolTransaction } from "./db.js";
import {
  analyzeTransactionImport,
  insertImportedTransaction,
  normalizeTransactionImport,
} from "./transaction-import.js";

export const TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI =
  "accounting://schemas/transaction-import-record/v1";

export const transactionImportCanonicalJsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: TRANSACTION_IMPORT_CANONICAL_SCHEMA_URI,
  title: "Canonical transaction import line record",
  description: "One source-neutral line item. Records are grouped by transaction_external_id before accounting validation.",
  type: "object",
  additionalProperties: false,
  required: [
    "transaction_external_id",
    "transaction_date",
    "valuation_currency_code",
    "account_full_name",
    "amount_decimal",
    "value_decimal",
  ],
  properties: {
    transaction_external_id: { type: "string", minLength: 1, maxLength: 128 },
    line_external_id: { type: ["string", "null"], minLength: 1, maxLength: 128 },
    transaction_date: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    description: { type: ["string", "null"], maxLength: 16000 },
    valuation_currency_code: { type: "string", minLength: 1, maxLength: 50 },
    account_full_name: { type: "string", minLength: 1, maxLength: 4096 },
    amount_decimal: { type: "string", pattern: "^[+-]?\\d+(?:\\.\\d+)?$", maxLength: 128 },
    value_decimal: {
      description: "Value in the transaction valuation currency. Null is allowed only for a native-currency account, where the server derives the same value as amount_decimal.",
      type: ["string", "null"],
      pattern: "^[+-]?\\d+(?:\\.\\d+)?$",
      maxLength: 128,
    },
    memo: { type: ["string", "null"], maxLength: 16000 },
  },
});

function jobError(message, code, details = undefined, status = 400) {
  return Object.assign(new Error(message), { message, code, details, status });
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function requiredText(value, field, maximum) {
  const text = String(value ?? "").trim();
  if (!text) throw jobError(`${field} is required.`, `${field.toUpperCase().replaceAll(" ", "_")}_REQUIRED`);
  if ([...text].length > maximum) throw jobError(`${field} cannot exceed ${maximum} characters.`, `${field.toUpperCase().replaceAll(" ", "_")}_TOO_LONG`);
  return text;
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch {
    throw jobError(`Stored ${label} is invalid.`, "IMPORT_JOB_STATE_CONFLICT", undefined, 500);
  }
}

function sourceIdentity(job, transactionExternalId, records) {
  return {
    source_system: String(job.source_system),
    source_file: {
      sha256: String(job.source_file_sha256),
      name: job.source_file_name == null ? null : String(job.source_file_name),
    },
    transaction_external_id: transactionExternalId,
    line_external_ids: records.map((record) => record.line_external_id ?? null),
  };
}

export function groupCanonicalTransactionRecords(records) {
  const groups = new Map();
  records.forEach((record, sourceOrdinal) => {
    const externalId = String(record?.transaction_external_id ?? "").trim();
    const key = externalId || `__invalid_${sourceOrdinal}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...record, transaction_external_id: externalId, _sourceOrdinal: sourceOrdinal });
  });
  return [...groups.entries()].map(([externalId, groupedRecords]) => {
    const canonicalRecords = groupedRecords.map(({ _sourceOrdinal, ...record }) => record);
    const first = canonicalRecords[0];
    const errors = [];
    if (!externalId) errors.push({ code: "TRANSACTION_EXTERNAL_ID_REQUIRED", message: "transaction_external_id is required." });
    for (const field of ["transaction_date", "description", "valuation_currency_code"]) {
      const values = new Set(canonicalRecords.map((record) => JSON.stringify(record[field] ?? null)));
      if (values.size > 1) errors.push({
        code: "INCONSISTENT_TRANSACTION_CONTEXT",
        message: `${field} must be identical on every record in transaction ${JSON.stringify(externalId)}.`,
        details: { field, values: [...values].map((value) => JSON.parse(value)) },
      });
    }
    return {
      externalId,
      canonicalRecords,
      errors,
      transaction: {
        externalId,
        transactionDate: first?.transaction_date,
        description: first?.description ?? null,
        valuationCurrencyCode: first?.valuation_currency_code,
        lineItems: canonicalRecords.map((record) => ({
          externalId: record.line_external_id ?? null,
          accountFullName: record.account_full_name,
          amountDecimal: record.amount_decimal,
          valueDecimal: record.value_decimal,
          memo: record.memo ?? null,
        })),
      },
    };
  });
}

function normalizationIssue(error) {
  return { code: String(error?.code ?? "INVALID_CANONICAL_TRANSACTION"), message: String(error?.message ?? "The canonical transaction is invalid."),
    ...(error?.details === undefined ? {} : { details: error.details }) };
}

async function analyzeGroups(connection, personId, sourceSystem, groups, lock) {
  const immediatelyRejected = [];
  const transactions = [];
  for (const group of groups) {
    if (group.errors.length) {
      immediatelyRejected.push({ group, errors: group.errors });
      continue;
    }
    try {
      const normalized = normalizeTransactionImport({ sourceSystem, transactions: [group.transaction] });
      transactions.push(normalized.transactions[0]);
    } catch (error) {
      immediatelyRejected.push({ group, errors: [normalizationIssue(error)] });
    }
  }
  const analyzed = transactions.length
    ? await analyzeTransactionImport(connection, personId, {
      sourceSystem,
      transactions,
      submittedTransactionCount: transactions.length,
      submittedLineItemCount: transactions.reduce((sum, transaction) => sum + transaction.lineItems.length, 0),
      duplicateInputTransactionCount: 0,
      conflictingExternalIds: [],
    }, lock)
    : [];
  const groupsById = new Map(groups.map((group) => [group.externalId, group]));
  return [
    ...analyzed.map((entry) => ({ ...entry, group: groupsById.get(entry.input.externalId) })),
    ...immediatelyRejected.map(({ group, errors }) => ({ input: group.transaction, group, errors, status: "rejected" })),
  ];
}

function exceptionValue(job, entry) {
  const group = entry.group;
  return {
    error_codes: (entry.errors ?? []).map((error) => error.code),
    errors: entry.errors ?? [],
    source_identity: sourceIdentity(job, group.externalId, group.canonicalRecords),
    canonical_records: group.canonicalRecords,
    transaction_context: group.transaction,
  };
}

async function loadJob(connection, personId, importJobId, lock = false) {
  const [rows] = await connection.query(
    `SELECT import_job_id, owner_person_id, source_system, source_file_sha256,
            source_file_name, expected_record_count, job_status, preview_sha256,
            result_json, committed_at, created_at, updated_at
       FROM accounting_transaction_import_jobs
      WHERE import_job_id = ? AND owner_person_id = ?${lock ? " FOR UPDATE" : ""}`,
    [importJobId, personId],
  );
  if (!rows[0]) throw jobError("Transaction import job not found.", "IMPORT_JOB_NOT_FOUND", undefined, 404);
  return rows[0];
}

async function aggregateProgress(connection, job, newlyStagedRecords = 0) {
  const [rows] = await connection.query(
    `SELECT
       COALESCE(SUM(CASE WHEN item_status IN ('staged','committed') THEN source_record_count ELSE 0 END), 0) AS staged_records,
       COALESCE(SUM(CASE WHEN item_status = 'reused' THEN source_record_count ELSE 0 END), 0) AS reused_records,
       COALESCE(SUM(CASE WHEN item_status = 'exception' THEN source_record_count ELSE 0 END), 0) AS exception_records,
       COALESCE(SUM(source_record_count), 0) AS received_records,
       COALESCE(SUM(CASE WHEN item_status IN ('staged','committed') THEN 1 ELSE 0 END), 0) AS staged_transactions,
       COALESCE(SUM(CASE WHEN item_status = 'reused' THEN 1 ELSE 0 END), 0) AS reused_transactions,
       COALESCE(SUM(CASE WHEN item_status = 'exception' THEN 1 ELSE 0 END), 0) AS exception_transactions
     FROM accounting_transaction_import_items
    WHERE import_job_id = ?`,
    [job.import_job_id],
  );
  const totals = rows[0] ?? {};
  const stagedRecords = Number(totals.staged_records ?? 0);
  const reusedRecords = Number(totals.reused_records ?? 0);
  const exceptionRecords = Number(totals.exception_records ?? 0);
  const expected = Number(job.expected_record_count);
  const remaining = expected - stagedRecords - reusedRecords - exceptionRecords;
  if (remaining < 0) throw jobError("The job contains more unique source records than expected.", "EXPECTED_RECORD_COUNT_EXCEEDED", {
    expected_record_count: expected,
    received_record_count: Number(totals.received_records ?? 0),
  }, 409);
  return {
    expected_source_records: expected,
    newly_staged_records: newlyStagedRecords,
    previously_staged_or_reused_records: stagedRecords + reusedRecords - newlyStagedRecords,
    exception_records: exceptionRecords,
    remaining_records: remaining,
    equation: `${expected} = ${newlyStagedRecords} + ${stagedRecords + reusedRecords - newlyStagedRecords} + ${exceptionRecords} + ${remaining}`,
    transaction_totals: {
      staged: Number(totals.staged_transactions ?? 0),
      reused: Number(totals.reused_transactions ?? 0),
      exceptions: Number(totals.exception_transactions ?? 0),
    },
  };
}

function jobIdentity(job) {
  return {
    import_job_id: String(job.import_job_id),
    source_system: String(job.source_system),
    source_file: { sha256: String(job.source_file_sha256), name: job.source_file_name ?? null },
    expected_record_count: Number(job.expected_record_count),
    job_status: String(job.job_status),
  };
}

async function currentJobResult(connection, job, newlyStagedRecords = 0) {
  return { ...jobIdentity(job), progress: await aggregateProgress(connection, job, newlyStagedRecords) };
}

async function requestReplay(connection, jobId, requestKind, requestId, payloadSha256) {
  const [rows] = await connection.query(
    `SELECT payload_sha256 FROM accounting_transaction_import_requests
      WHERE import_job_id = ? AND request_kind = ? AND request_id = ?`,
    [jobId, requestKind, requestId],
  );
  if (!rows[0]) return false;
  if (String(rows[0].payload_sha256) !== payloadSha256) throw jobError(
    "The request ID was already used with different canonical records.", "IDEMPOTENCY_KEY_CONFLICT", { request_id: requestId }, 409,
  );
  return true;
}

async function saveRequest(connection, jobId, requestKind, requestId, payloadSha256, recordCount) {
  await connection.query(
    `INSERT INTO accounting_transaction_import_requests
      (import_job_id, request_kind, request_id, payload_sha256, record_count)
     VALUES (?, ?, ?, ?, ?)`,
    [jobId, requestKind, requestId, payloadSha256, recordCount],
  );
}

export async function createTransactionImportJob({ pool, personId, sourceSystem, sourceFileSha256,
  sourceFileName = null, expectedRecordCount, clientRequestId }) {
  const normalizedSourceSystem = requiredText(sourceSystem, "source system", 32);
  const normalizedRequestId = requiredText(clientRequestId, "client request ID", 128);
  const digest = String(sourceFileSha256 ?? "").trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw jobError("source_file_sha256 must be a SHA-256 hex digest.", "INVALID_SOURCE_FILE_SHA256");
  if (!Number.isSafeInteger(expectedRecordCount) || expectedRecordCount < 1) throw jobError(
    "expected_record_count must be a positive safe integer.", "INVALID_EXPECTED_RECORD_COUNT",
  );
  const normalizedFileName = sourceFileName == null ? null : requiredText(sourceFileName, "source file name", 1024);
  return withPoolTransaction(pool, async (connection) => {
    const importJobId = randomUUID();
    await connection.query(
      `INSERT INTO accounting_transaction_import_jobs
        (import_job_id, owner_person_id, client_request_id, source_system,
         source_file_sha256, source_file_name, expected_record_count, job_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'receiving')
       ON DUPLICATE KEY UPDATE import_job_id = import_job_id`,
      [importJobId, personId, normalizedRequestId, normalizedSourceSystem, digest, normalizedFileName, expectedRecordCount],
    );
    const [rows] = await connection.query(
      `SELECT import_job_id, owner_person_id, source_system, source_file_sha256,
              source_file_name, expected_record_count, job_status, preview_sha256,
              result_json, committed_at, created_at, updated_at
         FROM accounting_transaction_import_jobs
        WHERE owner_person_id = ? AND client_request_id = ? FOR UPDATE`,
      [personId, normalizedRequestId],
    );
    const job = rows[0];
    if (!job) throw jobError("The transaction import job could not be created.", "IMPORT_JOB_STATE_CONFLICT", undefined, 500);
    if (String(job.source_system) !== normalizedSourceSystem || String(job.source_file_sha256) !== digest
      || Number(job.expected_record_count) !== expectedRecordCount || (job.source_file_name ?? null) !== normalizedFileName) {
      throw jobError("client_request_id was already used for a different logical import job.", "IDEMPOTENCY_KEY_CONFLICT", undefined, 409);
    }
    return { ...await currentJobResult(connection, job), idempotent_replay: String(job.import_job_id) !== importJobId };
  });
}

export async function stageTransactionImportChunk({ pool, personId, importJobId, chunkId, records }) {
  const normalizedJobId = requiredText(importJobId, "import job ID", 36);
  const normalizedChunkId = requiredText(chunkId, "chunk ID", 128);
  if (!Array.isArray(records) || records.length === 0) throw jobError("At least one canonical record is required.", "CANONICAL_RECORDS_REQUIRED");
  const payloadSha256 = hashJson(records);
  return withPoolTransaction(pool, async (connection) => {
    const job = await loadJob(connection, personId, normalizedJobId, true);
    if (job.job_status === "committed") throw jobError("The import job is already committed.", "IMPORT_JOB_ALREADY_COMMITTED", undefined, 409);
    if (await requestReplay(connection, normalizedJobId, "chunk", normalizedChunkId, payloadSha256)) {
      return { ...await currentJobResult(connection, job), chunk_id: normalizedChunkId,
        idempotent_replay: true, exceptions: [] };
    }

    const groups = groupCanonicalTransactionRecords(records);
    const ids = groups.map((group) => group.externalId);
    const placeholders = ids.map(() => "?").join(", ");
    const [priorRows] = ids.length ? await connection.query(
      `SELECT transaction_external_id, canonical_sha256, item_status
         FROM accounting_transaction_import_items
        WHERE import_job_id = ? AND transaction_external_id IN (${placeholders}) FOR UPDATE`,
      [normalizedJobId, ...ids],
    ) : [[]];
    const priorById = new Map(priorRows.map((row) => [String(row.transaction_external_id), row]));
    const newGroups = [];
    const requestExceptions = [];
    for (const group of groups) {
      const prior = priorById.get(group.externalId);
      if (!prior) newGroups.push(group);
      else if (String(prior.canonical_sha256) !== hashJson(group.canonicalRecords)) requestExceptions.push(exceptionValue(job, {
        group,
        errors: [{ code: "SOURCE_TRANSACTION_CONFLICT", message: "This transaction external ID was already received with different canonical records.",
          details: { existing_status: prior.item_status } }],
      }));
    }
    const entries = await analyzeGroups(connection, personId, String(job.source_system), newGroups, false);
    let newlyStagedRecords = 0;
    const exceptions = [...requestExceptions];
    for (const entry of entries) {
      const group = entry.group;
      const canonicalJson = JSON.stringify(group.canonicalRecords);
      const resolvedJson = entry.resolved ? JSON.stringify(entry.resolved) : null;
      const itemStatus = entry.status === "planned" ? "staged" : entry.status === "existing" ? "reused" : "exception";
      const errorsJson = itemStatus === "exception" ? JSON.stringify(entry.errors ?? []) : null;
      if (itemStatus === "staged") newlyStagedRecords += group.canonicalRecords.length;
      if (itemStatus === "exception") exceptions.push(exceptionValue(job, entry));
      await connection.query(
        `INSERT INTO accounting_transaction_import_items
          (import_job_id, transaction_external_id, canonical_sha256, canonical_json,
           resolved_json, source_record_count, item_status, ledger_transaction_id, errors_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [normalizedJobId, group.externalId, hashJson(group.canonicalRecords), canonicalJson, resolvedJson,
          group.canonicalRecords.length, itemStatus, entry.transactionId ?? null, errorsJson],
      );
    }
    await saveRequest(connection, normalizedJobId, "chunk", normalizedChunkId, payloadSha256, records.length);
    await connection.query(
      `UPDATE accounting_transaction_import_jobs
          SET job_status = 'receiving', preview_sha256 = NULL, updated_at = UTC_TIMESTAMP(6)
        WHERE import_job_id = ?`, [normalizedJobId],
    );
    const result = await currentJobResult(connection, { ...job, job_status: "receiving" }, newlyStagedRecords);
    return { ...result, chunk_id: normalizedChunkId, idempotent_replay: false, exceptions };
  });
}

export async function retryTransactionImportException({ pool, personId, importJobId, retryId,
  transactionExternalId, records }) {
  const normalizedJobId = requiredText(importJobId, "import job ID", 36);
  const normalizedRetryId = requiredText(retryId, "retry ID", 128);
  const normalizedExternalId = requiredText(transactionExternalId, "transaction external ID", 128);
  if (!Array.isArray(records) || records.length === 0) throw jobError("Corrected canonical records are required.", "CANONICAL_RECORDS_REQUIRED");
  const payloadSha256 = hashJson({ transactionExternalId: normalizedExternalId, records });
  return withPoolTransaction(pool, async (connection) => {
    const job = await loadJob(connection, personId, normalizedJobId, true);
    if (job.job_status === "committed") throw jobError("Committed import-job exceptions cannot be changed.", "IMPORT_JOB_ALREADY_COMMITTED", undefined, 409);
    if (await requestReplay(connection, normalizedJobId, "exception_retry", normalizedRetryId, payloadSha256)) {
      return { ...await currentJobResult(connection, job), retry_id: normalizedRetryId,
        idempotent_replay: true, exceptions: [] };
    }
    const [rows] = await connection.query(
      `SELECT transaction_external_id, source_record_count, item_status
         FROM accounting_transaction_import_items
        WHERE import_job_id = ? AND transaction_external_id = ? FOR UPDATE`,
      [normalizedJobId, normalizedExternalId],
    );
    const prior = rows[0];
    if (!prior || prior.item_status !== "exception") throw jobError(
      "Only a current structured exception can be retried without resubmitting successful records.", "IMPORT_EXCEPTION_NOT_FOUND", undefined, 404,
    );
    if (records.length !== Number(prior.source_record_count)) throw jobError(
      "A corrected exception must preserve the final expected source-record count.", "EXCEPTION_RECORD_COUNT_CHANGED",
      { expected: Number(prior.source_record_count), received: records.length }, 409,
    );
    if (records.some((record) => String(record.transaction_external_id ?? "").trim() !== normalizedExternalId)) throw jobError(
      "Every corrected record must retain the exception transaction_external_id.", "EXCEPTION_SOURCE_IDENTITY_CHANGED", undefined, 409,
    );
    const [group] = groupCanonicalTransactionRecords(records);
    const [entry] = await analyzeGroups(connection, personId, String(job.source_system), [group], false);
    const itemStatus = entry.status === "planned" ? "staged" : entry.status === "existing" ? "reused" : "exception";
    const errors = itemStatus === "exception" ? entry.errors ?? [] : [];
    await connection.query(
      `UPDATE accounting_transaction_import_items
          SET canonical_sha256 = ?, canonical_json = ?, resolved_json = ?, item_status = ?,
              ledger_transaction_id = ?, errors_json = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE import_job_id = ? AND transaction_external_id = ?`,
      [hashJson(group.canonicalRecords), JSON.stringify(group.canonicalRecords),
        entry.resolved ? JSON.stringify(entry.resolved) : null, itemStatus, entry.transactionId ?? null,
        errors.length ? JSON.stringify(errors) : null, normalizedJobId, normalizedExternalId],
    );
    await saveRequest(connection, normalizedJobId, "exception_retry", normalizedRetryId, payloadSha256, records.length);
    await connection.query(
      `UPDATE accounting_transaction_import_jobs
          SET job_status = 'receiving', preview_sha256 = NULL, updated_at = UTC_TIMESTAMP(6)
        WHERE import_job_id = ?`, [normalizedJobId],
    );
    const refreshedJob = { ...job, job_status: "receiving" };
    return { ...await currentJobResult(connection, refreshedJob, itemStatus === "staged" ? records.length : 0),
      retry_id: normalizedRetryId, idempotent_replay: false,
      exceptions: itemStatus === "exception" ? [exceptionValue(job, { ...entry, group })] : [] };
  });
}

async function entryDigest(connection, importJobId) {
  const [rows] = await connection.query(
    `SELECT transaction_external_id, canonical_sha256, item_status
       FROM accounting_transaction_import_items WHERE import_job_id = ?
      ORDER BY transaction_external_id`, [importJobId],
  );
  return hashJson(rows.map((row) => ({ transaction_external_id: String(row.transaction_external_id),
    canonical_sha256: String(row.canonical_sha256), item_status: String(row.item_status) })));
}

export async function previewTransactionImportJob({ pool, personId, importJobId }) {
  const normalizedJobId = requiredText(importJobId, "import job ID", 36);
  return withPoolTransaction(pool, async (connection) => {
    const job = await loadJob(connection, personId, normalizedJobId, true);
    if (job.job_status === "committed") return { ...parseJson(job.result_json, "transaction import result"), already_committed: true };
    const progress = await aggregateProgress(connection, job);
    if (progress.remaining_records !== 0) throw jobError(
      "The final preview requires every expected source record to be staged, reused, or represented by an exception.",
      "IMPORT_JOB_HAS_REMAINING_RECORDS", { progress }, 409,
    );
    const previewSha256 = await entryDigest(connection, normalizedJobId);
    await connection.query(
      `UPDATE accounting_transaction_import_jobs
          SET job_status = 'review_ready', preview_sha256 = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE import_job_id = ?`, [previewSha256, normalizedJobId],
    );
    return {
      ...jobIdentity({ ...job, job_status: "review_ready" }),
      progress,
      preview_digest: `sha256:${previewSha256}`,
      ready_to_commit: true,
      unresolved_exceptions: progress.transaction_totals.exceptions,
      commit_scope: "All staged transactions; reused transactions remain unchanged and exceptions remain uncommitted.",
    };
  });
}

export async function getTransactionImportJob({ pool, personId, importJobId }) {
  const normalizedJobId = requiredText(importJobId, "import job ID", 36);
  return withPoolTransaction(pool, async (connection) => {
    const job = await loadJob(connection, personId, normalizedJobId);
    if (job.job_status === "committed" && job.result_json) return { ...parseJson(job.result_json, "transaction import result"), already_committed: true };
    return { ...await currentJobResult(connection, job),
      preview_digest: job.preview_sha256 ? `sha256:${job.preview_sha256}` : null,
      ready_to_commit: job.job_status === "review_ready" };
  });
}

export async function listTransactionImportExceptions({ pool, personId, importJobId, limit = 100, afterExternalId = null }) {
  const normalizedJobId = requiredText(importJobId, "import job ID", 36);
  return withPoolTransaction(pool, async (connection) => {
    const job = await loadJob(connection, personId, normalizedJobId);
    const [rows] = await connection.query(
      `SELECT transaction_external_id, canonical_json, errors_json
         FROM accounting_transaction_import_items
        WHERE import_job_id = ? AND item_status = 'exception'
          AND (? IS NULL OR transaction_external_id > ?)
        ORDER BY transaction_external_id LIMIT ?`,
      [normalizedJobId, afterExternalId, afterExternalId, Number(limit) + 1],
    );
    const page = rows.slice(0, limit);
    return {
      ...jobIdentity(job),
      exceptions: page.map((row) => {
        const canonicalRecords = parseJson(row.canonical_json, "canonical exception records");
        const group = groupCanonicalTransactionRecords(canonicalRecords)[0];
        return exceptionValue(job, { group, errors: parseJson(row.errors_json, "import exception errors") });
      }),
      next_cursor: rows.length > limit ? String(page.at(-1).transaction_external_id) : null,
    };
  });
}

export async function commitTransactionImportJob({ pool, personId, importJobId, previewDigest }) {
  const normalizedJobId = requiredText(importJobId, "import job ID", 36);
  const normalizedDigest = String(previewDigest ?? "").trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(normalizedDigest)) throw jobError("preview_digest must be the exact digest returned by preview_transaction_import_job.", "INVALID_PREVIEW_DIGEST");
  return withPoolTransaction(pool, async (connection) => {
    const job = await loadJob(connection, personId, normalizedJobId, true);
    if (job.job_status === "committed") return { ...parseJson(job.result_json, "transaction import result"), already_committed: true };
    if (job.job_status !== "review_ready" || String(job.preview_sha256 ?? "") !== normalizedDigest) throw jobError(
      "The job is not bound to that final preview. Create a new preview after the latest staging or correction.", "IMPORT_JOB_PREVIEW_MISMATCH", undefined, 409,
    );
    if (await entryDigest(connection, normalizedJobId) !== normalizedDigest) throw jobError(
      "The staged job changed after preview.", "IMPORT_JOB_PREVIEW_MISMATCH", undefined, 409,
    );
    const [itemRows] = await connection.query(
      `SELECT transaction_external_id, resolved_json, source_record_count
         FROM accounting_transaction_import_items
        WHERE import_job_id = ? AND item_status = 'staged'
        ORDER BY transaction_external_id FOR UPDATE`, [normalizedJobId],
    );
    const transactions = itemRows.map((row) => parseJson(row.resolved_json, "resolved transaction"));
    if (transactions.length) {
      const entries = await analyzeTransactionImport(connection, personId, {
        sourceSystem: String(job.source_system), transactions,
        submittedTransactionCount: transactions.length,
        submittedLineItemCount: transactions.reduce((sum, transaction) => sum + transaction.lineItems.length, 0),
        duplicateInputTransactionCount: 0, conflictingExternalIds: [],
      }, true);
      const newlyInvalid = entries.filter((entry) => entry.status === "rejected");
      if (newlyInvalid.length) {
        for (const entry of newlyInvalid) await connection.query(
          `UPDATE accounting_transaction_import_items
              SET item_status = 'exception', errors_json = ?, resolved_json = NULL,
                  updated_at = UTC_TIMESTAMP(6)
            WHERE import_job_id = ? AND transaction_external_id = ?`,
          [JSON.stringify(entry.errors), normalizedJobId, entry.input.externalId],
        );
        await connection.query(
          `UPDATE accounting_transaction_import_jobs
              SET job_status = 'receiving', preview_sha256 = NULL, updated_at = UTC_TIMESTAMP(6)
            WHERE import_job_id = ?`, [normalizedJobId],
        );
        return { ...await currentJobResult(connection, { ...job, job_status: "receiving" }),
          ready_to_commit: false, code: "IMPORT_JOB_ACCOUNTING_CONTEXT_CHANGED" };
      }
      for (const entry of entries) {
        let transactionId = entry.transactionId ?? null;
        let itemStatus = "reused";
        if (entry.status === "planned") {
          transactionId = await insertImportedTransaction(connection, personId, String(job.source_system), entry.resolved);
          itemStatus = "committed";
        }
        await connection.query(
          `UPDATE accounting_transaction_import_items
              SET item_status = ?, ledger_transaction_id = ?, updated_at = UTC_TIMESTAMP(6)
            WHERE import_job_id = ? AND transaction_external_id = ?`,
          [itemStatus, transactionId, normalizedJobId, entry.input.externalId],
        );
      }
    }
    const [totalsRows] = await connection.query(
      `SELECT item_status, COUNT(*) AS transaction_count, COALESCE(SUM(source_record_count), 0) AS line_item_count
         FROM accounting_transaction_import_items WHERE import_job_id = ? GROUP BY item_status`, [normalizedJobId],
    );
    const totals = new Map(totalsRows.map((row) => [String(row.item_status), row]));
    const progress = await aggregateProgress(connection, job);
    const result = {
      ...jobIdentity({ ...job, job_status: "committed" }),
      committed: true,
      already_committed: false,
      preview_digest: `sha256:${normalizedDigest}`,
      progress,
      final_summary: {
        transactions: {
          created: Number(totals.get("committed")?.transaction_count ?? 0),
          reused: Number(totals.get("reused")?.transaction_count ?? 0),
          exceptions: Number(totals.get("exception")?.transaction_count ?? 0),
        },
        line_items: {
          created: Number(totals.get("committed")?.line_item_count ?? 0),
          reused: Number(totals.get("reused")?.line_item_count ?? 0),
          exceptions: Number(totals.get("exception")?.line_item_count ?? 0),
        },
      },
    };
    await connection.query(
      `UPDATE accounting_transaction_import_jobs
          SET job_status = 'committed', committed_at = UTC_TIMESTAMP(6), result_json = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE import_job_id = ?`, [JSON.stringify(result), normalizedJobId],
    );
    return result;
  });
}
