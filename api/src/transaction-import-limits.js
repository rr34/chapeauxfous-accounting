export const TRANSACTION_IMPORT_MAX_TRANSACTIONS = 1000;
export const TRANSACTION_IMPORT_MAX_LINE_ITEMS = 10000;
export const TRANSACTION_IMPORT_HTTP_BODY_LIMIT = "16mb";

// A one-account source row has a constrained shape: it becomes one balanced
// transaction with exactly two postings (the selected account and suspense).
// Keep these sources intact at a larger ceiling instead of partitioning one
// statement into unrelated review plans.
export const SINGLE_ACCOUNT_IMPORT_MAX_TRANSACTIONS = 10000;
export const SINGLE_ACCOUNT_IMPORT_MAX_LINE_ITEMS = 20000;
