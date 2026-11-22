import assert from "node:assert/strict";
import test from "node:test";
import { decimalToUnits } from "../src/money.ts";

test("amount inputs accept grouped thousands and leading currency symbols", () => {
  assert.equal(decimalToUnits("4,734.38", 2), "473438");
  assert.equal(decimalToUnits("$4,734.38", 2), "473438");
  assert.equal(decimalToUnits("€ 4,734.38", 2), "473438");
  assert.equal(decimalToUnits("£-4,734.38", 2), "-473438");
});

test("amount inputs reject malformed grouping and repeated symbols", () => {
  assert.throws(() => decimalToUnits("47,34.38", 2), /Invalid amount/);
  assert.throws(() => decimalToUnits("$$4.00", 2), /Invalid amount/);
});
