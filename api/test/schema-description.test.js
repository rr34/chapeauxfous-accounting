import test from "node:test";
import assert from "node:assert/strict";
import { describeAccountingSchema } from "../src/schema-description.js";

test("schema description reads live comments for matching accounting tables", async () => {
  let query;
  const pool = { async query(sql, args) {
    query = { sql, args };
    return [[
      { tableName: "accounts", tableComment: "Owner-scoped ledger accounts", columnName: "account_id",
        columnType: "int(11)", isNullable: "NO", columnComment: "Stable account ID" },
      { tableName: "accounts", tableComment: "Owner-scoped ledger accounts", columnName: "AccountName",
        columnType: "text", isNullable: "NO", columnComment: "User-visible account name" },
      { tableName: "transactions", tableComment: "Double-entry transactions", columnName: "transaction_id",
        columnType: "bigint(20)", isNullable: "NO", columnComment: "Stable transaction ID" },
    ]];
  } };
  const result = await describeAccountingSchema(pool, "accounting_test", "account name");
  assert.deepEqual(result.tables, [{
    name: "accounts", comment: "Owner-scoped ledger accounts", columns: [
      { name: "account_id", type: "int(11)", nullable: false, comment: "Stable account ID" },
      { name: "AccountName", type: "text", nullable: false, comment: "User-visible account name" },
    ],
  }]);
  assert.match(query.sql, /information_schema\.COLUMNS/);
  assert.equal(query.args[0], "accounting_test");
  assert.equal(query.args.includes("accounts"), true);
  assert.equal(query.args.includes("api_tokens"), true);
  assert.equal(query.args.includes("people2_people"), true);
});
