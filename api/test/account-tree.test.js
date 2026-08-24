import test from "node:test";
import assert from "node:assert/strict";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { importAccountTree } = await import("../src/account-tree.js");

function memoryPool(initialAccounts = []) {
  const state = {
    accounts: structuredClone(initialAccounts),
    currencies: [{
      currency_id: 1, owner_person_id: null, CurrencyAbbreviation: "USD",
      display_name: "USD", currency_type: "iso_4217", scale: 2,
    }],
    nextId: Math.max(0, ...initialAccounts.map((account) => Number(account.account_id))) + 1,
    nextCurrencyId: 2,
    inserts: [],
    commits: 0,
    rollbacks: 0,
  };
  return {
    state,
    async getConnection() {
      const accountSnapshot = structuredClone(state.accounts);
      const currencySnapshot = structuredClone(state.currencies);
      return {
        async beginTransaction() {},
        async commit() { state.commits += 1; },
        async rollback() {
          state.rollbacks += 1;
          state.accounts = accountSnapshot;
          state.currencies = currencySnapshot;
        },
        release() {},
        async query(sql, params = []) {
          if (sql.includes("FROM currencies")) {
            return [state.currencies.filter((currency) =>
              currency.owner_person_id == null || Number(currency.owner_person_id) === 7)];
          }
          if (sql.includes("INSERT INTO currencies")) {
            const [owner, scopeOwner, code, displayName, type, scale] = params;
            const row = {
              currency_id: state.nextCurrencyId++, owner_person_id: owner,
              scope_owner_person_id: scopeOwner,
              CurrencyAbbreviation: code, display_name: displayName, currency_type: type, scale,
            };
            state.currencies.push(row);
            return [{ insertId: row.currency_id }];
          }
          if (sql.includes("FROM accounts a")) {
            return [state.accounts.map((account) => ({
              ...account,
              CurrencyAbbreviation: state.currencies.find((currency) =>
                Number(currency.currency_id) === Number(account.account_currency_id))?.CurrencyAbbreviation,
            }))];
          }
          if (sql.includes("INSERT INTO accounts")) {
            const [owner, name, description, placeholder, parentId, type, currencyId, sourceSystem, sourceId] = params;
            const row = {
              account_id: state.nextId++,
              owner_person_id: owner,
              AccountName: name,
              description,
              is_placeholder: placeholder,
              parent_account_id: parentId,
              AccountType: type,
              account_currency_id: currencyId,
              archived_at: null,
              source_system: sourceSystem,
              source_id: sourceId,
            };
            state.accounts.push(row);
            state.inserts.push(row);
            return [{ insertId: row.account_id }];
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },
  };
}

const tree = [
  { fullName: "Assets:Bank:Checking", type: "asset", currencyCode: "usd", description: "Daily account" },
  { fullName: "Assets", type: "asset", currencyCode: "USD", placeholder: true },
  { fullName: "Assets:Bank", type: "asset", currencyCode: "USD", placeholder: true },
];

test("account-tree import sorts parents, preserves metadata, and is retry-safe", async () => {
  const pool = memoryPool();
  const first = await importAccountTree({ pool, personId: 7, accounts: tree, dryRun: false });
  assert.equal(first.createdCount, 3);
  assert.deepEqual(pool.state.inserts.map((account) => account.AccountName), ["Assets", "Bank", "Checking"]);
  assert.equal(pool.state.inserts[1].parent_account_id, pool.state.inserts[0].account_id);
  assert.equal(pool.state.inserts[2].parent_account_id, pool.state.inserts[1].account_id);
  assert.equal(pool.state.inserts[0].is_placeholder, true);
  assert.equal(pool.state.inserts[2].description, "Daily account");

  const second = await importAccountTree({ pool, personId: 7, accounts: tree, dryRun: false });
  assert.equal(second.createdCount, 0);
  assert.equal(second.existingCount, 3);
  assert.equal(pool.state.inserts.length, 3);
});

test("dry-run validates the complete tree without inserting", async () => {
  const pool = memoryPool();
  const result = await importAccountTree({ pool, personId: 7, accounts: tree, dryRun: true });
  assert.equal(result.plannedCount, 3);
  assert.equal(result.createdCount, 0);
  assert.equal(pool.state.inserts.length, 0);
});

test("account-tree import atomically creates explicit user-owned securities", async () => {
  const pool = memoryPool();
  const input = {
    pool,
    personId: 7,
    currencies: [{ code: "vtsax", displayName: "Vanguard Total Stock Market Index Fund", type: "security", scale: 4 }],
    accounts: [
      { fullName: "Assets", type: "asset", currencyCode: "USD", placeholder: true },
      { fullName: "Assets:Investments", type: "asset", currencyCode: "USD", placeholder: true },
      { fullName: "Assets:Investments:VTSAX", type: "asset", currencyCode: "VTSAX" },
    ],
    dryRun: false,
  };
  const result = await importAccountTree(input);
  assert.equal(result.currencyCreatedCount, 1);
  assert.equal(result.createdCount, 3);
  assert.equal(pool.state.currencies[1].CurrencyAbbreviation, "VTSAX");
  assert.equal(pool.state.currencies[1].currency_type, "security");
  assert.equal(pool.state.inserts[2].account_currency_id, pool.state.currencies[1].currency_id);

  const retry = await importAccountTree(input);
  assert.equal(retry.currencyExistingCount, 1);
  assert.equal(retry.currencyCreatedCount, 0);
  assert.equal(retry.createdCount, 0);
});

test("a missing parent rolls back the atomic import", async () => {
  const pool = memoryPool();
  await assert.rejects(
    importAccountTree({
      pool,
      personId: 7,
      accounts: [
        { fullName: "Assets", type: "asset", currencyCode: "USD" },
        { fullName: "Liabilities:Cards:Visa", type: "liability", currencyCode: "USD" },
      ],
      dryRun: false,
    }),
    (error) => error.code === "MISSING_PARENT_ACCOUNT",
  );
  assert.equal(pool.state.accounts.length, 0);
  assert.equal(pool.state.rollbacks, 1);
});

test("an existing path must match every imported field", async () => {
  const pool = memoryPool([{
    account_id: 4,
    AccountName: "Assets",
    description: null,
    is_placeholder: 1,
    parent_account_id: null,
    AccountType: "asset",
    account_currency_id: 1,
    archived_at: null,
  }]);
  await assert.rejects(
    importAccountTree({
      pool,
      personId: 7,
      accounts: [{ fullName: "Assets", type: "asset", currencyCode: "USD", placeholder: false }],
      dryRun: true,
    }),
    (error) => error.code === "ACCOUNT_PATH_CONFLICT" && error.details.differingFields.includes("placeholder"),
  );
});
