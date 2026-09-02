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
    valueUnits: string | null;
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

export type CanonicalImportRecord = {
  transaction_external_id: string;
  line_external_id?: string | null;
  transaction_date: string;
  description?: string | null;
  valuation_currency_code: string;
  account_full_name: string;
  amount_decimal: string;
  value_decimal: string | null;
  memo?: string | null;
};

export type TransactionImportProgress = {
  expected_source_records: number;
  newly_staged_records: number;
  previously_staged_or_reused_records: number;
  exception_records: number;
  remaining_records: number;
  equation: string;
  pending_commit_records: number;
  previously_committed_records: number;
  exception_record_totals: { unresolved: number; excluded: number };
  transaction_totals: {
    staged: number;
    pending_commit: number;
    previously_committed: number;
    reused: number;
    exceptions: number;
    unresolved_exceptions: number;
    excluded: number;
  };
};

export type TransactionImportJob = {
  import_job_id: string;
  source_system: string;
  source_file: { sha256: string; name: string | null };
  expected_record_count: number;
  job_status: "receiving" | "review_ready" | "committed";
  progress: TransactionImportProgress;
  preview_digest?: string | null;
  ready_to_commit?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  unresolved_exceptions?: number;
  excluded_exceptions?: number;
  commit_scope?: string;
};

export type TransactionImportException = {
  error_codes: string[];
  errors: Array<{ code: string; message: string; details?: unknown }>;
  resolution: { status: "unresolved" | "excluded"; reason: string | null; resolved_at: string | null };
  source_identity: {
    source_system: string;
    source_file: { sha256: string; name: string | null };
    transaction_external_id: string;
    line_external_ids: Array<string | null>;
  };
  canonical_records: CanonicalImportRecord[];
  transaction_context: {
    externalId: string;
    transactionDate: string;
    description: string | null;
    valuationCurrencyCode: string;
    lineItems: Array<{
      externalId: string | null;
      accountFullName: string;
      amountDecimal: string;
      valueDecimal: string | null;
      memo: string | null;
    }>;
  };
};
