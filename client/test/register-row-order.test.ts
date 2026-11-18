import assert from "node:assert/strict";
import test from "node:test";
import { knownBalanceOrderForSameDate, sameDateChronologicalOrder } from "../src/register-row-order.ts";

test("known balances act like the end-of-day event in chronological order", () => {
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", true, "2026-07-29", false, "asc"), 1);
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", false, "2026-07-29", true, "asc"), -1);
});

test("known balances come first within their date in recent-first order", () => {
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", true, "2026-07-29", false, "desc"), -1);
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", false, "2026-07-29", true, "desc"), 1);
});

test("other row pairs continue through the selected-field comparator", () => {
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", true, "2026-07-30", false, "asc"), null);
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", false, "2026-07-29", false, "desc"), null);
  assert.equal(knownBalanceOrderForSameDate("2026-07-29", true, "2026-07-29", false, null), null);
});

test("same-day transactions reverse their calculation order when dates are recent-first", () => {
  assert.equal(sameDateChronologicalOrder(10, 11, "asc"), -1);
  assert.equal(sameDateChronologicalOrder(10, 11, "desc"), 1);
  assert.equal(sameDateChronologicalOrder(11, 10, "desc"), -1);
});
