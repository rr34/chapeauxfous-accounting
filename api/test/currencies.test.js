import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const {
  createCurrency,
  listCurrencies,
  requireAccessibleCurrency,
} = await import("../src/currencies.js");

function memoryPool() {
  const state = {
    rows: [
      { currency_id: 1, owner_person_id: null, CurrencyAbbreviation: "USD", display_name: "US Dollar", currency_type: "iso_4217", scale: 2 },
      { currency_id: 2, owner_person_id: 8, CurrencyAbbreviation: "PRIVATE", display_name: "Other user's unit", currency_type: "custom", scale: 3 },
    ],
    nextId: 3,
  };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params = []) {
      if (sql.includes("FROM currencies") && sql.includes("currency_id = ?")) {
        return [state.rows.filter((row) => Number(row.currency_id) === Number(params[0])
          && (row.owner_person_id == null || Number(row.owner_person_id) === Number(params[1])))];
      }
      if (sql.includes("FROM currencies")) {
        return [state.rows.filter((row) => row.owner_person_id == null || Number(row.owner_person_id) === Number(params[0]))];
      }
      if (sql.includes("INSERT INTO currencies")) {
        const [owner, code, displayName, type, scale] = params;
        const row = { currency_id: state.nextId++, owner_person_id: owner, CurrencyAbbreviation: code, display_name: displayName, currency_type: type, scale };
        state.rows.push(row);
        return [{ insertId: row.currency_id }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return { state, connection, async query(sql, params) { return connection.query(sql, params); }, async getConnection() { return connection; } };
}

test("currency lists contain the global catalog plus only the authenticated user's units", async () => {
  const pool = memoryPool();
  pool.state.rows.push({ currency_id: 3, owner_person_id: 7, CurrencyAbbreviation: "VTSAX", display_name: "Vanguard Fund", currency_type: "security", scale: 4 });
  const currencies = await listCurrencies(pool, 7);
  assert.deepEqual(currencies.map((currency) => currency.code), ["USD", "VTSAX"]);
  assert.equal(currencies[1].userDefined, true);
});

test("users can create private securities but cannot shadow global codes", async () => {
  const pool = memoryPool();
  const created = await createCurrency({
    pool, personId: 7, code: " vtsax ", displayName: "Vanguard Fund", type: "security", scale: 4,
  });
  assert.equal(created.code, "VTSAX");
  assert.equal(created.ownerPersonId, 7);

  await assert.rejects(
    createCurrency({ pool, personId: 7, code: "USD", displayName: "Fake dollars", type: "custom", scale: 2 }),
    (error) => error.code === "GLOBAL_CURRENCY_CODE_RESERVED",
  );
});

test("another user's currency id is not accessible", async () => {
  const pool = memoryPool();
  await assert.rejects(
    requireAccessibleCurrency(pool.connection, 7, 2),
    (error) => error.code === "CURRENCY_NOT_FOUND",
  );
  assert.equal((await requireAccessibleCurrency(pool.connection, 7, 1)).code, "USD");
});
