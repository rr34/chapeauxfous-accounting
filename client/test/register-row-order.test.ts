import assert from "node:assert/strict";
import test from "node:test";
import { knownBalanceOrderForSameDate } from "../src/register-row-order.ts";

test("known balances follow every transaction row on the same date", () => {
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", true, "2026-07-29", false), 1);
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", false, "2026-07-29", true), -1);
});

test("other row pairs continue through the selected-field comparator", () => {
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", true, "2026-07-30", false), null);
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", false, "2026-07-29", false), null);
});
