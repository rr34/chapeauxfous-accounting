import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-only-jwt-secret";

const { hashPassword, verifyPassword } = await import("../src/auth.js");

test("four-character passwords are accepted and remain case-sensitive", async () => {
  const encoded = await hashPassword("Ab1!");
  assert.equal(await verifyPassword("Ab1!", encoded), true);
  assert.equal(await verifyPassword("ab1!", encoded), false);
});

test("passwords shorter than four characters are rejected", async () => {
  await assert.rejects(hashPassword("abc"), { code: "PASSWORD_TOO_SHORT" });
});

test("passwords longer than 4096 characters are rejected", async () => {
  await assert.rejects(hashPassword("x".repeat(4097)), { code: "PASSWORD_TOO_LONG" });
});
