import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bindStatementImportPreview,
  createStatementImportFromPdf,
  restartStatementImportJob,
  sendEvidenceFileContent,
  startStatementImportJob,
} from "../src/statement-import-jobs.js";

function statementPool() {
  const state = { evidence: new Map(), jobs: new Map(), nextEvidenceId: 1 };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      if (sql.includes("FROM accounts WHERE account_id")) {
        return [[{ account_id: Number(params[0]), is_placeholder: 0, archived_at: null }]];
      }
      if (sql.includes("INSERT INTO accounting_evidence_files")) {
        const [owner, fileName, mediaType, byteSize, sha256, storageKey] = params;
        let row = [...state.evidence.values()].find((item) => item.owner_person_id === owner
          && item.sha256 === sha256);
        if (!row) {
          row = { evidence_file_id: state.nextEvidenceId++, owner_person_id: owner,
            original_file_name: fileName, media_type: mediaType, byte_size: byteSize,
            sha256, storage_key: storageKey, currency_id: null,
            start_date: null, start_amount_units: null, end_date: null, end_amount_units: null,
            created_at: "2026-11-04 12:00:00.000000" };
          state.evidence.set(row.evidence_file_id, row);
        }
        return [{ insertId: row.evidence_file_id }];
      }
      if (sql.includes("INSERT INTO accounting_statement_import_jobs")) {
        const [id, owner, accountId, evidenceFileId] = params;
        state.jobs.set(id, { statement_import_job_id: id, owner_person_id: owner,
          account_id: accountId, evidence_file_id: evidenceFileId, job_status: "ready",
          import_plan_id: null, canonical_artifact_id: null,
          created_at: "2026-11-04 12:00:00.000000", updated_at: "2026-11-04 12:00:00.000000",
          committed_at: null });
        return [{ insertId: 0, affectedRows: 1 }];
      }
      if (sql.includes("FROM accounting_statement_import_jobs sij")) {
        const [id, owner] = params;
        const job = state.jobs.get(id);
        if (!job || job.owner_person_id !== owner) return [[]];
        const evidence = state.evidence.get(job.evidence_file_id);
        return [[{ ...job, ...evidence, evidence_created_at: evidence.created_at,
          account_currency_id: 1, AccountName: "Checking", CurrencyAbbreviation: "USD", scale: 2,
          evidence_currency_id: evidence.currency_id,
          evidence_currency_code: evidence.currency_id == null ? null : "USD",
          evidence_currency_scale: evidence.currency_id == null ? null : 2 }]];
      }
      if (sql.includes("FROM accounting_evidence_files")) {
        const [id, owner] = params;
        const evidence = state.evidence.get(Number(id));
        return [[evidence?.owner_person_id === owner ? evidence : undefined].filter(Boolean)];
      }
      if (sql.includes("SELECT person_id FROM people2_people")) return [[{ person_id: params[0] }]];
      if (sql.includes("SELECT statement_import_job_id FROM accounting_statement_import_jobs")) {
        const [owner, excludedId] = params;
        return [[...state.jobs.values()].filter((job) => job.owner_person_id === owner
          && job.job_status === "processing" && job.statement_import_job_id !== excludedId)
          .map((job) => ({ statement_import_job_id: job.statement_import_job_id }))];
      }
      if (sql.includes("SET job_status = 'processing'")) {
        const [id, owner] = params;
        const job = state.jobs.get(id);
        if (job?.owner_person_id === owner) job.job_status = "processing";
        return [{ affectedRows: job ? 1 : 0 }];
      }
      if (sql.includes("UPDATE accounting_evidence_files")) {
        const [startDate, startAmountUnits, endDate, endAmountUnits, currencyId, evidenceFileId, owner] = params;
        const evidence = state.evidence.get(Number(evidenceFileId));
        if (evidence?.owner_person_id === owner) Object.assign(evidence, {
          start_date: startDate, start_amount_units: startAmountUnits,
          end_date: endDate, end_amount_units: endAmountUnits, currency_id: currencyId,
        });
        return [{ affectedRows: evidence ? 1 : 0 }];
      }
      if (sql.includes("SET job_status = 'preview_ready'")) {
        const [importPlanId, canonicalArtifactId, id, owner] = params;
        const job = state.jobs.get(id);
        if (job?.owner_person_id === owner) Object.assign(job, { job_status: "preview_ready",
          import_plan_id: importPlanId, canonical_artifact_id: canonicalArtifactId });
        return [{ affectedRows: job ? 1 : 0 }];
      }
      if (sql.includes("DELETE FROM accounting_statement_import_jobs")) {
        const [id, owner] = params;
        const job = state.jobs.get(id);
        if (job?.owner_person_id === owner) state.jobs.delete(id);
        return [{ affectedRows: job ? 1 : 0 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return { state, query: connection.query.bind(connection), async getConnection() { return connection; } };
}

class TestResponse extends Writable {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 200;
    this.chunks = [];
  }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  set(name, value) { this.headers.set(name.toLowerCase(), String(value)); return this; }
  status(code) { this.statusCode = code; return this; }
  get body() { return Buffer.concat(this.chunks); }
}

test("Accounting owns the original PDF while statement jobs restart with a fresh identity", async (t) => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "accounting-evidence-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const pool = statementPool();
  const bytes = Buffer.from("%PDF-1.7\noriginal statement bytes\n%%EOF\n", "ascii");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const created = await createStatementImportFromPdf({ pool, evidenceRoot, personId: 7, accountId: 34,
    fileName: "November statement.pdf", mediaType: "application/pdf", bytes });
  assert.equal(created.status, "ready");
  assert.equal(created.account.id, 34);
  assert.equal(created.evidenceFile.sha256, `sha256:${sha256}`);
  assert.equal(created.download.endpointPath, `/mcp/evidence-files/${created.evidenceFile.id}/content`);
  assert.equal(created.download.acceptsByteRanges, true);
  assert.match(created.copiedPrompt, new RegExp(`accounting://statement-import-jobs/${created.id}`));
  assert.equal(created.copiedPrompt.includes("PDF bytes"), false);
  assert.deepEqual(await readFile(path.join(evidenceRoot, `owner-7/sha256/${sha256}.pdf`)), bytes);

  const started = await startStatementImportJob({ pool, personId: 7, statementImportJobId: created.id });
  assert.equal(started.transitioned, true);
  assert.equal(started.job.status, "processing");
  const replay = await startStatementImportJob({ pool, personId: 7, statementImportJobId: created.id });
  assert.equal(replay.transitioned, false);

  const restarted = await restartStatementImportJob({ pool, personId: 7, statementImportJobId: created.id });
  assert.notEqual(restarted.job.id, created.id);
  assert.equal(restarted.job.status, "ready");
  assert.equal(restarted.job.evidenceFile.id, created.evidenceFile.id);
  assert.equal(restarted.job.evidenceFile.sha256, created.evidenceFile.sha256);
  await assert.rejects(startStatementImportJob({ pool, personId: 7, statementImportJobId: created.id }),
    (error) => error.code === "STATEMENT_IMPORT_JOB_NOT_FOUND");

  const response = new TestResponse();
  const finished = new Promise((resolve, reject) => response.once("finish", resolve).once("error", reject));
  await sendEvidenceFileContent({ pool, evidenceRoot, personId: 7,
    evidenceFileId: created.evidenceFile.id, rangeHeader: "bytes=5-11", response });
  await finished;
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("x-content-sha256"), sha256);
  assert.equal(response.headers.get("content-range"), `bytes 5-11/${bytes.length}`);
  assert.deepEqual(response.body, bytes.subarray(5, 12));
});

test("statement processing is serial per owner", async (t) => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "accounting-evidence-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const pool = statementPool();
  const bytes = Buffer.from("%PDF-1.4\nstatement\n%%EOF", "ascii");
  const first = await createStatementImportFromPdf({ pool, evidenceRoot, personId: 7, accountId: 34,
    fileName: "first.pdf", mediaType: "application/pdf", bytes });
  const second = await createStatementImportFromPdf({ pool, evidenceRoot, personId: 7, accountId: 34,
    fileName: "second.pdf", mediaType: "application/pdf", bytes });
  await startStatementImportJob({ pool, personId: 7, statementImportJobId: first.id });
  await assert.rejects(startStatementImportJob({ pool, personId: 7, statementImportJobId: second.id }),
    (error) => error.code === "STATEMENT_PROCESSING_SERIAL_CONFLICT"
      && error.details.activeJobId === first.id);
});

test("binding a statement preview stores each evidence significance field independently", async (t) => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "accounting-evidence-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const pool = statementPool();
  const created = await createStatementImportFromPdf({ pool, evidenceRoot, personId: 7, accountId: 34,
    fileName: "independent.pdf", mediaType: "application/pdf",
    bytes: Buffer.from("%PDF-1.4\nstatement\n%%EOF", "ascii") });
  await startStatementImportJob({ pool, personId: 7, statementImportJobId: created.id });
  const saved = await bindStatementImportPreview({ pool, personId: 7, statementImportJobId: created.id,
    importPlanId: "11111111-1111-4111-8111-111111111111",
    canonicalArtifactId: "22222222-2222-4222-8222-222222222222",
    evidenceMetadata: {
      startDate: "2026-10-01", startAmountUnits: null,
      endDate: null, endAmountUnits: "12345", currencyId: 1,
    } });
  assert.equal(saved.status, "preview_ready");
  assert.deepEqual({
    startDate: saved.evidenceFile.startDate,
    startAmountUnits: saved.evidenceFile.startAmountUnits,
    endDate: saved.evidenceFile.endDate,
    endAmountUnits: saved.evidenceFile.endAmountUnits,
    currencyId: saved.evidenceFile.currencyId,
  }, {
    startDate: "2026-10-01", startAmountUnits: null,
    endDate: null, endAmountUnits: "12345", currencyId: 1,
  });
});
