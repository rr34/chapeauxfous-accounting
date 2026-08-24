import test from "node:test";
import assert from "node:assert/strict";
import { addFractions, decimalToUnits, fraction, unitsToDecimal } from "../src/money.js";

test("money conversion preserves exact commodity units", () => {
  assert.equal(decimalToUnits("123.45", 2), "12345");
  assert.equal(decimalToUnits("-0.01", 8), "-1000000");
  assert.equal(unitsToDecimal("250000000", 8), "2.5");
});

test("fraction arithmetic remains exact", () => {
  assert.deepEqual(addFractions(fraction(1n, 3n), fraction(2n, 3n)), fraction(1n));
  assert.deepEqual(addFractions(fraction(6000000n), fraction(-100000000n * 6000000n, 100000000n)), fraction(0n));
});

