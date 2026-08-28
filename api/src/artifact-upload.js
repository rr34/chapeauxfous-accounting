import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir, open, readFile, readdir, rename, rm, stat, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACT_UPLOAD_CONTRACT_VERSION = 1;
export const ARTIFACT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_UPLOAD_MAX_CHUNK_BYTES = 1024 * 1024;
export const TRANSACTION_IMPORT_ARTIFACT_MEDIA_TYPES = Object.freeze([
  "application/x-ndjson",
]);

export const artifactUploadContract = Object.freeze({
  contractVersion: ARTIFACT_UPLOAD_CONTRACT_VERSION,
  transportId: "transaction_import",
  endpointPath: "/mcp/artifacts",
  acceptedMediaTypes: ["application/x-ndjson"],
  maximumChunkBytes: ARTIFACT_UPLOAD_MAX_CHUNK_BYTES,
  maximumBytes: ARTIFACT_UPLOAD_MAX_BYTES,
});

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARTIFACT_ROOT = path.resolve(MODULE_DIRECTORY, "../data/artifacts");
const STALE_LOCK_MILLISECONDS = 5 * 60 * 1000;

function artifactError(message, code, details = undefined, status = 400) {
  return Object.assign(new Error(message), { message, code, details, status });
}

function requiredText(value, field, maximum) {
  const text = String(value ?? "").trim();
  if (!text) throw artifactError(`${field} is required.`, `${field.toUpperCase().replaceAll(" ", "_")}_REQUIRED`);
  if ([...text].length > maximum) throw artifactError(
    `${field} cannot exceed ${maximum} characters.`, `${field.toUpperCase().replaceAll(" ", "_")}_TOO_LONG`,
  );
  return text;
}

function sha256(value, field = "sha256") {
  const digest = String(value ?? "").trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw artifactError(
    `${field} must be a SHA-256 hex digest.`, "INVALID_ARTIFACT_SHA256", { field },
  );
  return digest;
}

function mediaType(value) {
  const normalized = requiredText(value, "media type", 255).split(";", 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    throw artifactError("media_type must be a valid MIME media type.", "INVALID_ARTIFACT_MEDIA_TYPE");
  }
  return normalized;
}

function byteSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > ARTIFACT_UPLOAD_MAX_BYTES) throw artifactError(
    `byte_size must be an integer from 1 through ${ARTIFACT_UPLOAD_MAX_BYTES}.`, "INVALID_ARTIFACT_BYTE_SIZE",
    { maximum_bytes: ARTIFACT_UPLOAD_MAX_BYTES },
  );
  return size;
}

function personKey(personId) {
  const value = Number(personId);
  if (!Number.isSafeInteger(value) || value < 1) throw artifactError(
    "Authenticated person identity is invalid.", "INVALID_ARTIFACT_OWNER", undefined, 500,
  );
  return String(value);
}

function uuid(value, field) {
  const normalized = requiredText(value, field, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw artifactError(`${field} must be a UUID.`, `INVALID_${field.toUpperCase().replaceAll(" ", "_")}`);
  }
  return normalized;
}

function deterministicArtifactId(personId, requestId) {
  const bytes = createHash("sha256").update(`${personKey(personId)}\0${requestId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function resolveArtifactUploadRoot(value = process.env.ACCOUNTING_ARTIFACT_ROOT) {
  const configured = String(value ?? "").trim();
  return configured ? path.resolve(configured) : DEFAULT_ARTIFACT_ROOT;
}

function ownerPaths(artifactRoot, personId) {
  const owner = path.join(resolveArtifactUploadRoot(artifactRoot), `owner-${personKey(personId)}`);
  return {
    owner,
    locks: path.join(owner, ".locks"),
    jobs: path.join(owner, "import-jobs"),
  };
}

function artifactPaths(artifactRoot, personId, artifactId) {
  const owner = ownerPaths(artifactRoot, personId);
  const directory = path.join(owner.owner, artifactId);
  return {
    ...owner,
    directory,
    metadata: path.join(directory, "metadata.json"),
    partial: path.join(directory, "content.part"),
    complete: path.join(directory, "content.complete"),
    lock: path.join(owner.locks, `${artifactId}.lock`),
  };
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function withLock(lockPath, operation) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try { return await operation(); } finally { await rm(lockPath, { recursive: true, force: true }); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > STALE_LOCK_MILLISECONDS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw artifactError("The artifact is currently busy; retry the operation.", "ARTIFACT_BUSY", undefined, 503);
}

async function readMetadata(paths) {
  let raw;
  try { raw = await readFile(paths.metadata, "utf8"); } catch (error) {
    if (error.code === "ENOENT") throw artifactError("Artifact upload not found.", "ARTIFACT_NOT_FOUND", undefined, 404);
    throw error;
  }
  try { return JSON.parse(raw); } catch {
    throw artifactError("Stored artifact metadata is invalid.", "ARTIFACT_STATE_CONFLICT", undefined, 500);
  }
}

async function receivedSize(paths, metadata) {
  const content = metadata.upload_status === "complete" || await exists(paths.complete) ? paths.complete : paths.partial;
  try { return (await stat(content)).size; } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function uploadValue(paths, metadata) {
  return {
    artifact_id: String(metadata.artifact_id),
    file_name: metadata.file_name == null ? null : String(metadata.file_name),
    media_type: String(metadata.media_type),
    byte_size: Number(metadata.expected_byte_size),
    sha256: String(metadata.expected_sha256),
    status: String(metadata.upload_status),
    next_offset: await receivedSize(paths, metadata),
  };
}

export async function createArtifactUpload({ artifactRoot, personId, clientRequestId, fileName = null,
  artifactMediaType, expectedByteSize, expectedSha256 }) {
  const requestId = requiredText(clientRequestId, "client request ID", 128);
  const normalizedName = fileName == null ? null : requiredText(fileName, "file name", 1024);
  const normalizedMediaType = mediaType(artifactMediaType);
  const normalizedByteSize = byteSize(expectedByteSize);
  const normalizedSha256 = sha256(expectedSha256);
  const artifactId = deterministicArtifactId(personId, requestId);
  const paths = artifactPaths(artifactRoot, personId, artifactId);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  return withLock(paths.lock, async () => {
    const replay = await exists(paths.metadata);
    if (!replay) {
      const now = new Date().toISOString();
      await atomicJson(paths.metadata, {
        contract_version: ARTIFACT_UPLOAD_CONTRACT_VERSION,
        artifact_id: artifactId,
        owner_person_id: Number(personId),
        client_request_id: requestId,
        file_name: normalizedName,
        media_type: normalizedMediaType,
        expected_byte_size: normalizedByteSize,
        expected_sha256: normalizedSha256,
        upload_status: "receiving",
        bound_import_job_id: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      });
    }
    const metadata = await readMetadata(paths);
    if (metadata.client_request_id !== requestId || (metadata.file_name ?? null) !== normalizedName
      || metadata.media_type !== normalizedMediaType || Number(metadata.expected_byte_size) !== normalizedByteSize
      || metadata.expected_sha256 !== normalizedSha256) {
      throw artifactError("client_request_id was already used for a different artifact.",
        "IDEMPOTENCY_KEY_CONFLICT", { client_request_id: requestId }, 409);
    }
    return { ...await uploadValue(paths, metadata), idempotent_replay: replay };
  });
}

export async function getArtifactUpload({ artifactRoot, personId, artifactId }) {
  const normalizedId = uuid(artifactId, "artifact ID");
  const paths = artifactPaths(artifactRoot, personId, normalizedId);
  return uploadValue(paths, await readMetadata(paths));
}

async function readRange(filePath, offset, length) {
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, offset);
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export async function appendArtifactUpload({ artifactRoot, personId, artifactId, offset, chunkSha256, bytes }) {
  const normalizedId = uuid(artifactId, "artifact ID");
  const normalizedOffset = Number(offset);
  if (!Number.isSafeInteger(normalizedOffset) || normalizedOffset < 0) throw artifactError(
    "Upload-Offset must be a nonnegative safe integer.", "INVALID_ARTIFACT_OFFSET",
  );
  if (!Buffer.isBuffer(bytes)) throw artifactError(
    "Artifact chunks require Content-Type: application/octet-stream.", "INVALID_ARTIFACT_CHUNK_CONTENT_TYPE", undefined, 415,
  );
  if (bytes.length < 1 || bytes.length > ARTIFACT_UPLOAD_MAX_CHUNK_BYTES) throw artifactError(
    `Each upload chunk must contain 1 through ${ARTIFACT_UPLOAD_MAX_CHUNK_BYTES} bytes.`,
    "INVALID_ARTIFACT_CHUNK_SIZE", { maximum_chunk_bytes: ARTIFACT_UPLOAD_MAX_CHUNK_BYTES }, 413,
  );
  const expectedChunkSha256 = sha256(chunkSha256, "X-Content-SHA256");
  const observedChunkSha256 = createHash("sha256").update(bytes).digest("hex");
  if (observedChunkSha256 !== expectedChunkSha256) throw artifactError(
    "The uploaded chunk does not match X-Content-SHA256.", "ARTIFACT_CHUNK_CHECKSUM_MISMATCH",
    { expected_sha256: expectedChunkSha256, observed_sha256: observedChunkSha256 }, 409,
  );
  const paths = artifactPaths(artifactRoot, personId, normalizedId);
  return withLock(paths.lock, async () => {
    const metadata = await readMetadata(paths);
    const received = await receivedSize(paths, metadata);
    if (normalizedOffset < received) {
      if (normalizedOffset + bytes.length <= received) {
        const prior = await readRange(metadata.upload_status === "complete" ? paths.complete : paths.partial,
          normalizedOffset, bytes.length);
        if (prior.length === bytes.length && prior.equals(bytes)) {
          return { ...await uploadValue(paths, metadata), idempotent_replay: true };
        }
      }
      throw artifactError("This byte range was already uploaded with different bytes.",
        "ARTIFACT_OFFSET_CONFLICT", { offset: normalizedOffset }, 409);
    }
    if (metadata.upload_status === "complete") throw artifactError(
      "The artifact upload is already complete.", "ARTIFACT_ALREADY_COMPLETE", undefined, 409,
    );
    if (normalizedOffset !== received) throw artifactError(
      "Upload-Offset does not match the next resumable byte offset.", "ARTIFACT_OFFSET_MISMATCH",
      { supplied_offset: normalizedOffset, expected_offset: received }, 409,
    );
    if (received + bytes.length > Number(metadata.expected_byte_size)) throw artifactError(
      "The chunk would exceed the declared artifact byte size.", "ARTIFACT_BYTE_SIZE_EXCEEDED",
      { expected_byte_size: Number(metadata.expected_byte_size) }, 409,
    );
    const handle = await open(paths.partial, "a", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    metadata.updated_at = new Date().toISOString();
    await atomicJson(paths.metadata, metadata);
    return { ...await uploadValue(paths, metadata), idempotent_replay: false };
  });
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest("hex") };
}

export async function completeArtifactUpload({ artifactRoot, personId, artifactId }) {
  const normalizedId = uuid(artifactId, "artifact ID");
  const paths = artifactPaths(artifactRoot, personId, normalizedId);
  return withLock(paths.lock, async () => {
    const metadata = await readMetadata(paths);
    if (metadata.upload_status === "complete") return { ...await uploadValue(paths, metadata), idempotent_replay: true };
    const content = await exists(paths.complete) ? paths.complete : paths.partial;
    let observed;
    try { observed = await hashFile(content); } catch (error) {
      if (error.code === "ENOENT") observed = { size: 0, sha256: createHash("sha256").digest("hex") };
      else throw error;
    }
    if (observed.size !== Number(metadata.expected_byte_size)) throw artifactError(
      "The artifact cannot be completed until every declared byte is present.", "ARTIFACT_UPLOAD_INCOMPLETE",
      { received_byte_size: observed.size, expected_byte_size: Number(metadata.expected_byte_size) }, 409,
    );
    if (observed.sha256 !== metadata.expected_sha256) throw artifactError(
      "The complete artifact does not match its declared SHA-256.", "ARTIFACT_CHECKSUM_MISMATCH",
      { expected_sha256: metadata.expected_sha256, observed_sha256: observed.sha256 }, 409,
    );
    if (content === paths.partial) await rename(paths.partial, paths.complete);
    const now = new Date().toISOString();
    metadata.upload_status = "complete";
    metadata.completed_at = now;
    metadata.updated_at = now;
    await atomicJson(paths.metadata, metadata);
    return { ...await uploadValue(paths, metadata), idempotent_replay: false };
  });
}

export async function readCompleteArtifact({ artifactRoot, personId, artifactId }) {
  const normalizedId = uuid(artifactId, "artifact ID");
  const paths = artifactPaths(artifactRoot, personId, normalizedId);
  const metadata = await readMetadata(paths);
  if (metadata.upload_status !== "complete" || !await exists(paths.complete)) throw artifactError(
    "The artifact upload must be completed and verified before it can be consumed.",
    "ARTIFACT_UPLOAD_INCOMPLETE", { next_offset: await receivedSize(paths, metadata) }, 409,
  );
  const observed = await hashFile(paths.complete);
  if (observed.size !== Number(metadata.expected_byte_size) || observed.sha256 !== metadata.expected_sha256) throw artifactError(
    "The stored artifact failed its integrity check.", "ARTIFACT_STATE_CONFLICT", undefined, 500,
  );
  return { artifact: await uploadValue(paths, metadata), bytes: await readFile(paths.complete) };
}

export async function bindArtifactToImportJob({ artifactRoot, personId, artifactId, importJobId }) {
  const normalizedArtifactId = uuid(artifactId, "artifact ID");
  const normalizedJobId = uuid(importJobId, "import job ID");
  const paths = artifactPaths(artifactRoot, personId, normalizedArtifactId);
  await mkdir(paths.jobs, { recursive: true, mode: 0o700 });
  return withLock(path.join(paths.locks, "bindings.lock"), async () => {
    const metadata = await readMetadata(paths);
    if (metadata.upload_status !== "complete") throw artifactError(
      "The artifact upload must be complete before it can be bound.", "ARTIFACT_UPLOAD_INCOMPLETE", undefined, 409,
    );
    if (metadata.bound_import_job_id && metadata.bound_import_job_id !== normalizedJobId) throw artifactError(
      "The artifact is already bound to a different import job.", "ARTIFACT_BINDING_CONFLICT", undefined, 409,
    );
    const bindingPath = path.join(paths.jobs, `${normalizedJobId}.json`);
    let binding = null;
    try { binding = JSON.parse(await readFile(bindingPath, "utf8")); } catch (error) {
      if (error.code !== "ENOENT") throw artifactError(
        "Stored artifact binding metadata is invalid.", "ARTIFACT_STATE_CONFLICT", undefined, 500,
      );
    }
    if (binding && binding.artifact_id !== normalizedArtifactId) throw artifactError(
      "The import job is already bound to a different artifact.", "ARTIFACT_BINDING_CONFLICT", undefined, 409,
    );
    const replay = Boolean(binding && metadata.bound_import_job_id === normalizedJobId);
    const now = new Date().toISOString();
    metadata.bound_import_job_id = normalizedJobId;
    metadata.updated_at = now;
    await atomicJson(paths.metadata, metadata);
    if (!binding) await atomicJson(bindingPath, {
      import_job_id: normalizedJobId, artifact_id: normalizedArtifactId, bound_at: now,
    });
    return { artifact_id: normalizedArtifactId, import_job_id: normalizedJobId, idempotent_replay: replay };
  });
}

export function parseCanonicalTransactionArtifact(bytes, artifactMediaType) {
  const normalizedMediaType = mediaType(artifactMediaType);
  if (!TRANSACTION_IMPORT_ARTIFACT_MEDIA_TYPES.includes(normalizedMediaType)) throw artifactError(
    "This import tool accepts canonical UTF-8 JSON Lines as application/x-ndjson.",
    "UNSUPPORTED_TRANSACTION_IMPORT_ARTIFACT", { accepted_media_types: TRANSACTION_IMPORT_ARTIFACT_MEDIA_TYPES }, 415,
  );
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(bytes)); } catch {
    throw artifactError("The canonical JSON Lines artifact is not valid UTF-8.", "INVALID_CANONICAL_ARTIFACT_UTF8");
  }
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try { records.push(JSON.parse(lines[index])); } catch (error) {
      throw artifactError("The canonical JSON Lines artifact contains invalid JSON.",
        "INVALID_CANONICAL_ARTIFACT_JSON", { line_number: index + 1, parser_message: error.message });
    }
  }
  return records;
}

export function artifactUploadHttpResponse(upload) {
  return { contractVersion: ARTIFACT_UPLOAD_CONTRACT_VERSION, ...upload };
}

function sendUpload(res, status, upload) {
  res.set("Upload-Offset", String(upload.next_offset));
  res.set("Upload-Length", String(upload.byte_size));
  return res.status(status).json(artifactUploadHttpResponse(upload));
}

export function mountArtifactUploadRoutes(app, { artifactRoot, authenticate, jsonBodyParser, rawBodyParser }) {
  app.post("/mcp/artifacts", authenticate, jsonBodyParser, async (req, res, next) => {
    try {
      const artifact = await createArtifactUpload({
        artifactRoot, personId: req.auth.personId, clientRequestId: req.body?.client_request_id,
        fileName: req.body?.file_name, artifactMediaType: req.body?.media_type,
        expectedByteSize: req.body?.byte_size, expectedSha256: req.body?.sha256,
      });
      res.set("Location", `/mcp/artifacts/${artifact.artifact_id}`);
      return sendUpload(res, artifact.idempotent_replay ? 200 : 201, artifact);
    } catch (error) { return next(error); }
  });

  app.get("/mcp/artifacts/:artifactId", authenticate, async (req, res, next) => {
    try {
      return sendUpload(res, 200, await getArtifactUpload({
        artifactRoot, personId: req.auth.personId, artifactId: req.params.artifactId,
      }));
    } catch (error) { return next(error); }
  });

  app.patch("/mcp/artifacts/:artifactId", authenticate, rawBodyParser, async (req, res, next) => {
    try {
      return sendUpload(res, 200, await appendArtifactUpload({
        artifactRoot, personId: req.auth.personId, artifactId: req.params.artifactId,
        offset: req.get("Upload-Offset"), chunkSha256: req.get("X-Content-SHA256"), bytes: req.body,
      }));
    } catch (error) { return next(error); }
  });

  app.post("/mcp/artifacts/:artifactId/complete", authenticate, async (req, res, next) => {
    try {
      return sendUpload(res, 200, await completeArtifactUpload({
        artifactRoot, personId: req.auth.personId, artifactId: req.params.artifactId,
      }));
    } catch (error) { return next(error); }
  });
}
