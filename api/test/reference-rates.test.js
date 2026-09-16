import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceRate, listReferenceRatesPage } from "../src/reference-rates.js";

const rateRow = { xrate_id: 41, ValidAt: "2026-08-18 14:32:00.000", from_units: "100000000",
  from_currency_id: 2, from_currency_code: "BTC", from_scale: 8, to_units: "6123456",
  to_currency_id: 1, to_currency_code: "USD", to_scale: 2 };

test("reference rates preserve exact native-unit ratios and UTC timestamps", async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes("FROM currencies")) return [[{ currency_id: 1 }, { currency_id: 2 }]];
    if (sql.includes("INSERT INTO xrates")) return [{ insertId: 41 }];
    return [[rateRow]];
  } };
  const result = await createReferenceRate({ pool, personId: 7,
    validAt: "2026-08-18T14:32:00.000Z", fromUnits: "100000000", fromCurrencyId: 2,
    toUnits: "6123456", toCurrencyId: 1 });
  assert.equal(result.validAt, "2026-08-18T14:32:00.000Z");
  assert.equal(result.fromUnits, "100000000");
  assert.deepEqual(calls[1].values, [7, "2026-08-18 14:32:00.000", "100000000", 2, "6123456", 1]);
});

test("reference rate listing is owner-scoped and pageable", async () => {
  const pool = { async query(sql, values) {
    assert.match(sql, /x\.owner_person_id = \?/);
    assert.match(sql, /x\.xrate_type = 'reference'/);
    assert.deepEqual(values, [7, 2, 1, "2026-08-18 00:00:00.000", "2026-08-18 23:59:59.000", 2]);
    return [[rateRow]];
  } };
  const result = await listReferenceRatesPage(pool, 7, { fromCurrencyId: 2, toCurrencyId: 1,
    validAtFrom: "2026-08-18T00:00:00Z", validAtTo: "2026-08-18T23:59:59Z", limit: 1 });
  assert.equal(result.rates[0].toCurrencyCode, "USD");
  assert.equal(result.nextCursor, null);
});
