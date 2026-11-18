import assert from "node:assert/strict";
import test from "node:test";
import { findUnambiguousSuspenseTransferPairs } from "../src/suspense-transfer-pairs.ts";

const candidate = (lineItemId: number, transactionId: number, date: string,
  amountUnits: string, counterpartAccountId: number) => ({
  lineItemId, transactionId, date, amountUnits, counterpartAccountIds: [counterpartAccountId],
});

test("pairs exact opposite suspense amounts within three days across different accounts", () => {
  assert.deepEqual(findUnambiguousSuspenseTransferPairs([
    candidate(11, 101, "2026-09-28", "-9700", 31),
    candidate(12, 102, "2026-09-26", "9700", 44),
  ]), [{ firstLineItemId: 11, secondLineItemId: 12, dateGapDays: 2 }]);
});

test("does not pair a late, same-account, same-transaction, or non-opposite candidate", () => {
  assert.deepEqual(findUnambiguousSuspenseTransferPairs([
    candidate(11, 101, "2026-09-28", "-9700", 31),
    candidate(12, 102, "2026-09-24", "9700", 44),
    candidate(13, 103, "2026-09-27", "9700", 31),
    candidate(14, 101, "2026-09-27", "9700", 44),
    candidate(15, 105, "2026-09-27", "9600", 44),
  ]), []);
});

test("leaves repeated equal transfers unpaired when the match is ambiguous", () => {
  assert.deepEqual(findUnambiguousSuspenseTransferPairs([
    candidate(11, 101, "2026-09-28", "-9700", 31),
    candidate(12, 102, "2026-09-27", "9700", 44),
    candidate(13, 103, "2026-09-26", "9700", 55),
  ]), []);
});
