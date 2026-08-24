import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { requireApiToken } from "./api-tokens.js";
import { listBalanceAssertions, saveBalanceAssertion } from "./balance-assertions.js";
import {
  createAccount,
  createTransaction,
  getTransaction,
  listAccounts,
  listTransactions,
  verifyAllPostedTransactions,
} from "./accounting.js";
import { importAccountTree } from "./account-tree.js";
import { createCurrency, listCurrencies, userCurrencyTypes } from "./currencies.js";
import { AccountingSchemaSemantics, withSchemaProjection } from "./schema-semantics.js";

const readOnly = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const writesData = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

const operations = Object.freeze({
  listCurrencies: {
    name: "list_currencies",
    purpose: "List global and user-owned currencies, securities, commodities, and their native-unit scales.",
    schemaObjects: ["currencies"],
    fields: { currencies: ["currency_id", "owner_person_id", "CurrencyAbbreviation", "display_name", "currency_type", "scale"] },
  },
  createCurrency: {
    name: "create_currency",
    purpose: "Create one user-owned currency, security, commodity, or other accounting unit.",
    schemaObjects: ["currencies"],
    fields: { currencies: ["currency_id", "owner_person_id", "CurrencyAbbreviation", "display_name", "currency_type", "scale"] },
  },
  listAccounts: {
    name: "list_accounts",
    purpose: "List this user's accounts and balances derived from posted line items.",
    schemaObjects: ["accounts", "currencies", "transactions", "line_items"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      transactions: ["transaction_id", "TransactionState"],
      line_items: ["transaction_id", "amount_units", "account_id"],
    },
  },
  createAccount: {
    name: "create_account",
    purpose: "Create one user-owned accounting account.",
    schemaObjects: ["accounts", "currencies"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
    },
  },
  importAccountTree: {
    name: "import_account_tree",
    purpose: "Validate and atomically import a colon-delimited account hierarchy in parent-first order.",
    schemaObjects: ["accounts", "currencies"],
    fields: {
      accounts: ["account_id", "AccountName", "description", "is_placeholder", "parent_account_id", "AccountType", "account_currency_id", "archived_at", "source_system", "source_id"],
      currencies: ["currency_id", "owner_person_id", "CurrencyAbbreviation", "display_name", "currency_type", "scale"],
    },
  },
  listTransactions: {
    name: "list_transactions",
    purpose: "List this user's recent accounting transactions.",
    schemaObjects: ["transactions", "currencies", "line_items"],
    fields: {
      transactions: ["transaction_id", "TransactionDate", "description", "TransactionState", "valuation_currency_id"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      line_items: ["line_item_id", "transaction_id"],
    },
  },
  getTransaction: {
    name: "get_transaction",
    purpose: "Read one user-owned transaction with its line items, tags, and exchange rates.",
    schemaObjects: ["transactions", "line_items", "accounts", "currencies", "tags", "lineitems_tags_join", "xrates"],
    fields: {
      transactions: ["transaction_id", "TransactionDate", "description", "TransactionState", "valuation_currency_id"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id"],
      accounts: ["account_id", "AccountName", "account_currency_id"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      tags: ["tag_id", "tag_key", "tag_value"],
      lineitems_tags_join: ["tagged_line_item_id", "tag_id"],
      xrates: ["xrate_id", "transaction_id", "from_units", "from_currency_id", "to_units", "to_currency_id"],
    },
  },
  createTransaction: {
    name: "create_transaction",
    purpose: "Create a balanced double-entry transaction and optionally post it.",
    schemaObjects: ["transactions", "line_items", "accounts", "currencies", "tags", "lineitems_tags_join", "xrates"],
    fields: {
      transactions: ["transaction_id", "description", "valuation_currency_id", "TransactionState", "TransactionDate", "source_system", "source_id"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "memo", "account_id", "source_id"],
      accounts: ["account_id", "account_currency_id", "is_placeholder", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      tags: ["tag_id", "tag_key", "tag_value"],
      lineitems_tags_join: ["tagged_line_item_id", "tag_id"],
      xrates: ["xrate_id", "xrate_type", "transaction_id", "from_units", "from_currency_id", "to_units", "to_currency_id"],
    },
  },
  listBalanceAssertions: {
    name: "list_balance_assertions",
    purpose: "List known end-of-day account balances and compare them with the posted ledger.",
    schemaObjects: ["account_balance_assertions", "accounts", "currencies", "transactions", "line_items"],
    fields: {
      account_balance_assertions: ["account_balance_assertion_id", "account_id", "balance_date", "known_balance_units"],
      accounts: ["account_id", "AccountName", "account_currency_id", "is_placeholder"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      transactions: ["transaction_id", "TransactionDate", "TransactionState"],
      line_items: ["transaction_id", "amount_units", "account_id"],
    },
  },
  saveBalanceAssertion: {
    name: "save_balance_assertion",
    purpose: "Create or replace a known end-of-day account balance.",
    schemaObjects: ["account_balance_assertions", "accounts", "currencies", "transactions", "line_items"],
    fields: {
      account_balance_assertions: ["account_balance_assertion_id", "account_id", "balance_date", "known_balance_units"],
      accounts: ["account_id", "AccountName", "account_currency_id", "is_placeholder", "archived_at"],
      currencies: ["currency_id", "CurrencyAbbreviation", "scale"],
      transactions: ["transaction_id", "TransactionDate", "TransactionState"],
      line_items: ["transaction_id", "amount_units", "account_id"],
    },
  },
  verifyLedger: {
    name: "verify_ledger",
    purpose: "Re-run the accounting invariants for every posted transaction owned by this user.",
    schemaObjects: ["transactions", "line_items", "accounts", "xrates"],
    fields: {
      transactions: ["transaction_id", "owner_person_id", "valuation_currency_id", "TransactionState"],
      line_items: ["line_item_id", "transaction_id", "amount_units", "account_id"],
      accounts: ["account_id", "owner_person_id", "account_currency_id", "is_placeholder"],
      xrates: ["transaction_id", "xrate_type", "from_units", "from_currency_id", "to_units", "to_currency_id"],
    },
  },
});

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function positiveInteger(label) {
  return z.number().int().positive().describe(label);
}

export function createAccountingMcpServer({ personId, pool, schemaSemantics = new AccountingSchemaSemantics(), services = {} }) {
  const accounting = {
    listCurrencies: services.listCurrencies ?? listCurrencies,
    createCurrency: services.createCurrency ?? createCurrency,
    listAccounts: services.listAccounts ?? listAccounts,
    createAccount: services.createAccount ?? createAccount,
    importAccountTree: services.importAccountTree ?? importAccountTree,
    listTransactions: services.listTransactions ?? listTransactions,
    getTransaction: services.getTransaction ?? getTransaction,
    createTransaction: services.createTransaction ?? createTransaction,
    listBalanceAssertions: services.listBalanceAssertions ?? listBalanceAssertions,
    saveBalanceAssertion: services.saveBalanceAssertion ?? saveBalanceAssertion,
    verifyAllPostedTransactions: services.verifyAllPostedTransactions ?? verifyAllPostedTransactions,
  };
  const server = new McpServer({ name: "chapeaux-fous-accounting", version: "0.3.0" });

  server.registerTool("describe_accounting_schema", {
    title: "Describe accounting schema",
    description: "Return a small Schema Semantic Compiler projection for the accounting concepts named in the request. Use this before choosing accounting tools when the relevant entities or field meanings are unclear.",
    inputSchema: {
      request: z.string().trim().min(1).max(2000).describe("Natural-language description of the accounting data or operation to understand."),
    },
    annotations: readOnly,
  }, async ({ request }) => toolResult(schemaSemantics.route(request)));

  server.registerTool("list_currencies", {
    title: "List currencies",
    description: "List global and user-owned accounting units with ids, codes, display names, semantic types, and native-unit scales. Amounts elsewhere are integer native units, not decimal strings.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => toolResult(withSchemaProjection(schemaSemantics, {
    currencies: await accounting.listCurrencies(pool, personId),
  }, operations.listCurrencies)));

  server.registerTool("create_currency", {
    title: "Create currency or security",
    description: "Create a private accounting unit for the API-token owner. Use security for stocks and mutual funds. Scale is the number of fractional decimal places and cannot safely change after amounts have been recorded.",
    inputSchema: {
      code: z.string().trim().min(1).max(50).describe("Short user-facing code or ticker, such as VTSAX."),
      display_name: z.string().trim().min(1).max(255),
      currency_type: z.enum(userCurrencyTypes),
      scale: z.number().int().min(0).max(18).describe("Decimal places retained for integer native-unit amounts."),
    },
    annotations: writesData,
  }, async ({ code, display_name, currency_type, scale }) => toolResult(withSchemaProjection(schemaSemantics, {
    currency: await accounting.createCurrency({
      pool,
      personId,
      code,
      displayName: display_name,
      type: currency_type,
      scale,
    }),
  }, operations.createCurrency)));

  server.registerTool("list_accounts", {
    title: "List accounts",
    description: "List all accounts belonging to the API-token owner, including descriptions, placeholder state, posted native-unit balances, and archived state.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => toolResult(withSchemaProjection(schemaSemantics, {
    accounts: await accounting.listAccounts(pool, personId),
  }, operations.listAccounts)));

  server.registerTool("create_account", {
    title: "Create account",
    description: "Create an account for the API-token owner. No root account, account type, or currency is inferred.",
    inputSchema: {
      name: z.string().trim().min(1).describe("Human-facing account name."),
      description: z.string().trim().max(16000).nullable().optional(),
      placeholder: z.boolean().default(false).describe("Placeholder accounts organize the tree and cannot receive transactions or balance assertions."),
      parent_account_id: positiveInteger("Optional parent account id owned by the same user.").nullable().optional(),
      account_type: z.enum(["asset", "liability", "equity", "income", "expense"]),
      currency_id: positiveInteger("Currency id returned by list_currencies."),
    },
    annotations: writesData,
  }, async ({ name, description, placeholder, parent_account_id, account_type, currency_id }) => {
    const created = await accounting.createAccount({
      personId,
      name,
      description,
      placeholder,
      parentAccountId: parent_account_id,
      type: account_type,
      currencyId: currency_id,
    });
    return toolResult(withSchemaProjection(schemaSemantics, { account: created }, operations.createAccount));
  });

  const importedAccountSchema = z.object({
    full_name: z.string().trim().min(1).max(4096).describe("Complete account path with colon-separated account names, such as Assets:Bank:Checking."),
    account_type: z.enum(["asset", "liability", "equity", "income", "expense"]),
    currency_code: z.string().trim().min(1).max(50).describe("Currency code returned by list_currencies."),
    description: z.string().trim().max(16000).nullable().optional(),
    placeholder: z.boolean().default(false).describe("Whether this is a non-postable organizational account."),
  });
  const importedCurrencySchema = z.object({
    code: z.string().trim().min(1).max(50),
    display_name: z.string().trim().min(1).max(255),
    currency_type: z.enum(userCurrencyTypes),
    scale: z.number().int().min(0).max(18),
  });
  server.registerTool("import_account_tree", {
    title: "Import account tree",
    description: "Validate and atomically import optional user-owned currency definitions plus up to 1,000 accounts from colon-delimited full names. Use currency_type=security for mutual funds and stocks. Input order does not matter, every non-root parent must be present in this batch or already exist, and matching currencies and account paths make retries safe. Call with dry_run=true first, then repeat the same input with dry_run=false to import.",
    inputSchema: {
      currencies: z.array(importedCurrencySchema).max(500).default([]),
      accounts: z.array(importedAccountSchema).min(1).max(1000),
      dry_run: z.boolean().default(true).describe("Validate and report the complete plan without writing. Set false only after reviewing a successful dry run."),
    },
    annotations: { ...writesData, idempotentHint: true },
  }, async ({ currencies, accounts, dry_run }) => toolResult(withSchemaProjection(schemaSemantics, {
    import: await accounting.importAccountTree({
      pool,
      personId,
      dryRun: dry_run,
      currencies: currencies.map((currency) => ({
        code: currency.code,
        displayName: currency.display_name,
        type: currency.currency_type,
        scale: currency.scale,
      })),
      accounts: accounts.map((account) => ({
        fullName: account.full_name,
        type: account.account_type,
        currencyCode: account.currency_code,
        description: account.description,
        placeholder: account.placeholder,
      })),
    }),
  }, operations.importAccountTree)));

  server.registerTool("list_transactions", {
    title: "List transactions",
    description: "List recent transactions belonging to the API-token owner, newest first.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: readOnly,
  }, async ({ limit }) => toolResult(withSchemaProjection(schemaSemantics, {
    transactions: await accounting.listTransactions(pool, personId, limit),
  }, operations.listTransactions)));

  server.registerTool("get_transaction", {
    title: "Get transaction",
    description: "Get one transaction belonging to the API-token owner, including its line items, tags, and transaction exchange rates.",
    inputSchema: { transaction_id: positiveInteger("Transaction id.") },
    annotations: readOnly,
  }, async ({ transaction_id }) => toolResult(withSchemaProjection(schemaSemantics, {
    transaction: await accounting.getTransaction(pool, personId, transaction_id),
  }, operations.getTransaction)));

  const lineItemSchema = z.object({
    account_id: positiveInteger("Account id owned by the token owner."),
    amount_units: z.string().regex(/^-?\d+$/).describe("Signed integer amount in the account currency's native units."),
    memo: z.string().trim().nullable().optional(),
    source_id: z.string().trim().nullable().optional(),
    tags: z.array(z.object({
      key: z.string().trim().min(1).max(50),
      value: z.string().trim().min(1),
    })).optional(),
  });
  const rateSchema = z.object({
    from_units: z.string().regex(/^\d+$/).describe("Positive integer units in the source currency."),
    from_currency_id: positiveInteger("Source currency id."),
    to_units: z.string().regex(/^\d+$/).describe("Positive integer units in the valuation currency."),
    to_currency_id: positiveInteger("Must equal valuation_currency_id."),
  });
  server.registerTool("create_transaction", {
    title: "Create transaction",
    description: "Atomically create and validate a double-entry transaction using non-placeholder accounts. Values must balance in valuation_currency_id; provide a positive-unit exchange rate for each foreign account currency.",
    inputSchema: {
      description: z.string().trim().nullable().optional(),
      transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar date in YYYY-MM-DD form."),
      valuation_currency_id: positiveInteger("Currency in which transaction balance is evaluated."),
      line_items: z.array(lineItemSchema).min(2),
      rates: z.array(rateSchema).optional(),
      post: z.boolean().default(true).describe("Post after validation; false leaves a validated draft."),
      source_system: z.string().trim().max(32).nullable().optional(),
      source_id: z.string().trim().max(128).nullable().optional(),
    },
    annotations: writesData,
  }, async (input) => {
    const created = await accounting.createTransaction({
      personId,
      description: input.description,
      transactionDate: input.transaction_date,
      valuationCurrencyId: input.valuation_currency_id,
      lineItems: input.line_items.map((line) => ({
        accountId: line.account_id,
        amountUnits: line.amount_units,
        memo: line.memo,
        sourceId: line.source_id,
        tags: line.tags,
      })),
      rates: input.rates?.map((rate) => ({
        fromUnits: rate.from_units,
        fromCurrencyId: rate.from_currency_id,
        toUnits: rate.to_units,
        toCurrencyId: rate.to_currency_id,
      })),
      post: input.post,
      sourceSystem: input.source_system,
      sourceId: input.source_id,
    });
    return toolResult(withSchemaProjection(schemaSemantics, { transaction: created }, operations.createTransaction));
  });

  server.registerTool("list_balance_assertions", {
    title: "List balance assertions",
    description: "List known end-of-day balances and their differences from the posted ledger for the API-token owner.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => toolResult(withSchemaProjection(schemaSemantics, {
    assertions: await accounting.listBalanceAssertions(pool, personId),
  }, operations.listBalanceAssertions)));

  server.registerTool("save_balance_assertion", {
    title: "Save balance assertion",
    description: "Create or replace the known end-of-day native-unit balance for one account and date.",
    inputSchema: {
      account_id: positiveInteger("Account id owned by the token owner."),
      balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      known_balance_units: z.string().regex(/^-?\d+$/).describe("Signed integer native units in the account currency."),
    },
    annotations: { ...writesData, idempotentHint: true },
  }, async ({ account_id, balance_date, known_balance_units }) => toolResult(withSchemaProjection(schemaSemantics, {
    assertion: await accounting.saveBalanceAssertion({
      personId,
      accountId: account_id,
      balanceDate: balance_date,
      knownBalanceUnits: known_balance_units,
    }),
  }, operations.saveBalanceAssertion)));

  server.registerTool("verify_ledger", {
    title: "Verify ledger",
    description: "Check every posted transaction belonging to the API-token owner against the central double-entry and exchange-rate invariants.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => toolResult(withSchemaProjection(schemaSemantics,
    await accounting.verifyAllPostedTransactions(pool, personId), operations.verifyLedger)));

  return server;
}

export function mountAccountingMcp(app, { pool }) {
  const authenticate = requireApiToken(pool);
  const handler = createAccountingMcpHandler({ pool });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => console.error("Accounting MCP HTTP adapter error:", error),
  });

  app.all("/mcp", authenticate, async (req, res) => {
    const accountingAuth = req.auth ?? {};
    const personId = Number(accountingAuth.personId);
    if (!Number.isInteger(personId) || personId <= 0) {
      return res.status(403).json({ error: "ACCOUNTING_AUTH_REQUIRED" });
    }

    req.auth = {
      token: `cfacct-token-${accountingAuth.tokenId}`,
      clientId: "chapeaux-fous-accounting",
      scopes: ["accounting"],
      extra: { accountingAuth },
    };

    await nodeHandler(req, res, req.body);
  });
}

export function createAccountingMcpHandler({ pool }) {
  return createMcpHandler(
    (requestContext) => {
      const accountingAuth = requestContext.authInfo?.extra?.accountingAuth ?? {};
      const personId = Number(accountingAuth.personId);
      if (!Number.isInteger(personId) || personId <= 0) {
        throw new Error("Authenticated accounting user is required.");
      }
      return createAccountingMcpServer({ personId, pool });
    },
    {
      legacy: "stateless",
      onerror: (error) => console.error("Accounting MCP protocol error:", error),
    },
  );
}
