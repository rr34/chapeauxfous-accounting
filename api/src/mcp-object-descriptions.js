// Each type is published on exactly one owner-scoped, read-only object tool.
export const accountObjectDescription = Object.freeze({
  protocol: "agent-slayer.object-description",
  version: 1,
  types: [{
    id: "accounting.account",
    title: "Accounting account",
    summary: "One owner-scoped ledger account that the user can name, inspect, or select for a statement.",
    aliases: ["ledger account", "bank account", "exchange account", "crypto account"],
    reference: { field: "sourceRef", summary: "Stable owner-scoped accounting://accounts/{id} reference." },
    display: { field: "displayName", summary: "Full account path in the user's chart of accounts." },
    qualifiers: [
      { field: "accountType", summary: "Asset, liability, equity, income, or expense classification." },
      { field: "currencyCode", summary: "Native currency or accounting unit code." },
      { field: "postable", summary: "Whether the account currently accepts postings." },
      { field: "suspense", summary: "Whether the owner designated this account for unresolved imported counterlines." },
      { field: "archived", summary: "Whether the account is archived." },
    ],
    relationships: [{
      name: "parent",
      targetType: "accounting.account",
      summary: "parentAccountId identifies this account's parent in the same owner-scoped chart.",
    }],
  }],
});

export const transactionObjectDescription = Object.freeze({
  protocol: "agent-slayer.object-description",
  version: 1,
  types: [{
    id: "accounting.transaction",
    title: "Accounting transaction",
    summary: "One dated owner-scoped ledger event whose postings can be inspected as a unit.",
    aliases: ["ledger transaction", "journal entry", "payment", "transfer"],
    reference: { field: "sourceRef", summary: "Stable accounting://transactions/{id} reference." },
    display: { field: "displayName", summary: "Accounting date and a compact transaction description." },
    qualifiers: [
      { field: "date", summary: "Accounting calendar date of this transaction." },
      { field: "state", summary: "Draft, posted, or voided lifecycle state." },
      { field: "valuationCurrencyCode", summary: "Currency in which transaction values balance." },
      { field: "accountIds", summary: "Owner-scoped account IDs receiving the transaction's postings." },
    ],
    relationships: [{
      name: "accounts",
      targetType: "accounting.account",
      summary: "accountIds identify the accounts with postings in this transaction.",
    }],
  }],
});

export const accountingQuestionObjectDescription = Object.freeze({
  protocol: "agent-slayer.object-description",
  version: 1,
  types: [{
    id: "accounting.question",
    title: "Accounting question",
    summary: "One owner-scoped suspense posting awaiting or recording a classification decision.",
    aliases: ["unresolved charge", "suspense question", "classification question"],
    reference: { field: "sourceRef", summary: "Stable accounting://questions/{lineItemId} reference." },
    display: { field: "displayName", summary: "Transaction date and a compact question prompt." },
    qualifiers: [
      { field: "status", summary: "Open or resolved question state." },
      { field: "audience", summary: "Person or role expected to answer the question." },
      { field: "transactionDate", summary: "Accounting date of the linked transaction." },
      { field: "accountFullName", summary: "Full current path of the posting account." },
      { field: "currencyCode", summary: "Native currency of the suspense posting." },
    ],
    relationships: [
      { name: "transaction", targetType: "accounting.transaction",
        summary: "transactionId identifies the transaction containing this question's posting." },
      { name: "account", targetType: "accounting.account",
        summary: "accountId identifies the account receiving this question's posting." },
    ],
  }],
});

export const transactionImportJobObjectDescription = Object.freeze({
  protocol: "agent-slayer.object-description",
  version: 1,
  types: [{
    id: "accounting.transaction_import_job",
    title: "Transaction import job",
    summary: "One durable owner-scoped source-file transaction import that can be resumed or inspected.",
    aliases: ["import job", "file import", "transaction import"],
    reference: { field: "sourceRef", summary: "Stable accounting://transaction-import-jobs/{id} reference." },
    display: { field: "displayName", summary: "Source filename or system, creation date, and current job state." },
    qualifiers: [
      { field: "sourceSystem", summary: "External-system namespace of the source records." },
      { field: "fileName", summary: "Optional informational source filename." },
      { field: "jobStatus", summary: "Receiving, review-ready, or committed state." },
      { field: "createdAt", summary: "Creation time of this durable import job." },
      { field: "expectedRecordCount", summary: "Expected complete source-record count." },
    ],
  }],
});

export const balanceAssertionObjectDescription = Object.freeze({
  protocol: "agent-slayer.object-description",
  version: 1,
  types: [{
    id: "accounting.balance_assertion",
    title: "Balance assertion",
    summary: "One owner-entered end-of-day account balance used for reconciliation.",
    aliases: ["closing balance", "statement balance", "known balance"],
    reference: { field: "sourceRef", summary: "Stable accounting://balance-assertions/{id} reference." },
    display: { field: "displayName", summary: "Balance date, account name, and known native-currency amount." },
    qualifiers: [
      { field: "date", summary: "End-of-day accounting calendar date." },
      { field: "accountName", summary: "Current local name of the related ledger account." },
      { field: "knownBalanceUnits", summary: "Signed known balance in native units." },
      { field: "currencyCode", summary: "Native accounting-unit code of the balance." },
      { field: "matches", summary: "Whether the known balance matches the currently calculated ledger balance." },
    ],
    relationships: [{
      name: "account",
      targetType: "accounting.account",
      summary: "accountId identifies the account whose end-of-day balance was asserted.",
    }],
  }],
});
