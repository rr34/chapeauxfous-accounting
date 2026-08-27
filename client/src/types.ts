export type CurrencyType = "iso_4217" | "crypto" | "security" | "commodity" | "custom";

export type Currency = {
  id: number;
  code: string;
  displayName: string;
  type: CurrencyType;
  scale: number;
  ownerPersonId: number | null;
  userDefined: boolean;
};

export type User = {
  personId: number;
  name: string;
  email: string;
};

export type ApiTokenCredential = {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CreatedApiToken = {
  token: string;
  credential: ApiTokenCredential;
};

export type Account = {
  id: number;
  name: string;
  description: string | null;
  placeholder: boolean;
  parentAccountId: number | null;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  currencyId: number;
  currencyCode: string;
  scale: number;
  balanceUnits: string;
  archivedAt: string | null;
};

export type AccountLedgerEntry = {
  lineItemId: number;
  transactionId: number;
  date: string;
  description: string | null;
  memo: string | null;
  splitAccountNames: string[];
  splits: Array<{
    lineItemId: number;
    accountId: number;
    accountName: string;
    memo: string | null;
    amountUnits: string;
    currencyId: number;
    currencyCode: string;
    scale: number;
  }>;
  debitUnits: string | null;
  creditUnits: string | null;
  runningBalanceUnits: string;
};

export type BalanceAssertion = {
  id: number;
  accountId: number;
  accountName: string;
  date: string;
  knownBalanceUnits: string;
  calculatedBalanceUnits: string;
  differenceUnits: string;
  matches: boolean;
  currencyId: number;
  currencyCode: string;
  scale: number;
};

export type TransactionSummary = {
  id: number;
  date: string;
  description: string | null;
  state: "draft" | "posted" | "voided";
  valuationCurrencyId: number;
  valuationCurrencyCode: string;
  scale: number;
  lineItemCount: number;
};

export type TransactionDetail = {
  id: number;
  date: string;
  description: string | null;
  state: string;
  valuationCurrencyId: number;
  lineItems: Array<{
    id: number;
    amountUnits: string;
    memo: string | null;
    accountId: number;
    accountName: string;
    currencyId: number;
    currencyCode: string;
    scale: number;
    tags: Array<{ key: string; value: string }>;
  }>;
  rates: Array<{ id: number; fromUnits: string; fromCurrencyId: number; toUnits: string; toCurrencyId: number }>;
};
