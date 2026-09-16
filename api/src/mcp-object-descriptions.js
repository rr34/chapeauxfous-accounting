// Accounts are the reviewed first-class objects exposed by Accounting's object read tool.
// Other ledger rows remain readable through their focused tools and resources.
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
      { field: "archived", summary: "Whether the account is archived." },
    ],
    relationships: [{
      name: "parent",
      targetType: "accounting.account",
      summary: "parentAccountId identifies this account's parent in the same owner-scoped chart.",
    }],
  }],
});
