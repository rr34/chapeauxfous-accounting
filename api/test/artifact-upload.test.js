import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendArtifactUpload,
  artifactUploadHttpResponse,
  artifactUploadContract,
  bindArtifactToImportJob,
  completeArtifactUpload,
  createArtifactUpload,
  getArtifactUpload,
  readCompleteArtifact,
} from "../src/artifact-upload.js";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function testRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "accounting-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the generic artifact receiver resumes exact raw byte chunks and verifies the whole file", async (t) => {
  const artifactRoot = await testRoot(t);
  const bytes = Buffer.from('{"transaction_external_id":"tx-1"}\n', "utf8");
  const input = {
    artifactRoot,
    personId: 7,
    clientRequestId: "file-218-send-v1",
    fileName: "canonical.jsonl",
    artifactMediaType: "application/x-ndjson",
    expectedByteSize: bytes.length,
    expectedSha256: digest(bytes),
  };
  const created = await createArtifactUpload(input);
  assert.equal(created.next_offset, 0);
  assert.equal((await createArtifactUpload(input)).idempotent_replay, true);

  const first = bytes.subarray(0, 12);
  const rest = bytes.subarray(12);
  const firstResult = await appendArtifactUpload({ artifactRoot, personId: 7, artifactId: created.artifact_id,
    offset: 0, chunkSha256: digest(first), bytes: first });
  assert.equal(firstResult.next_offset, first.length);
  const replay = await appendArtifactUpload({ artifactRoot, personId: 7, artifactId: created.artifact_id,
    offset: 0, chunkSha256: digest(first), bytes: first });
  assert.equal(replay.idempotent_replay, true);
  await assert.rejects(appendArtifactUpload({ artifactRoot, personId: 7, artifactId: created.artifact_id,
    offset: first.length + 1, chunkSha256: digest(rest), bytes: rest }),
  (error) => error.code === "ARTIFACT_OFFSET_MISMATCH" && error.details.expected_offset === first.length);
  await appendArtifactUpload({ artifactRoot, personId: 7, artifactId: created.artifact_id,
    offset: first.length, chunkSha256: digest(rest), bytes: rest });

  const completed = await completeArtifactUpload({ artifactRoot, personId: 7, artifactId: created.artifact_id });
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
  assert.equal((await getArtifactUpload({ artifactRoot, personId: 7,
    artifactId: created.artifact_id })).next_offset, bytes.length);
  const verified = await readCompleteArtifact({ artifactRoot, personId: 7, artifactId: created.artifact_id });
  assert.deepEqual(verified.bytes, bytes);

  const stored = await readFile(path.join(artifactRoot, "owner-7", created.artifact_id, "content.complete"));
  assert.deepEqual(stored, bytes);
});

test("filesystem bindings keep one completed artifact and one import job paired idempotently", async (t) => {
  const artifactRoot = await testRoot(t);
  const bytes = Buffer.from("{}\n", "utf8");
  const first = await createArtifactUpload({ artifactRoot, personId: 7, clientRequestId: "first",
    fileName: "first.jsonl", artifactMediaType: "application/x-ndjson",
    expectedByteSize: bytes.length, expectedSha256: digest(bytes) });
  await appendArtifactUpload({ artifactRoot, personId: 7, artifactId: first.artifact_id,
    offset: 0, chunkSha256: digest(bytes), bytes });
  await completeArtifactUpload({ artifactRoot, personId: 7, artifactId: first.artifact_id });
  const firstJob = "11111111-1111-4111-8111-111111111111";
  const secondJob = "22222222-2222-4222-8222-222222222222";
  assert.equal((await bindArtifactToImportJob({ artifactRoot, personId: 7,
    artifactId: first.artifact_id, importJobId: firstJob })).idempotent_replay, false);
  assert.equal((await bindArtifactToImportJob({ artifactRoot, personId: 7,
    artifactId: first.artifact_id, importJobId: firstJob })).idempotent_replay, true);
  await assert.rejects(bindArtifactToImportJob({ artifactRoot, personId: 7,
    artifactId: first.artifact_id, importJobId: secondJob }), (error) => error.code === "ARTIFACT_BINDING_CONFLICT");

  const second = await createArtifactUpload({ artifactRoot, personId: 7, clientRequestId: "second",
    fileName: "second.jsonl", artifactMediaType: "application/x-ndjson",
    expectedByteSize: bytes.length, expectedSha256: digest(bytes) });
  await appendArtifactUpload({ artifactRoot, personId: 7, artifactId: second.artifact_id,
    offset: 0, chunkSha256: digest(bytes), bytes });
  await completeArtifactUpload({ artifactRoot, personId: 7, artifactId: second.artifact_id });
  await assert.rejects(bindArtifactToImportJob({ artifactRoot, personId: 7,
    artifactId: second.artifact_id, importJobId: firstJob }), (error) => error.code === "ARTIFACT_BINDING_CONFLICT");
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
