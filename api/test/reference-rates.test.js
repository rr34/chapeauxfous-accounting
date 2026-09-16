import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceRates, listReferenceRatesPage } from "../src/reference-rates.js";

const rateRow = { xrate_id: 41, ValidAt: "2026-08-18 14:32:00.000", from_units: "100000000",
  from_currency_id: 2, from_currency_code: "BTC", from_scale: 8, to_units: "6123456",
  to_currency_id: 1, to_currency_code: "USD", to_scale: 2 };

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
  assert.equal(result.rates[0].fromUnits, "100000000");
  assert.equal(result.rates[0].toUnits, "6123456");
  assert.equal(result.nextCursor, null);
});

test("a price batch reuses prior rates, rounds to currency scale, and replays exactly", async () => {
  const rows = [{ xrate_id: 224, ValidAt: "2013-04-28 00:00:00.000",
    from_units: "100000000", to_units: "14196", from_currency_id: 2, to_currency_id: 1 }];
  const observed = { inserts: 0, commits: 0, rollbacks: 0 };
  const connection = {
    async beginTransaction() {},
    async commit() { observed.commits += 1; },
    async rollback() { observed.rollbacks += 1; },
    release() {},
    async query(sql, values) {
      if (sql.includes("FROM people2_people")) return [[{ person_id: 7 }]];
      if (sql.includes("FROM currencies")) return [[
        { currency_id: 1, scale: 2 }, { currency_id: 2, scale: 8 },
      ]];
      if (sql.includes("FROM xrates")) return [rows.filter((row) =>
        row.from_currency_id === values[1] && row.to_currency_id === values[2]
        && row.ValidAt >= values[3] && row.ValidAt <= values[4])];
      if (sql.includes("INSERT INTO xrates")) {
        observed.inserts += 1;
        for (let index = 0; index < values.length; index += 6) rows.push({
          xrate_id: 225 + rows.length, ValidAt: values[index + 1],
          from_units: values[index + 2], from_currency_id: values[index + 3],
          to_units: values[index + 4], to_currency_id: values[index + 5],
        });
        return [{ affectedRows: values.length / 6 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const pool = { async getConnection() { return connection; } };
  const rates = [
    { valid_at: "2013-04-28", from_currency_id: 2, to_currency_id: 1,
      from_decimal: "1", to_decimal: "141.96" },
    { valid_at: "2026-09-15", from_currency_id: 2, to_currency_id: 1,
      from_decimal: "1", to_decimal: "75590.24471973324" },
    { valid_at: "2026-09-14", from_currency_id: 2, to_currency_id: 1,
      from_decimal: "1", to_decimal: "75590.24471973324179" },
    { valid_at: "2026-09-13", from_currency_id: 2, to_currency_id: 1,
      from_decimal: "1", to_decimal: "1.005" },
  ];
  const first = await createReferenceRates({ pool, personId: 7, rates });
  assert.deepEqual([first.createdCount, first.reusedCount, first.roundedCount], [3, 1, 3]);
  assert.deepEqual(first.outcomeRuns, [
    { startIndex: 0, endIndex: 0, status: "reused" },
    { startIndex: 1, endIndex: 3, status: "created" },
  ]);
  assert.equal(rows.find((row) => row.ValidAt === "2026-09-15 00:00:00.000")
    .to_units, "7559024");
  assert.equal(rows.find((row) => row.ValidAt === "2026-09-14 00:00:00.000")
    .to_units, "7559024");
  assert.equal(rows.find((row) => row.ValidAt === "2026-09-13 00:00:00.000")
    .to_units, "101");
  const replay = await createReferenceRates({ pool, personId: 7, rates });
  assert.deepEqual([replay.createdCount, replay.reusedCount], [0, 4]);
  assert.equal(observed.inserts, 1);
  assert.equal(observed.commits, 2);
  assert.equal(observed.rollbacks, 0);
});

test("a conflicting rate aborts the entire batch before inserting another day", async () => {
  let inserts = 0;
  let rollbacks = 0;
  const connection = {
    async beginTransaction() {}, async commit() {},
    async rollback() { rollbacks += 1; }, release() {},
    async query(sql) {
      if (sql.includes("FROM people2_people")) return [[{ person_id: 7 }]];
      if (sql.includes("FROM currencies")) return [[
        { currency_id: 1, scale: 2 }, { currency_id: 2, scale: 8 },
      ]];
      if (sql.includes("FROM xrates")) return [[{
        xrate_id: 224, ValidAt: "2013-04-28 00:00:00.000",
        from_units: "100000000", to_units: "14196",
      }]];
      if (sql.includes("INSERT INTO xrates")) inserts += 1;
      return [[]];
    },
  };
  const pool = { async getConnection() { return connection; } };
  await assert.rejects(createReferenceRates({ pool, personId: 7, rates: [
    { valid_at: "2013-04-29", from_currency_id: 2, to_currency_id: 1,
      from_decimal: "1", to_decimal: "135.30" },
    { valid_at: "2013-04-28", from_currency_id: 2, to_currency_id: 1,
      from_decimal: "1", to_decimal: "141.97" },
  ] }), { code: "REFERENCE_RATE_CONFLICT" });
  assert.equal(inserts, 0);
  assert.equal(rollbacks, 1);
});
