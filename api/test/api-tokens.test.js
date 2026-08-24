import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticateApiToken,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "../src/api-tokens.js";

test("API token creation stores only a digest and returns the secret once", async () => {
  let insertParameters;
  const pool = {
    async query(sql, parameters) {
      assert.match(sql, /INSERT INTO api_tokens/);
      insertParameters = parameters;
      return [{ insertId: 91 }];
    },
  };
  const result = await createApiToken(pool, 7, { name: "Codex production" });

  assert.match(result.token, /^cfacct_[A-Za-z0-9_-]{43}$/);
  assert.equal(result.credential.id, 91);
  assert.equal(insertParameters[0], 7);
  assert.equal(insertParameters[1], "Codex production");
  assert.equal(insertParameters[2], result.token.slice(0, 15));
  assert.equal(Buffer.isBuffer(insertParameters[3]), true);
  assert.equal(insertParameters[3].length, 32);
  assert.equal(insertParameters.includes(result.token), false);
});

test("API token authentication resolves its owner and throttles last-used writes", async () => {
  const queries = [];
  const pool = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (sql.includes("SELECT api_token_id, owner_person_id")) {
        return [[{ api_token_id: 12, owner_person_id: 7 }]];
      }
      return [{ affectedRows: 1 }];
    },
  };
  const auth = await authenticateApiToken(pool, `Bearer cfacct_${"a".repeat(43)}`);
  assert.deepEqual(auth, { tokenId: 12, personId: 7 });
  assert.equal(Buffer.isBuffer(queries[0].parameters[0]), true);
  assert.match(queries[1].sql, /INTERVAL 15 MINUTE/);
  assert.equal(await authenticateApiToken(pool, "Bearer not-an-accounting-token"), null);
});

test("API tokens can be listed without secrets and revoked only by their owner", async () => {
  const rows = [{
    api_token_id: 5,
    token_name: "Agent",
    token_prefix: "cfacct_example",
    created_at: "2026-08-24 00:00:00.000000",
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
  }];
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT api_token_id, token_name")) return [rows];
      return [{ affectedRows: 1 }];
    },
  };
  assert.deepEqual(await listApiTokens(pool, 7), [{
    id: 5,
    name: "Agent",
    prefix: "cfacct_example",
    createdAt: rows[0].created_at,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  }]);
  assert.deepEqual(await revokeApiToken(pool, 7, 5), { revoked: true, tokenId: 5 });
});
