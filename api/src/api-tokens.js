import { createHash, randomBytes } from "node:crypto";

const tokenMarker = "cfacct_";

function applicationError(message, status = 400, code = "INVALID_API_TOKEN_OPERATION") {
  return Object.assign(new Error(message), { status, code });
}

function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest();
}

function normalizeExpiration(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw applicationError("expiresAt must be a valid ISO 8601 date-time.", 400, "INVALID_TOKEN_EXPIRATION");
  }
  if (parsed.getTime() <= Date.now()) {
    throw applicationError("expiresAt must be in the future.", 400, "INVALID_TOKEN_EXPIRATION");
  }
  return parsed.toISOString().slice(0, 23).replace("T", " ");
}

function mapToken(row) {
  return {
    id: Number(row.api_token_id),
    name: row.token_name,
    prefix: row.token_prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export async function createApiToken(pool, personId, { name, expiresAt } = {}) {
  const tokenName = String(name ?? "").trim();
  if (!tokenName) throw applicationError("Token name is required.", 400, "TOKEN_NAME_REQUIRED");
  if ([...tokenName].length > 128) {
    throw applicationError("Token name must contain no more than 128 characters.", 400, "TOKEN_NAME_TOO_LONG");
  }

  const token = `${tokenMarker}${randomBytes(32).toString("base64url")}`;
  const prefix = token.slice(0, 15);
  const expiration = normalizeExpiration(expiresAt);
  const [result] = await pool.query(
    `INSERT INTO api_tokens
      (owner_person_id, token_name, token_prefix, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [personId, tokenName, prefix, tokenHash(token), expiration],
  );
  return {
    token,
    credential: {
      id: Number(result.insertId),
      name: tokenName,
      prefix,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt == null || String(expiresAt).trim() === "" ? null : new Date(expiresAt).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

export async function listApiTokens(pool, personId) {
  const [rows] = await pool.query(
    `SELECT api_token_id, token_name, token_prefix, created_at, expires_at,
            last_used_at, revoked_at
       FROM api_tokens
      WHERE owner_person_id = ?
      ORDER BY created_at DESC, api_token_id DESC`,
    [personId],
  );
  return rows.map(mapToken);
}

export async function revokeApiToken(pool, personId, tokenId) {
  const resolvedTokenId = Number(tokenId);
  if (!Number.isInteger(resolvedTokenId) || resolvedTokenId <= 0) {
    throw applicationError("Token id must be a positive integer.", 400, "INVALID_TOKEN_ID");
  }
  const [result] = await pool.query(
    `UPDATE api_tokens
        SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(6))
      WHERE api_token_id = ? AND owner_person_id = ?`,
    [resolvedTokenId, personId],
  );
  if (Number(result.affectedRows) !== 1) {
    throw applicationError("API token not found.", 404, "API_TOKEN_NOT_FOUND");
  }
  return { revoked: true, tokenId: resolvedTokenId };
}

export async function authenticateApiToken(pool, authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token.startsWith(tokenMarker) || token.length < 40 || token.length > 128) return null;
  const [rows] = await pool.query(
    `SELECT api_token_id, owner_person_id
       FROM api_tokens
      WHERE token_hash = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(6))
      LIMIT 1`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (!row) return null;
  await pool.query(
    `UPDATE api_tokens
        SET last_used_at = CURRENT_TIMESTAMP(6)
      WHERE api_token_id = ?
        AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP(6) - INTERVAL 15 MINUTE)`,
    [row.api_token_id],
  );
  return { tokenId: Number(row.api_token_id), personId: Number(row.owner_person_id) };
}

export function requireApiToken(pool) {
  return async function apiTokenMiddleware(req, res, next) {
    try {
      const auth = await authenticateApiToken(pool, req.headers.authorization);
      if (!auth) {
        res.set("WWW-Authenticate", 'Bearer realm="chapeaux-fous-accounting-mcp"');
        return res.status(401).json({ error: "INVALID_API_TOKEN" });
      }
      req.auth = auth;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
