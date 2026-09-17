import { FormEvent, Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, ApiError, mcpEndpointUrl } from "./api";
import { decimalToUnits, unitsToDecimal } from "./money";
import StatementWorkspace from "./StatementWorkspace";
import type {
  Account, AccountLedgerEntry, ApiTokenCredential, BalanceAssertion, CreatedApiToken, Currency,
  CanonicalImportRecord, CurrencyType, TransactionDetail, TransactionImportException,
  TransactionImportJob, TransactionSummary, User,
} from "./types";

const tokenKey = "cf-accounting-token";
const today = () => new Date().toISOString().slice(0, 10);
const currencyLabel = (currency: Currency) => currency.displayName === currency.code
  ? currency.code
  : `${currency.code} — ${currency.displayName}`;

function CurrencyOptions({ currencies, accounts, valueBy = "id" }: {
  currencies: Currency[]; accounts: Account[]; valueBy?: "id" | "code";
}) {
  const usedCurrencyIds = new Set(accounts.map((account) => account.currencyId));
  const inUse = currencies.filter((currency) => usedCurrencyIds.has(currency.id));
  const other = currencies.filter((currency) => !usedCurrencyIds.has(currency.id));
  const options = (items: Currency[]) => items.map((currency) =>
    <option key={currency.id} value={valueBy === "code" ? currency.code : currency.id}>{currencyLabel(currency)}</option>);
  return <>{inUse.length > 0 && <optgroup label="In use">{options(inUse)}</optgroup>}
    {other.length > 0 && <optgroup label="Other currencies">{options(other)}</optgroup>}</>;
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong.";
}

type AuthProps = { onAuthenticated: (token: string, user: User) => void };

type AccountTreeBalance = { currencyId: number; currencyCode: string; scale: number; units: string };
type AccountTreeNode = Account & { children: AccountTreeNode[]; subtreeBalances: AccountTreeBalance[] };
type TransactionDeletionPreview = {
  deletionPlanId: string;
  previewDigest: string;
  summary: {
    scope: "all" | "selected";
    transactionCount: number;
    lineItemCount: number;
    exchangeRateCount: number;
    tagAssignmentCount: number;
    affectedAccountCount: number;
    deleteAccounts: boolean;
    accountCount: number;
    balanceAssertionCount: number;
    deleteImportHistory: boolean;
    importJobCount: number;
    importItemCount: number;
    importRequestCount: number;
    dateRange: { first: string | null; last: string | null };
  };
};
type DataSummary = {
  accountCount: number;
  transactionCount: number;
  lineItemCount: number;
  assertionCount: number;
  customCurrencyCount: number;
  tagCount: number;
  exchangeRateCount: number;
  importJobCount: number;
  importItemCount: number;
  apiTokenCount: number;
  savedPlanCount: number;
};
type AccountDeletionPreview = {
  deletionPlanId: string;
  previewDigest: string;
  summary: { accountId: number; accountName: string };
};
type ImportRestartPreview = {
  restartPlanId: string;
  previewDigest: string;
  summary: {
    importJobId: string;
    sourceSystem: string;
    sourceFileName: string | null;
    importItemCount: number;
    createdTransactionCount: number;
    preservedReusedTransactionCount: number;
    lineItemCount: number;
    exchangeRateCount: number;
    tagAssignmentCount: number;
  };
};
type UserDeletionPreview = {
  deletionPlanId: string;
  previewDigest: string;
  confirmationText: string;
  summary: {
    name: string;
    email: string;
    accountCount: number;
    transactionCount: number;
    lineItemCount: number;
    assertionCount: number;
    customCurrencyCount: number;
    importJobCount: number;
    apiTokenCount: number;
  };
};

function buildAccountTree(accounts: Account[]): AccountTreeNode[] {
  const accountIds = new Set(accounts.map((account) => account.id));
  const childrenByParentId = new Map<number | null, Account[]>();

  for (const account of accounts) {
    const parentId = account.parentAccountId != null && accountIds.has(account.parentAccountId)
      ? account.parentAccountId
      : null;
    const siblings = childrenByParentId.get(parentId) ?? [];
    siblings.push(account);
    childrenByParentId.set(parentId, siblings);
  }

  const addChildren = (account: Account, ancestors: Set<number>): AccountTreeNode => {
    const nextAncestors = new Set(ancestors).add(account.id);
    const children = (childrenByParentId.get(account.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id))
      .map((child) => addChildren(child, nextAncestors));
    const balancesByCurrency = new Map<number, AccountTreeBalance>();
    balancesByCurrency.set(account.currencyId, {
      currencyId: account.currencyId,
      currencyCode: account.currencyCode,
      scale: account.scale,
      units: account.balanceUnits,
    });
    for (const child of children) {
      for (const balance of child.subtreeBalances) {
        const current = balancesByCurrency.get(balance.currencyId);
        balancesByCurrency.set(balance.currencyId, current
          ? { ...current, units: (BigInt(current.units) + BigInt(balance.units)).toString() }
          : balance);
      }
    }
    return {
      ...account,
      children,
      subtreeBalances: [...balancesByCurrency.values()],
    };
  };

  return (childrenByParentId.get(null) ?? []).map((account) => addChildren(account, new Set()));
}

function accountFullNames(accounts: Account[]) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const names = new Map<number, string>();
  function resolve(account: Account, visiting = new Set<number>()): string {
    const known = names.get(account.id);
    if (known) return known;
    if (visiting.has(account.id)) return account.name;
    const parent = account.parentAccountId == null ? null : byId.get(account.parentAccountId);
    const fullName = parent ? `${resolve(parent, new Set(visiting).add(account.id))}:${account.name}` : account.name;
    names.set(account.id, fullName);
    return fullName;
  }
  for (const account of accounts) resolve(account);
  return names;
}

type AccountChoice = { value: string; label: string; currencyCode: string };

function AccountCombobox({ value, choices, onChange, label, placeholder = "Type to find an account…" }: {
  value: string; choices: AccountChoice[]; onChange: (value: string) => void; label: string; placeholder?: string;
}) {
  const listId = useId();
  const selected = choices.find((choice) => choice.value === value) ?? null;
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!open) setQuery(selected?.label ?? ""); }, [selected?.label, open]);
  const normalized = query.trim().toLocaleLowerCase("en-US");
  const matches = normalized
    ? choices.filter((choice) => `${choice.label} ${choice.currencyCode}`.toLocaleLowerCase("en-US").includes(normalized)).slice(0, 40)
    : [];

  return <div className="account-combobox">
    <input role="combobox" aria-label={label} aria-expanded={open} aria-controls={listId}
      aria-autocomplete="list" autoComplete="off" value={query}
      placeholder={placeholder}
      onFocus={() => { setOpen(true); setQuery(""); }}
      onBlur={() => { setOpen(false); setQuery(selected?.label ?? ""); }}
      onChange={(event) => { setQuery(event.target.value); setOpen(true); onChange(""); }} />
    {open && <div className="account-combobox-list" id={listId} role="listbox">
      {!normalized && <span>Type part of an account name to filter.</span>}
      {normalized && matches.map((choice) => <button type="button" role="option" key={choice.value}
        aria-selected={choice.value === value} onMouseDown={(event) => event.preventDefault()}
        onClick={() => { onChange(choice.value); setQuery(choice.label); setOpen(false); }}>
        <strong>{choice.label}</strong><small>{choice.currencyCode}</small>
      </button>)}
      {normalized && !matches.length && <span>No postable accounts match “{query}”.</span>}
    </div>}
  </div>;
}

function AccountTree({ accounts, selectedAccountId, onSelect, onEdit }: {
  accounts: Account[]; selectedAccountId: number | null;
  onSelect: (account: Account) => void; onEdit: (account: Account) => void;
}) {
  const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(() => new Set());
  const tree = useMemo(() => buildAccountTree(accounts), [accounts]);

  function toggleExpanded(accountId: number) {
    setExpandedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  function renderNode(node: AccountTreeNode, depth: number) {
    const hasChildren = node.children.length > 0;
    const isExpanded = hasChildren && expandedAccountIds.has(node.id);
    return <div className="account-tree-item" key={node.id}>
      <div className="account-tree-row" style={{ paddingInlineStart: `${depth * 0.9}rem` }}>
        {hasChildren
          ? <button type="button" className="account-disclosure" aria-expanded={isExpanded}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
              onClick={() => toggleExpanded(node.id)}><span aria-hidden="true">›</span></button>
          : <span className="account-disclosure-spacer" />}
        <button type="button" className={`account-row ${selectedAccountId === node.id ? "selected" : ""}`}
          aria-label={`View ${node.name} ledger`} onClick={() => onSelect(node)}>
          <div><strong>{node.name}</strong><span>{node.type} · {node.currencyCode}{node.placeholder ? " · placeholder" : ""}{node.suspense ? " · suspense" : ""}</span>
            {node.description && <small>{node.description}</small>}</div>
          <div className="account-balances">{node.subtreeBalances.map((balance) => <b key={balance.currencyId}>
            {unitsToDecimal(balance.units, balance.scale)}
            {node.subtreeBalances.length > 1 && <em>{balance.currencyCode}</em>}
          </b>)}</div>
        </button>
        <button type="button" className="account-edit-button" aria-label={`Edit account ${node.name}`}
          onClick={() => onEdit(node)}>✎</button>
      </div>
      {isExpanded && <div role="group" aria-label={`${node.name} subaccounts`}>
        {node.children.map((child) => renderNode(child, depth + 1))}
      </div>}
    </div>;
  }

  return <div className="account-list">{tree.map((node) => renderNode(node, 0))}</div>;
}

function AuthScreen({ onAuthenticated }: AuthProps) {
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const result = registering
        ? await api<{ token: string; user: User }>("/auth/register", {
            method: "POST", body: JSON.stringify({ name, email, password }),
          })
        : await api<{ token: string; user: User }>("/auth/login", {
            method: "POST", body: JSON.stringify({ email, password }),
          });
      onAuthenticated(result.token, result.user);
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  return <main className="auth-page">
    <section className="auth-card">
      <p className="eyebrow">Chapeaux Fous</p>
      <h1>Accounting, connected.</h1>
      <p className="muted">A strict double-entry ledger with flexible tags and an AI-ready accounting service.</p>
      <form onSubmit={submit}>
        {registering && <label>Name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>}
        <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)}
          minLength={registering ? 4 : undefined} maxLength={4096}
          autoComplete={registering ? "new-password" : "current-password"} /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Working…" : registering ? "Create ledger" : "Sign in"}</button>
      </form>
      <button className="link-button" onClick={() => setRegistering(!registering)}>
        {registering ? "Already have an account? Sign in" : "New here? Create an account"}
      </button>
    </section>
  </main>;
}

function AccountEditDialog({ account, accounts, currencies, token, onClose, onChanged }: {
  account: Account; accounts: Account[]; currencies: Currency[]; token: string;
  onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(account.name);
  const [description, setDescription] = useState(account.description ?? "");
  const [placeholder, setPlaceholder] = useState(account.placeholder);
  const [type, setType] = useState<Account["type"]>(account.type);
  const [suspense, setSuspense] = useState(account.suspense);
  const [currencyId, setCurrencyId] = useState(account.currencyId);
  const [parentAccountId, setParentAccountId] = useState(account.parentAccountId == null ? "" : String(account.parentAccountId));
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<"save" | "preview-delete" | "delete" | "">("");
  const [deletePreview, setDeletePreview] = useState<AccountDeletionPreview | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const unavailableParentIds = useMemo(() => {
    const ids = new Set([account.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of accounts) {
        if (candidate.parentAccountId != null && ids.has(candidate.parentAccountId) && !ids.has(candidate.id)) {
          ids.add(candidate.id); changed = true;
        }
      }
    }
    return ids;
  }, [account.id, accounts]);

  async function save(event: FormEvent) {
    event.preventDefault(); setBusyAction("save"); setError("");
    try {
      await api(`/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify({
        name,
        description,
        placeholder,
        suspense,
        type,
        currencyId,
        parentAccountId: parentAccountId ? Number(parentAccountId) : null,
      }) }, token);
      await onChanged(); onClose();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusyAction(""); }
  }

  async function remove() {
    const confirmationText = `DELETE ${account.name}`;
    if (deletePreview && deleteConfirmation !== confirmationText) return;
    setBusyAction(deletePreview ? "delete" : "preview-delete"); setError("");
    try {
      if (!deletePreview) {
        const preview = await api<AccountDeletionPreview>(`/data/accounts/${account.id}/delete-preview`, {
          method: "POST", body: "{}",
        }, token);
        setDeletePreview(preview);
      } else {
        await api(`/data/accounts/${account.id}/delete-commit`, {
          method: "POST", body: JSON.stringify({ deletionPlanId: deletePreview.deletionPlanId,
            previewDigest: deletePreview.previewDigest }),
        }, token);
        await onChanged(); onClose();
      }
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusyAction(""); }
  }

  return <div className="dialog-backdrop" role="presentation">
    <section className="agent-dialog account-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="account-edit-title">
      <div className="dialog-heading"><div><p className="eyebrow">Chart of accounts</p><h2 id="account-edit-title">Edit account</h2></div>
        <button className="dialog-close" aria-label="Close account editor" onClick={onClose}>×</button></div>
      <form onSubmit={save}>
        <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <div className="form-row"><label>Type<select value={type} onChange={(event) => setType(event.target.value as Account["type"])}>
          {(["asset", "liability", "equity", "income", "expense"] as const).map((value) => <option key={value}>{value}</option>)}
        </select></label><label>Currency<select value={currencyId} onChange={(event) => setCurrencyId(Number(event.target.value))}>
          <CurrencyOptions currencies={currencies} accounts={accounts} />
        </select></label></div>
        <label>Parent<select value={parentAccountId} onChange={(event) => setParentAccountId(event.target.value)}>
          <option value="">No parent</option>
          {accounts.filter((candidate) => !candidate.archivedAt && !unavailableParentIds.has(candidate.id)).map((candidate) =>
            <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select></label>
        <label className="checkbox-field"><input type="checkbox" checked={placeholder}
          onChange={(event) => setPlaceholder(event.target.checked)} />Placeholder (cannot receive transactions)</label>
        <label className="checkbox-field"><input type="checkbox" checked={suspense}
          onChange={(event) => setSuspense(event.target.checked)} />Use for unresolved imported entries in {account.currencyCode}</label>
        {deletePreview && <section className="delete-confirmation-panel">
          <strong>Delete this empty account?</strong>
          <p>This permanently removes only <b>{deletePreview.summary.accountName}</b>. Accounts with children, postings, or known balances cannot be deleted.</p>
          <label>Type <code>DELETE {account.name}</code>
            <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} />
          </label>
        </section>}
        {error && <p className="error">{error}</p>}
        <div className="account-dialog-actions"><button type="button" className="danger-button"
          disabled={Boolean(busyAction) || Boolean(deletePreview && deleteConfirmation !== `DELETE ${account.name}`)}
          onClick={() => void remove()}>{busyAction === "preview-delete" ? "Preparing preview…"
            : busyAction === "delete" ? "Deleting…" : deletePreview ? "Permanently delete account" : "Review account deletion"}</button>
          <button className="primary" disabled={Boolean(busyAction)}>{busyAction === "save" ? "Saving…" : "Save changes"}</button></div>
      </form>
    </section>
  </div>;
}

function ChartOfAccounts({ accounts, currencies, selectedAccountId,
  token, onSelectAccount, onChanged }: {
  accounts: Account[]; currencies: Currency[]; selectedAccountId: number | null; token: string;
  onSelectAccount: (account: Account) => void; onChanged: () => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [placeholder, setPlaceholder] = useState(false);
  const [suspense, setSuspense] = useState(false);
  const [type, setType] = useState<Account["type"] | "">("");
  const [currencyId, setCurrencyId] = useState<number | "">("");
  const [parentAccountId, setParentAccountId] = useState("");
  const [error, setError] = useState("");
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      await api("/accounts", { method: "POST", body: JSON.stringify({ name, description, placeholder, suspense, type, currencyId: Number(currencyId),
        parentAccountId: parentAccountId ? Number(parentAccountId) : null }) }, token);
      setName(""); setDescription(""); setPlaceholder(false); setSuspense(false); setShowForm(false); await onChanged();
    } catch (nextError) { setError(errorMessage(nextError)); }
  }

  return <section className="accounts-view card">
    <div className="section-heading"><div><p className="eyebrow">Accounting structure</p><h2>Chart of accounts</h2></div>
      <button aria-label={showForm ? "Close new account form" : "Add account"} onClick={() => setShowForm(!showForm)}>＋</button></div>
    {showForm && <form className="compact-form" onSubmit={submit}>
      <input placeholder="Account name" value={name} onChange={(event) => setName(event.target.value)} />
      <input placeholder="Description (optional)" value={description} onChange={(event) => setDescription(event.target.value)} />
      <div className="form-row"><select required value={type} onChange={(event) => setType(event.target.value as Account["type"] | "")}>
        <option value="">Choose type…</option>
        {(["asset", "liability", "equity", "income", "expense"] as const).map((value) => <option key={value}>{value}</option>)}
      </select><select required value={currencyId} onChange={(event) => setCurrencyId(event.target.value ? Number(event.target.value) : "")}>
        <option value="">Choose currency…</option>
        <CurrencyOptions currencies={currencies} accounts={accounts} />
      </select></div>
      <select value={parentAccountId} onChange={(event) => setParentAccountId(event.target.value)}>
        <option value="">No parent</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select>
      <label className="checkbox-field"><input type="checkbox" checked={placeholder}
        onChange={(event) => setPlaceholder(event.target.checked)} />Placeholder (cannot receive transactions)</label>
      <label className="checkbox-field"><input type="checkbox" checked={suspense}
        onChange={(event) => setSuspense(event.target.checked)} />Use for unresolved imported entries in this currency</label>
      {error && <p className="error">{error}</p>}<button className="primary">Add account</button>
    </form>}
    <AccountTree accounts={accounts} selectedAccountId={selectedAccountId}
      onSelect={onSelectAccount} onEdit={setEditingAccount} />
    {editingAccount && <AccountEditDialog key={editingAccount.id} account={editingAccount} accounts={accounts} currencies={currencies}
      token={token} onClose={() => setEditingAccount(null)} onChanged={onChanged} />}
  </section>;
}

type RateDirection = "value-per-amount" | "amount-per-value";
const oppositeRateDirection = (direction: RateDirection): RateDirection => direction === "value-per-amount"
  ? "amount-per-value"
  : "value-per-amount";
const exchangeRateCurrencies = (direction: RateDirection, valueCurrencyCode: string, amountCurrencyCode: string) =>
  direction === "value-per-amount"
    ? [valueCurrencyCode, amountCurrencyCode] as const
    : [amountCurrencyCode, valueCurrencyCode] as const;
const exchangeRateUnits = (direction: RateDirection, valueCurrencyCode: string, amountCurrencyCode: string) =>
  exchangeRateCurrencies(direction, valueCurrencyCode, amountCurrencyCode).join(" per ");

function ExchangeRateFraction({ direction, valueCurrencyCode, amountCurrencyCode }: {
  direction: RateDirection; valueCurrencyCode: string; amountCurrencyCode: string;
}) {
  const [numerator, denominator] = exchangeRateCurrencies(direction, valueCurrencyCode, amountCurrencyCode);
  return <span className="rate-unit-fraction" aria-hidden="true">
    <span className="rate-unit-numerator">{numerator}</span>
    <span className="rate-unit-denominator">{denominator}</span>
  </span>;
}
type EditableLine = { id: number | null; accountId: string; amount: string; value: string; memo: string;
  rateDecimal: string; rateDirection: RateDirection; rateChanges: "amount" | "value"; autoBalance: boolean;
  rateSource?: "xrates" | "implied" | "edited" };
type EditableImportRecord = Omit<CanonicalImportRecord, "value_decimal"> & {
  value_decimal: string | null;
  editorKey: string;
  rateDecimal: string;
  rateDirection: RateDirection;
  rateChanges: "amount" | "value";
  autoBalance: boolean;
};

function amountForSide(amount: string, side: "debit" | "credit") {
  const trimmed = amount.trim();
  const isCredit = trimmed.startsWith("-");
  if ((side === "credit") !== isCredit || !trimmed) return "";
  return trimmed.replace(/^[+-]/, "");
}

function signedAmountForSide(side: "debit" | "credit", value: string) {
  const unsigned = value.trim().replace(/^[+-]/, "");
  if (!unsigned) return "";
  return side === "credit" ? `-${unsigned}` : unsigned;
}

function debitIncreasesAccount(type: Account["type"]) {
  return type === "asset" || type === "expense";
}

function reversePostingSign(value: string) {
  if (!value) return "";
  if (value.startsWith("-")) return `+${value.slice(1)}`;
  if (value.startsWith("+")) return `-${value.slice(1)}`;
  return `-${value}`;
}

function accountMovementInput(amount: string, accountType: Account["type"]) {
  const movement = debitIncreasesAccount(accountType) ? amount : reversePostingSign(amount);
  return movement.startsWith("+") && movement.length > 1 ? movement.slice(1) : movement;
}

function postingAmountFromMovement(movement: string, accountType: Account["type"]) {
  return debitIncreasesAccount(accountType) ? movement : reversePostingSign(movement);
}

function signedAccountMovement(amountUnits: string, account: Pick<Account, "type" | "scale" | "currencyCode">) {
  const movementUnits = BigInt(amountUnits) * (debitIncreasesAccount(account.type) ? 1n : -1n);
  const amount = unitsToDecimal(movementUnits.toString(), account.scale);
  return `${movementUnits > 0n ? "+" : ""}${amount} ${account.currencyCode}`;
}

function movementEffectClass(amountUnits: string, accountType: Account["type"]) {
  const movementUnits = BigInt(amountUnits) * (debitIncreasesAccount(accountType) ? 1n : -1n);
  return movementUnits > 0n ? "increase-effect" : movementUnits < 0n ? "decrease-effect" : "";
}

type DecimalParts = { units: bigint; scale: number };

function decimalParts(value: string | null | undefined): DecimalParts | null {
  const match = (value == null ? "" : String(value)).trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return { units: match[1] === "-" ? -magnitude : magnitude, scale: fraction.length };
}

function powerOfTen(exponent: number) {
  return 10n ** BigInt(exponent);
}

function roundedQuotient(numerator: bigint, denominator: bigint) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function signedRoundedQuotient(numerator: bigint, denominator: bigint) {
  const negative = numerator < 0n !== denominator < 0n;
  const magnitude = roundedQuotient(numerator < 0n ? -numerator : numerator,
    denominator < 0n ? -denominator : denominator);
  return negative ? -magnitude : magnitude;
}

function formattedDecimal(units: bigint, scale: number) {
  const value = unitsToDecimal(units.toString(), scale);
  return scale === 0 ? value : value.replace(/\.?0+$/, "");
}

function signedAccountMovementDecimal(amount: string | null, account: Pick<Account, "type" | "currencyCode">) {
  const parts = decimalParts(amount);
  if (!parts) return "—";
  const movementUnits = parts.units * (debitIncreasesAccount(account.type) ? 1n : -1n);
  return `${movementUnits > 0n ? "+" : ""}${formattedDecimal(movementUnits, parts.scale)} ${account.currencyCode}`;
}

function sumDecimals(values: Array<string | null | undefined>, { ignoreBlank = false } = {}) {
  const parsed: DecimalParts[] = [];
  for (const value of values) {
    if (ignoreBlank && String(value ?? "").trim() === "") continue;
    const parts = decimalParts(typeof value === "string" ? value : value == null ? "" : String(value));
    if (!parts) return null;
    parsed.push(parts);
  }
  if (!parsed.length) return "0";
  const scale = Math.max(...parsed.map((parts) => parts.scale));
  const units = parsed.reduce((sum, parts) => sum + parts.units * powerOfTen(scale - parts.scale), 0n);
  return formattedDecimal(units, scale);
}

function negateDecimal(value: string) {
  const parts = decimalParts(value);
  return parts ? formattedDecimal(-parts.units, parts.scale) : "";
}

function decimalRatio(dividend: string | null | undefined, divisor: string | null | undefined) {
  const left = decimalParts(dividend);
  const right = decimalParts(divisor);
  if (!left || !right || left.units === 0n || right.units === 0n) return "";
  const numerator = (left.units < 0n ? -left.units : left.units) * powerOfTen(right.scale);
  const denominator = (right.units < 0n ? -right.units : right.units) * powerOfTen(left.scale);
  const integerPart = numerator / denominator;
  let exponent: number;
  if (integerPart > 0n) {
    exponent = integerPart.toString().length - 1;
  } else {
    let shifted = numerator;
    let places = 0;
    while (shifted < denominator && places < 18) { shifted *= 10n; places += 1; }
    exponent = -places;
  }
  const decimalPlaces = Math.max(0, Math.min(18, 11 - exponent));
  return formattedDecimal(roundedQuotient(numerator * powerOfTen(decimalPlaces), denominator), decimalPlaces);
}

function greatestCommonDivisor(left: bigint, right: bigint) {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

function storedRateFromDecimal(rateDecimal: string, direction: RateDirection,
  accountScale: number, valueScale: number) {
  const rate = decimalParts(rateDecimal);
  if (!rate || rate.units <= 0n) return null;
  const from = direction === "value-per-amount"
    ? powerOfTen(accountScale + rate.scale) : rate.units * powerOfTen(accountScale);
  const to = direction === "value-per-amount"
    ? rate.units * powerOfTen(valueScale) : powerOfTen(valueScale + rate.scale);
  const divisor = greatestCommonDivisor(from, to);
  return { fromUnits: (from / divisor).toString(), toUnits: (to / divisor).toString() };
}

function decimalProductToScale(leftValue: string, rightValue: string, outputScale: number) {
  const left = decimalParts(leftValue);
  const right = decimalParts(rightValue);
  if (!left || !right || right.units <= 0n) return null;
  const negative = left.units < 0n;
  const numerator = (negative ? -left.units : left.units) * right.units * powerOfTen(outputScale);
  const denominator = powerOfTen(left.scale + right.scale);
  const units = roundedQuotient(numerator, denominator);
  return unitsToDecimal((negative ? -units : units).toString(), outputScale);
}

function decimalQuotientToScale(leftValue: string, rightValue: string, outputScale: number) {
  const left = decimalParts(leftValue);
  const right = decimalParts(rightValue);
  if (!left || !right || right.units <= 0n) return null;
  const negative = left.units < 0n;
  const numerator = (negative ? -left.units : left.units) * powerOfTen(right.scale + outputScale);
  const denominator = right.units * powerOfTen(left.scale);
  const units = roundedQuotient(numerator, denominator);
  return unitsToDecimal((negative ? -units : units).toString(), outputScale);
}

function lineRate(record: Pick<CanonicalImportRecord, "amount_decimal" | "value_decimal">, direction: RateDirection) {
  return direction === "value-per-amount"
    ? decimalRatio(record.value_decimal, record.amount_decimal)
    : decimalRatio(record.amount_decimal, record.value_decimal);
}

function sameLineRate(
  left: Pick<CanonicalImportRecord, "amount_decimal" | "value_decimal">,
  right: Pick<CanonicalImportRecord, "amount_decimal" | "value_decimal">,
) {
  const leftAmount = decimalParts(left.amount_decimal);
  const leftValue = decimalParts(left.value_decimal);
  const rightAmount = decimalParts(right.amount_decimal);
  const rightValue = decimalParts(right.value_decimal);
  if (!leftAmount || !leftValue || !rightAmount || !rightValue
    || leftAmount.units === 0n || rightAmount.units === 0n) return true;
  const leftNumerator = (leftValue.units < 0n ? -leftValue.units : leftValue.units)
    * powerOfTen(leftAmount.scale);
  const leftDenominator = (leftAmount.units < 0n ? -leftAmount.units : leftAmount.units)
    * powerOfTen(leftValue.scale);
  const rightNumerator = (rightValue.units < 0n ? -rightValue.units : rightValue.units)
    * powerOfTen(rightAmount.scale);
  const rightDenominator = (rightAmount.units < 0n ? -rightAmount.units : rightAmount.units)
    * powerOfTen(rightValue.scale);
  return leftNumerator * rightDenominator === rightNumerator * leftDenominator;
}

function TransactionEditorModal({ eyebrow, title, onClose, children }: {
  eyebrow: string; title: string; onClose: () => void; children: React.ReactNode;
}) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="agent-dialog transaction-dialog" role="dialog" aria-modal="true" aria-labelledby="transaction-dialog-title">
      <div className="dialog-heading"><div><p className="eyebrow">{eyebrow}</p>
        <h2 id="transaction-dialog-title">{title}</h2></div>
        <button type="button" className="dialog-close" aria-label="Close transaction editor" onClick={onClose}>×</button></div>
      {children}
    </section>
  </div>;
}

function TransactionComposer({ accounts, currencies, initialAccountId, initialTransaction = null,
  initialLineItemId = null, initialDateEditorOpen = false, runningBalanceUnits = null,
  knownBalanceAction = null, journalHeader = false,
  layout = "standard", token, onSaved, onCancel }: {
  accounts: Account[]; currencies: Currency[]; initialAccountId: number | null;
  initialTransaction?: TransactionDetail | null; initialLineItemId?: number | null;
  initialDateEditorOpen?: boolean; runningBalanceUnits?: string | null;
  knownBalanceAction?: React.ReactNode; journalHeader?: boolean;
  layout?: "standard" | "register" | "register-edit"; token: string;
  onSaved: () => Promise<void>; onCancel?: () => void;
}) {
  const accountMap = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const currencyMap = useMemo(() => new Map(currencies.map((currency) => [currency.id, currency])), [currencies]);
  const fullNames = useMemo(() => accountFullNames(accounts), [accounts]);
  const initialAccount = accounts.find((account) => account.id === initialAccountId);
  const isRegisterEdit = layout === "register-edit" && initialTransaction != null;
  const blankLine = (accountId = ""): EditableLine => ({ id: null, accountId, amount: "", value: "", memo: "",
    rateDecimal: "", rateDirection: "value-per-amount", rateChanges: "value", autoBalance: false });
  const [description, setDescription] = useState(initialTransaction?.description ?? "");
  const [date, setDate] = useState(initialTransaction?.date ?? today());
  const [transactionAt, setTransactionAt] = useState(initialTransaction?.transactionAt ?? "");
  const [valuationCurrencyId, setValuationCurrencyId] = useState<number | "">(
    initialTransaction?.valuationCurrencyId ?? initialAccount?.currencyId ?? "");
  const [lines, setLines] = useState<EditableLine[]>(() => {
    if (!initialTransaction) {
      const firstLine = blankLine(initialAccountId == null ? "" : String(initialAccountId));
      return layout === "register" ? [firstLine, { ...blankLine(), autoBalance: true }] : [firstLine];
    }
    const valuationScale = currencyMap.get(initialTransaction.valuationCurrencyId)?.scale ?? 2;
    const transactionLines = initialLineItemId == null || journalHeader ? initialTransaction.lineItems
      : [...initialTransaction.lineItems].sort((left, right) =>
        Number(right.id === initialLineItemId) - Number(left.id === initialLineItemId));
    const editableLines = transactionLines.map((line) => {
      const amount = unitsToDecimal(line.amountUnits, line.scale);
      let valueUnits = line.valueUnits;
      if (valueUnits == null && line.currencyId === initialTransaction.valuationCurrencyId) valueUnits = line.amountUnits;
      if (valueUnits == null) {
        const rate = initialTransaction.rates.find((candidate) => candidate.fromCurrencyId === line.currencyId
          && candidate.toCurrencyId === initialTransaction.valuationCurrencyId);
        if (rate && BigInt(rate.fromUnits) !== 0n) {
          valueUnits = signedRoundedQuotient(BigInt(line.amountUnits) * BigInt(rate.toUnits),
            BigInt(rate.fromUnits)).toString();
        }
      }
      const value = valueUnits == null ? "" : unitsToDecimal(valueUnits, valuationScale);
      const rateRecord = { amount_decimal: amount, value_decimal: value };
      const sourceRate = initialTransaction.rates.find((candidate) => candidate.fromCurrencyId === line.currencyId
        && candidate.toCurrencyId === initialTransaction.valuationCurrencyId);
      const sourceRateDecimal = sourceRate && line.currencyId !== initialTransaction.valuationCurrencyId
        ? decimalRatio(unitsToDecimal(sourceRate.toUnits, valuationScale),
          unitsToDecimal(sourceRate.fromUnits, line.scale)) : "";
      return { id: line.id, accountId: String(line.accountId), amount, value, memo: line.memo ?? "",
        rateDecimal: sourceRateDecimal || lineRate(rateRecord, "value-per-amount"),
        rateDirection: "value-per-amount" as const, rateChanges: "value" as const, autoBalance: false,
        rateSource: sourceRateDecimal ? "xrates" as const : "implied" as const };
    });
    return isRegisterEdit ? [...editableLines, { ...blankLine(), autoBalance: true }] : editableLines;
  });
  const [showValuationDetails, setShowValuationDetails] = useState(false);
  const [showDateEditor, setShowDateEditor] = useState(initialDateEditorOpen);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const initiallyUsedAccountIds = useMemo(() => new Set(initialTransaction?.lineItems.map((line) => line.accountId) ?? []),
    [initialTransaction]);
  const accountChoices = useMemo(() => accounts.filter((account) => !account.placeholder
    && (!account.archivedAt || initiallyUsedAccountIds.has(account.id)))
    .map((account) => ({ value: String(account.id), label: fullNames.get(account.id) ?? account.name,
      currencyCode: account.currencyCode })).sort((left, right) => left.label.localeCompare(right.label)),
  [accounts, fullNames, initiallyUsedAccountIds]);
  const resolvedValuationCurrencyId = Number(valuationCurrencyId);
  const valuationCurrency = currencyMap.get(resolvedValuationCurrencyId);

  function synchronizeLine(line: EditableLine, nextValuationCurrencyId = resolvedValuationCurrencyId) {
    const account = accountMap.get(Number(line.accountId));
    if (account?.currencyId === nextValuationCurrencyId) return { ...line, value: line.amount,
      rateDecimal: "1", rateSource: "implied" as const };
    if (line.rateSource === "xrates" || line.rateSource === "edited") return line;
    return { ...line, rateDecimal: line.rateDirection === "value-per-amount"
      ? decimalRatio(line.value, line.amount) : decimalRatio(line.amount, line.value),
      rateSource: "implied" as const };
  }

  function rebalanceLines(current: EditableLine[], nextValuationCurrencyId = resolvedValuationCurrencyId) {
    const balanceIndex = current.findIndex((line) => line.autoBalance);
    if (balanceIndex < 0) return current;
    const otherTotal = sumDecimals(current.filter((_, index) => index !== balanceIndex).map((line) => line.value));
    if (otherTotal == null) return current;
    const value = negateDecimal(otherTotal);
    const target = current[balanceIndex];
    const accountId = isRegisterEdit ? "" : target.accountId;
    const account = accountMap.get(Number(accountId));
    const rate = decimalParts(target.rateDecimal);
    let amount = account && account.currencyId !== nextValuationCurrencyId ? "" : value;
    if (account && account.currencyId !== nextValuationCurrencyId && rate && rate.units > 0n) {
      amount = target.rateDirection === "value-per-amount"
        ? decimalQuotientToScale(value, target.rateDecimal, account.scale) ?? target.amount
        : decimalProductToScale(value, target.rateDecimal, account.scale) ?? target.amount;
    }
    return current.map((line, index) => index === balanceIndex
      ? synchronizeLine({ ...line, accountId, amount: isRegisterEdit && value === "0" ? "" : amount,
        value: isRegisterEdit && value === "0" ? "" : value }, nextValuationCurrencyId) : line);
  }

  function updateLine(index: number, patch: Partial<EditableLine>) {
    const manualValue = Object.hasOwn(patch, "amount") || Object.hasOwn(patch, "value");
    setLines((current) => {
      const consumeBlank = isRegisterEdit && current[index]?.autoBalance
        && (Boolean(patch.accountId) || Object.hasOwn(patch, "memo") || manualValue);
      const chosenAccount = Object.hasOwn(patch, "accountId") ? accountMap.get(Number(patch.accountId)) : null;
      const needsNativeAmount = current[index]?.autoBalance && chosenAccount
        && chosenAccount.currencyId !== resolvedValuationCurrencyId;
      const updated = current.map((line, lineIndex) => lineIndex === index
        ? synchronizeLine({ ...line, ...patch, amount: needsNativeAmount ? "" : patch.amount ?? line.amount,
          rateSource: Object.hasOwn(patch, "accountId") && patch.accountId !== line.accountId
            ? "implied" : line.rateSource,
          autoBalance: consumeBlank || manualValue ? false : line.autoBalance }) : line);
      if (consumeBlank) updated.push({ ...blankLine(), autoBalance: true });
      return rebalanceLines(updated);
    });
  }

  function updateLineAmount(index: number, side: "debit" | "credit", value: string) {
    updateLine(index, { amount: signedAmountForSide(side, value) });
  }

  function registerMovementInput(line: EditableLine, index: number) {
    const lineAccount = accountMap.get(Number(line.accountId));
    const accountName = lineAccount?.name ?? "unassigned line";
    return <input className="amount-input" inputMode="decimal"
      aria-label={`Signed amount for ${accountName}, line ${index + 1}`}
      placeholder={lineAccount ? "± amount" : "Choose account first"}
      disabled={!lineAccount}
      value={lineAccount ? accountMovementInput(line.amount, lineAccount.type) : ""}
      onChange={(event) => updateLine(index, { amount: lineAccount
        ? postingAmountFromMovement(event.target.value, lineAccount.type) : event.target.value })} />;
  }

  function updateLineRate(index: number, rateDecimal: string) {
    setLines((current) => rebalanceLines(current.map((line, lineIndex) => {
      if (lineIndex !== index) return line;
      const account = accountMap.get(Number(line.accountId));
      if (line.rateChanges === "amount") {
        const amount = line.rateDirection === "value-per-amount"
          ? decimalQuotientToScale(line.value, rateDecimal, account?.scale ?? 2)
          : decimalProductToScale(line.value, rateDecimal, account?.scale ?? 2);
        return { ...line, rateDecimal, amount: amount ?? line.amount, rateSource: "edited" };
      }
      const value = line.rateDirection === "value-per-amount"
        ? decimalProductToScale(line.amount, rateDecimal, valuationCurrency?.scale ?? 2)
        : decimalQuotientToScale(line.amount, rateDecimal, valuationCurrency?.scale ?? 2);
      return { ...line, rateDecimal, value: value ?? line.value, rateSource: "edited" };
    })));
  }

  function invertLineRate(index: number) {
    setLines((current) => rebalanceLines(current.map((line, lineIndex) => {
      if (lineIndex !== index) return line;
      const rateDirection = oppositeRateDirection(line.rateDirection);
      return { ...line, rateDirection, rateDecimal: decimalRatio("1", line.rateDecimal) };
    })));
  }

  function addBalancingLine() {
    if (isRegisterEdit && lines.at(-1)?.autoBalance) return;
    setLines((current) => rebalanceLines([...current.map((line) => ({ ...line, autoBalance: false })),
      { ...blankLine(), autoBalance: true }]));
  }

  const activeLines = isRegisterEdit && lines.at(-1)?.autoBalance
    && !lines.at(-1)?.accountId && !lines.at(-1)?.amount && !lines.at(-1)?.value && !lines.at(-1)?.memo
    ? lines.slice(0, -1) : lines;
  const valueTotal = sumDecimals(activeLines.map((line) => line.value));
  const firstIncompleteLine = activeLines.findIndex((line) => !accountMap.has(Number(line.accountId))
    || !decimalParts(line.amount) || !decimalParts(line.value));
  const valueWithoutAmountLine = activeLines.findIndex((line) => {
    const account = accountMap.get(Number(line.accountId));
    const amount = decimalParts(line.amount);
    const value = decimalParts(line.value);
    return Boolean(account && account.currencyId !== resolvedValuationCurrencyId && amount && value
      && amount.units === 0n && value.units !== 0n);
  });
  const signMismatchLine = activeLines.findIndex((line) => {
    const amount = decimalParts(line.amount);
    const value = decimalParts(line.value);
    return Boolean(amount && value && amount.units !== 0n && value.units !== 0n
      && (amount.units < 0n) !== (value.units < 0n));
  });
  const invalidRateLine = activeLines.findIndex((line) => {
    const account = accountMap.get(Number(line.accountId));
    const amount = decimalParts(line.amount);
    const value = decimalParts(line.value);
    return Boolean(account && account.currencyId !== resolvedValuationCurrencyId
      && amount && value && amount.units !== 0n && value.units !== 0n
      && (!decimalParts(line.rateDecimal) || decimalParts(line.rateDecimal)!.units <= 0n));
  });
  const singleLineQuantityAdjustment = activeLines.length === 1 && (() => {
    const account = accountMap.get(Number(activeLines[0].accountId));
    const amount = decimalParts(activeLines[0].amount);
    const value = decimalParts(activeLines[0].value);
    return Boolean(account && account.currencyId !== resolvedValuationCurrencyId && amount && value
      && amount.units !== 0n && value.units === 0n);
  })();
  const hasEnoughLines = activeLines.length >= 2 || singleLineQuantityAdjustment;
  const balanced = valueTotal === "0";
  const unassignedBalancingLine = isRegisterEdit && lines.at(-1)?.autoBalance
    && Boolean(lines.at(-1)?.value) && !lines.at(-1)?.accountId;
  const canSubmit = Boolean(date && valuationCurrency && hasEnoughLines
    && firstIncompleteLine < 0 && valueWithoutAmountLine < 0 && signMismatchLine < 0
    && invalidRateLine < 0 && balanced);
  const liveStatus = !valuationCurrency ? "Choose the transaction value currency."
    : unassignedBalancingLine ? `Assign an account to the ${lines.at(-1)?.value} ${valuationCurrency.code} balancing line.`
    : firstIncompleteLine >= 0 ? `Complete the account, amount, and value for split ${firstIncompleteLine + 1}.`
    : !hasEnoughLines ? "Add a balancing split; only a zero-value quantity adjustment may contain one split."
    : valueWithoutAmountLine >= 0 ? `Split ${valueWithoutAmountLine + 1} cannot have value without an amount.`
    : signMismatchLine >= 0 ? `Amount and value must have the same debit or credit sign on split ${signMismatchLine + 1}.`
    : invalidRateLine >= 0 ? `Enter a positive exchange rate for split ${invalidRateLine + 1}.`
    : !balanced ? `Out of balance by ${valueTotal ?? "an invalid value"} ${valuationCurrency.code}.`
    : `Balanced in ${valuationCurrency.code} and ready to ${initialTransaction ? "save" : "post"}.`;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit || !valuationCurrency) { setError(liveStatus); return; }
    setBusy(true); setError("");
    try {
      const payloadLines = activeLines.map((line) => {
        const account = accountMap.get(Number(line.accountId));
        if (!account) throw new Error("Choose an account for every line.");
        return { id: line.id, accountId: account.id, amountUnits: decimalToUnits(line.amount, account.scale),
          valueUnits: decimalToUnits(line.value, valuationCurrency.scale), memo: line.memo, tags: [] };
      });
      const foreignCurrencyIds = new Set(activeLines.map((line) => accountMap.get(Number(line.accountId))?.currencyId)
        .filter((currencyId): currencyId is number => currencyId != null && currencyId !== resolvedValuationCurrencyId));
      const ratesByCurrency = new Map((initialTransaction?.rates ?? [])
        .filter((rate) => rate.toCurrencyId === resolvedValuationCurrencyId
          && foreignCurrencyIds.has(rate.fromCurrencyId))
        .map((rate) => [rate.fromCurrencyId, { fromCurrencyId: rate.fromCurrencyId,
          toCurrencyId: rate.toCurrencyId, fromUnits: rate.fromUnits, toUnits: rate.toUnits }]));
      for (const line of activeLines) {
        if (line.rateSource !== "edited") continue;
        const account = accountMap.get(Number(line.accountId));
        if (!account || account.currencyId === resolvedValuationCurrencyId) continue;
        const rate = storedRateFromDecimal(line.rateDecimal, line.rateDirection,
          account.scale, valuationCurrency.scale);
        if (rate) ratesByCurrency.set(account.currencyId, { fromCurrencyId: account.currencyId,
          toCurrencyId: resolvedValuationCurrencyId, ...rate });
      }
      await api(initialTransaction ? `/transactions/${initialTransaction.id}` : "/transactions",
        { method: initialTransaction ? "PATCH" : "POST", body: JSON.stringify({ description, transactionDate: date,
        transactionAt: transactionAt.trim() || null,
        valuationCurrencyId: resolvedValuationCurrencyId, lineItems: payloadLines,
        rates: [...ratesByCurrency.values()], post: true }) }, token);
      if (!initialTransaction) {
        setDescription(""); setDate(today()); setTransactionAt(""); setLines([
          blankLine(initialAccountId == null ? "" : String(initialAccountId)),
        ]);
      }
      setShowValuationDetails(false); await onSaved();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  function registerEditValueRow(line: EditableLine, index: number) {
    if (!showValuationDetails || (line.autoBalance && !line.amount && !line.value)) return null;
    const lineAccount = accountMap.get(Number(line.accountId));
    const isNative = Boolean(lineAccount && lineAccount.currencyId === resolvedValuationCurrencyId);
    const amount = decimalParts(line.amount);
    const value = decimalParts(line.value);
    const isZeroValueAdjustment = Boolean(!isNative && lineAccount && amount && value
      && amount.units !== 0n && value.units === 0n);
    const valueCurrencyCode = valuationCurrency?.code ?? "value currency";
    const amountCurrencyCode = lineAccount?.currencyCode ?? "account currency";
    const rateUnits = exchangeRateUnits(line.rateDirection, valueCurrencyCode, amountCurrencyCode);
    const inverseRateUnits = exchangeRateUnits(oppositeRateDirection(line.rateDirection),
      valueCurrencyCode, amountCurrencyCode);
    return <tr className="register-inline-value-row" key={`value-${line.id ?? index}`}><td /><td colSpan={6}>
      <div className="register-inline-value-controls">
        <label>Value in {valueCurrencyCode}<input inputMode="decimal" disabled={isNative || line.autoBalance}
          value={line.value} onChange={(event) => updateLine(index, { value: event.target.value })} /></label>
        <label>Exchange rate<span className="rate-input-group"><input inputMode="decimal"
          placeholder={isZeroValueAdjustment ? "Not applicable" : undefined}
          value={isNative ? "1" : isZeroValueAdjustment ? "" : line.rateDecimal}
          disabled={!lineAccount || isNative || isZeroValueAdjustment || line.autoBalance}
          onChange={(event) => updateLineRate(index, event.target.value)} />
          <button type="button" className="rate-invert" disabled={!lineAccount || isNative || isZeroValueAdjustment || line.autoBalance}
            aria-label={`Exchange rate shown as ${rateUnits}; click to show ${inverseRateUnits} for line ${index + 1}`}
            onClick={() => invertLineRate(index)}><ExchangeRateFraction direction={line.rateDirection}
              valueCurrencyCode={valueCurrencyCode} amountCurrencyCode={amountCurrencyCode} /></button></span>
          {!isNative && lineAccount && !line.autoBalance && <small>{line.rateSource === "xrates"
            ? "Stored transaction rate (Xrates)" : line.rateSource === "edited"
              ? "Edited transaction rate" : "Implied by this line's amount and value"}</small>}</label>
        {!isNative && !isZeroValueAdjustment && !line.autoBalance && <label>Changing rate updates<select value={line.rateChanges}
          onChange={(event) => setLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index
            ? { ...candidate, rateChanges: event.target.value as "amount" | "value" } : candidate))}>
          <option value="value">Value</option><option value="amount">Amount</option></select></label>}
      </div>
    </td></tr>;
  }

  if (isRegisterEdit) {
    const mainLine = lines[0];
    const currentAccountTotal = initialAccount ? sumDecimals(lines
      .filter((line) => !line.autoBalance && Number(line.accountId) === initialAccount.id)
      .map((line) => line.amount), { ignoreBlank: true }) : null;
    const totalParts = decimalParts(currentAccountTotal);
    return <>
      <tr className={`register-entry-row register-edit-transaction-row ${journalHeader ? "register-journal-header" : ""}`}>
        <td><button type="button" className="register-date-edit" aria-label={`Edit date for transaction ${initialTransaction.id}`}
          aria-expanded={showDateEditor} onClick={() => setShowDateEditor((current) => !current)}>
          {formatRegisterDate(date)} <span aria-hidden="true">✎</span></button></td>
        <td className="register-description"><textarea aria-label="Transaction description" value={description}
          onChange={(event) => setDescription(event.target.value)} rows={2} />
          {!journalHeader && <input className="register-main-memo" aria-label="Memo for selected account line"
            value={mainLine.memo} onChange={(event) => updateLine(0, { memo: event.target.value })}
            placeholder="Memo for this account line" />}
          <button type="button" className="register-values-toggle" aria-expanded={showValuationDetails}
            onClick={() => setShowValuationDetails((current) => !current)}>
            {showValuationDetails ? "Hide values & rates" : "Values & rates"}</button></td>
        <td>{journalHeader ? <span className="register-transaction-label">Transaction</span>
          : <strong>{initialAccount?.name ?? accountMap.get(Number(mainLine.accountId))?.name}</strong>}</td>
        <td className={`amount ${journalHeader && totalParts && initialAccount
          ? movementEffectClass(totalParts.units.toString(), initialAccount.type) : ""}`}>
          {journalHeader && initialAccount
            ? signedAccountMovementDecimal(currentAccountTotal, initialAccount)
            : registerMovementInput(mainLine, 0)}</td>
        <td />
        <td className="amount balance" title="Running balance before these edits; updates after save">
          {runningBalanceUnits != null && initialAccount
            ? unitsToDecimal(runningBalanceUnits, initialAccount.scale) : "—"}</td>
        <td className="amount known-balance">{date === initialTransaction.date ? knownBalanceAction : null}</td>
      </tr>
      {showDateEditor && <tr className="register-inline-date-row"><td colSpan={7}>
        <div className="register-inline-date-controls">
          <label>Ledger date<input type="date" required value={date}
            onChange={(event) => setDate(event.target.value)} /></label>
          <label>UTC date and time (optional)<input aria-label="Transaction UTC date and time"
            value={transactionAt} onChange={(event) => setTransactionAt(event.target.value)}
            placeholder="YYYY-MM-DDTHH:mm:ssZ" /></label>
          <button type="button" className="link-button" onClick={() => setShowDateEditor(false)}>Done</button>
        </div>
      </td></tr>}
      {!journalHeader && registerEditValueRow(mainLine, 0)}
      {(journalHeader ? lines : lines.slice(1)).map((line, offset) => {
        const index = journalHeader ? offset : offset + 1;
        const isSelectedAccountLine = journalHeader && line.id === initialLineItemId;
        const isThisAccount = Number(line.accountId) === initialAccountId;
        return <Fragment key={line.id ?? `new-${index}`}>
          <tr className={`register-inline-line ${journalHeader ? "register-journal-line" : ""} ${line.autoBalance ? "auto-balanced" : ""}`}>
            <td><span className="register-line-marker" aria-hidden="true">↳</span></td>
            <td><input aria-label={`Memo for line ${index + 1}`} value={line.memo}
              onChange={(event) => updateLine(index, { memo: event.target.value })}
              placeholder={line.autoBalance ? "New line or balancing line" : isSelectedAccountLine ? "Memo for this account line" : "Memo"} /></td>
            <td>{isSelectedAccountLine && initialAccount
              ? <span className="register-fixed-account">{fullNames.get(initialAccount.id) ?? initialAccount.name}</span>
              : <AccountCombobox label={`Account for line ${index + 1}`} value={line.accountId}
              choices={accountChoices} placeholder={line.autoBalance ? "Unassigned — choose account" : undefined}
              onChange={(accountId) => updateLine(index, { accountId })} />}
              {line.autoBalance && line.value && <small>Balancing value {line.value} {valuationCurrency?.code ?? ""}; choose an account to see its signed amount and save.</small>}</td>
            <td>{isThisAccount && registerMovementInput(line, index)}</td>
            <td>{!isThisAccount && registerMovementInput(line, index)}</td>
            <td />
            <td>{!line.autoBalance && !isSelectedAccountLine && <button type="button" className="quiet"
              aria-label={`Remove line ${index + 1}`}
              onClick={() => setLines((current) => rebalanceLines(current.filter((_, lineIndex) => lineIndex !== index)))}>×</button>}</td>
          </tr>
          {registerEditValueRow(line, index)}
        </Fragment>;
      })}
      <tr className="register-inline-actions-row"><td /><td colSpan={6}>
        <div className="register-inline-actions">
          <label className="register-inline-currency">Transaction value currency<select required value={valuationCurrencyId}
            onChange={(event) => {
              const nextId = event.target.value ? Number(event.target.value) : "";
              setValuationCurrencyId(nextId);
              setLines((current) => rebalanceLines(current.map((candidate) =>
                synchronizeLine({ ...candidate, rateSource: "implied" }, Number(nextId))), Number(nextId)));
            }}><option value="">Choose currency…</option>
            <CurrencyOptions currencies={currencies} accounts={accounts} /></select></label>
          <span className={`register-inline-status ${canSubmit ? "balanced" : "needs-attention"}`}>{liveStatus}</span>
          {error && <span className="register-inline-error">{error}</span>}
          <button type="button" className="link-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
            {busy ? "Saving…" : "Save changes"}</button>
        </div>
      </td></tr>
    </>;
  }

  if (layout === "register") {
    const currentAccountAmounts = lines.filter((line) => Number(line.accountId) === initialAccountId
      && line.amount.trim() !== "").map((line) => line.amount);
    const currentAccountTotal = currentAccountAmounts.length > 0 ? sumDecimals(currentAccountAmounts) : null;
    return <>
    <tr className="register-new-transaction-row">
      <td><input type="date" aria-label="New transaction date" value={date}
        onChange={(event) => setDate(event.target.value)} /></td>
      <td className="register-description"><input autoFocus aria-label="New transaction description" value={description}
        onChange={(event) => setDescription(event.target.value)} placeholder="Description" /></td>
      <td><span className="register-new-label">New transaction</span></td>
      <td className="amount">{initialAccount && currentAccountTotal
        ? signedAccountMovementDecimal(currentAccountTotal, initialAccount) : null}</td>
      <td /><td /><td />
    </tr>
    {lines.map((line, index) => {
      const lineAccount = accountMap.get(Number(line.accountId));
      const isThisAccount = Number(line.accountId) === initialAccountId;
      const isNative = Boolean(lineAccount && lineAccount.currencyId === resolvedValuationCurrencyId);
      const amount = decimalParts(line.amount);
      const value = decimalParts(line.value);
      const isZeroValueAdjustment = Boolean(!isNative && lineAccount && amount && value
        && amount.units !== 0n && value.units === 0n);
      const canChooseRateDirection = Boolean(lineAccount && !isNative && !isZeroValueAdjustment);
      const amountCurrencyCode = lineAccount?.currencyCode ?? "account currency";
      const valueCurrencyCode = valuationCurrency?.code ?? "value currency";
      const rateUnits = exchangeRateUnits(line.rateDirection, valueCurrencyCode, amountCurrencyCode);
      const inverseRateUnits = exchangeRateUnits(oppositeRateDirection(line.rateDirection),
        valueCurrencyCode, amountCurrencyCode);
      return <Fragment key={index}>
        <tr className={`register-inline-line ${line.autoBalance ? "auto-balanced" : ""}`}>
          <td><span className="register-line-marker" aria-hidden="true">↳</span></td>
          <td><input aria-label={`Memo for line ${index + 1}`} value={line.memo}
            onChange={(event) => updateLine(index, { memo: event.target.value })} placeholder="Memo" /></td>
          <td>{index === 0 && initialAccount
            ? <span className="register-fixed-account">{fullNames.get(initialAccount.id) ?? initialAccount.name}</span>
            : <AccountCombobox label={`Account for line ${index + 1}`} value={line.accountId}
                choices={accountChoices} onChange={(accountId) => updateLine(index, { accountId })} />}</td>
          <td>{isThisAccount && registerMovementInput(line, index)}</td>
          <td>{!isThisAccount && registerMovementInput(line, index)}</td>
          <td />
          <td><button type="button" className="quiet" aria-label={`Remove line ${index + 1}`}
            disabled={index === 0 || lines.length <= 1}
            onClick={() => setLines((current) => rebalanceLines(current.filter((_, lineIndex) => lineIndex !== index)))}>×</button></td>
        </tr>
        {showValuationDetails && <tr className="register-inline-value-row"><td /><td colSpan={6}>
          <div className="register-inline-value-controls">
            <label>Value in {valueCurrencyCode}<input inputMode="decimal" disabled={isNative} value={line.value}
              onChange={(event) => updateLine(index, { value: event.target.value })} /></label>
            <label>Exchange rate<span className="rate-input-group"><input inputMode="decimal"
              placeholder={isZeroValueAdjustment ? "Not applicable" : undefined}
              value={isNative ? "1" : isZeroValueAdjustment ? "" : line.rateDecimal}
              disabled={isNative || isZeroValueAdjustment}
              onChange={(event) => updateLineRate(index, event.target.value)} />
              <button type="button" className="rate-invert" disabled={!canChooseRateDirection}
                aria-label={canChooseRateDirection
                  ? `Exchange rate shown as ${rateUnits}; click to show ${inverseRateUnits} for line ${index + 1}`
                  : `Exchange rate units for line ${index + 1}: ${rateUnits}`}
                onClick={() => invertLineRate(index)}><ExchangeRateFraction direction={line.rateDirection}
                  valueCurrencyCode={valueCurrencyCode} amountCurrencyCode={amountCurrencyCode} /></button></span></label>
            {!isNative && !isZeroValueAdjustment && <label>Changing rate updates<select value={line.rateChanges}
              onChange={(event) => setLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index
                ? { ...candidate, rateChanges: event.target.value as "amount" | "value" } : candidate))}>
              <option value="value">Value</option><option value="amount">Amount</option></select></label>}
          </div>
        </td></tr>}
      </Fragment>;
    })}
    <tr className="register-inline-actions-row"><td /><td colSpan={6}>
      <div className="register-inline-actions">
        <button type="button" className="secondary" onClick={addBalancingLine}>＋ Add line</button>
        <label className="register-inline-currency">Value currency<select required value={valuationCurrencyId}
          onChange={(event) => {
            const nextId = event.target.value ? Number(event.target.value) : "";
            setValuationCurrencyId(nextId);
            setLines((current) => rebalanceLines(current.map((candidate) => synchronizeLine(candidate, Number(nextId))), Number(nextId)));
          }}><option value="">Choose currency…</option>
          <CurrencyOptions currencies={currencies} accounts={accounts} /></select></label>
        <label>UTC time (optional)<input aria-label="Transaction UTC time" value={transactionAt}
          onChange={(event) => setTransactionAt(event.target.value)} placeholder="YYYY-MM-DDTHH:mm:ssZ" /></label>
        <button type="button" className="link-button" aria-expanded={showValuationDetails}
          onClick={() => setShowValuationDetails((current) => !current)}>
          {showValuationDetails ? "Hide values & rates" : "Values & rates"}</button>
        <span className={`register-inline-status ${canSubmit ? "balanced" : "needs-attention"}`}>{liveStatus}</span>
        {error && <span className="register-inline-error">{error}</span>}
        <button type="button" className="link-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
          {busy ? "Validating…" : "Post transaction"}</button>
      </div>
    </td></tr>
  </>;
  }

  return <section className="composer">
    <form onSubmit={submit}>
      <div className="transaction-meta"><label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label>UTC time (optional)<input value={transactionAt} onChange={(event) => setTransactionAt(event.target.value)}
          placeholder="YYYY-MM-DDTHH:mm:ssZ" /></label>
        <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What happened?" /></label>
        <label>Value currency<select required value={valuationCurrencyId}
          onChange={(event) => {
            const nextId = event.target.value ? Number(event.target.value) : "";
            setValuationCurrencyId(nextId);
            setLines((current) => rebalanceLines(current.map((line) => synchronizeLine(line, Number(nextId))), Number(nextId)));
          }}>
          <option value="">Choose currency…</option>
          <CurrencyOptions currencies={currencies} accounts={accounts} /></select></label></div>
      <div className="transaction-editor-toolbar"><div><strong>Transaction splits</strong><small>Each row is one posting under this transaction.</small></div>
        <button type="button" className="secondary" aria-expanded={showValuationDetails}
          onClick={() => setShowValuationDetails((current) => !current)}>
          {showValuationDetails ? "Hide values & rates" : "Show values & rates"}</button></div>
      <div className="line-editor transaction-split-group"><div className="line-head"><span>Memo</span><span>Account</span><span>Debit</span><span>Credit</span><span /></div>
        {lines.map((line, index) => {
          const account = accountMap.get(Number(line.accountId));
          const isNative = Boolean(account && account.currencyId === resolvedValuationCurrencyId);
          const amount = decimalParts(line.amount);
          const value = decimalParts(line.value);
          const isZeroValueAdjustment = Boolean(!isNative && account && amount && value
            && amount.units !== 0n && value.units === 0n);
          const canChooseRateDirection = Boolean(account && !isNative && !isZeroValueAdjustment);
          const amountCurrencyCode = account?.currencyCode ?? "account currency";
          const valueCurrencyCode = valuationCurrency?.code ?? "value currency";
          const rateUnits = exchangeRateUnits(line.rateDirection, valueCurrencyCode, amountCurrencyCode);
          const inverseRateUnits = exchangeRateUnits(oppositeRateDirection(line.rateDirection),
            valueCurrencyCode, amountCurrencyCode);
          return <div className={`transaction-split ${line.autoBalance ? "auto-balanced" : ""}`} key={index}><div className="line-grid">
            <input value={line.memo} onChange={(event) => updateLine(index, { memo: event.target.value })} placeholder="Memo" />
            <AccountCombobox label={`Account for split ${index + 1}`} value={line.accountId}
              choices={accountChoices} onChange={(accountId) => updateLine(index, { accountId })} />
            <input inputMode="decimal" aria-label={`Debit for line ${index + 1}`} value={amountForSide(line.amount, "debit")}
              onChange={(event) => updateLineAmount(index, "debit", event.target.value)} />
            <input inputMode="decimal" aria-label={`Credit for line ${index + 1}`} value={amountForSide(line.amount, "credit")}
              onChange={(event) => updateLineAmount(index, "credit", event.target.value)} />
            <button type="button" className="quiet" aria-label={`Remove split ${index + 1}`} disabled={lines.length <= 1}
              onClick={() => setLines((current) => rebalanceLines(current.filter((_, lineIndex) => lineIndex !== index)))}>×</button>
          </div>
          {showValuationDetails && <div className="line-value-rate"><label>Value in {valuationCurrency?.code ?? "value currency"}
            <input inputMode="decimal" disabled={isNative} value={line.value}
              onChange={(event) => updateLine(index, { value: event.target.value })} /></label>
            <label>Exchange rate<span className="rate-input-group"><input inputMode="decimal"
              placeholder={isZeroValueAdjustment ? "Not applicable" : undefined}
              value={isNative ? "1" : isZeroValueAdjustment ? "" : line.rateDecimal}
              disabled={isNative || isZeroValueAdjustment} onChange={(event) => updateLineRate(index, event.target.value)} />
              <button type="button" className="rate-invert"
                disabled={!canChooseRateDirection}
                aria-label={canChooseRateDirection
                  ? `Exchange rate shown as ${rateUnits}; click to show ${inverseRateUnits} for line ${index + 1}`
                  : `Exchange rate units for line ${index + 1}: ${rateUnits}`}
                title={canChooseRateDirection ? `Show ${inverseRateUnits}` : undefined}
                onClick={() => invertLineRate(index)}><ExchangeRateFraction direction={line.rateDirection}
                  valueCurrencyCode={valueCurrencyCode} amountCurrencyCode={amountCurrencyCode} /></button></span>
              <small>{isZeroValueAdjustment
                ? "No exchange rate — zero-value quantity adjustment."
                : !account ? "Choose an account to set the rate units."
                : isNative ? `No conversion — amount and value are both ${valueCurrencyCode}.`
                : `Click the unit fraction to show ${inverseRateUnits}.`}</small>
              {!isNative && !isZeroValueAdjustment && <span className="rate-update-choice">Changing rate updates<select value={line.rateChanges}
                onChange={(event) => setLines((current) => current.map((candidate, candidateIndex) => candidateIndex === index
                  ? { ...candidate, rateChanges: event.target.value as "amount" | "value" } : candidate))}>
                <option value="value">value</option><option value="amount">amount</option></select></span>}</label></div>}
          </div>;
        })}
        <button type="button" className="add-split-row" onClick={addBalancingLine}><span>＋</span>
          Add another split <small>The balancing debit or credit will be entered automatically</small></button>
      </div>
      <p className={`transaction-live-status ${canSubmit ? "balanced" : "needs-attention"}`}>{liveStatus}</p>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !canSubmit}>{busy ? "Validating…"
        : initialTransaction ? "Save transaction" : "Validate and post"}</button>
    </form>
  </section>;
}

function MisfitEditor({ exception, accounts, currencies, token, importJobId, onSaved, onCancel }: {
  exception: TransactionImportException; accounts: Account[]; currencies: Currency[]; token: string;
  importJobId: string; onSaved: () => Promise<void>; onCancel: () => void;
}) {
  const fullNames = useMemo(() => accountFullNames(accounts), [accounts]);
  const initialAccountByFullName = useMemo(() => new Map(accounts.map((account) =>
    [fullNames.get(account.id) ?? account.name, account])), [accounts, fullNames]);
  const [records, setRecords] = useState<EditableImportRecord[]>(() => {
    const prepared = exception.canonical_records.map((record, index) => {
      const normalized = {
        ...record,
        transaction_external_id: String(record.transaction_external_id ?? exception.source_identity.transaction_external_id),
        line_external_id: record.line_external_id == null ? null : String(record.line_external_id),
        transaction_date: String(record.transaction_date ?? today()),
        transaction_at: record.transaction_at == null ? null : String(record.transaction_at),
        description: record.description == null ? null : String(record.description),
        valuation_currency_code: String(record.valuation_currency_code ?? "USD"),
        fee_account_full_name: record.fee_account_full_name == null ? null : String(record.fee_account_full_name),
        account_full_name: String(record.account_full_name ?? ""),
        amount_decimal: record.amount_decimal == null ? "" : String(record.amount_decimal),
        value_decimal: record.value_decimal == null ? null : String(record.value_decimal),
        memo: record.memo == null ? null : String(record.memo),
      };
      const account = initialAccountByFullName.get(normalized.account_full_name);
      if (account?.currencyCode === normalized.valuation_currency_code) normalized.value_decimal = normalized.amount_decimal;
      return { ...normalized, editorKey: `${normalized.line_external_id ?? "line"}-${index}`,
        rateDirection: "value-per-amount" as const,
        rateDecimal: lineRate(normalized, "value-per-amount"), rateChanges: "value" as const,
        autoBalance: false };
    });
    return prepared;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showValuationDetails, setShowValuationDetails] = useState(false);
  const postableAccounts = useMemo(() => accounts.filter((account) => !account.archivedAt && !account.placeholder)
    .map((account) => ({ account, fullName: fullNames.get(account.id) ?? account.name }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName)), [accounts, fullNames]);
  const accountByFullName = useMemo(() => new Map(postableAccounts.map(({ account, fullName }) => [fullName, account])),
    [postableAccounts]);
  const accountChoices = useMemo(() => postableAccounts.map(({ account, fullName }) => ({
    value: fullName, label: fullName, currencyCode: account.currencyCode,
  })), [postableAccounts]);
  const first = records[0];

  function synchronizeRate(record: EditableImportRecord) {
    const account = accountByFullName.get(record.account_full_name);
    if (account?.currencyCode === record.valuation_currency_code) {
      return { ...record, value_decimal: record.amount_decimal, rateDecimal: "1" };
    }
    return { ...record, rateDecimal: lineRate(record, record.rateDirection) };
  }

  function rebalanceRecords(current: EditableImportRecord[]) {
    const balanceIndex = current.findIndex((record) => record.autoBalance);
    if (balanceIndex < 0) return current;
    const otherTotal = sumDecimals(current.filter((_, index) => index !== balanceIndex)
      .map((record) => record.value_decimal));
    if (otherTotal == null) return current;
    const value = negateDecimal(otherTotal);
    const target = current[balanceIndex];
    const account = accountByFullName.get(target.account_full_name);
    const rate = decimalParts(target.rateDecimal);
    let amount = value;
    if (account && account.currencyCode !== target.valuation_currency_code && rate && rate.units > 0n) {
      amount = target.rateDirection === "value-per-amount"
        ? decimalQuotientToScale(value, target.rateDecimal, account.scale) ?? target.amount_decimal
        : decimalProductToScale(value, target.rateDecimal, account.scale) ?? target.amount_decimal;
    }
    return current.map((record, index) => index === balanceIndex
      ? synchronizeRate({ ...record, amount_decimal: amount, value_decimal: value }) : record);
  }

  function updateTransaction(patch: Partial<Pick<CanonicalImportRecord,
    "transaction_date" | "transaction_at" | "description" | "valuation_currency_code" | "fee_account_full_name">>) {
    setRecords((current) => rebalanceRecords(current.map((record) => synchronizeRate({ ...record, ...patch }))));
  }

  function updateLine(index: number, patch: Partial<CanonicalImportRecord>) {
    const changesValue = Object.hasOwn(patch, "amount_decimal") || Object.hasOwn(patch, "value_decimal");
    setRecords((current) => rebalanceRecords(current.map((record, recordIndex) => recordIndex === index
      ? synchronizeRate({ ...record, ...patch, autoBalance: changesValue ? false : record.autoBalance }) : record)));
  }

  function updateLineAmount(index: number, side: "debit" | "credit", value: string) {
    setRecords((current) => rebalanceRecords(current.map((record, recordIndex) => {
      if (recordIndex !== index) return record;
      const amount = signedAmountForSide(side, value);
      const account = accountByFullName.get(record.account_full_name);
      const next = { ...record, amount_decimal: amount, autoBalance: false };
      if (account?.currencyCode === record.valuation_currency_code) next.value_decimal = amount;
      return synchronizeRate(next);
    })));
  }

  function updateLineValue(index: number, value: string) {
    setRecords((current) => rebalanceRecords(current.map((record, recordIndex) => recordIndex === index
      ? synchronizeRate({ ...record, value_decimal: value, autoBalance: false }) : record)));
  }

  function updateLineRate(index: number, rateDecimal: string) {
    setRecords((current) => rebalanceRecords(current.map((record, recordIndex) => {
      if (recordIndex !== index) return record;
      const valuationCurrency = currencies.find((currency) => currency.code === record.valuation_currency_code);
      const account = accountByFullName.get(record.account_full_name);
      if (record.rateChanges === "amount") {
        const calculatedAmount = record.rateDirection === "value-per-amount"
          ? decimalQuotientToScale(record.value_decimal ?? "", rateDecimal, account?.scale ?? 2)
          : decimalProductToScale(record.value_decimal ?? "", rateDecimal, account?.scale ?? 2);
        return { ...record, rateDecimal, amount_decimal: calculatedAmount ?? record.amount_decimal };
      }
      const calculatedValue = record.rateDirection === "value-per-amount"
        ? decimalProductToScale(record.amount_decimal, rateDecimal, valuationCurrency?.scale ?? 2)
        : decimalQuotientToScale(record.amount_decimal, rateDecimal, valuationCurrency?.scale ?? 2);
      return { ...record, rateDecimal, value_decimal: calculatedValue ?? record.value_decimal };
    })));
  }

  function invertLineRate(index: number) {
    setRecords((current) => rebalanceRecords(current.map((record, recordIndex) => {
      if (recordIndex !== index) return record;
      const rateDirection = oppositeRateDirection(record.rateDirection);
      return { ...record, rateDirection, rateDecimal: lineRate(record, rateDirection) };
    })));
  }

  function addSplit() {
    setRecords((current) => {
      const hasForeignLine = current.some((record) => {
        const account = accountByFullName.get(record.account_full_name);
        return account && account.currencyCode !== record.valuation_currency_code;
      });
      const currentTotal = hasForeignLine ? null
        : sumDecimals(current.map((record) => record.value_decimal), { ignoreBlank: true });
      const balancing = currentTotal == null ? "" : negateDecimal(currentTotal);
      return rebalanceRecords([...current.map((record) => ({ ...record, autoBalance: false })), {
      transaction_external_id: exception.source_identity.transaction_external_id,
      line_external_id: null,
      transaction_date: current[0]?.transaction_date ?? today(),
      transaction_at: current[0]?.transaction_at ?? null,
      description: current[0]?.description ?? null,
      valuation_currency_code: current[0]?.valuation_currency_code ?? "USD",
      fee_account_full_name: current[0]?.fee_account_full_name ?? null,
      account_full_name: "",
      amount_decimal: balancing,
      value_decimal: balancing,
      memo: null,
      editorKey: `new-${crypto.randomUUID()}`,
      rateDirection: "value-per-amount",
      rateDecimal: "",
      rateChanges: "value",
      autoBalance: !hasForeignLine,
    }]);
    });
  }

  const valueTotal = sumDecimals(records.map((record) => record.value_decimal));
  const hasForeignLine = records.some((record) => {
    const account = accountByFullName.get(record.account_full_name);
    return account && account.currencyCode !== record.valuation_currency_code;
  });
  const incompleteLine = records.findIndex((record) => {
    const account = accountByFullName.get(record.account_full_name);
    return !account || !decimalParts(record.amount_decimal)
      || (account.currencyCode === record.valuation_currency_code && !decimalParts(record.value_decimal));
  });
  const valueWithoutAmountLine = records.findIndex((record) => {
    const account = accountByFullName.get(record.account_full_name);
    const amount = decimalParts(record.amount_decimal);
    const value = decimalParts(record.value_decimal);
    return Boolean(account && account.currencyCode !== first?.valuation_currency_code && amount && value
      && amount.units === 0n && value.units !== 0n);
  });
  const signMismatchLine = records.findIndex((record) => {
    const amount = decimalParts(record.amount_decimal);
    const value = decimalParts(record.value_decimal);
    return Boolean(amount && value && amount.units !== 0n && value.units !== 0n
      && (amount.units < 0n) !== (value.units < 0n));
  });
  const invalidRateLine = records.findIndex((record) => {
    const account = accountByFullName.get(record.account_full_name);
    const amount = decimalParts(record.amount_decimal);
    const value = decimalParts(record.value_decimal);
    return Boolean(!hasForeignLine && account && account.currencyCode !== first?.valuation_currency_code
      && amount && value && amount.units !== 0n && value.units !== 0n
      && (!decimalParts(record.rateDecimal) || decimalParts(record.rateDecimal)!.units <= 0n));
  });
  const isQuantityAdjustment = (record: EditableImportRecord) => {
    const account = accountByFullName.get(record.account_full_name);
    const amount = decimalParts(record.amount_decimal);
    const value = decimalParts(record.value_decimal);
    return Boolean(account && account.currencyCode !== first?.valuation_currency_code && amount && value
      && amount.units !== 0n && value.units === 0n);
  };
  const singleLineQuantityAdjustment = records.length === 1 && isQuantityAdjustment(records[0]);
  const hasEnoughLines = records.length >= 2 || singleLineQuantityAdjustment;
  const removableIncompleteLine = records.length === 2 && incompleteLine >= 0
    && isQuantityAdjustment(records[incompleteLine === 0 ? 1 : 0]);
  const balanced = hasForeignLine || valueTotal === "0";
  const canSave = Boolean(first?.transaction_date && first?.valuation_currency_code && hasEnoughLines
    && incompleteLine < 0 && (hasForeignLine || valueWithoutAmountLine < 0)
    && (hasForeignLine || signMismatchLine < 0)
    && invalidRateLine < 0 && balanced);
  const liveStatus = removableIncompleteLine
    ? `Remove split ${incompleteLine + 1}; this zero-value quantity adjustment is valid with one split.`
    : incompleteLine >= 0 ? `Complete the account, amount, and value for split ${incompleteLine + 1}.`
    : !hasEnoughLines ? "Add a balancing split; only a zero-value quantity adjustment may contain one split."
    : valueWithoutAmountLine >= 0 && !hasForeignLine ? `Split ${valueWithoutAmountLine + 1} cannot have value without an amount.`
    : signMismatchLine >= 0 && !hasForeignLine ? `Amount and value must have the same debit or credit sign on split ${signMismatchLine + 1}.`
    : invalidRateLine >= 0 ? `Enter a positive exchange rate for split ${invalidRateLine + 1}.`
    : !balanced ? `Out of balance by ${valueTotal ?? "an invalid value"} ${first?.valuation_currency_code ?? ""}.`
    : hasForeignLine ? "Ready for Accounting to value foreign amounts from reference rates and check the transaction."
      : `Balanced in ${first?.valuation_currency_code ?? "the value currency"} and ready to revalidate.`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) { setError(liveStatus); return; }
    setBusy(true); setError("");
    try {
      const corrected = records.map((record) => {
        const { editorKey: _editorKey, rateDecimal: _rateDecimal, rateDirection: _rateDirection,
          rateChanges: _rateChanges, autoBalance: _autoBalance, ...canonical } = record;
        return {
          ...canonical,
          description: canonical.description?.trim() || null,
          memo: canonical.memo?.trim() || null,
          line_external_id: canonical.line_external_id?.trim() || null,
          account_full_name: canonical.account_full_name.trim(),
          amount_decimal: canonical.amount_decimal.trim(),
          value_decimal: canonical.value_decimal == null || canonical.value_decimal.trim() === ""
            ? null : canonical.value_decimal.trim(),
        };
      });
      await api(`/transaction-import-jobs/${importJobId}/exceptions/${encodeURIComponent(exception.source_identity.transaction_external_id)}/retry`, {
        method: "POST",
        body: JSON.stringify({ retryId: crypto.randomUUID(), records: corrected }),
      }, token);
      await onSaved(); onCancel();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  if (!first) return null;
  return <form className="misfit-editor" onSubmit={submit}>
    <div className="misfit-meta">
      <label>Date<input type="date" required value={first.transaction_date}
        onChange={(event) => updateTransaction({ transaction_date: event.target.value })} /></label>
      <label>UTC time (optional)<input value={first.transaction_at ?? ""}
        onChange={(event) => updateTransaction({ transaction_at: event.target.value || null })}
        placeholder="YYYY-MM-DDTHH:mm:ssZ" /></label>
      <label>Description<input value={first.description ?? ""}
        onChange={(event) => updateTransaction({ description: event.target.value })} /></label>
      <label>Value currency<select required value={first.valuation_currency_code}
        onChange={(event) => updateTransaction({ valuation_currency_code: event.target.value })}>
        <CurrencyOptions currencies={currencies} accounts={accounts} valueBy="code" />
      </select></label>
      <label>Fee account (if applicable)<input value={first.fee_account_full_name ?? ""}
        onChange={(event) => updateTransaction({ fee_account_full_name: event.target.value || null })}
        placeholder="Expenses:Conversion Fees" /></label>
    </div>
    <div className="transaction-editor-toolbar"><div><strong>Transaction splits</strong>
      <small>Each indented row is one posting under this transaction.</small></div>
      <button type="button" className="secondary" aria-expanded={showValuationDetails}
        onClick={() => setShowValuationDetails((current) => !current)}>
        {showValuationDetails ? "Hide values & rates" : "Show values & rates"}</button></div>
    {showValuationDetails && <p className="transaction-editor-rule">Amount + value determine each line’s rate. A nonzero amount with zero value is a quantity-only adjustment and has no rate. When changing a rate, choose whether its amount or value should be recalculated.</p>}
    <div className="misfit-lines transaction-split-group">
      <div className="misfit-line-head"><span>Memo</span><span>Account</span><span>Debit</span><span>Credit</span><span /></div>
      {records.map((record, index) => {
        const selectedAccount = accountByFullName.get(record.account_full_name);
        const amountCurrencyCode = selectedAccount?.currencyCode ?? "account currency";
        const isNative = selectedAccount?.currencyCode === first.valuation_currency_code;
        const amount = decimalParts(record.amount_decimal);
        const value = decimalParts(record.value_decimal);
        const isZeroValueAdjustment = Boolean(!isNative && selectedAccount && amount && value
          && amount.units !== 0n && value.units === 0n);
        const canChooseRateDirection = Boolean(selectedAccount && !isNative && !isZeroValueAdjustment);
        const rateIsInvalid = !isZeroValueAdjustment && record.rateDecimal.trim() !== ""
          && (!decimalParts(record.rateDecimal) || decimalParts(record.rateDecimal)!.units <= 0n);
        const hasDifferentRate = !isNative && !isZeroValueAdjustment && Boolean(selectedAccount)
          && records.some((candidate, candidateIndex) =>
          candidateIndex !== index
          && accountByFullName.get(candidate.account_full_name)?.currencyCode === selectedAccount?.currencyCode
          && !sameLineRate(record, candidate));
        const rateUnits = exchangeRateUnits(record.rateDirection, first.valuation_currency_code, amountCurrencyCode);
        const inverseRateUnits = exchangeRateUnits(oppositeRateDirection(record.rateDirection),
          first.valuation_currency_code, amountCurrencyCode);
        return <div className={`misfit-line-wrapper ${record.autoBalance ? "auto-balanced" : ""}`} key={record.editorKey}>
          <div className="misfit-line">
            <input value={record.memo ?? ""} onChange={(event) => updateLine(index, { memo: event.target.value })} placeholder="Memo" />
            <AccountCombobox label={`Account for imported split ${index + 1}`} value={record.account_full_name}
              choices={accountChoices} onChange={(accountFullName) => updateLine(index, { account_full_name: accountFullName })} />
            <input inputMode="decimal" aria-label={`Debit for imported line ${index + 1}`}
              value={amountForSide(record.amount_decimal, "debit")}
              onChange={(event) => updateLineAmount(index, "debit", event.target.value)} />
            <input inputMode="decimal" aria-label={`Credit for imported line ${index + 1}`}
              value={amountForSide(record.amount_decimal, "credit")}
              onChange={(event) => updateLineAmount(index, "credit", event.target.value)} />
            <button type="button" className="quiet" aria-label="Remove split" disabled={records.length === 1}
              onClick={() => setRecords((current) => rebalanceRecords(current.filter((_, recordIndex) => recordIndex !== index)))}>×</button>
          </div>
          {showValuationDetails && <div className={`line-value-rate ${hasDifferentRate ? "different-rate" : ""}`}>
            <label>Value in {first.valuation_currency_code}
              <input inputMode="decimal" disabled={isNative} value={record.value_decimal ?? ""}
                onChange={(event) => updateLineValue(index, event.target.value)} />
            </label>
            <label>Exchange rate
              <span className="rate-input-group"><input inputMode="decimal"
                disabled={isNative || isZeroValueAdjustment}
                placeholder={isZeroValueAdjustment ? "Not applicable" : undefined}
                aria-invalid={rateIsInvalid || undefined}
                value={isNative ? "1" : isZeroValueAdjustment ? "" : record.rateDecimal}
                onChange={(event) => updateLineRate(index, event.target.value)} />
                <button type="button" className="rate-invert"
                  disabled={!canChooseRateDirection}
                  aria-label={canChooseRateDirection
                    ? `Exchange rate shown as ${rateUnits}; click to show ${inverseRateUnits} for line ${index + 1}`
                    : `Exchange rate units for line ${index + 1}: ${rateUnits}`}
                  title={canChooseRateDirection ? `Show ${inverseRateUnits}` : undefined}
                  onClick={() => invertLineRate(index)}><ExchangeRateFraction direction={record.rateDirection}
                    valueCurrencyCode={first.valuation_currency_code} amountCurrencyCode={amountCurrencyCode} /></button></span>
              <small>{isZeroValueAdjustment
                ? "No exchange rate — zero-value quantity adjustment."
                : !selectedAccount ? "Choose an account to set the rate units."
                : isNative ? `No conversion — amount and value are both ${first.valuation_currency_code}.`
                : `Click the unit fraction to show ${inverseRateUnits}.`}</small>
              {!isNative && !isZeroValueAdjustment && <span className="rate-update-choice">Changing rate updates
                <select aria-label={`Exchange-rate update target for line ${index + 1}`} value={record.rateChanges}
                  onChange={(event) => setRecords((current) => current.map((candidate, candidateIndex) => candidateIndex === index
                    ? { ...candidate, rateChanges: event.target.value as "amount" | "value" } : candidate))}>
                  <option value="value">value</option><option value="amount">amount</option>
                </select>
              </span>}
            </label>
            {hasDifferentRate && <p className="rate-note">This line uses a different {selectedAccount?.currencyCode} rate.</p>}
            {rateIsInvalid && <p>Enter a positive exchange rate.</p>}
          </div>}
        </div>;
      })}
      <button type="button" className="add-split-row" onClick={addSplit}><span>＋</span>
        Add another split <small>The balancing debit or credit will be entered automatically</small></button>
    </div>
    <p className={`transaction-live-status ${canSave ? "balanced" : "needs-attention"}`}>{liveStatus}</p>
    <div className="misfit-editor-actions">
      <button type="button" className="link-button" onClick={onCancel}>Cancel</button>
      <button className="primary" disabled={busy || !canSave}>{busy ? "Checking…" : "Save correction"}</button>
    </div>
    {error && <p className="error">{error}</p>}
  </form>;
}

function ImportRestartDialog({ job, token, onClose, onRestarted }: {
  job: TransactionImportJob; token: string; onClose: () => void; onRestarted: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<ImportRestartPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<ImportRestartPreview>(`/transaction-import-jobs/${job.import_job_id}/restart-preview`, {
      method: "POST", body: "{}",
    }, token).then(setPreview).catch((nextError) => setError(errorMessage(nextError))).finally(() => setBusy(false));
  }, [job.import_job_id, token]);

  async function restart() {
    if (!preview || confirmation !== "RESTART IMPORT") return;
    setBusy(true); setError("");
    try {
      await api(`/transaction-import-jobs/${job.import_job_id}/restart-commit`, {
        method: "POST", body: JSON.stringify({
          restartPlanId: preview.restartPlanId, previewDigest: preview.previewDigest,
        }),
      }, token);
      await onRestarted(); onClose();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  return <TransactionEditorModal eyebrow="Import data"
    title={`Restart ${job.source_file.name ?? job.source_system}`} onClose={onClose}>
    {busy && !preview && <p className="muted">Preparing an exact restart preview…</p>}
    {preview && <>
      <p className="deletion-explanation">This removes the import job and only the ledger transactions it created. Transactions this import reused are preserved, as are all accounts and currencies.</p>
      <div className="deletion-summary">
        <div><span>Import records</span><strong>{preview.summary.importItemCount}</strong></div>
        <div><span>Created transactions removed</span><strong>{preview.summary.createdTransactionCount}</strong></div>
        <div><span>Reused transactions preserved</span><strong>{preview.summary.preservedReusedTransactionCount}</strong></div>
        <div><span>Line items removed</span><strong>{preview.summary.lineItemCount}</strong></div>
      </div>
      <label>Type <code>RESTART IMPORT</code> to confirm
        <input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </label>
      <div className="destructive-actions"><button type="button" className="link-button" onClick={onClose}>Cancel</button>
        <button type="button" className="danger-button" disabled={busy || confirmation !== "RESTART IMPORT"}
          onClick={() => void restart()}>{busy ? "Restarting…" : "Remove this import and start over"}</button></div>
    </>}
    {error && <p className="error">{error}</p>}
  </TransactionEditorModal>;
}

function ImportMisfits({ jobs, accounts, currencies, token, onChanged }: {
  jobs: TransactionImportJob[]; accounts: Account[]; currencies: Currency[]; token: string;
  onChanged: () => Promise<void>;
}) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [job, setJob] = useState<TransactionImportJob | null>(null);
  const [exceptions, setExceptions] = useState<TransactionImportException[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [editingExternalId, setEditingExternalId] = useState<string | null>(null);
  const [filter, setFilter] = useState("unresolved");
  const [preview, setPreview] = useState<TransactionImportJob | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [busy, setBusy] = useState<"load" | "preview" | "commit" | "exclude" | "">("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (selectedJobId && jobs.some((candidate) => candidate.import_job_id === selectedJobId)) return;
    setSelectedJobId(jobs.find((candidate) => candidate.progress.transaction_totals.exceptions > 0)?.import_job_id
      ?? jobs[0]?.import_job_id ?? null);
  }, [jobs, selectedJobId]);

  async function load(append = false) {
    if (!selectedJobId) { setJob(null); setExceptions([]); setNextCursor(null); return; }
    setBusy("load"); setError("");
    try {
      if (!append) {
        setJob(null); setExceptions([]); setNextCursor(null);
        const jobResult = await api<{ job: TransactionImportJob }>(`/transaction-import-jobs/${selectedJobId}`, {}, token);
        setJob(jobResult.job);
      }
      const cursor = append ? nextCursor : null;
      const suffix = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
      const page: { job: { exceptions: TransactionImportException[]; next_cursor: string | null } } =
        await api(`/transaction-import-jobs/${selectedJobId}/exceptions${suffix}`, {}, token);
      setExceptions((current) => append ? [...current, ...page.job.exceptions] : page.job.exceptions);
      setNextCursor(page.job.next_cursor);
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(""); }
  }

  useEffect(() => { void load(); }, [selectedJobId]);

  async function changed() {
    setPreview(null);
    await onChanged();
    await load();
  }

  async function exclude(exception: TransactionImportException) {
    const reason = window.prompt("Why should this source transaction remain outside the ledger?");
    if (!reason?.trim() || !selectedJobId) return;
    setBusy("exclude"); setError("");
    try {
      await api(`/transaction-import-jobs/${selectedJobId}/exceptions/${encodeURIComponent(exception.source_identity.transaction_external_id)}/exclude`, {
        method: "POST",
        body: JSON.stringify({ exclusionId: crypto.randomUUID(), reason: reason.trim() }),
      }, token);
      await changed();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(""); }
  }

  async function preparePreview() {
    if (!selectedJobId) return;
    setBusy("preview"); setError("");
    try {
      const result = await api<{ job: TransactionImportJob }>(`/transaction-import-jobs/${selectedJobId}/preview`, {
        method: "POST", body: "{}",
      }, token);
      setPreview(result.job); setJob(result.job);
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(""); }
  }

  async function commitPreview() {
    if (!selectedJobId || !preview?.preview_digest || !preview.ready_to_commit) return;
    const pending = preview.progress.transaction_totals.pending_commit;
    if (!window.confirm(`Add ${pending} imported transaction${pending === 1 ? "" : "s"} to the ledger now? Transactions already in the ledger will not be duplicated.`)) return;
    setBusy("commit"); setError("");
    try {
      await api(`/transaction-import-jobs/${selectedJobId}/commit`, {
        method: "POST", body: JSON.stringify({ previewDigest: preview.preview_digest }),
      }, token);
      setPreview(null); await changed();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(""); }
  }

  const errorCodes = [...new Set(exceptions.flatMap((exception) => exception.error_codes))].sort();
  const visible = exceptions.filter((exception) => filter === "all"
    || filter === exception.resolution.status || exception.error_codes.includes(filter));
  const editingException = exceptions.find((exception) =>
    exception.source_identity.transaction_external_id === editingExternalId) ?? null;

  return <section className="misfits-page card">
    <div className="section-heading misfits-heading"><div><p className="eyebrow">Import holding area</p>
      <h2>Import misfits</h2><p>Imported transactions that need correction. Fix them here, then add them to the ledger.</p></div>
      {jobs.length > 0 && <div className="misfit-heading-actions">
        {jobs.length > 1 && <select aria-label="Import job" value={selectedJobId ?? ""}
          onChange={(event) => { setSelectedJobId(event.target.value); setPreview(null); }}>
          {jobs.map((candidate) => <option key={candidate.import_job_id} value={candidate.import_job_id}>
            {candidate.source_file.name ?? candidate.source_system} · {candidate.progress.transaction_totals.unresolved_exceptions} unresolved
          </option>)}
        </select>}
        {job && <button type="button" className="danger-link" disabled={Boolean(busy)}
          onClick={() => setRestartOpen(true)}>Restart this import</button>}
      </div>}
    </div>
    {!jobs.length && <p className="misfits-empty">No transaction import jobs yet.</p>}
    {error && <p className="error">{error}</p>}
    {busy === "load" && !job && <p className="misfits-empty">Loading import job…</p>}
    {job && <>
      <div className="misfit-job-summary">
        <div><span>Source</span><strong>{job.source_file.name ?? job.source_system}</strong><small>{job.source_system}</small></div>
        <div><span>Ready for ledger</span><strong>{job.progress.transaction_totals.pending_commit}</strong><small>{job.progress.pending_commit_records} source records</small></div>
        <div><span>In ledger</span><strong>{job.progress.transaction_totals.previously_committed}</strong><small>{job.progress.previously_committed_records} source records</small></div>
        <div><span>Unresolved</span><strong>{job.progress.transaction_totals.unresolved_exceptions}</strong><small>{job.progress.exception_record_totals.unresolved} source records</small></div>
        <div><span>Excluded</span><strong>{job.progress.transaction_totals.excluded}</strong><small>{job.progress.exception_record_totals.excluded} source records</small></div>
      </div>
      <p className="reconciliation-equation">{job.progress.equation}</p>
      <div className="misfit-commit-panel">
        <div><strong>{job.progress.transaction_totals.pending_commit > 0 ? "Source data received" : "No ledger additions ready"}</strong>
          <span>All source data is in Accounting. {job.progress.transaction_totals.pending_commit} transactions are ready for the ledger; {job.progress.transaction_totals.exceptions} are here for correction.</span></div>
        {!preview && job.progress.transaction_totals.pending_commit > 0 ? <button className="secondary" disabled={Boolean(busy) || job.job_status === "committed"}
          onClick={() => void preparePreview()}>{busy === "preview" ? "Preparing…" : "Review ledger addition"}</button>
          : preview?.ready_to_commit ? <button className="primary" disabled={Boolean(busy)} onClick={() => void commitPreview()}>
            {busy === "commit" ? "Adding…" : `Add ${preview.progress.transaction_totals.pending_commit} to ledger`}
          </button> : null}
      </div>
      {preview && <div className="preview-notice"><strong>{preview.ready_to_commit ? "Ready to add." : "Needs correction."}</strong><span>{preview.ready_to_commit ? preview.commit_scope : "Correct unresolved Import misfits before adding transactions to the ledger."}</span></div>}
      <div className="misfit-filters">
        {[{ value: "unresolved", label: "Unresolved" }, { value: "excluded", label: "Excluded" },
          { value: "all", label: "All" }, ...errorCodes.map((code) => ({ value: code, label: code.replaceAll("_", " ") }))]
          .map((option) => <button key={option.value} className={filter === option.value ? "active" : ""}
            onClick={() => setFilter(option.value)}>{option.label}</button>)}
      </div>
      {busy === "load" && <p className="misfits-empty">Loading import exceptions…</p>}
      <div className="misfit-list">{visible.map((exception) => {
        const externalId = exception.source_identity.transaction_external_id;
        return <article className={`misfit-card ${exception.resolution.status}`} key={externalId}>
          <div className="misfit-card-heading"><div><div className="misfit-code-list">
            {exception.error_codes.map((code) => <span key={code}>{code.replaceAll("_", " ")}</span>)}
            {exception.resolution.status === "excluded" && <span className="excluded-label">EXCLUDED</span>}
          </div><h3>{exception.transaction_context.description || "Undescribed transaction"}</h3>
            <p>{exception.transaction_context.transactionDate} · {exception.transaction_context.valuationCurrencyCode} · {exception.canonical_records.length} canonical line{exception.canonical_records.length === 1 ? "" : "s"}</p></div>
            <code title={externalId}>{externalId}</code></div>
          {exception.errors.map((entry) => <p className="misfit-error-message" key={`${entry.code}-${entry.message}`}>
            <strong>{entry.code}</strong> {entry.message}
            {entry.details != null && <code>{JSON.stringify(entry.details)}</code>}
          </p>)}
          {exception.resolution.status === "excluded" && <p className="exclusion-reason">
            Excluded: {exception.resolution.reason} {exception.resolution.resolved_at && <small>· {new Date(exception.resolution.resolved_at).toLocaleString()}</small>}
          </p>}
          <div className="misfit-source-lines">{exception.canonical_records.map((record, index) => <div key={index}>
            <span>{record.account_full_name}</span><strong>{record.amount_decimal}</strong>
            <small>{record.memo || "No memo"}{record.value_decimal != null && ` · value ${record.value_decimal}`}</small>
          </div>)}</div>
          <details className="misfit-source-identity"><summary>Complete source identity</summary>
            <dl><dt>Source system</dt><dd>{exception.source_identity.source_system}</dd>
              <dt>Source file</dt><dd>{exception.source_identity.source_file.name ?? "Unnamed source"}</dd>
              <dt>File SHA-256</dt><dd><code>{exception.source_identity.source_file.sha256}</code></dd>
              <dt>Transaction ID</dt><dd><code>{externalId}</code></dd>
              <dt>Line IDs</dt><dd>{exception.source_identity.line_external_ids.map((id) => id ?? "(none)").join(", ")}</dd></dl>
          </details>
          <div className="misfit-actions"><button className="secondary" onClick={() => setEditingExternalId(externalId)}>
              {exception.resolution.status === "excluded" ? "Reopen and correct" : "Fix transaction"}</button>
              {exception.resolution.status === "unresolved" && <button className="danger-link" disabled={Boolean(busy)}
                onClick={() => void exclude(exception)}>Exclude with reason</button>}</div>
        </article>;
      })}
        {!visible.length && busy !== "load" && <p className="misfits-empty">No exceptions match this view.</p>}
      </div>
      {nextCursor && <button type="button" className="secondary" disabled={Boolean(busy)}
        onClick={() => void load(true)}>{busy === "load" ? "Loading…" : "Load 100 more"}</button>}
    </>}
    {job && editingException && <TransactionEditorModal eyebrow="Import correction"
      title={editingException.transaction_context.description || "Edit transaction"}
      onClose={() => setEditingExternalId(null)}>
      <MisfitEditor key={editingException.source_identity.transaction_external_id}
        exception={editingException} accounts={accounts} currencies={currencies} token={token}
        importJobId={job.import_job_id} onSaved={changed} onCancel={() => setEditingExternalId(null)} />
    </TransactionEditorModal>}
    {job && restartOpen && <ImportRestartDialog job={job} token={token} onClose={() => setRestartOpen(false)}
      onRestarted={async () => {
        setPreview(null); setJob(null); setExceptions([]); setNextCursor(null); setEditingExternalId(null);
        setSelectedJobId(null); await onChanged();
      }} />}
  </section>;
}

function Ledger({ transactions, selected, onSelect, onOpenInRegister, onVerify, onDelete, verification }: {
  transactions: TransactionSummary[]; selected: TransactionDetail | null; onSelect: (id: number) => void;
  onOpenInRegister: (transaction: TransactionDetail) => void; onVerify: () => void;
  onDelete: (id: number) => void; verification: string;
}) {
  return <section className="ledger card"><div className="section-heading"><div><p className="eyebrow">Activity</p><h2>Ledger</h2></div>
    <button className="secondary" onClick={onVerify}>Verify ledger</button></div>{verification && <p className="verification">{verification}</p>}
    <div className="ledger-layout"><div className="transaction-list">{transactions.map((transaction) => <button key={transaction.id}
      className={`transaction-row ${selected?.id === transaction.id ? "selected" : ""}`} onClick={() => onSelect(transaction.id)}>
      <span>{transaction.date}</span><strong>{transaction.description || "Untitled transaction"}</strong><small>{transaction.lineItemCount} lines · {transaction.state}</small>
    </button>)}</div>
      <div className="transaction-detail">{selected ? <><div className="detail-title"><div><h3>{selected.description || "Untitled transaction"}</h3><p>{selected.date} · {selected.state}</p>
        {selected.transactionAt && <p>Source time (UTC): {selected.transactionAt}</p>}</div>
      <div className="detail-actions"><span>#{selected.id}</span><button type="button" className="secondary"
        onClick={() => onOpenInRegister(selected)}>Open in register</button><button type="button" className="danger-link"
          onClick={() => onDelete(selected.id)}>Delete transaction</button></div></div>
      {selected.lineItems.map((line) => <div className="detail-line" key={line.id}><div><strong>{line.accountName}</strong><small>{line.memo}</small>
        {line.tags.length > 0 && <div className="tag-list">{line.tags.map((tag) => <span key={`${tag.key}:${tag.value}`}>{tag.key}:{tag.value}</span>)}</div>}</div>
        <b>{unitsToDecimal(line.amountUnits, line.scale)} {line.currencyCode}</b></div>)}</> : <p className="empty-state">Select a transaction to see its complete balanced entry.</p>}</div></div>
  </section>;
}

type AccountRegisterRow =
  | { kind: "entry"; date: string; order: number; entry: AccountLedgerEntry;
      totalAmountUnits: string; currentAccountLineCount: number }
  | { kind: "assertion"; date: string; order: number; assertion: BalanceAssertion };

function formatRegisterDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(match[2]) - 1];
  return month ? `${match[3]} ${month} ${match[1]}` : value;
}

function AccountRegister({ account, accounts, currencies, entries, assertions, loading, error, token, onShowAll,
  onImportStatement, openTransaction, onOpenTransactionHandled, onTransactionCreated, onChanged }: {
  account: Account; accounts: Account[]; currencies: Currency[]; entries: AccountLedgerEntry[];
  assertions: BalanceAssertion[]; loading: boolean; error: string; token: string;
  onShowAll: () => void; onImportStatement: () => void;
  openTransaction: { transactionId: number; lineItemId: number } | null;
  onOpenTransactionHandled: () => void;
  onTransactionCreated: () => Promise<void>; onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<"basic" | "auto-split" | "journal">("basic");
  const [sortOrder, setSortOrder] = useState<"recent" | "oldest">("recent");
  const [showNewTransaction, setShowNewTransaction] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<TransactionDetail | null>(null);
  const [selectedLineItemId, setSelectedLineItemId] = useState<number | null>(null);
  const [dateEditorOpen, setDateEditorOpen] = useState(false);
  const [selectingTransactionId, setSelectingTransactionId] = useState<number | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const selectionRequest = useRef(0);
  const [knownBalanceFormMode, setKnownBalanceFormMode] = useState<"row" | "manual" | null>(null);
  const [knownBalanceDate, setKnownBalanceDate] = useState(today());
  const [knownBalance, setKnownBalance] = useState("");
  const [knownBalanceError, setKnownBalanceError] = useState("");
  const [knownBalanceBusy, setKnownBalanceBusy] = useState(false);
  const [showAccountEditor, setShowAccountEditor] = useState(false);
  const accountById = useMemo(() => new Map(accounts.map((candidate) => [candidate.id, candidate])), [accounts]);
  const accountAssertions = useMemo(() => assertions.filter((assertion) => assertion.accountId === account.id), [account.id, assertions]);
  const assertionDates = useMemo(() => new Set(accountAssertions.map((assertion) => assertion.date)), [accountAssertions]);
  const lastEntryByDate = useMemo(() => {
    const lastEntries = new Map<string, number>();
    for (const entry of entries) lastEntries.set(entry.date, entry.lineItemId);
    return lastEntries;
  }, [entries]);
  const registerRows = useMemo<AccountRegisterRow[]>(() => {
    const groupedEntries = new Map<number, Extract<AccountRegisterRow, { kind: "entry" }>>();
    entries.forEach((entry, order) => {
      const previous = groupedEntries.get(entry.transactionId);
      const amountUnits = BigInt(entry.debitUnits ?? (entry.creditUnits == null ? "0" : `-${entry.creditUnits}`));
      groupedEntries.set(entry.transactionId, { kind: "entry", date: entry.date, order, entry,
        totalAmountUnits: (BigInt(previous?.totalAmountUnits ?? "0") + amountUnits).toString(),
        currentAccountLineCount: (previous?.currentAccountLineCount ?? 0) + 1 });
    });
    return [
      ...groupedEntries.values(),
      ...accountAssertions.map((assertion) => ({ kind: "assertion" as const,
        date: assertion.date, order: assertion.id, assertion })),
    ].sort((left, right) => {
      const chronologicalOrder = left.date.localeCompare(right.date)
        || (left.kind === right.kind ? left.order - right.order : left.kind === "entry" ? -1 : 1);
      return sortOrder === "recent" ? -chronologicalOrder : chronologicalOrder;
    });
  }, [accountAssertions, entries, sortOrder]);

  useEffect(() => {
    selectionRequest.current += 1;
    setSelectedTransaction(null); setSelectedLineItemId(null); setSelectingTransactionId(null); setSelectionError("");
    setKnownBalanceFormMode(null); setKnownBalanceDate(today());
    setKnownBalance(""); setKnownBalanceError(""); setShowNewTransaction(false);
    setShowAccountEditor(false);
  }, [account.id]);

  useEffect(() => {
    if (!openTransaction || loading) return;
    const entry = entries.find((candidate) => candidate.transactionId === openTransaction.transactionId
      && candidate.lineItemId === openTransaction.lineItemId);
    if (!entry) return;
    onOpenTransactionHandled();
    void activateTransaction(entry);
  }, [openTransaction, loading, entries]);

  const newTransactionRows = showNewTransaction && <TransactionComposer key={`new-${account.id}`}
    accounts={accounts} currencies={currencies} initialAccountId={account.id} layout="register" token={token}
    onCancel={() => setShowNewTransaction(false)} onSaved={async () => {
      await onTransactionCreated(); setShowNewTransaction(false);
    }} />;

  async function activateTransaction(entry: AccountLedgerEntry, openDateEditor = false) {
    if (selectedTransaction?.id === entry.transactionId) {
      if (selectedLineItemId === entry.lineItemId && openDateEditor) setDateEditorOpen(true);
      return;
    }
    if (selectedTransaction) {
      setSelectionError("Save or cancel the selected transaction before opening another one.");
      return;
    }
    const request = ++selectionRequest.current;
    setSelectingTransactionId(entry.transactionId); setSelectionError("");
    try {
      const result = await api<{ transaction: TransactionDetail }>(`/transactions/${entry.transactionId}`, {}, token);
      if (request !== selectionRequest.current) return;
      setSelectedTransaction(result.transaction); setSelectedLineItemId(entry.lineItemId);
      setDateEditorOpen(openDateEditor);
    } catch (nextError) {
      if (request === selectionRequest.current) setSelectionError(errorMessage(nextError));
    } finally {
      if (request === selectionRequest.current) setSelectingTransactionId(null);
    }
  }

  function closeSelectedTransaction() {
    selectionRequest.current += 1;
    setSelectedTransaction(null); setSelectedLineItemId(null); setSelectingTransactionId(null);
    setDateEditorOpen(false); setSelectionError("");
  }

  function changeRegisterView(nextView: "basic" | "auto-split" | "journal") {
    if (view === nextView) return;
    if (selectedTransaction) {
      setSelectionError("Save or cancel the selected transaction before changing register views.");
      return;
    }
    setView(nextView);
  }

  function editKnownBalance(assertion: BalanceAssertion) {
    setKnownBalanceDate(assertion.date);
    setKnownBalance(unitsToDecimal(assertion.knownBalanceUnits, assertion.scale));
    setKnownBalanceError(""); setKnownBalanceFormMode("row");
  }

  function addKnownBalance(date: string) {
    setKnownBalanceDate(date);
    setKnownBalance("");
    setKnownBalanceError(""); setKnownBalanceFormMode("row");
  }

  function addKnownBalanceForAnotherDate() {
    setKnownBalanceDate(today());
    setKnownBalance("");
    setKnownBalanceError(""); setKnownBalanceFormMode("manual");
  }

  async function saveKnownBalance(event: FormEvent) {
    event.preventDefault(); setKnownBalanceBusy(true); setKnownBalanceError("");
    try {
      await api("/balance-assertions", { method: "POST", body: JSON.stringify({
        accountId: account.id,
        balanceDate: knownBalanceDate,
        knownBalanceUnits: decimalToUnits(knownBalance, account.scale),
      }) }, token);
      await onChanged(); setKnownBalanceFormMode(null); setKnownBalance("");
    } catch (nextError) { setKnownBalanceError(errorMessage(nextError)); }
    finally { setKnownBalanceBusy(false); }
  }

  const knownBalanceForm = knownBalanceFormMode && <form id="known-balance-form" className="known-balance-form" onSubmit={saveKnownBalance}>
    <label>End of date<input type="date" required readOnly={knownBalanceFormMode === "row"} value={knownBalanceDate}
      onChange={(event) => setKnownBalanceDate(event.target.value)} /></label>
    <label>Known ending balance ({account.currencyCode})<input required placeholder="Known balance" value={knownBalance}
      onChange={(event) => setKnownBalance(event.target.value)} /></label>
    <div className="known-balance-form-actions"><button className="secondary" disabled={knownBalanceBusy}>
      {knownBalanceBusy ? "Saving…" : "Save balance"}</button>
      <button type="button" className="link-button" onClick={() => setKnownBalanceFormMode(null)}>Cancel</button></div>
    {knownBalanceError && <p className="error">{knownBalanceError}</p>}
  </form>;

  return <><section className="account-register card">
    <div className="section-heading"><div><p className="eyebrow">Account register</p>
      <div className="register-account-name"><h2>{account.name}</h2>
        <button type="button" className="register-account-edit-button" aria-label={`Edit account ${account.name}`}
          title="Edit account" onClick={() => setShowAccountEditor(true)}>✎</button></div>
      <p className="register-subtitle">Posted transactions · {account.currencyCode}</p></div>
      <div className="register-heading-actions">
        <div className="register-current-balance">
          <span>Current balance</span>
          <strong>{unitsToDecimal(account.balanceUnits, account.scale)} {account.currencyCode}</strong>
        </div>
        <button className="secondary" onClick={onImportStatement}>Import statement</button>
        <button className="secondary" onClick={onShowAll}>All activity</button>
      </div></div>
    {!account.placeholder && !account.archivedAt && <div className="register-known-balance-actions">
      <button type="button" className="link-button" onClick={addKnownBalanceForAnotherDate}>
        Add known balance for another date</button>
    </div>}
    {knownBalanceFormMode === "manual" && knownBalanceForm}
    <div className="register-view-controls" role="group" aria-label="Register view">
      <button className={view === "basic" ? "active" : ""} aria-pressed={view === "basic"}
        onClick={() => changeRegisterView("basic")}>Basic Ledger</button>
      <button className={view === "auto-split" ? "active" : ""} aria-pressed={view === "auto-split"}
        onClick={() => changeRegisterView("auto-split")}>Auto-Split Ledger</button>
      <button className={view === "journal" ? "active" : ""} aria-pressed={view === "journal"}
        onClick={() => changeRegisterView("journal")}>Transaction Journal</button>
      <button className="register-sort-control"
        title={sortOrder === "recent" ? "Show oldest transactions first" : "Show recent transactions first"}
        onClick={() => setSortOrder((current) => current === "recent" ? "oldest" : "recent")}>
        {sortOrder === "recent" ? "Recent first ↓" : "Oldest first ↑"}</button>
    </div>
    {error && <p className="error">{error}</p>}
    {selectionError && <p className="error">{selectionError}</p>}
    {loading ? <p className="register-message" aria-live="polite">Loading account transactions…</p>
      : !error && registerRows.length === 0 && !showNewTransaction
      ? <p className="register-message">No posted transactions or known balances in this account.</p>
      : !error && <div className="register-table-wrap"><table className="register-table">
        <thead><tr><th>Date</th><th>Description</th><th>Account</th>
          <th>This account</th><th>Other accounts</th><th>Running balance</th>
          <th>Known balance</th></tr></thead>
        <tbody>{sortOrder === "recent" && newTransactionRows}{registerRows.map((row) => {
          if (row.kind === "assertion") {
            const { assertion } = row;
            return <Fragment key={`assertion-${assertion.id}`}><tr className={`register-assertion-row ${assertion.matches ? "matches" : "mismatch"}`}>
              <td>{formatRegisterDate(assertion.date)}</td>
              <td><strong>Known balance</strong><small>{assertion.matches
                ? "Matches the ledger"
                : `Difference ${unitsToDecimal(assertion.differenceUnits, assertion.scale)} ${assertion.currencyCode}`}</small></td>
              <td>—</td><td></td><td></td>
              <td className="amount balance">{unitsToDecimal(assertion.calculatedBalanceUnits, assertion.scale)}</td>
              <td className="amount known-balance"><button type="button" className="known-balance-edit"
                aria-label={`Edit known balance for ${assertion.date}`} onClick={() => editKnownBalance(assertion)}>
                {unitsToDecimal(assertion.knownBalanceUnits, assertion.scale)} <span aria-hidden="true">✎</span></button></td>
            </tr>
              {knownBalanceFormMode === "row" && knownBalanceDate === assertion.date
                && <tr className="register-known-balance-form-row"><td colSpan={7}>{knownBalanceForm}</td></tr>}
            </Fragment>;
          }
          const { entry } = row;
          const counterpartNames = [...new Map(entry.splits
            .filter((split) => split.accountId !== account.id)
            .map((split) => [split.accountId, split.accountName])).values()];
          const counterpartLabel = counterpartNames.length === 0 ? "—"
            : counterpartNames.length === 1 ? counterpartNames[0] : "Split";
          const expanded = view !== "basic";
          const isEndOfDateEntry = lastEntryByDate.get(entry.date) === entry.lineItemId;
          const showAddKnownBalance = isEndOfDateEntry && !assertionDates.has(entry.date)
            && !account.placeholder && !account.archivedAt;
          const knownBalanceAction = showAddKnownBalance && <button type="button"
            className="known-balance-add" aria-label={`Add known balance for ${entry.date}`}
            aria-expanded={knownBalanceFormMode === "row" && knownBalanceDate === entry.date}
            aria-controls="known-balance-form" title={`Add known balance for ${formatRegisterDate(entry.date)}`}
            onClick={(event) => { event.stopPropagation(); addKnownBalance(entry.date); }}
            onKeyDown={(event) => event.stopPropagation()}>+</button>;
          const rowBalanceForm = showAddKnownBalance && knownBalanceFormMode === "row" && knownBalanceDate === entry.date
            && <tr className="register-known-balance-form-row"><td colSpan={7}>{knownBalanceForm}</td></tr>;
          if (selectedTransaction?.id === entry.transactionId) {
            return <Fragment key={entry.lineItemId}>
              {sortOrder === "recent" && rowBalanceForm}
              <TransactionComposer key={`${entry.transactionId}:${entry.lineItemId}`}
                accounts={accounts} currencies={currencies} initialAccountId={account.id}
                initialLineItemId={selectedLineItemId ?? entry.lineItemId}
                initialTransaction={selectedTransaction}
                journalHeader={view === "journal" || row.currentAccountLineCount > 1}
                initialDateEditorOpen={dateEditorOpen} runningBalanceUnits={entry.runningBalanceUnits}
                knownBalanceAction={knownBalanceAction} layout="register-edit" token={token}
                onCancel={closeSelectedTransaction} onSaved={async () => {
                  await onTransactionCreated(); closeSelectedTransaction();
                }} />
              {sortOrder === "oldest" && rowBalanceForm}
            </Fragment>;
          }
          return <Fragment key={entry.lineItemId}>
            {sortOrder === "recent" && rowBalanceForm}
            <tr className={`register-entry-row selectable ${expanded ? "expanded" : ""} ${view === "journal" ? "register-journal-header" : ""}`}
              tabIndex={0}
              onClick={() => void activateTransaction(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault(); void activateTransaction(entry);
                }
              }}>
              <td><button type="button" className="register-date-edit"
                aria-label={`Edit date for transaction ${entry.transactionId}`}
                onClick={(event) => { event.stopPropagation(); void activateTransaction(entry, true); }}
                onKeyDown={(event) => event.stopPropagation()}>{formatRegisterDate(entry.date)}</button></td>
              <td className="register-description"><strong title={entry.description || "Untitled transaction"}>
                {entry.description || "Untitled transaction"}</strong>
                {selectingTransactionId === entry.transactionId && <small>Opening transaction…</small>}</td>
              <td>{view === "journal" ? <span className="register-transaction-label">Transaction</span>
                : <strong>{account.name}</strong>}</td>
              <td className={`amount ${movementEffectClass(row.totalAmountUnits, account.type)}`}>
                {signedAccountMovement(row.totalAmountUnits, account)}</td>
              <td className={view === "basic" ? "register-other-account-summary" : undefined}>
                {view === "basic" ? counterpartLabel : null}</td>
              <td className="amount balance">{unitsToDecimal(entry.runningBalanceUnits, account.scale)}</td>
              <td className="amount known-balance">{knownBalanceAction}</td>
            </tr>
            {view !== "basic" && entry.splits
              .filter((split) => view === "journal" || split.accountId !== account.id)
              .map((split) => {
                const splitAccount = accountById.get(split.accountId);
                const isThisAccount = split.accountId === account.id;
                return <tr className="register-line-item-row selectable" key={split.lineItemId} tabIndex={0}
                  onClick={() => void activateTransaction(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault(); void activateTransaction(entry);
                    }
                  }}>
                  <td></td><td>{split.memo && <small>{split.memo}</small>}</td>
                  <td><strong>{split.accountName}</strong></td>
                  <td className={`amount ${splitAccount && isThisAccount
                    ? movementEffectClass(split.amountUnits, splitAccount.type) : ""}`}>
                    {isThisAccount && splitAccount && signedAccountMovement(split.amountUnits, splitAccount)}</td>
                  <td className={`amount ${splitAccount && !isThisAccount
                    ? movementEffectClass(split.amountUnits, splitAccount.type) : ""}`}>
                    {!isThisAccount && splitAccount && signedAccountMovement(split.amountUnits, splitAccount)}</td>
                  <td></td><td></td>
                </tr>;
              })}
            {sortOrder === "oldest" && rowBalanceForm}
          </Fragment>;
        })}{sortOrder === "oldest" && newTransactionRows}</tbody>
      </table></div>}
    {!showNewTransaction && !loading && !error && !account.placeholder && !account.archivedAt
      && <div className="register-actions"><button className="primary"
      onClick={() => setShowNewTransaction(true)}>＋ New transaction</button></div>}
  </section>
    {showAccountEditor && <AccountEditDialog key={account.id} account={account} accounts={accounts} currencies={currencies}
      token={token} onClose={() => setShowAccountEditor(false)} onChanged={onChanged} />}
  </>;
}

function displayDate(value: string | null) {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function TransactionDeletionDialog({ scope, transactionIds, deleteAccounts, deleteImportHistory,
  token, onClose, onDeleted }: {
  scope: "all" | "selected"; transactionIds: number[]; deleteAccounts: boolean;
  deleteImportHistory: boolean; token: string;
  onClose: () => void; onDeleted: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<TransactionDeletionPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<TransactionDeletionPreview>("/data/transactions/delete-preview", {
      method: "POST", body: JSON.stringify({ scope,
        transactionIds: scope === "selected" ? transactionIds : [], deleteAccounts, deleteImportHistory }),
    }, token).then(setPreview).catch((nextError) => setError(errorMessage(nextError))).finally(() => setBusy(false));
  }, [scope, token, transactionIds, deleteAccounts, deleteImportHistory]);

  function requiredConfirmation(candidate: TransactionDeletionPreview) {
    const parts = [`${candidate.summary.transactionCount} ${candidate.summary.transactionCount === 1 ? "TRANSACTION" : "TRANSACTIONS"}`];
    if (candidate.summary.deleteAccounts) parts.push(`${candidate.summary.accountCount} ACCOUNTS`);
    if (candidate.summary.deleteImportHistory) parts.push(`${candidate.summary.importJobCount} IMPORT JOBS`);
    return `DELETE ${parts.join(" AND ")}`;
  }

  async function commit() {
    if (!preview) return;
    const required = requiredConfirmation(preview);
    if (confirmation !== required) return;
    setBusy(true); setError("");
    try {
      await api("/data/transactions/delete-commit", { method: "POST", body: JSON.stringify({
        deletionPlanId: preview.deletionPlanId, previewDigest: preview.previewDigest,
      }) }, token);
      await onDeleted(); onClose();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  const required = preview ? requiredConfirmation(preview) : "";
  return <TransactionEditorModal eyebrow="Danger zone"
    title={scope === "all" ? deleteAccounts && deleteImportHistory ? "Clear ledger, accounts, and imports"
      : deleteAccounts ? "Clear ledger and accounts"
      : deleteImportHistory ? "Clear ledger and import history" : "Clear ledger transactions"
      : "Delete transaction"} onClose={onClose}>
    {busy && !preview && <p className="muted">Preparing an exact deletion preview…</p>}
    {preview && <>
      <div className="deletion-summary">
        <div><span>Transactions</span><strong>{preview.summary.transactionCount}</strong></div>
        <div><span>Line items</span><strong>{preview.summary.lineItemCount}</strong></div>
        <div><span>Tags</span><strong>{preview.summary.tagAssignmentCount}</strong></div>
        {preview.summary.deleteAccounts
          ? <div><span>Accounts</span><strong>{preview.summary.accountCount}</strong></div>
          : <div><span>Legacy rates</span><strong>{preview.summary.exchangeRateCount}</strong></div>}
        {preview.summary.deleteImportHistory
          && <div><span>Import jobs</span><strong>{preview.summary.importJobCount}</strong></div>}
      </div>
      <p className="deletion-explanation">
        {preview.summary.deleteAccounts
          ? `The complete chart of accounts and ${preview.summary.balanceAssertionCount} known-balance records will also be removed. `
          : "Accounts are preserved. "}
        {preview.summary.deleteImportHistory
          ? `${preview.summary.importItemCount} imported transaction records and their import receipts will be removed, so they will not become misfits. `
          : "Import history is preserved and affected references are safely reopened or marked deleted. "}
        Currencies and your login remain.
      </p>
      <label>Type <code>{required}</code> to confirm
        <input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </label>
      <div className="destructive-actions"><button type="button" className="link-button" onClick={onClose}>Cancel</button>
        <button type="button" className="danger-button" disabled={busy || confirmation !== required}
          onClick={() => void commit()}>{busy ? "Deleting…" : "Permanently delete"}</button></div>
    </>}
    {error && <p className="error">{error}</p>}
  </TransactionEditorModal>;
}

function AccountDataDialog({ user, token, onClearLedger, onDeleted, onClose }: {
  user: User; token: string;
  onClearLedger: (deleteAccounts: boolean, deleteImportHistory: boolean) => void;
  onDeleted: () => void; onClose: () => void;
}) {
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [deleteAccounts, setDeleteAccounts] = useState(false);
  const [deleteImportHistory, setDeleteImportHistory] = useState(false);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<UserDeletionPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"preview" | "delete" | "">("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ summary: DataSummary }>("/data/summary", {}, token)
      .then((result) => setSummary(result.summary))
      .catch((nextError) => setError(errorMessage(nextError)));
  }, [token]);

  async function previewDeletion(event: FormEvent) {
    event.preventDefault(); setBusy("preview"); setError("");
    try {
      setPreview(await api<UserDeletionPreview>("/data/user/delete-preview", {
        method: "POST", body: JSON.stringify({ currentPassword: password }),
      }, token));
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(""); }
  }

  async function deleteUser() {
    if (!preview || confirmation !== preview.confirmationText) return;
    setBusy("delete"); setError("");
    try {
      await api("/data/user/delete-commit", { method: "POST", body: JSON.stringify({
        deletionPlanId: preview.deletionPlanId,
        previewDigest: preview.previewDigest,
        currentPassword: password,
        confirmationText: confirmation,
      }) }, token);
      onDeleted();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(""); }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}><section className="agent-dialog account-data-dialog" role="dialog" aria-modal="true" aria-labelledby="account-data-title">
    <div className="dialog-heading"><div><p className="eyebrow">Settings</p><h2 id="account-data-title">Account &amp; data</h2></div>
      <button type="button" className="dialog-close" aria-label="Close account and data settings" onClick={onClose}>×</button></div>
    <section className="settings-section"><h3>Ledger data</h3>
      <p>{summary ? `${summary.transactionCount} transactions · ${summary.accountCount} accounts · ${summary.importJobCount} import jobs`
        : "Counting all stored accounting data…"}</p>
      <label className="checkbox-field data-delete-choice"><input type="checkbox" checked={deleteAccounts}
        onChange={(event) => setDeleteAccounts(event.target.checked)} />
        Also delete the complete chart of accounts and known balances</label>
      <label className="checkbox-field data-delete-choice"><input type="checkbox" checked={deleteImportHistory}
        onChange={(event) => setDeleteImportHistory(event.target.checked)} />
        Also delete all {summary?.importJobCount ?? ""} import jobs and their staged or misfit records</label>
      <button type="button" className="danger-button"
        disabled={!summary || (summary.transactionCount === 0 && (!deleteAccounts || summary.accountCount === 0)
          && (!deleteImportHistory || summary.importJobCount === 0))}
        onClick={() => onClearLedger(deleteAccounts, deleteImportHistory)}>Review exact data deletion</button>
      <small>{deleteImportHistory ? "Selected import history will be removed instead of resurfacing as misfits. " : "Import history remains. "}
        {!deleteAccounts && "Accounts remain. "}Currencies and your login remain.</small>
    </section>
    <section className="settings-section danger-zone"><h3>Delete user account</h3>
      <p>Permanently deletes {user.email} and all accounting data owned by it.</p>
      {!preview ? <form onSubmit={previewDeletion}><label>Current password
        <input type="password" required autoComplete="current-password" value={password}
          onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="danger-button" disabled={Boolean(busy)}>{busy === "preview" ? "Preparing preview…" : "Review complete account deletion"}</button>
      </form> : <>
        <div className="deletion-summary">
          <div><span>Transactions</span><strong>{preview.summary.transactionCount}</strong></div>
          <div><span>Accounts</span><strong>{preview.summary.accountCount}</strong></div>
          <div><span>Import jobs</span><strong>{preview.summary.importJobCount}</strong></div>
          <div><span>API tokens</span><strong>{preview.summary.apiTokenCount}</strong></div>
        </div>
        <label>Type <code>{preview.confirmationText}</code>
          <input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        <button type="button" className="danger-button" disabled={Boolean(busy) || confirmation !== preview.confirmationText}
          onClick={() => void deleteUser()}>{busy === "delete" ? "Deleting account…" : "Permanently delete my account"}</button>
      </>}
      {error && <p className="error">{error}</p>}
    </section>
  </section></div>;
}

function CurrencyManagerDialog({ currencies, accounts, token, onClose, onChanged }: {
  currencies: Currency[]; accounts: Account[]; token: string;
  onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [catalogQuery, setCatalogQuery] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState<Currency | null>(null);
  const [currencyCode, setCurrencyCode] = useState("");
  const [currencyDisplayName, setCurrencyDisplayName] = useState("");
  const [currencyType, setCurrencyType] = useState<Exclude<CurrencyType, "iso_4217">>("security");
  const [currencyScale, setCurrencyScale] = useState("4");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const usageByCurrency = useMemo(() => {
    const usage = new Map<number, number>();
    for (const account of accounts) {
      usage.set(account.currencyId, (usage.get(account.currencyId) ?? 0) + 1);
    }
    return usage;
  }, [accounts]);
  const inUseCurrencies = currencies.filter((currency) => usageByCurrency.has(currency.id));
  const personalCurrencies = currencies.filter((currency) => currency.userDefined);
  const normalizedQuery = catalogQuery.trim().toLocaleLowerCase("en-US");
  const catalogMatches = normalizedQuery
    ? currencies.filter((currency) => !currency.userDefined && [currency.code, currency.displayName, currency.type]
      .some((value) => value.toLocaleLowerCase("en-US").includes(normalizedQuery)))
    : [];
  const structuralFieldsLocked = Boolean(editingCurrency && usageByCurrency.has(editingCurrency.id));

  function closeCurrencyForm() {
    setShowCreateForm(false); setEditingCurrency(null); setError("");
  }

  function beginCreate() {
    setEditingCurrency(null); setCurrencyCode(""); setCurrencyDisplayName("");
    setCurrencyType("security"); setCurrencyScale("4"); setError(""); setShowCreateForm(true);
  }

  function beginEdit(currency: Currency) {
    setEditingCurrency(currency); setCurrencyCode(currency.code); setCurrencyDisplayName(currency.displayName);
    setCurrencyType(currency.type as Exclude<CurrencyType, "iso_4217">); setCurrencyScale(String(currency.scale));
    setError(""); setShowCreateForm(true);
  }

  async function saveCurrency(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api(editingCurrency ? `/currencies/${editingCurrency.id}` : "/currencies", {
        method: editingCurrency ? "PATCH" : "POST", body: JSON.stringify({
        code: currencyCode,
        displayName: currencyDisplayName,
        type: currencyType,
        scale: Number(currencyScale),
      }) }, token);
      closeCurrencyForm(); await onChanged();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  function currencyRow(currency: Currency, showUsage: boolean, editable = false) {
    const accountCount = usageByCurrency.get(currency.id);
    return <div className="currency-row" key={currency.id}>
      <div><strong>{currency.code}</strong><span>{currency.displayName}</span></div>
      <div className="currency-row-meta">
        <small>{currency.type === "iso_4217" ? "ISO 4217" : currency.type} · {currency.scale} decimals</small>
        {showUsage && accountCount && <small>{accountCount} {accountCount === 1 ? "account" : "accounts"}</small>}
        {!showUsage && <small>{accountCount ? "In use" : currency.userDefined ? "Not currently used" : "Catalog"}</small>}
        {editable && <button type="button" className="currency-edit-button" onClick={() => beginEdit(currency)}>Edit</button>}
      </div>
    </div>;
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}><section className="agent-dialog currency-manager-dialog" role="dialog" aria-modal="true"
    aria-labelledby="currency-manager-title">
    <div className="dialog-heading"><div><p className="eyebrow">Accounting units</p>
      <h2 id="currency-manager-title">Currencies &amp; securities</h2></div>
      <button type="button" className="dialog-close" aria-label="Close currencies and securities" onClick={onClose}>×</button></div>
    <p className="muted">Currencies in the ledger appear first. Search the full catalog only when you need another one.</p>

    <section className="settings-section currency-manager-section"><div className="currency-section-heading">
      <div><h3>In use</h3><p>Assigned to one or more accounts in your chart.</p></div>
      <span>{inUseCurrencies.length}</span></div>
      <div className="currency-list">{inUseCurrencies.map((currency) => currencyRow(currency, true))}
        {!inUseCurrencies.length && <p className="assertion-empty">No currencies are in use yet.</p>}
      </div>
    </section>

    <section className="settings-section currency-manager-section"><div className="currency-section-heading">
      <div><h3>Personal units</h3><p>Your securities, funds, crypto assets, commodities, and custom units.</p></div>
      <button type="button" className="secondary" onClick={showCreateForm ? closeCurrencyForm : beginCreate}>
        {showCreateForm ? "Cancel" : "＋ Add unit"}</button></div>
      {showCreateForm && <form className="compact-form currency-create-form" onSubmit={saveCurrency}>
        <strong>{editingCurrency ? `Edit ${editingCurrency.code}` : "Add a personal unit"}</strong>
        <div className="form-row"><input required disabled={structuralFieldsLocked} maxLength={50} placeholder="Code or ticker" value={currencyCode}
          onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())} />
          <select disabled={structuralFieldsLocked} value={currencyType} onChange={(event) => setCurrencyType(event.target.value as Exclude<CurrencyType, "iso_4217">)}>
            <option value="security">Security / fund</option><option value="crypto">Crypto</option>
            <option value="commodity">Commodity</option><option value="custom">Custom unit</option>
          </select></div>
        <input required maxLength={255} placeholder="Display name" value={currencyDisplayName}
          onChange={(event) => setCurrencyDisplayName(event.target.value)} />
        <label>Decimal places<input required disabled={structuralFieldsLocked} type="number" min="0" max="18" value={currencyScale}
          onChange={(event) => setCurrencyScale(event.target.value)} /></label>
        {structuralFieldsLocked && <small className="currency-edit-note">This unit is assigned to an account. Its code, type, and decimal places are locked so existing amounts keep their meaning.</small>}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Saving…" : editingCurrency ? "Save unit" : "Create unit"}</button>
      </form>}
      <div className="currency-list">{personalCurrencies.map((currency) => currencyRow(currency, false, true))}
        {!personalCurrencies.length && <p className="assertion-empty">No personal units yet.</p>}
      </div>
    </section>

    <section className="settings-section currency-manager-section"><h3>Currency catalog</h3>
      <p>Search standard currencies and shared accounting units by code or name.</p>
      <label className="catalog-search">Search catalog<input value={catalogQuery} placeholder="For example, PEN or Peruvian sol"
        onChange={(event) => setCatalogQuery(event.target.value)} /></label>
      <div className="currency-list">{catalogMatches.map((currency) => currencyRow(currency, false))}
        {!normalizedQuery && <p className="assertion-empty">Enter a code or name to browse the catalog.</p>}
        {normalizedQuery && !catalogMatches.length && <p className="assertion-empty">No catalog currencies match “{catalogQuery.trim()}”.</p>}
      </div>
    </section>
  </section></div>;
}

function AppMenu({ open, onToggle, onCurrencies, onAgentAccess, onAccountData, onSignOut }: {
  open: boolean; onToggle: () => void; onCurrencies: () => void; onAgentAccess: () => void;
  onAccountData: () => void; onSignOut: () => void;
}) {
  return <div className="app-menu"><button type="button" className="header-menu-button" aria-label="Open application menu"
    aria-expanded={open} onClick={onToggle}><span aria-hidden="true">☰</span></button>
    {open && <div className="app-menu-popover" role="menu">
      <button type="button" role="menuitem" onClick={onCurrencies}>Currencies &amp; securities</button>
      <button type="button" role="menuitem" onClick={onAccountData}>Account &amp; data</button>
      <button type="button" role="menuitem" onClick={onAgentAccess}>Agent access</button>
      <button type="button" role="menuitem" onClick={onSignOut}>Sign out</button>
    </div>}
  </div>;
}

function AgentAccessDialog({ loginToken, onClose }: { loginToken: string; onClose: () => void }) {
  const [credentials, setCredentials] = useState<ApiTokenCredential[]>([]);
  const [name, setName] = useState("My accounting agent");
  const [expiresAt, setExpiresAt] = useState("");
  const [createdToken, setCreatedToken] = useState("");
  const [copied, setCopied] = useState<"url" | "token" | "">("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = mcpEndpointUrl();

  async function loadCredentials() {
    const result = await api<{ tokens: ApiTokenCredential[] }>("/auth/tokens", {}, loginToken);
    setCredentials(result.tokens);
  }

  useEffect(() => {
    void loadCredentials().catch((nextError) => setError(errorMessage(nextError)));
  }, []);

  async function createCredential(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setCreatedToken("");
    try {
      const result = await api<CreatedApiToken>("/auth/tokens", {
        method: "POST",
        body: JSON.stringify({
          name,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      }, loginToken);
      setCreatedToken(result.token);
      setCredentials((current) => [result.credential, ...current]);
      setName("My accounting agent"); setExpiresAt("");
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  async function revokeCredential(credential: ApiTokenCredential) {
    if (!window.confirm(`Revoke “${credential.name}”? Any agent using it will immediately lose access.`)) return;
    setError("");
    try {
      await api(`/auth/tokens/${credential.id}`, { method: "DELETE" }, loginToken);
      await loadCredentials();
    } catch (nextError) { setError(errorMessage(nextError)); }
  }

  async function copy(value: string, target: "url" | "token") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
      window.setTimeout(() => setCopied(""), 1800);
    } catch {
      setError("Clipboard access was blocked. Select the value and copy it manually.");
    }
  }

  return <div className="dialog-backdrop" role="presentation">
    <section className="agent-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-access-title">
      <div className="dialog-heading"><div><p className="eyebrow">Integrations</p><h2 id="agent-access-title">Agent access</h2></div>
        <button className="dialog-close" aria-label="Close agent access" onClick={onClose}>×</button></div>
      <p className="muted">Generate a private bearer token here, then enter this MCP URL and token in your agent's Add MCP dialog. The agent can list first-class accounting.account objects; each postable account advertises an Import statement action that starts the four-question workflow.</p>

      <div className="connection-field"><label>MCP URL</label><div><input readOnly value={endpoint} onFocus={(event) => event.currentTarget.select()} />
        <button className="secondary" onClick={() => void copy(endpoint, "url")}>{copied === "url" ? "Copied" : "Copy"}</button></div></div>

      {createdToken && <section className="new-token-notice" aria-live="polite">
        <strong>Copy this API token now.</strong>
        <p>For security, Accounting cannot show it again after you close this dialog.</p>
        <div><input aria-label="New API token" readOnly value={createdToken} onFocus={(event) => event.currentTarget.select()} />
          <button className="primary" onClick={() => void copy(createdToken, "token")}>{copied === "token" ? "Copied" : "Copy token"}</button></div>
      </section>}

      <form className="token-form" onSubmit={createCredential}>
        <label>Token name<input required maxLength={128} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Expires <span>(optional)</span><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
        <button className="primary" disabled={busy}>{busy ? "Generating…" : "Generate API token"}</button>
      </form>
      {error && <p className="error">{error}</p>}

      <div className="token-list-heading"><h3>Generated tokens</h3><span>{credentials.length}</span></div>
      <div className="token-list">{credentials.map((credential) => {
        const expired = credential.expiresAt != null && new Date(credential.expiresAt).getTime() <= Date.now();
        const status = credential.revokedAt ? "Revoked" : expired ? "Expired" : "Active";
        return <div className="token-row" key={credential.id}><div><strong>{credential.name}</strong>
          <code>{credential.prefix}…</code><small>Created {displayDate(credential.createdAt)} · Last used {displayDate(credential.lastUsedAt)}</small></div>
          <div><span className={`token-status ${status.toLowerCase()}`}>{status}</span>
            {!credential.revokedAt && !expired && <button className="danger-link" onClick={() => void revokeCredential(credential)}>Revoke</button>}</div></div>;
      })}
        {!credentials.length && <p className="empty-token-list">No API tokens yet.</p>}
      </div>
    </section>
  </div>;
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey));
  const [user, setUser] = useState<User | null>(null);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [assertions, setAssertions] = useState<BalanceAssertion[]>([]);
  const [transactions, setTransactions] = useState<TransactionSummary[]>([]);
  const [importJobs, setImportJobs] = useState<TransactionImportJob[]>([]);
  const [selected, setSelected] = useState<TransactionDetail | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [accountLedgerEntries, setAccountLedgerEntries] = useState<AccountLedgerEntry[]>([]);
  const [accountLedgerLoading, setAccountLedgerLoading] = useState(false);
  const [accountLedgerError, setAccountLedgerError] = useState("");
  const [accountLedgerRefresh, setAccountLedgerRefresh] = useState(0);
  const [openRegisterTransaction, setOpenRegisterTransaction] = useState<{
    transactionId: number; lineItemId: number;
  } | null>(null);
  const [verification, setVerification] = useState("");
  const [showAgentAccess, setShowAgentAccess] = useState(false);
  const [showCurrencyManager, setShowCurrencyManager] = useState(false);
  const [showAccountData, setShowAccountData] = useState(false);
  const [showAppMenu, setShowAppMenu] = useState(false);
  const [deletionRequest, setDeletionRequest] = useState<{
    scope: "all" | "selected"; transactionIds: number[]; deleteAccounts: boolean;
    deleteImportHistory: boolean;
  } | null>(null);
  const [workspaceView, setWorkspaceView] = useState<"chart" | "account" | "activity" | "misfits" | "statements">(
    () => window.location.hash === "#import-misfits" ? "misfits" : "chart",
  );
  const [loading, setLoading] = useState(true);
  const mainContentRef = useRef<HTMLDivElement>(null);

  function revealMainContent() {
    requestAnimationFrame(() => {
      const content = mainContentRef.current;
      if (!content) return;
      content.scrollIntoView({ behavior: "smooth", block: "start" });
      content.focus({ preventScroll: true });
    });
  }

  function selectAccount(account: Account) {
    setSelectedAccountId(account.id);
    setWorkspaceView("account");
    if (window.location.hash === "#import-misfits") {
      window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    revealMainContent();
  }

  function selectWorkspaceView(view: "chart" | "activity" | "misfits" | "statements") {
    if (view !== "statements") setSelectedAccountId(null);
    setWorkspaceView(view);
    if (view === "misfits" && window.location.hash !== "#import-misfits") {
      window.history.pushState(null, "", "#import-misfits");
    } else if (view !== "misfits" && window.location.hash === "#import-misfits") {
      window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    revealMainContent();
  }

  useEffect(() => {
    if (!token) { setUser(null); setCurrencies([]); setLoading(false); return; }
    setLoading(true);
    api<{ user: User }>("/auth/me", {}, token).then((result) => setUser(result.user)).catch(() => {
      localStorage.removeItem(tokenKey); setToken(null);
    }).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    const syncViewFromUrl = () => {
      const misfits = window.location.hash === "#import-misfits";
      if (misfits) {
        setWorkspaceView("misfits");
        setSelectedAccountId(null);
      } else {
        setWorkspaceView((current) => current === "misfits" ? "chart" : current);
      }
    };
    window.addEventListener("popstate", syncViewFromUrl);
    window.addEventListener("hashchange", syncViewFromUrl);
    return () => {
      window.removeEventListener("popstate", syncViewFromUrl);
      window.removeEventListener("hashchange", syncViewFromUrl);
    };
  }, []);

  async function refresh() {
    if (!token) return;
    const [currencyResult, accountResult, assertionResult, transactionResult, importJobResult] = await Promise.all([
      api<{ currencies: Currency[] }>("/currencies", {}, token),
      api<{ accounts: Account[] }>("/accounts", {}, token),
      api<{ assertions: BalanceAssertion[] }>("/balance-assertions", {}, token),
      api<{ transactions: TransactionSummary[] }>("/transactions", {}, token),
      api<{ jobs: TransactionImportJob[] }>("/transaction-import-jobs", {}, token),
    ]);
    setCurrencies(currencyResult.currencies); setAccounts(accountResult.accounts);
    setAssertions(assertionResult.assertions); setTransactions(transactionResult.transactions);
    setImportJobs(importJobResult.jobs);
  }
  useEffect(() => { if (token && user) void refresh(); }, [token, user]);

  useEffect(() => {
    if (!token || selectedAccountId == null) {
      setAccountLedgerEntries([]); setAccountLedgerError(""); setAccountLedgerLoading(false); return;
    }
    let active = true;
    setAccountLedgerLoading(true); setAccountLedgerError("");
    api<{ entries: AccountLedgerEntry[] }>(`/accounts/${selectedAccountId}/ledger`, {}, token)
      .then((result) => { if (active) setAccountLedgerEntries(result.entries); })
      .catch((nextError) => { if (active) { setAccountLedgerEntries([]); setAccountLedgerError(errorMessage(nextError)); } })
      .finally(() => { if (active) setAccountLedgerLoading(false); });
    return () => { active = false; };
  }, [token, selectedAccountId, accountLedgerRefresh]);

  useEffect(() => {
    if (selectedAccountId != null && !accounts.some((account) => account.id === selectedAccountId)) {
      setSelectedAccountId(null);
      setWorkspaceView("chart");
    }
  }, [accounts, selectedAccountId]);

  function authenticated(nextToken: string, nextUser: User) {
    localStorage.setItem(tokenKey, nextToken); setToken(nextToken); setUser(nextUser);
  }
  function logout() {
    localStorage.removeItem(tokenKey); setToken(null); setUser(null); setSelectedAccountId(null);
    setImportJobs([]); setTransactions([]); setSelected(null); setWorkspaceView("chart");
    setShowAppMenu(false); setShowAgentAccess(false); setShowAccountData(false); setDeletionRequest(null);
    setOpenRegisterTransaction(null);
  }
  async function refreshAfterTransaction() {
    await refresh();
    if (token && selected) {
      try {
        const result = await api<{ transaction: TransactionDetail }>(`/transactions/${selected.id}`, {}, token);
        setSelected(result.transaction);
      } catch { setSelected(null); }
    }
    setAccountLedgerRefresh((current) => current + 1);
  }
  async function selectTransaction(id: number) {
    if (!token) return;
    const result = await api<{ transaction: TransactionDetail }>(`/transactions/${id}`, {}, token); setSelected(result.transaction);
  }
  function openTransactionInRegister(transaction: TransactionDetail) {
    const line = transaction.lineItems.find((candidate) => accounts.some((account) => account.id === candidate.accountId));
    if (!line) return;
    const targetAccount = accounts.find((account) => account.id === line.accountId);
    if (!targetAccount) return;
    setOpenRegisterTransaction({ transactionId: transaction.id, lineItemId: line.id });
    selectAccount(targetAccount);
  }
  async function verify() {
    if (!token) return;
    setVerification("Checking every posted transaction…");
    try {
      const result = await api<{ valid: boolean; checked: number }>("/ledger/verify", { method: "POST", body: "{}" }, token);
      setVerification(`Verified: all ${result.checked} posted transactions balance.`);
    } catch (error) { setVerification(errorMessage(error)); }
  }

  if (loading) return <div className="loading">Loading accounting…</div>;
  if (!token || !user) return <AuthScreen onAuthenticated={authenticated} />;
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? null;
  const unresolvedMisfits = importJobs.reduce((total, job) => total + job.progress.transaction_totals.unresolved_exceptions, 0);
  return <div className="app-shell"><header><div><p className="eyebrow">Chapeaux Fous</p><h1>Accounting</h1></div><div className="user-menu"><span>{user.name}</span>
    <AppMenu open={showAppMenu} onToggle={() => setShowAppMenu((current) => !current)}
      onCurrencies={() => { setShowAppMenu(false); setShowCurrencyManager(true); }}
      onAccountData={() => { setShowAppMenu(false); setShowAccountData(true); }}
      onAgentAccess={() => { setShowAppMenu(false); setShowAgentAccess(true); }}
      onSignOut={logout} /></div></header>
    <main className="workspace">
      <nav className="workspace-nav" aria-label="Accounting views">
        <button className={workspaceView === "chart" ? "active" : ""} aria-pressed={workspaceView === "chart"}
          onClick={() => selectWorkspaceView("chart")}>Chart of accounts</button>
        <button className={workspaceView === "activity" ? "active" : ""} aria-pressed={workspaceView === "activity"}
          onClick={() => selectWorkspaceView("activity")}>All activity</button>
        <button className={workspaceView === "misfits" ? "active" : ""} aria-pressed={workspaceView === "misfits"}
          onClick={() => selectWorkspaceView("misfits")}>Import misfits
          {unresolvedMisfits > 0 && <span>{unresolvedMisfits}</span>}</button>
        <button className={workspaceView === "statements" ? "active" : ""} aria-pressed={workspaceView === "statements"}
          onClick={() => selectWorkspaceView("statements")}>Statements &amp; questions</button>
      </nav>
      <div id="import-misfits" className="main-column" ref={mainContentRef} tabIndex={-1}>
        {workspaceView === "chart"
          ? <ChartOfAccounts accounts={accounts} currencies={currencies} selectedAccountId={selectedAccountId}
              token={token} onSelectAccount={selectAccount} onChanged={refresh} />
          : workspaceView === "misfits"
          ? <ImportMisfits jobs={importJobs} accounts={accounts} currencies={currencies} token={token} onChanged={refresh} />
          : workspaceView === "statements"
          ? <StatementWorkspace accounts={accounts} assertions={assertions} token={token}
              initialAccountId={selectedAccountId} onChanged={refresh} />
          : workspaceView === "account" && selectedAccount
          ? <AccountRegister account={selectedAccount} accounts={accounts} currencies={currencies}
              entries={accountLedgerEntries} assertions={assertions}
              loading={accountLedgerLoading} error={accountLedgerError} token={token}
              onShowAll={() => selectWorkspaceView("activity")}
              onImportStatement={() => selectWorkspaceView("statements")}
              openTransaction={openRegisterTransaction}
              onOpenTransactionHandled={() => setOpenRegisterTransaction(null)}
              onTransactionCreated={refreshAfterTransaction}
              onChanged={refresh} />
          : <Ledger transactions={transactions} selected={selected} onSelect={(id) => void selectTransaction(id)}
              onOpenInRegister={openTransactionInRegister}
              onDelete={(id) => setDeletionRequest({ scope: "selected", transactionIds: [id],
                deleteAccounts: false, deleteImportHistory: false })}
              onVerify={() => void verify()} verification={verification} />}</div></main>
    {showAgentAccess && <AgentAccessDialog loginToken={token} onClose={() => setShowAgentAccess(false)} />}
    {showCurrencyManager && <CurrencyManagerDialog currencies={currencies} accounts={accounts}
      token={token} onClose={() => setShowCurrencyManager(false)} onChanged={refresh} />}
    {showAccountData && <AccountDataDialog user={user} token={token} onClose={() => setShowAccountData(false)}
      onClearLedger={(deleteAccounts, deleteImportHistory) => { setShowAccountData(false);
        setDeletionRequest({ scope: "all", transactionIds: [], deleteAccounts, deleteImportHistory }); }}
      onDeleted={logout} />}
    {deletionRequest && <TransactionDeletionDialog scope={deletionRequest.scope}
      transactionIds={deletionRequest.transactionIds} deleteAccounts={deletionRequest.deleteAccounts}
      deleteImportHistory={deletionRequest.deleteImportHistory}
      token={token} onClose={() => setDeletionRequest(null)}
      onDeleted={async () => {
        setSelected(null); await refresh(); setAccountLedgerRefresh((current) => current + 1);
      }} />}
  </div>;
}
