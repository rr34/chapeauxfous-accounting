import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendArtifactUpload,
  artifactUploadHttpResponse,
  artifactUploadContract,
  completeArtifactUpload,
  createArtifactUpload,
  getArtifactUpload,
  readCompleteArtifact,
} from "../src/artifact-upload.js";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function memoryPool() {
  const uploads = new Map();
  const chunks = new Map();
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, values) {
      if (sql.includes("INSERT INTO accounting_artifact_uploads")) {
        const [artifactId, ownerPersonId, clientRequestId, fileName, mediaType, expectedByteSize, expectedSha256] = values;
        const prior = [...uploads.values()].find((row) => row.owner_person_id === ownerPersonId
          && row.client_request_id === clientRequestId);
        if (!prior) uploads.set(artifactId, { artifact_id: artifactId, owner_person_id: ownerPersonId,
          client_request_id: clientRequestId, file_name: fileName, media_type: mediaType,
          expected_byte_size: expectedByteSize, received_byte_size: 0, expected_sha256: expectedSha256,
          upload_status: "receiving", completed_at: null });
        return [{ affectedRows: prior ? 0 : 1 }];
      }
      if (sql.includes("WHERE owner_person_id = ? AND client_request_id = ?")) {
        const [ownerPersonId, clientRequestId] = values;
        return [[...uploads.values()].filter((row) => row.owner_person_id === ownerPersonId
          && row.client_request_id === clientRequestId)];
      }
      if (sql.includes("FROM accounting_artifact_uploads") && sql.includes("WHERE artifact_id = ?")) {
        const [artifactId, ownerPersonId] = values;
        const row = uploads.get(artifactId);
        return [[row && row.owner_person_id === ownerPersonId ? row : undefined].filter(Boolean)];
      }
      if (sql.includes("SELECT byte_count, chunk_sha256 FROM accounting_artifact_chunks")) {
        const row = chunks.get(`${values[0]}:${values[1]}`);
        return [[row].filter(Boolean)];
      }
      if (sql.includes("INSERT INTO accounting_artifact_chunks")) {
        const [artifactId, byteOffset, byteCount, chunkSha256, chunkBytes] = values;
        chunks.set(`${artifactId}:${byteOffset}`, { artifact_id: artifactId, byte_offset: byteOffset,
          byte_count: byteCount, chunk_sha256: chunkSha256, chunk_bytes: Buffer.from(chunkBytes) });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET received_byte_size = ?")) {
        uploads.get(values[1]).received_byte_size = values[0];
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SELECT byte_offset, byte_count, chunk_sha256, chunk_bytes")) {
        return [[...chunks.values()].filter((row) => row.artifact_id === values[0])
          .sort((left, right) => left.byte_offset - right.byte_offset)];
      }
      if (sql.includes("SET upload_status = 'complete'")) {
        uploads.get(values[0]).upload_status = "complete";
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
  };
  return { async getConnection() { return connection; } };
}

test("the generic artifact receiver resumes exact raw byte chunks and verifies the whole file", async () => {
  const pool = memoryPool();
  const bytes = Buffer.from('{"transaction_external_id":"tx-1"}\n', "utf8");
  const created = await createArtifactUpload({ pool, personId: 7, clientRequestId: "file-218-send-v1",
    fileName: "canonical.jsonl", artifactMediaType: "application/x-ndjson",
    expectedByteSize: bytes.length, expectedSha256: digest(bytes) });
  assert.equal(created.next_offset, 0);
  const first = bytes.subarray(0, 12);
  const rest = bytes.subarray(12);
  const firstResult = await appendArtifactUpload({ pool, personId: 7, artifactId: created.artifact_id,
    offset: 0, chunkSha256: digest(first), bytes: first });
  assert.equal(firstResult.next_offset, first.length);
  const replay = await appendArtifactUpload({ pool, personId: 7, artifactId: created.artifact_id,
    offset: 0, chunkSha256: digest(first), bytes: first });
  assert.equal(replay.idempotent_replay, true);
  await assert.rejects(appendArtifactUpload({ pool, personId: 7, artifactId: created.artifact_id,
    offset: first.length + 1, chunkSha256: digest(rest), bytes: rest }),
  (error) => error.code === "ARTIFACT_OFFSET_MISMATCH" && error.details.expected_offset === first.length);
  await appendArtifactUpload({ pool, personId: 7, artifactId: created.artifact_id,
    offset: first.length, chunkSha256: digest(rest), bytes: rest });
  const completed = await completeArtifactUpload({ pool, personId: 7, artifactId: created.artifact_id });
  assert.equal(completed.status, "complete");
  assert.equal(completed.artifact_id, created.artifact_id);
  assert.equal(completed.next_offset, bytes.length);
  assert.equal(completed.media_type, "application/x-ndjson");
  assert.equal(completed.byte_size, bytes.length);
  assert.equal(completed.sha256, digest(bytes));
  assert.deepEqual(artifactUploadHttpResponse(completed), {
    contractVersion: 1,
    artifact_id: created.artifact_id,
    file_name: "canonical.jsonl",
    media_type: "application/x-ndjson",
    byte_size: bytes.length,
    sha256: digest(bytes),
    status: "complete",
    next_offset: bytes.length,
    idempotent_replay: false,
  });
  assert.equal((await getArtifactUpload({ pool, personId: 7, artifactId: created.artifact_id })).next_offset,
    bytes.length);
  const verified = await readCompleteArtifact({ pool, personId: 7, artifactId: created.artifact_id });
  assert.deepEqual(verified.bytes, bytes);
});

test("the advertised upload contract matches the Agent Slayer HTTP data-plane convention", () => {
  assert.deepEqual(artifactUploadContract, {
    contractVersion: 1,
    transportId: "transaction_import",
    endpointPath: "/mcp/artifacts",
    acceptedMediaTypes: ["application/x-ndjson"],
    maximumChunkBytes: 1024 * 1024,
    maximumBytes: 64 * 1024 * 1024,
  });
});
