export type Currency = { id: number; code: string; scale: number };

export type User = {
  personId: number;
  name: string;
  email: string;
  functionalCurrencyId: number;
};

export type Account = {
  id: number;
  name: string;
  parentAccountId: number | null;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  currencyId: number;
  currencyCode: string;
  scale: number;
  balanceUnits: string;
  archivedAt: string | null;
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
