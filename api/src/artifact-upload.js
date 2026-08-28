import { createHash, randomUUID } from "node:crypto";
import { withPoolTransaction } from "./db.js";

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

function uploadValue(row) {
  return {
    artifact_id: String(row.artifact_id),
    file_name: row.file_name == null ? null : String(row.file_name),
    media_type: String(row.media_type),
    byte_size: Number(row.expected_byte_size),
    sha256: String(row.expected_sha256),
    status: String(row.upload_status),
    next_offset: Number(row.received_byte_size),
  };
}

async function loadUpload(connection, personId, artifactId, lock = false) {
  const [rows] = await connection.query(
    `SELECT artifact_id, owner_person_id, client_request_id, file_name, media_type,
            expected_byte_size, received_byte_size, expected_sha256, upload_status,
            completed_at, created_at, updated_at
       FROM accounting_artifact_uploads
      WHERE artifact_id = ? AND owner_person_id = ?${lock ? " FOR UPDATE" : ""}`,
    [artifactId, personId],
  );
  if (!rows[0]) throw artifactError("Artifact upload not found.", "ARTIFACT_NOT_FOUND", undefined, 404);
  return rows[0];
}

export async function createArtifactUpload({ pool, personId, clientRequestId, fileName = null,
  artifactMediaType, expectedByteSize, expectedSha256 }) {
  const requestId = requiredText(clientRequestId, "client request ID", 128);
  const normalizedName = fileName == null ? null : requiredText(fileName, "file name", 1024);
  const normalizedMediaType = mediaType(artifactMediaType);
  const normalizedByteSize = byteSize(expectedByteSize);
  const normalizedSha256 = sha256(expectedSha256);
  return withPoolTransaction(pool, async (connection) => {
    const artifactId = randomUUID();
    await connection.query(
      `INSERT INTO accounting_artifact_uploads
        (artifact_id, owner_person_id, client_request_id, file_name, media_type,
         expected_byte_size, expected_sha256, upload_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'receiving')
       ON DUPLICATE KEY UPDATE artifact_id = artifact_id`,
      [artifactId, personId, requestId, normalizedName, normalizedMediaType, normalizedByteSize, normalizedSha256],
    );
    const [rows] = await connection.query(
      `SELECT artifact_id, owner_person_id, client_request_id, file_name, media_type,
              expected_byte_size, received_byte_size, expected_sha256, upload_status,
              completed_at, created_at, updated_at
         FROM accounting_artifact_uploads
        WHERE owner_person_id = ? AND client_request_id = ? FOR UPDATE`,
      [personId, requestId],
    );
    const upload = rows[0];
    if (!upload) throw artifactError("Artifact upload could not be created.", "ARTIFACT_STATE_CONFLICT", undefined, 500);
    if ((upload.file_name ?? null) !== normalizedName || String(upload.media_type) !== normalizedMediaType
      || Number(upload.expected_byte_size) !== normalizedByteSize || String(upload.expected_sha256) !== normalizedSha256) {
      throw artifactError("client_request_id was already used for a different artifact.",
        "IDEMPOTENCY_KEY_CONFLICT", { client_request_id: requestId }, 409);
    }
    return { ...uploadValue(upload), idempotent_replay: String(upload.artifact_id) !== artifactId };
  });
}

export async function getArtifactUpload({ pool, personId, artifactId }) {
  const normalizedId = requiredText(artifactId, "artifact ID", 36);
  const connection = await pool.getConnection();
  try {
    return uploadValue(await loadUpload(connection, personId, normalizedId));
  } finally {
    connection.release();
  }
}

export async function appendArtifactUpload({ pool, personId, artifactId, offset, chunkSha256, bytes }) {
  const normalizedId = requiredText(artifactId, "artifact ID", 36);
  const normalizedOffset = Number(offset);
  if (!Number.isSafeInteger(normalizedOffset) || normalizedOffset < 0) throw artifactError(
    "Upload-Offset must be a nonnegative safe integer.", "INVALID_ARTIFACT_OFFSET",
  );
  if (!Buffer.isBuffer(bytes)) throw artifactError(
    "Artifact chunks require Content-Type: application/octet-stream.", "INVALID_ARTIFACT_CHUNK_CONTENT_TYPE", undefined, 415,
  );
  const body = bytes;
  if (body.length < 1 || body.length > ARTIFACT_UPLOAD_MAX_CHUNK_BYTES) throw artifactError(
    `Each upload chunk must contain 1 through ${ARTIFACT_UPLOAD_MAX_CHUNK_BYTES} bytes.`,
    "INVALID_ARTIFACT_CHUNK_SIZE", { maximum_chunk_bytes: ARTIFACT_UPLOAD_MAX_CHUNK_BYTES }, 413,
  );
  const expectedChunkSha256 = sha256(chunkSha256, "X-Content-SHA256");
  const observedChunkSha256 = createHash("sha256").update(body).digest("hex");
  if (observedChunkSha256 !== expectedChunkSha256) throw artifactError(
    "The uploaded chunk does not match X-Content-SHA256.", "ARTIFACT_CHUNK_CHECKSUM_MISMATCH",
    { expected_sha256: expectedChunkSha256, observed_sha256: observedChunkSha256 }, 409,
  );
  return withPoolTransaction(pool, async (connection) => {
    const upload = await loadUpload(connection, personId, normalizedId, true);
    const [priorRows] = await connection.query(
      `SELECT byte_count, chunk_sha256 FROM accounting_artifact_chunks
        WHERE artifact_id = ? AND byte_offset = ?`, [normalizedId, normalizedOffset],
    );
    const prior = priorRows[0];
    if (prior) {
      if (Number(prior.byte_count) !== body.length || String(prior.chunk_sha256) !== observedChunkSha256) {
        throw artifactError("This byte offset was already uploaded with different bytes.",
          "ARTIFACT_OFFSET_CONFLICT", { offset: normalizedOffset }, 409);
      }
      return { ...uploadValue(upload), idempotent_replay: true };
    }
    if (String(upload.upload_status) === "complete") throw artifactError(
      "The artifact upload is already complete.", "ARTIFACT_ALREADY_COMPLETE", undefined, 409,
    );
    const received = Number(upload.received_byte_size);
    if (normalizedOffset !== received) throw artifactError(
      "Upload-Offset does not match the next resumable byte offset.", "ARTIFACT_OFFSET_MISMATCH",
      { supplied_offset: normalizedOffset, expected_offset: received }, 409,
    );
    if (received + body.length > Number(upload.expected_byte_size)) throw artifactError(
      "The chunk would exceed the declared artifact byte size.", "ARTIFACT_BYTE_SIZE_EXCEEDED",
      { expected_byte_size: Number(upload.expected_byte_size) }, 409,
    );
    await connection.query(
      `INSERT INTO accounting_artifact_chunks
        (artifact_id, byte_offset, byte_count, chunk_sha256, chunk_bytes)
       VALUES (?, ?, ?, ?, ?)`,
      [normalizedId, normalizedOffset, body.length, observedChunkSha256, body],
    );
    await connection.query(
      `UPDATE accounting_artifact_uploads
          SET received_byte_size = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE artifact_id = ?`, [received + body.length, normalizedId],
    );
    return { ...uploadValue({ ...upload, received_byte_size: received + body.length }), idempotent_replay: false };
  });
}

async function verifiedArtifactBytes(connection, upload) {
  const [rows] = await connection.query(
    `SELECT byte_offset, byte_count, chunk_sha256, chunk_bytes
       FROM accounting_artifact_chunks WHERE artifact_id = ? ORDER BY byte_offset`,
    [upload.artifact_id],
  );
  const hash = createHash("sha256");
  const buffers = [];
  let offset = 0;
  for (const row of rows) {
    const bytes = Buffer.from(row.chunk_bytes);
    const chunkHash = createHash("sha256").update(bytes).digest("hex");
    if (Number(row.byte_offset) !== offset || Number(row.byte_count) !== bytes.length
      || String(row.chunk_sha256) !== chunkHash) throw artifactError(
      "Stored artifact chunks failed their integrity check.", "ARTIFACT_STATE_CONFLICT", undefined, 500,
    );
    offset += bytes.length;
    hash.update(bytes);
    buffers.push(bytes);
  }
  if (offset !== Number(upload.expected_byte_size) || hash.digest("hex") !== String(upload.expected_sha256)) {
    throw artifactError("The complete artifact does not match its declared byte size and SHA-256.",
      "ARTIFACT_CHECKSUM_MISMATCH", { received_byte_size: offset }, 409);
  }
  return Buffer.concat(buffers, offset);
}

export async function completeArtifactUpload({ pool, personId, artifactId }) {
  const normalizedId = requiredText(artifactId, "artifact ID", 36);
  return withPoolTransaction(pool, async (connection) => {
    const upload = await loadUpload(connection, personId, normalizedId, true);
    if (String(upload.upload_status) === "complete") return { ...uploadValue(upload), idempotent_replay: true };
    if (Number(upload.received_byte_size) !== Number(upload.expected_byte_size)) throw artifactError(
      "The artifact cannot be completed until every declared byte is present.", "ARTIFACT_UPLOAD_INCOMPLETE",
      { received_byte_size: Number(upload.received_byte_size), expected_byte_size: Number(upload.expected_byte_size) }, 409,
    );
    await verifiedArtifactBytes(connection, upload);
    await connection.query(
      `UPDATE accounting_artifact_uploads
          SET upload_status = 'complete', completed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
        WHERE artifact_id = ?`, [normalizedId],
    );
    return { ...uploadValue({ ...upload, upload_status: "complete" }), idempotent_replay: false };
  });
}

export async function readCompleteArtifact({ pool, personId, artifactId }) {
  const normalizedId = requiredText(artifactId, "artifact ID", 36);
  const connection = await pool.getConnection();
  try {
    const upload = await loadUpload(connection, personId, normalizedId);
    if (String(upload.upload_status) !== "complete") throw artifactError(
      "The artifact upload must be completed and verified before it can be consumed.",
      "ARTIFACT_UPLOAD_INCOMPLETE", { next_offset: Number(upload.received_byte_size) }, 409,
    );
    return { artifact: uploadValue(upload), bytes: await verifiedArtifactBytes(connection, upload) };
  } finally {
    connection.release();
  }
}

export function parseCanonicalTransactionArtifact(bytes, artifactMediaType) {
  const normalizedMediaType = mediaType(artifactMediaType);
  if (!TRANSACTION_IMPORT_ARTIFACT_MEDIA_TYPES.includes(normalizedMediaType)) throw artifactError(
    "This import tool accepts canonical UTF-8 JSON Lines as application/x-ndjson.",
    "UNSUPPORTED_TRANSACTION_IMPORT_ARTIFACT", { accepted_media_types: TRANSACTION_IMPORT_ARTIFACT_MEDIA_TYPES }, 415,
  );
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(bytes)); } catch {
    throw artifactError("The canonical JSON Lines artifact is not valid UTF-8.",
      "INVALID_CANONICAL_ARTIFACT_UTF8");
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

export function mountArtifactUploadRoutes(app, { pool, authenticate, jsonBodyParser, rawBodyParser }) {
  app.post("/mcp/artifacts", authenticate, jsonBodyParser, async (req, res, next) => {
    try {
      const artifact = await createArtifactUpload({
        pool, personId: req.auth.personId, clientRequestId: req.body?.client_request_id,
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
        pool, personId: req.auth.personId, artifactId: req.params.artifactId,
      }));
    } catch (error) { return next(error); }
  });

  app.patch("/mcp/artifacts/:artifactId", authenticate, rawBodyParser, async (req, res, next) => {
    try {
      return sendUpload(res, 200, await appendArtifactUpload({
        pool, personId: req.auth.personId, artifactId: req.params.artifactId,
        offset: req.get("Upload-Offset"), chunkSha256: req.get("X-Content-SHA256"), bytes: req.body,
      }));
    } catch (error) { return next(error); }
  });

  app.post("/mcp/artifacts/:artifactId/complete", authenticate, async (req, res, next) => {
    try {
      return sendUpload(res, 200, await completeArtifactUpload({
        pool, personId: req.auth.personId, artifactId: req.params.artifactId,
      }));
    } catch (error) { return next(error); }
  });
}
