import test from "node:test";
import assert from "node:assert/strict";
import { nearestReferenceRate, valueAtReferenceRate } from "../src/reference-valuation.js";

test("nearest reference rates are deterministic and reciprocal in native units", () => {
  const earlier = { xrate_id: 1, ValidAt: "2026-09-01 00:00:00", from_currency_id: 2,
    to_currency_id: 1, from_units: "100000000", to_units: "8000000" };
  const later = { xrate_id: 2, ValidAt: "2026-09-03 00:00:00", from_currency_id: 1,
    to_currency_id: 2, from_units: "8000000", to_units: "100000000" };
  const selected = nearestReferenceRate([later, earlier], "2026-09-02T00:00:00Z", 2, 1);
  assert.equal(selected.rate.xrate_id, 1);
  assert.equal(valueAtReferenceRate("-1000000", selected), "-80000");
  const inverse = nearestReferenceRate([later], "2026-09-03T01:00:00Z", 2, 1);
  assert.equal(valueAtReferenceRate("-1000000", inverse), "-80000");
  const forward = nearestReferenceRate([later], "2026-09-03T01:00:00Z", 1, 2);
  assert.equal(valueAtReferenceRate("80000", forward), "1000000");
});

test("reference valuation rounds signed ties half-up", () => {
  const selection = nearestReferenceRate([{
    xrate_id: 1, ValidAt: "2026-09-01 00:00:00", from_currency_id: 2,
    to_currency_id: 1, from_units: "200", to_units: "1",
  }], "2026-09-01T00:00:00Z", 2, 1);
  assert.equal(valueAtReferenceRate("1", selection), "0");
  assert.equal(valueAtReferenceRate("100", selection), "1");
  assert.equal(valueAtReferenceRate("-100", selection), "-1");
});

test("conflicting direct and reciprocal rates at one instant are rejected", () => {
  const rates = [
    { xrate_id: 1, ValidAt: "2026-09-01 00:00:00", from_currency_id: 2,
      to_currency_id: 1, from_units: "100000000", to_units: "8000000" },
    { xrate_id: 2, ValidAt: "2026-09-01 00:00:00", from_currency_id: 1,
      to_currency_id: 2, from_units: "9000000", to_units: "100000000" },
  ];
  assert.throws(() => nearestReferenceRate(rates, "2026-09-01T01:00:00Z", 2, 1),
    (error) => error.code === "CONFLICTING_REFERENCE_RATES");
});
