import test from "node:test";
import assert from "node:assert/strict";

import { compileSingleAccountStatementImport } from "../src/single-account-import.js";

const accounts = [
  { id: 1, name: "Assets", parentAccountId: null, placeholder: true, archivedAt: null,
    currencyId: 1, currencyCode: "USD" },
  { id: 2, name: "Checking", parentAccountId: 1, placeholder: false, archivedAt: null,
    currencyId: 1, currencyCode: "USD" },
  { id: 3, name: "Ask Human", parentAccountId: 1, placeholder: false, archivedAt: null,
    currencyId: 1, currencyCode: "USD", suspense: true },
  { id: 4, name: "BTC suspense", parentAccountId: 1, placeholder: false, archivedAt: null,
    currencyId: 2, currencyCode: "BTC" },
];

test("one-sided statement lines compile into cleared authoritative lines and one suspense bucket", () => {
  const compiled = compileSingleAccountStatementImport({
    accounts, accountId: 2, valuationCurrencyCode: "USD",
    questionAudience: "Accountant",
    lines: [{ externalId: "statement-row-17", transactionDate: "2026-08-10",
      description: "ACME 1234", amountDecimal: "-12.50", valueDecimal: "-12.50" }],
  });
  assert.equal(compiled.transactions.length, 1);
  assert.deepEqual(compiled.transactions[0].lineItems, [
    { externalId: "statement-row-17", accountFullName: "Assets:Checking",
      amountDecimal: "-12.50", valueDecimal: "-12.50", memo: undefined,
      reconciliationState: "cleared" },
    { externalId: null, accountFullName: "Assets:Ask Human",
      amountDecimal: "12.50", valueDecimal: "12.50", memo: undefined,
      reconciliationState: "unreconciled", question: {
          audience: "accountant", prompt: "What evidence identifies the other side of \"ACME 1234\"? Check for a matching imported account entry, including near matches affected by fees.",
      } },
  ]);
});

test("one-sided import rejects a suspense bucket other than the designated account", () => {
  assert.throws(() => compileSingleAccountStatementImport({
    accounts, accountId: 2, suspenseAccountId: 4, valuationCurrencyCode: "USD",
    lines: [{ externalId: "row-1", transactionDate: "2026-08-10", amountDecimal: "-1.00" }],
  }), (error) => error.code === "SUSPENSE_ACCOUNT_NOT_DESIGNATED");
});

test("one-sided import asks for designation when the currency has no suspense account", () => {
  assert.throws(() => compileSingleAccountStatementImport({
    accounts: accounts.map((account) => ({ ...account, suspense: false })),
    accountId: 2, valuationCurrencyCode: "USD",
    lines: [{ externalId: "row-1", transactionDate: "2026-08-10", amountDecimal: "-1.00" }],
  }), (error) => error.code === "SUSPENSE_ACCOUNT_NOT_CONFIGURED" && error.details.currencyCode === "USD");
});
