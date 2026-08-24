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
    nextId: Math.max(0, ...initialAccounts.map((account) => Number(account.account_id))) + 1,
    inserts: [],
    commits: 0,
    rollbacks: 0,
  };
  return {
    state,
    async getConnection() {
      const snapshot = structuredClone(state.accounts);
      return {
        async beginTransaction() {},
        async commit() { state.commits += 1; },
        async rollback() { state.rollbacks += 1; state.accounts = snapshot; },
        release() {},
        async query(sql, params = []) {
          if (sql.includes("FROM currencies")) {
            return [[{ currency_id: 1, CurrencyAbbreviation: "USD" }]];
          }
          if (sql.includes("FROM accounts a")) {
            return [state.accounts.map((account) => ({ ...account, CurrencyAbbreviation: "USD" }))];
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
