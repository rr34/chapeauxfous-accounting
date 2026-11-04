import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withPoolTransaction } from "./db.js";

export const STATEMENT_EVIDENCE_MAX_BYTES = 64 * 1024 * 1024;
export const STATEMENT_EVIDENCE_MEDIA_TYPE = "application/pdf";
export const STATEMENT_EVIDENCE_DOWNLOAD_CONTRACT_VERSION = 1;

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EVIDENCE_ROOT = path.resolve(MODULE_DIRECTORY, "../data/evidence");

function statementError(message, code, details = undefined, status = 400) {
  return Object.assign(new Error(message), { message, code, details, status });
}

function ownerId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw statementError("Authenticated statement owner is invalid.", "INVALID_STATEMENT_OWNER", undefined, 500);
  }
  return id;
}

function positiveId(value, label, code = "INVALID_STATEMENT_IDENTIFIER") {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw statementError(`${label} is invalid.`, code);
  return id;
}

function jobId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(id)) {
    throw statementError("Statement import job not found.", "STATEMENT_IMPORT_JOB_NOT_FOUND", undefined, 404);
  }
  return id;
}

function safeFileName(value) {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f/\\]+/gu, " ").trim();
  if (!normalized) throw statementError("A PDF filename is required.", "STATEMENT_FILE_NAME_REQUIRED");
  const characters = [...normalized];
  if (characters.length > 1024) {
    throw statementError("The PDF filename cannot exceed 1,024 characters.", "STATEMENT_FILE_NAME_TOO_LONG");
  }
  return normalized;
}

function pdfBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  if (bytes.length < 1 || bytes.length > STATEMENT_EVIDENCE_MAX_BYTES) {
    throw statementError(`The statement PDF must contain 1 through ${STATEMENT_EVIDENCE_MAX_BYTES} bytes.`,
      "INVALID_STATEMENT_FILE_SIZE", { maximumBytes: STATEMENT_EVIDENCE_MAX_BYTES }, 413);
  }
  if (!bytes.subarray(0, Math.min(bytes.length, 1024)).includes(Buffer.from("%PDF-", "ascii"))) {
    throw statementError("The uploaded file is not a recognizable PDF.", "INVALID_STATEMENT_PDF", undefined, 415);
  }
  return bytes;
}

export function resolveEvidenceRoot(value = process.env.ACCOUNTING_EVIDENCE_ROOT) {
  const configured = String(value ?? "").trim();
  return configured ? path.resolve(configured) : DEFAULT_EVIDENCE_ROOT;
}

function evidenceStorageKey(personId, digest) {
  return `owner-${ownerId(personId)}/sha256/${digest}.pdf`;
}

function evidencePath(evidenceRoot, storageKey) {
  const root = resolveEvidenceRoot(evidenceRoot);
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw statementError("Stored evidence identity is invalid.", "EVIDENCE_STORAGE_CONFLICT", undefined, 500);
  }
  return resolved;
}

async function persistEvidenceBytes({ evidenceRoot, personId, digest, bytes }) {
  const storageKey = evidenceStorageKey(personId, digest);
  const destination = evidencePath(evidenceRoot, storageKey);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await access(destination);
    const existing = await readFile(destination);
    const existingDigest = createHash("sha256").update(existing).digest("hex");
    if (existing.length !== bytes.length || existingDigest !== digest) {
      throw statementError("Stored evidence bytes conflict with their content identity.",
        "EVIDENCE_STORAGE_CONFLICT", undefined, 500);
    }
    return storageKey;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.${randomUUID()}.partial`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, destination);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return storageKey;
}

function evidenceValue(row) {
  const id = Number(row.evidence_file_id);
  return {
    objectType: "accounting.evidence_file",
    id,
    sourceRef: `accounting://evidence-files/${id}`,
    displayName: String(row.original_file_name),
    fileName: String(row.original_file_name),
    mediaType: String(row.media_type),
    byteSize: Number(row.byte_size),
    sha256: `sha256:${String(row.sha256)}`,
    createdAt: String(row.evidence_created_at ?? row.created_at),
  };
}

function accountDisplayName(row) {
  return String(row.AccountName);
}

function copiedPrompt(id) {
  return [
    "Process my pending Accounting statement import:",
    "",
    `accounting://statement-import-jobs/${id}`,
    "",
    "Use the Accounting MCP to resolve this exact work item, obtain the complete original PDF and current extraction requirements, and create a pending import preview. Do not commit the preview. Stop after reporting the summary and asking for my approval.",
  ].join("\n");
}

function downloadDescriptor(evidence) {
  return {
    contractVersion: STATEMENT_EVIDENCE_DOWNLOAD_CONTRACT_VERSION,
    transportId: "statement_evidence_download",
    evidenceFileId: evidence.id,
    sourceRef: evidence.sourceRef,
    fileName: evidence.fileName,
    mediaType: evidence.mediaType,
    byteSize: evidence.byteSize,
    sha256: evidence.sha256,
    method: "GET",
    endpointPath: `/mcp/evidence-files/${evidence.id}/content`,
    acceptsByteRanges: true,
  };
}

function statementJobValue(row) {
  const id = String(row.statement_import_job_id);
  const evidence = evidenceValue(row);
  return {
    objectType: "accounting.statement_import_job",
    id,
    sourceRef: `accounting://statement-import-jobs/${id}`,
    displayName: `${evidence.fileName} · ${accountDisplayName(row)} · ${String(row.job_status)}`,
    status: String(row.job_status),
    account: {
      objectType: "accounting.account",
      id: Number(row.account_id),
      sourceRef: `accounting://accounts/${row.account_id}`,
      displayName: accountDisplayName(row),
      currencyCode: String(row.CurrencyAbbreviation).trim(),
      scale: Number(row.scale),
    },
    evidenceFile: evidence,
    sourceDocumentId: evidence.sha256,
    importPlanId: row.import_plan_id == null ? null : String(row.import_plan_id),
    canonicalArtifactId: row.canonical_artifact_id == null ? null : String(row.canonical_artifact_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    committedAt: row.committed_at == null ? null : String(row.committed_at),
    download: downloadDescriptor(evidence),
    copiedPrompt: copiedPrompt(id),
  };
}

const statementJobSelect = `
  SELECT sij.statement_import_job_id, sij.account_id, sij.evidence_file_id, sij.job_status,
         sij.import_plan_id, sij.canonical_artifact_id, sij.created_at, sij.updated_at, sij.committed_at,
         ef.original_file_name, ef.media_type, ef.byte_size, ef.sha256, ef.storage_key,
         ef.created_at AS evidence_created_at, a.AccountName, c.CurrencyAbbreviation, c.scale
    FROM accounting_statement_import_jobs sij
    JOIN accounting_evidence_files ef
      ON ef.evidence_file_id = sij.evidence_file_id AND ef.owner_person_id = sij.owner_person_id
    JOIN accounts a ON a.account_id = sij.account_id AND a.owner_person_id = sij.owner_person_id
    JOIN currencies c ON c.currency_id = a.account_currency_id`;

async function loadStatementJob(connection, personId, statementImportJobId, { lock = false } = {}) {
  const id = jobId(statementImportJobId);
  const [rows] = await connection.query(
    `${statementJobSelect}
      WHERE sij.statement_import_job_id = ? AND sij.owner_person_id = ?${lock ? " FOR UPDATE" : ""}`,
    [id, ownerId(personId)],
  );
  if (!rows.length) throw statementError("Statement import job not found.",
    "STATEMENT_IMPORT_JOB_NOT_FOUND", undefined, 404);
  return rows[0];
}

export async function createStatementImportFromPdf({
  pool, evidenceRoot, personId, accountId, fileName, mediaType, bytes,
}) {
  const owner = ownerId(personId);
  const account = positiveId(accountId, "Statement account", "ACCOUNT_NOT_FOUND");
  const name = safeFileName(fileName);
  if (String(mediaType ?? "").split(";", 1)[0].trim().toLowerCase() !== STATEMENT_EVIDENCE_MEDIA_TYPE) {
    throw statementError("Statement upload currently accepts application/pdf.",
      "UNSUPPORTED_STATEMENT_MEDIA_TYPE", { acceptedMediaTypes: [STATEMENT_EVIDENCE_MEDIA_TYPE] }, 415);
  }
  const content = pdfBytes(bytes);
  const digest = createHash("sha256").update(content).digest("hex");
  const storageKey = await persistEvidenceBytes({ evidenceRoot, personId: owner, digest, bytes: content });
  const statementImportJobId = randomUUID();
  await withPoolTransaction(pool, async (connection) => {
    const [accounts] = await connection.query(
      `SELECT account_id, is_placeholder, archived_at
         FROM accounts WHERE account_id = ? AND owner_person_id = ? FOR UPDATE`,
      [account, owner],
    );
    if (!accounts.length) throw statementError("Statement account not found.", "ACCOUNT_NOT_FOUND", undefined, 404);
    if (accounts[0].archived_at != null || Boolean(accounts[0].is_placeholder)) {
      throw statementError("A statement requires an active postable account.", "STATEMENT_ACCOUNT_NOT_POSTABLE");
    }
    const [evidenceInsert] = await connection.query(
      `INSERT INTO accounting_evidence_files
        (owner_person_id, original_file_name, media_type, byte_size, sha256, storage_key)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE evidence_file_id = LAST_INSERT_ID(evidence_file_id)`,
      [owner, name, STATEMENT_EVIDENCE_MEDIA_TYPE, content.length, digest, storageKey],
    );
    const evidenceFileId = Number(evidenceInsert.insertId);
    await connection.query(
      `INSERT INTO accounting_statement_import_jobs
        (statement_import_job_id, owner_person_id, account_id, evidence_file_id, job_status)
       VALUES (?, ?, ?, ?, 'ready')`,
      [statementImportJobId, owner, account, evidenceFileId],
    );
  });
  return getStatementImportJob({ pool, personId: owner, statementImportJobId });
}

export async function getStatementImportJob({ pool, personId, statementImportJobId }) {
  const row = await loadStatementJob(pool, personId, statementImportJobId);
  return statementJobValue(row);
}

export async function listStatementImportJobs({ pool, personId, accountId = null, limit = 25 }) {
  const owner = ownerId(personId);
  const resolvedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const clauses = ["sij.owner_person_id = ?"];
  const params = [owner];
  if (accountId != null) {
    clauses.push("sij.account_id = ?");
    params.push(positiveId(accountId, "Statement account", "ACCOUNT_NOT_FOUND"));
  }
  const [rows] = await pool.query(
    `${statementJobSelect}
      WHERE ${clauses.join(" AND ")}
      ORDER BY sij.updated_at DESC, sij.statement_import_job_id DESC LIMIT ?`,
    [...params, resolvedLimit],
  );
  return rows.map(statementJobValue);
}

export async function listStatementImportJobObjectsPage(pool, personId, {
  limit = 100, cursor = null, statementImportJobId = null, accountId = null,
} = {}) {
  const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const clauses = ["sij.owner_person_id = ?"];
  const params = [ownerId(personId)];
  if (statementImportJobId != null) {
    if (cursor != null || accountId != null) throw statementError(
      "An exact statement-job ID cannot be combined with other filters.", "INVALID_STATEMENT_JOB_OBJECT_FILTER");
    clauses.push("sij.statement_import_job_id = ?");
    params.push(jobId(statementImportJobId));
  } else {
    if (cursor != null) {
      clauses.push("sij.statement_import_job_id < ?");
      params.push(jobId(cursor));
    }
    if (accountId != null) {
      clauses.push("sij.account_id = ?");
      params.push(positiveId(accountId, "Statement account", "ACCOUNT_NOT_FOUND"));
    }
  }
  const [rows] = await pool.query(
    `${statementJobSelect}
      WHERE ${clauses.join(" AND ")}
      ORDER BY sij.statement_import_job_id DESC LIMIT ?`,
    [...params, resolvedLimit + 1],
  );
  const objects = rows.slice(0, resolvedLimit).map(statementJobValue);
  return { objects, nextCursor: rows.length > resolvedLimit ? objects.at(-1).id : null };
}

export async function listEvidenceFileObjectsPage(pool, personId, {
  limit = 100, cursor = null, evidenceFileId = null,
} = {}) {
  const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const clauses = ["owner_person_id = ?"];
  const params = [ownerId(personId)];
  if (evidenceFileId != null) {
    if (cursor != null) throw statementError("An exact evidence ID cannot be combined with a cursor.",
      "INVALID_EVIDENCE_OBJECT_FILTER");
    clauses.push("evidence_file_id = ?");
    params.push(positiveId(evidenceFileId, "Evidence file"));
  } else if (cursor != null) {
    clauses.push("evidence_file_id < ?");
    params.push(positiveId(cursor, "Evidence cursor"));
  }
  const [rows] = await pool.query(
    `SELECT evidence_file_id, original_file_name, media_type, byte_size, sha256, created_at
       FROM accounting_evidence_files
      WHERE ${clauses.join(" AND ")}
      ORDER BY evidence_file_id DESC LIMIT ?`,
    [...params, resolvedLimit + 1],
  );
  const objects = rows.slice(0, resolvedLimit).map(evidenceValue);
  return { objects, nextCursor: rows.length > resolvedLimit ? String(objects.at(-1).id) : null };
}

export async function startStatementImportJob({ pool, personId, statementImportJobId }) {
  return withPoolTransaction(pool, async (connection) => {
    await connection.query("SELECT person_id FROM people2_people WHERE person_id = ? FOR UPDATE",
      [ownerId(personId)]);
    const row = await loadStatementJob(connection, personId, statementImportJobId, { lock: true });
    let transitioned = false;
    if (row.job_status === "ready") {
      const [active] = await connection.query(
        `SELECT statement_import_job_id FROM accounting_statement_import_jobs
          WHERE owner_person_id = ? AND job_status = 'processing'
            AND statement_import_job_id <> ? LIMIT 1 FOR UPDATE`,
        [ownerId(personId), row.statement_import_job_id],
      );
      if (active.length) throw statementError("Another statement is already being processed. Finish or restart it first.",
        "STATEMENT_PROCESSING_SERIAL_CONFLICT", { activeJobId: String(active[0].statement_import_job_id) }, 409);
      await connection.query(
        `UPDATE accounting_statement_import_jobs
            SET job_status = 'processing', updated_at = UTC_TIMESTAMP(6)
          WHERE statement_import_job_id = ? AND owner_person_id = ?`,
        [row.statement_import_job_id, ownerId(personId)],
      );
      row.job_status = "processing";
      row.updated_at = new Date().toISOString();
      transitioned = true;
    } else if (row.job_status !== "processing") {
      throw statementError(row.job_status === "preview_ready"
        ? "This statement job already has a pending preview. Review or restart it instead of processing it again."
        : "This statement import is already committed.",
      row.job_status === "preview_ready" ? "STATEMENT_PREVIEW_ALREADY_READY" : "STATEMENT_IMPORT_ALREADY_COMMITTED",
      undefined, 409);
    }
    return { job: statementJobValue(row), transitioned };
  });
}

export async function bindStatementImportPreview({
  pool, personId, statementImportJobId, importPlanId, canonicalArtifactId,
}) {
  return withPoolTransaction(pool, async (connection) => {
    const row = await loadStatementJob(connection, personId, statementImportJobId, { lock: true });
    if (row.job_status === "committed") throw statementError("The statement import is already committed.",
      "STATEMENT_IMPORT_ALREADY_COMMITTED", undefined, 409);
    if (row.job_status === "preview_ready") {
      if (String(row.import_plan_id) !== String(importPlanId)
          || String(row.canonical_artifact_id) !== String(canonicalArtifactId)) {
        throw statementError("This statement job is already bound to a different preview.",
          "STATEMENT_PREVIEW_BINDING_CONFLICT", undefined, 409);
      }
      return statementJobValue(row);
    }
    if (row.job_status !== "processing") throw statementError("Start this statement job before submitting extraction.",
      "STATEMENT_JOB_NOT_PROCESSING", undefined, 409);
    await connection.query(
      `UPDATE accounting_statement_import_jobs
          SET job_status = 'preview_ready', import_plan_id = ?, canonical_artifact_id = ?,
              updated_at = UTC_TIMESTAMP(6)
        WHERE statement_import_job_id = ? AND owner_person_id = ?`,
      [String(importPlanId), String(canonicalArtifactId), row.statement_import_job_id, ownerId(personId)],
    );
    return getStatementImportJob({ pool: connection, personId, statementImportJobId: row.statement_import_job_id });
  });
}

export async function restartStatementImportJob({ pool, personId, statementImportJobId }) {
  const newJobId = randomUUID();
  const removed = await withPoolTransaction(pool, async (connection) => {
    const row = await loadStatementJob(connection, personId, statementImportJobId, { lock: true });
    if (row.job_status === "committed") throw statementError(
      "A committed statement import cannot be restarted. Use the committed-import removal workflow.",
      "COMMITTED_STATEMENT_RESTART_FORBIDDEN", undefined, 409);
    await connection.query(
      `DELETE FROM accounting_statement_import_jobs
        WHERE statement_import_job_id = ? AND owner_person_id = ?`,
      [row.statement_import_job_id, ownerId(personId)],
    );
    if (row.import_plan_id != null) {
      await connection.query(
        `DELETE FROM accounting_import_plans
          WHERE import_plan_id = ? AND owner_person_id = ? AND plan_status <> 'committed'`,
        [row.import_plan_id, ownerId(personId)],
      );
    }
    await connection.query(
      `INSERT INTO accounting_statement_import_jobs
        (statement_import_job_id, owner_person_id, account_id, evidence_file_id, job_status)
       VALUES (?, ?, ?, ?, 'ready')`,
      [newJobId, ownerId(personId), row.account_id, row.evidence_file_id],
    );
    return { canonicalArtifactId: row.canonical_artifact_id == null ? null : String(row.canonical_artifact_id) };
  });
  return {
    job: await getStatementImportJob({ pool, personId, statementImportJobId: newJobId }),
    removedCanonicalArtifactId: removed.canonicalArtifactId,
  };
}

export async function getEvidenceFile({ pool, personId, evidenceFileId }) {
  const id = positiveId(evidenceFileId, "Evidence file", "EVIDENCE_FILE_NOT_FOUND");
  const [rows] = await pool.query(
    `SELECT evidence_file_id, original_file_name, media_type, byte_size, sha256, storage_key, created_at
       FROM accounting_evidence_files
      WHERE evidence_file_id = ? AND owner_person_id = ?`,
    [id, ownerId(personId)],
  );
  if (!rows.length) throw statementError("Evidence file not found.", "EVIDENCE_FILE_NOT_FOUND", undefined, 404);
  return rows[0];
}

function contentDisposition(fileName) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(fileName))}`;
}

function requestedRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return false;
  }
  return { start, end: Math.min(end, size - 1) };
}

export async function sendEvidenceFileContent({
  pool, evidenceRoot, personId, evidenceFileId, rangeHeader, method = "GET", response,
}) {
  const row = await getEvidenceFile({ pool, personId, evidenceFileId });
  const filePath = evidencePath(evidenceRoot, String(row.storage_key));
  const fileStat = await stat(filePath);
  const size = Number(row.byte_size);
  if (fileStat.size !== size) throw statementError("Stored evidence size failed verification.",
    "EVIDENCE_STORAGE_CONFLICT", undefined, 500);
  const range = requestedRange(rangeHeader, size);
  response.set("Accept-Ranges", "bytes");
  response.set("Cache-Control", "private, no-store");
  response.set("Content-Type", STATEMENT_EVIDENCE_MEDIA_TYPE);
  response.set("Content-Disposition", contentDisposition(row.original_file_name));
  response.set("ETag", `"sha256-${row.sha256}"`);
  response.set("X-Content-SHA256", String(row.sha256));
  if (range === false) {
    response.set("Content-Range", `bytes */${size}`);
    return response.status(416).end();
  }
  if (range) {
    response.status(206);
    response.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    response.set("Content-Length", String(range.end - range.start + 1));
  } else {
    response.status(200);
    response.set("Content-Length", String(size));
  }
  if (String(method).toUpperCase() === "HEAD") return response.end();
  const stream = createReadStream(filePath, range || undefined);
  stream.on("error", (error) => response.destroy(error));
  return stream.pipe(response);
}

