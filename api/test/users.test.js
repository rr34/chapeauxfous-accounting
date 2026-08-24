import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";
process.env.JWT_SECRET = "test-only-jwt-secret";

const { registerUser } = await import("../src/users.js");

test("registration creates only the user identity", async () => {
  const statements = [];
  const runInTransaction = async (work) => work({
    async query(sql, params) {
      statements.push({ sql, params });
      return [{ insertId: 17 }];
    },
  });

  const result = await registerUser({
    name: "New User",
    email: "new@example.com",
    password: "four",
  }, runInTransaction);

  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /INSERT INTO people2_people/);
  assert.equal(result.user.personId, 17);
  assert.equal(Object.hasOwn(result.user, "functionalCurrencyId"), false);
});
