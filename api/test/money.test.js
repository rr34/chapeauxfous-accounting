import test from "node:test";
import assert from "node:assert/strict";
import { addFractions, decimalToUnits, fraction, unitsToDecimal } from "../src/money.js";

test("money conversion preserves exact commodity units", () => {
  assert.equal(decimalToUnits("123.45", 2), "12345");
  assert.equal(decimalToUnits("-0.01", 8), "-1000000");
  assert.throws(() => decimalToUnits("0.120604321", 8), /exceeds 8 decimal places/);
  assert.equal(decimalToUnits("-7818.78377", 2, { round: true }), "-781878");
  assert.equal(decimalToUnits("-1.005", 2, { round: true }), "-101");
  assert.equal(decimalToUnits("0.004", 2, { round: true }), "0");
  assert.equal(unitsToDecimal("250000000", 8), "2.5");
});

test("fraction arithmetic remains exact", () => {
  assert.deepEqual(addFractions(fraction(1n, 3n), fraction(2n, 3n)), fraction(1n));
  assert.deepEqual(addFractions(fraction(6000000n), fraction(-100000000n * 6000000n, 100000000n)), fraction(0n));
});
