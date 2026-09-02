import { FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, mcpEndpointUrl } from "./api";
import { decimalToUnits, unitsToDecimal } from "./money";
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
          <div><strong>{node.name}</strong><span>{node.type} · {node.currencyCode}{node.placeholder ? " · placeholder" : ""}</span>
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
          {currencies.map((currency) => <option key={currency.id} value={currency.id}>{currencyLabel(currency)}</option>)}
        </select></label></div>
        <label>Parent<select value={parentAccountId} onChange={(event) => setParentAccountId(event.target.value)}>
          <option value="">No parent</option>
          {accounts.filter((candidate) => !candidate.archivedAt && !unavailableParentIds.has(candidate.id)).map((candidate) =>
            <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select></label>
        <label className="checkbox-field"><input type="checkbox" checked={placeholder}
          onChange={(event) => setPlaceholder(event.target.checked)} />Placeholder (cannot receive transactions)</label>
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

function AccountPanel({ accounts, currencies, importJobs, selectedAccountId, misfitsSelected,
  token, onSelectAccount, onSelectMisfits, onChanged }: {
  accounts: Account[]; currencies: Currency[];
  importJobs: TransactionImportJob[]; selectedAccountId: number | null; misfitsSelected: boolean; token: string;
  onSelectAccount: (account: Account) => void; onSelectMisfits: () => void; onChanged: () => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [placeholder, setPlaceholder] = useState(false);
  const [type, setType] = useState<Account["type"] | "">("");
  const [currencyId, setCurrencyId] = useState<number | "">("");
  const [parentAccountId, setParentAccountId] = useState("");
  const [error, setError] = useState("");
  const [showCurrencyForm, setShowCurrencyForm] = useState(false);
  const [currencyCode, setCurrencyCode] = useState("");
  const [currencyDisplayName, setCurrencyDisplayName] = useState("");
  const [currencyType, setCurrencyType] = useState<Exclude<CurrencyType, "iso_4217">>("security");
  const [currencyScale, setCurrencyScale] = useState("4");
  const [currencyError, setCurrencyError] = useState("");
  const [currencyBusy, setCurrencyBusy] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const unresolvedMisfits = importJobs.reduce((total, job) => total + job.progress.transaction_totals.unresolved_exceptions, 0);
  const excludedMisfits = importJobs.reduce((total, job) => total + job.progress.transaction_totals.excluded, 0);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      await api("/accounts", { method: "POST", body: JSON.stringify({ name, description, placeholder, type, currencyId: Number(currencyId),
        parentAccountId: parentAccountId ? Number(parentAccountId) : null }) }, token);
      setName(""); setDescription(""); setPlaceholder(false); setShowForm(false); await onChanged();
    } catch (nextError) { setError(errorMessage(nextError)); }
  }

  async function createCurrency(event: FormEvent) {
    event.preventDefault(); setCurrencyBusy(true); setCurrencyError("");
    try {
      await api("/currencies", { method: "POST", body: JSON.stringify({
        code: currencyCode,
        displayName: currencyDisplayName,
        type: currencyType,
        scale: Number(currencyScale),
      }) }, token);
      setCurrencyCode(""); setCurrencyDisplayName(""); setCurrencyType("security"); setCurrencyScale("4");
      setShowCurrencyForm(false); await onChanged();
    } catch (nextError) { setCurrencyError(errorMessage(nextError)); }
    finally { setCurrencyBusy(false); }
  }

  return <aside className="accounts-panel">
    <div className="section-heading"><div><p className="eyebrow">Chart</p><h2>Accounts</h2></div><button onClick={() => setShowForm(!showForm)}>＋</button></div>
    {showForm && <form className="compact-form" onSubmit={submit}>
      <input placeholder="Account name" value={name} onChange={(event) => setName(event.target.value)} />
      <input placeholder="Description (optional)" value={description} onChange={(event) => setDescription(event.target.value)} />
      <div className="form-row"><select required value={type} onChange={(event) => setType(event.target.value as Account["type"] | "")}>
        <option value="">Choose type…</option>
        {(["asset", "liability", "equity", "income", "expense"] as const).map((value) => <option key={value}>{value}</option>)}
      </select><select required value={currencyId} onChange={(event) => setCurrencyId(event.target.value ? Number(event.target.value) : "")}>
        <option value="">Choose currency…</option>
        {currencies.map((currency) => <option key={currency.id} value={currency.id}>{currencyLabel(currency)}</option>)}
      </select></div>
      <select value={parentAccountId} onChange={(event) => setParentAccountId(event.target.value)}>
        <option value="">No parent</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select>
      <label className="checkbox-field"><input type="checkbox" checked={placeholder}
        onChange={(event) => setPlaceholder(event.target.checked)} />Placeholder (cannot receive transactions)</label>
      {error && <p className="error">{error}</p>}<button className="primary">Add account</button>
    </form>}
    <AccountTree accounts={accounts} selectedAccountId={selectedAccountId}
      onSelect={onSelectAccount} onEdit={setEditingAccount} />
    <button type="button" className={`misfits-account ${misfitsSelected ? "selected" : ""}`}
      aria-controls="import-misfits" aria-pressed={misfitsSelected} onClick={onSelectMisfits}>
      <span className="misfits-mark" aria-hidden="true">◇</span>
      <span><strong>Import misfits</strong><small>Transactions needing a home or a decision</small></span>
      <span className="misfits-count">{unresolvedMisfits}{excludedMisfits > 0 && <small>{excludedMisfits} excluded</small>}</span>
    </button>
    <section className="currencies-panel">
      <div className="section-heading"><div><p className="eyebrow">Units</p><h3>Currencies &amp; securities</h3></div>
        <button aria-label="Create currency or security" onClick={() => setShowCurrencyForm(!showCurrencyForm)}>＋</button></div>
      {showCurrencyForm && <form className="compact-form" onSubmit={createCurrency}>
        <div className="form-row"><input required maxLength={50} placeholder="Code or ticker" value={currencyCode}
          onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())} />
          <select value={currencyType} onChange={(event) => setCurrencyType(event.target.value as Exclude<CurrencyType, "iso_4217">)}>
            <option value="security">Security / fund</option><option value="crypto">Crypto</option>
            <option value="commodity">Commodity</option><option value="custom">Custom unit</option>
          </select></div>
        <input required maxLength={255} placeholder="Display name" value={currencyDisplayName}
          onChange={(event) => setCurrencyDisplayName(event.target.value)} />
        <label>Decimal places<input required type="number" min="0" max="18" value={currencyScale}
          onChange={(event) => setCurrencyScale(event.target.value)} /></label>
        {currencyError && <p className="error">{currencyError}</p>}
        <button className="primary" disabled={currencyBusy}>{currencyBusy ? "Creating…" : "Create unit"}</button>
      </form>}
      <div className="currency-list">{currencies.filter((currency) => currency.userDefined).map((currency) =>
        <div className="currency-row" key={currency.id}><div><strong>{currency.code}</strong><span>{currency.displayName}</span></div>
          <small>{currency.type} · {currency.scale} decimals</small></div>)}
        {!currencies.some((currency) => currency.userDefined) && <p className="assertion-empty">No custom units yet.</p>}
      </div>
    </section>
    {editingAccount && <AccountEditDialog key={editingAccount.id} account={editingAccount} accounts={accounts} currencies={currencies}
      token={token} onClose={() => setEditingAccount(null)} onChanged={onChanged} />}
  </aside>;
}

type EditableLine = { accountId: string; amount: string; memo: string };
type EditableRate = { fromAmount: string; toAmount: string };
type RateDirection = "value-per-amount" | "amount-per-value";
type EditableImportRecord = CanonicalImportRecord & {
  editorKey: string;
  rateDecimal: string;
  rateDirection: RateDirection;
  rateChanges: "amount" | "value";
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

type DecimalParts = { units: bigint; scale: number };

function decimalParts(value: string | null | undefined): DecimalParts | null {
  const match = value?.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
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

function formattedDecimal(units: bigint, scale: number) {
  const value = unitsToDecimal(units.toString(), scale);
  return scale === 0 ? value : value.replace(/\.?0+$/, "");
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

function TransactionComposer({ accounts, currencies, initialAccountId, token, onCreated }: {
  accounts: Account[]; currencies: Currency[]; initialAccountId: number | null;
  token: string; onCreated: () => Promise<void>;
}) {
  const initialAccount = accounts.find((account) => account.id === initialAccountId);
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(today());
  const [valuationCurrencyId, setValuationCurrencyId] = useState<number | "">(initialAccount?.currencyId ?? "");
  const [lines, setLines] = useState<EditableLine[]>([
    { accountId: initialAccountId == null ? "" : String(initialAccountId), amount: "", memo: "" },
    { accountId: "", amount: "", memo: "" },
  ]);
  const [rates, setRates] = useState<Record<number, EditableRate>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const accountMap = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const currencyMap = useMemo(() => new Map(currencies.map((currency) => [currency.id, currency])), [currencies]);
  const resolvedValuationCurrencyId = Number(valuationCurrencyId);
  const foreignCurrencyIds = [...new Set(lines.map((line) => accountMap.get(Number(line.accountId))?.currencyId)
    .filter((currencyId): currencyId is number => Boolean(currencyId) && currencyId !== resolvedValuationCurrencyId))];

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line));
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const payloadLines = lines.map((line) => {
        const account = accountMap.get(Number(line.accountId));
        if (!account) throw new Error("Choose an account for every line.");
        return { accountId: account.id, amountUnits: decimalToUnits(line.amount, account.scale), memo: line.memo, tags: [] };
      });
      const payloadRates = foreignCurrencyIds.map((fromCurrencyId) => {
        const fromCurrency = currencyMap.get(fromCurrencyId);
        const toCurrency = currencyMap.get(resolvedValuationCurrencyId);
        const rate = rates[fromCurrencyId];
        if (!fromCurrency || !toCurrency || !rate) throw new Error(`Enter a ${fromCurrency?.code || "foreign"} conversion rate.`);
        return { fromCurrencyId, toCurrencyId: resolvedValuationCurrencyId,
          fromUnits: decimalToUnits(rate.fromAmount, fromCurrency.scale), toUnits: decimalToUnits(rate.toAmount, toCurrency.scale) };
      });
      await api("/transactions", { method: "POST", body: JSON.stringify({ description, transactionDate: date,
        valuationCurrencyId: resolvedValuationCurrencyId, lineItems: payloadLines, rates: payloadRates, post: true }) }, token);
      setDescription(""); setDate(today()); setLines([
        { accountId: initialAccountId == null ? "" : String(initialAccountId), amount: "", memo: "" },
        { accountId: "", amount: "", memo: "" },
      ]);
      setRates({}); await onCreated();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  return <section className="composer">
    <form onSubmit={submit}>
      <div className="transaction-meta"><label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What happened?" /></label>
        <label>Value currency<select required value={valuationCurrencyId}
          onChange={(event) => setValuationCurrencyId(event.target.value ? Number(event.target.value) : "")}>
          <option value="">Choose currency…</option>
          {currencies.map((currency) => <option key={currency.id} value={currency.id}>{currencyLabel(currency)}</option>)}</select></label></div>
      <div className="line-editor"><div className="line-head"><span>Memo</span><span>Account</span><span>Debit</span><span>Credit</span><span /></div>
        {lines.map((line, index) => <div className="line-grid" key={index}>
          <input value={line.memo} onChange={(event) => updateLine(index, { memo: event.target.value })} placeholder="Memo" />
          <select value={line.accountId} onChange={(event) => updateLine(index, { accountId: event.target.value })}><option value="">Choose…</option>
            {accounts.filter((account) => !account.archivedAt && !account.placeholder).map((account) => <option key={account.id} value={account.id}>{account.name} ({account.currencyCode})</option>)}</select>
          <input inputMode="decimal" aria-label={`Debit for line ${index + 1}`} value={amountForSide(line.amount, "debit")}
            onChange={(event) => updateLine(index, { amount: signedAmountForSide("debit", event.target.value) })} />
          <input inputMode="decimal" aria-label={`Credit for line ${index + 1}`} value={amountForSide(line.amount, "credit")}
            onChange={(event) => updateLine(index, { amount: signedAmountForSide("credit", event.target.value) })} />
          <button type="button" className="quiet" disabled={lines.length <= 2} onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}>×</button>
        </div>)}</div>
      <button type="button" className="secondary" onClick={() => setLines((current) => [...current, { accountId: "", amount: "", memo: "" }])}>Add split</button>
      {foreignCurrencyIds.length > 0 && <div className="rates"><h3>Transaction exchange rates</h3>{foreignCurrencyIds.map((currencyId) => {
        const foreign = currencyMap.get(currencyId)!; const valuation = currencyMap.get(resolvedValuationCurrencyId)!; const rate = rates[currencyId] || { fromAmount: "", toAmount: "" };
        return <div className="rate-row" key={currencyId}><span>When</span><input placeholder={`1 ${foreign.code}`} value={rate.fromAmount}
          onChange={(event) => setRates((current) => ({ ...current, [currencyId]: { ...rate, fromAmount: event.target.value } }))} />
          <span>{foreign.code} equals</span><input placeholder={valuation.code} value={rate.toAmount}
          onChange={(event) => setRates((current) => ({ ...current, [currencyId]: { ...rate, toAmount: event.target.value } }))} /><span>{valuation.code}</span></div>;
      })}</div>}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "Validating…" : "Validate and post"}</button>
    </form>
  </section>;
}

function TransactionComposerDialog({ accounts, currencies, initialAccountId, token, onCreated, onClose }: {
  accounts: Account[]; currencies: Currency[]; initialAccountId: number | null; token: string;
  onCreated: () => Promise<void>; onClose: () => void;
}) {
  return <TransactionEditorModal eyebrow="New entry" title="Balanced transaction" onClose={onClose}>
    <TransactionComposer accounts={accounts} currencies={currencies} initialAccountId={initialAccountId}
      token={token} onCreated={onCreated} />
  </TransactionEditorModal>;
}

function MisfitEditor({ exception, accounts, currencies, token, importJobId, onSaved, onCancel }: {
  exception: TransactionImportException; accounts: Account[]; currencies: Currency[]; token: string;
  importJobId: string; onSaved: () => Promise<void>; onCancel: () => void;
}) {
  const [records, setRecords] = useState<EditableImportRecord[]>(() =>
    exception.canonical_records.map((record, index) => ({
      ...record,
      editorKey: `${record.line_external_id ?? "line"}-${index}`,
      rateDirection: "value-per-amount",
      rateDecimal: lineRate(record, "value-per-amount"),
      rateChanges: "value",
    })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fullNames = useMemo(() => accountFullNames(accounts), [accounts]);
  const postableAccounts = useMemo(() => accounts.filter((account) => !account.archivedAt && !account.placeholder)
    .map((account) => ({ account, fullName: fullNames.get(account.id) ?? account.name }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName)), [accounts, fullNames]);
  const accountByFullName = useMemo(() => new Map(postableAccounts.map(({ account, fullName }) => [fullName, account])),
    [postableAccounts]);
  const first = records[0];

  function synchronizeRate(record: EditableImportRecord) {
    const account = accountByFullName.get(record.account_full_name);
    if (account?.currencyCode === record.valuation_currency_code) {
      return { ...record, value_decimal: record.amount_decimal, rateDecimal: "1" };
    }
    return { ...record, rateDecimal: lineRate(record, record.rateDirection) };
  }

  function updateTransaction(patch: Partial<Pick<CanonicalImportRecord,
    "transaction_date" | "description" | "valuation_currency_code">>) {
    setRecords((current) => current.map((record) => synchronizeRate({ ...record, ...patch })));
  }

  function updateLine(index: number, patch: Partial<CanonicalImportRecord>) {
    setRecords((current) => current.map((record, recordIndex) => recordIndex === index
      ? synchronizeRate({ ...record, ...patch }) : record));
  }

  function updateLineAmount(index: number, side: "debit" | "credit", value: string) {
    setRecords((current) => current.map((record, recordIndex) => {
      if (recordIndex !== index) return record;
      const amount = signedAmountForSide(side, value);
      const account = accountByFullName.get(record.account_full_name);
      const next = { ...record, amount_decimal: amount };
      if (account?.currencyCode === record.valuation_currency_code) next.value_decimal = amount;
      return synchronizeRate(next);
    }));
  }

  function updateLineValue(index: number, value: string) {
    setRecords((current) => current.map((record, recordIndex) => recordIndex === index
      ? synchronizeRate({ ...record, value_decimal: value }) : record));
  }

  function updateLineRate(index: number, rateDecimal: string) {
    setRecords((current) => current.map((record, recordIndex) => {
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
    }));
  }

  function invertLineRate(index: number) {
    setRecords((current) => current.map((record, recordIndex) => {
      if (recordIndex !== index) return record;
      const rateDirection = record.rateDirection === "value-per-amount" ? "amount-per-value" : "value-per-amount";
      return { ...record, rateDirection, rateDecimal: lineRate(record, rateDirection) };
    }));
  }

  function addSplit() {
    setRecords((current) => [...current, {
      transaction_external_id: exception.source_identity.transaction_external_id,
      line_external_id: null,
      transaction_date: current[0]?.transaction_date ?? today(),
      description: current[0]?.description ?? null,
      valuation_currency_code: current[0]?.valuation_currency_code ?? "USD",
      account_full_name: "",
      amount_decimal: "",
      value_decimal: "",
      memo: null,
      editorKey: `new-${crypto.randomUUID()}`,
      rateDirection: "value-per-amount",
      rateDecimal: "",
      rateChanges: "value",
    }]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const corrected = records.map((record) => {
        const { editorKey: _editorKey, rateDecimal: _rateDecimal, rateDirection: _rateDirection,
          rateChanges: _rateChanges, ...canonical } = record;
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
    <p className="transaction-editor-rule">Amount + value determine the rate. When changing a rate, choose whether its amount or value should be recalculated.</p>
    <div className="misfit-meta">
      <label>Date<input type="date" required value={first.transaction_date}
        onChange={(event) => updateTransaction({ transaction_date: event.target.value })} /></label>
      <label>Description<input value={first.description ?? ""}
        onChange={(event) => updateTransaction({ description: event.target.value })} /></label>
      <label>Value currency<select required value={first.valuation_currency_code}
        onChange={(event) => updateTransaction({ valuation_currency_code: event.target.value })}>
        {currencies.map((currency) => <option key={currency.id} value={currency.code}>{currencyLabel(currency)}</option>)}
      </select></label>
    </div>
    <div className="misfit-lines">
      <div className="misfit-line-head"><span>Memo</span><span>Account</span><span>Debit</span><span>Credit</span><span /></div>
      {records.map((record, index) => {
        const selectedAccount = accountByFullName.get(record.account_full_name);
        const amountCurrencyCode = selectedAccount?.currencyCode ?? "account currency";
        const isNative = selectedAccount?.currencyCode === first.valuation_currency_code;
        const rateIsInvalid = record.rateDecimal.trim() !== ""
          && (!decimalParts(record.rateDecimal) || decimalParts(record.rateDecimal)!.units <= 0n);
        const hasDifferentRate = !isNative && Boolean(selectedAccount) && records.some((candidate, candidateIndex) =>
          candidateIndex !== index
          && accountByFullName.get(candidate.account_full_name)?.currencyCode === selectedAccount?.currencyCode
          && !sameLineRate(record, candidate));
        const rateUnits = record.rateDirection === "value-per-amount"
          ? `${first.valuation_currency_code} / ${amountCurrencyCode}`
          : `${amountCurrencyCode} / ${first.valuation_currency_code}`;
        return <div className="misfit-line-wrapper" key={record.editorKey}>
          <div className="misfit-line">
            <input value={record.memo ?? ""} onChange={(event) => updateLine(index, { memo: event.target.value })} placeholder="Memo" />
            <select required value={record.account_full_name}
              onChange={(event) => updateLine(index, { account_full_name: event.target.value })}>
              <option value="">Choose a postable account…</option>
              {postableAccounts.map(({ account, fullName }) => <option key={account.id} value={fullName}>
                {fullName} ({account.currencyCode})
              </option>)}
            </select>
            <input inputMode="decimal" aria-label={`Debit for imported line ${index + 1}`}
              value={amountForSide(record.amount_decimal, "debit")}
              onChange={(event) => updateLineAmount(index, "debit", event.target.value)} />
            <input inputMode="decimal" aria-label={`Credit for imported line ${index + 1}`}
              value={amountForSide(record.amount_decimal, "credit")}
              onChange={(event) => updateLineAmount(index, "credit", event.target.value)} />
            <button type="button" className="quiet" aria-label="Remove split" disabled={records.length === 1}
              onClick={() => setRecords((current) => current.filter((_, recordIndex) => recordIndex !== index))}>×</button>
          </div>
          <div className={`line-value-rate ${hasDifferentRate ? "different-rate" : ""}`}>
            <label>Value in {first.valuation_currency_code}
              <input inputMode="decimal" disabled={isNative} value={record.value_decimal ?? ""}
                onChange={(event) => updateLineValue(index, event.target.value)} />
            </label>
            <label>Exchange rate
              <span className="rate-input-group"><input inputMode="decimal" disabled={isNative}
                aria-invalid={rateIsInvalid || undefined} value={isNative ? "1" : record.rateDecimal}
                onChange={(event) => updateLineRate(index, event.target.value)} />
                <button type="button" className="rate-invert" disabled={isNative || !record.rateDecimal}
                  aria-label={`Invert exchange rate for line ${index + 1}`} title="Show the reciprocal rate"
                  onClick={() => invertLineRate(index)}>1/x</button></span>
              <small>{rateUnits}</small>
              {!isNative && <span className="rate-update-choice">Changing rate updates
                <select aria-label={`Exchange-rate update target for line ${index + 1}`} value={record.rateChanges}
                  onChange={(event) => setRecords((current) => current.map((candidate, candidateIndex) => candidateIndex === index
                    ? { ...candidate, rateChanges: event.target.value as "amount" | "value" } : candidate))}>
                  <option value="value">value</option><option value="amount">amount</option>
                </select>
              </span>}
            </label>
            {hasDifferentRate && <p className="rate-note">This line uses a different {selectedAccount?.currencyCode} rate.</p>}
            {rateIsInvalid && <p>Enter a positive exchange rate.</p>}
          </div>
        </div>;
      })}
    </div>
    <div className="misfit-editor-actions">
      <button type="button" className="secondary" onClick={addSplit}>Add balancing split</button>
      <span />
      <button type="button" className="link-button" onClick={onCancel}>Cancel</button>
      <button className="primary" disabled={busy}>{busy ? "Revalidating…" : "Revalidate correction"}</button>
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
    if (!selectedJobId || !preview?.preview_digest) return;
    const pending = preview.progress.transaction_totals.pending_commit;
    if (!window.confirm(`Commit exactly ${pending} pending corrected or staged transaction${pending === 1 ? "" : "s"}? Previously committed transactions will not be recreated.`)) return;
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
      <h2>Import misfits</h2><p>Source transactions that need a correction, an accounting choice, or an explicit exclusion.</p></div>
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
        <div><span>Pending commit</span><strong>{job.progress.transaction_totals.pending_commit}</strong><small>{job.progress.pending_commit_records} source records</small></div>
        <div><span>Already committed</span><strong>{job.progress.transaction_totals.previously_committed}</strong><small>{job.progress.previously_committed_records} source records</small></div>
        <div><span>Unresolved</span><strong>{job.progress.transaction_totals.unresolved_exceptions}</strong><small>{job.progress.exception_record_totals.unresolved} source records</small></div>
        <div><span>Excluded</span><strong>{job.progress.transaction_totals.excluded}</strong><small>{job.progress.exception_record_totals.excluded} source records</small></div>
      </div>
      <p className="reconciliation-equation">{job.progress.equation}</p>
      <div className="misfit-commit-panel">
        <div><strong>{job.progress.transaction_totals.pending_commit} transactions waiting for commit</strong>
          <span>Corrections are fully revalidated. Existing committed and reused transactions stay untouched.</span></div>
        {!preview ? <button className="secondary" disabled={Boolean(busy) || job.job_status === "committed"}
          onClick={() => void preparePreview()}>{busy === "preview" ? "Preparing…" : "Prepare exact preview"}</button>
          : <button className="primary" disabled={Boolean(busy)} onClick={() => void commitPreview()}>
            {busy === "commit" ? "Committing…" : `Commit ${preview.progress.transaction_totals.pending_commit} pending`}
          </button>}
      </div>
      {preview && <div className="preview-notice"><strong>Exact preview ready.</strong><span>{preview.commit_scope}</span>
        <code>{preview.preview_digest}</code></div>}
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

function Ledger({ transactions, selected, onSelect, onVerify, onDelete, verification }: {
  transactions: TransactionSummary[]; selected: TransactionDetail | null; onSelect: (id: number) => void;
  onVerify: () => void; onDelete: (id: number) => void; verification: string;
}) {
  return <section className="ledger card"><div className="section-heading"><div><p className="eyebrow">Activity</p><h2>Ledger</h2></div>
    <button className="secondary" onClick={onVerify}>Verify ledger</button></div>{verification && <p className="verification">{verification}</p>}
    <div className="ledger-layout"><div className="transaction-list">{transactions.map((transaction) => <button key={transaction.id}
      className={`transaction-row ${selected?.id === transaction.id ? "selected" : ""}`} onClick={() => onSelect(transaction.id)}>
      <span>{transaction.date}</span><strong>{transaction.description || "Untitled transaction"}</strong><small>{transaction.lineItemCount} lines · {transaction.state}</small>
    </button>)}</div>
    <div className="transaction-detail">{selected ? <><div className="detail-title"><div><h3>{selected.description || "Untitled transaction"}</h3><p>{selected.date} · {selected.state}</p></div>
      <div className="detail-actions"><span>#{selected.id}</span><button type="button" className="danger-link"
        onClick={() => onDelete(selected.id)}>Delete transaction</button></div></div>
      {selected.lineItems.map((line) => <div className="detail-line" key={line.id}><div><strong>{line.accountName}</strong><small>{line.memo}</small>
        {line.tags.length > 0 && <div className="tag-list">{line.tags.map((tag) => <span key={`${tag.key}:${tag.value}`}>{tag.key}:{tag.value}</span>)}</div>}</div>
        <b>{unitsToDecimal(line.amountUnits, line.scale)} {line.currencyCode}</b></div>)}</> : <p className="empty-state">Select a transaction to see its complete balanced entry.</p>}</div></div>
  </section>;
}

type AccountRegisterRow =
  | { kind: "entry"; date: string; order: number; entry: AccountLedgerEntry }
  | { kind: "assertion"; date: string; order: number; assertion: BalanceAssertion };

function AccountRegister({ account, entries, assertions, loading, error, token, onShowAll, onNewTransaction, onChanged }: {
  account: Account; entries: AccountLedgerEntry[]; assertions: BalanceAssertion[]; loading: boolean; error: string; token: string;
  onShowAll: () => void; onNewTransaction: () => void; onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<"basic" | "auto-split" | "journal">("basic");
  const [activeTransactionId, setActiveTransactionId] = useState<number | null>(null);
  const [showKnownBalanceForm, setShowKnownBalanceForm] = useState(false);
  const [knownBalanceDate, setKnownBalanceDate] = useState(today());
  const [knownBalance, setKnownBalance] = useState("");
  const [knownBalanceError, setKnownBalanceError] = useState("");
  const [knownBalanceBusy, setKnownBalanceBusy] = useState(false);
  const debitIncreases = account.type === "asset" || account.type === "expense";
  const debitEffect = debitIncreases ? "increases" : "decreases";
  const creditEffect = debitIncreases ? "decreases" : "increases";
  const accountAssertions = useMemo(() => assertions.filter((assertion) => assertion.accountId === account.id), [account.id, assertions]);
  const registerRows = useMemo<AccountRegisterRow[]>(() => [
    ...entries.map((entry, order) => ({ kind: "entry" as const, date: entry.date, order, entry })),
    ...accountAssertions.map((assertion) => ({ kind: "assertion" as const, date: assertion.date, order: assertion.id, assertion })),
  ].sort((left, right) => left.date.localeCompare(right.date)
    || (left.kind === right.kind ? left.order - right.order : left.kind === "entry" ? -1 : 1)), [accountAssertions, entries]);

  useEffect(() => {
    setActiveTransactionId(null); setShowKnownBalanceForm(false); setKnownBalanceDate(today());
    setKnownBalance(""); setKnownBalanceError("");
  }, [account.id]);

  function activateTransaction(transactionId: number) {
    if (view === "auto-split") setActiveTransactionId(transactionId);
  }

  function editKnownBalance(assertion: BalanceAssertion) {
    setKnownBalanceDate(assertion.date);
    setKnownBalance(unitsToDecimal(assertion.knownBalanceUnits, assertion.scale));
    setKnownBalanceError(""); setShowKnownBalanceForm(true);
  }

  async function saveKnownBalance(event: FormEvent) {
    event.preventDefault(); setKnownBalanceBusy(true); setKnownBalanceError("");
    try {
      await api("/balance-assertions", { method: "POST", body: JSON.stringify({
        accountId: account.id,
        balanceDate: knownBalanceDate,
        knownBalanceUnits: decimalToUnits(knownBalance, account.scale),
      }) }, token);
      setKnownBalance(""); await onChanged();
    } catch (nextError) { setKnownBalanceError(errorMessage(nextError)); }
    finally { setKnownBalanceBusy(false); }
  }

  return <section className="account-register card">
    <div className="section-heading"><div><p className="eyebrow">Account register</p><h2>{account.name}</h2>
      <p className="register-subtitle">Posted transactions · {account.currencyCode}</p></div>
      <div className="register-heading-actions">
        {!account.placeholder && !account.archivedAt && <button className="secondary" aria-expanded={showKnownBalanceForm}
          aria-controls="known-balance-form" onClick={() => setShowKnownBalanceForm((current) => !current)}>
          Enter a known balance</button>}
        <button className="secondary" onClick={onShowAll}>All activity</button>
      </div></div>
    {showKnownBalanceForm && <form id="known-balance-form" className="known-balance-form" onSubmit={saveKnownBalance}>
      <label>End of date<input type="date" required value={knownBalanceDate}
        onChange={(event) => setKnownBalanceDate(event.target.value)} /></label>
      <label>Known ending balance ({account.currencyCode})<input required placeholder="Known balance" value={knownBalance}
        onChange={(event) => setKnownBalance(event.target.value)} /></label>
      <button className="secondary" disabled={knownBalanceBusy}>{knownBalanceBusy ? "Saving…" : "Save balance"}</button>
      {knownBalanceError && <p className="error">{knownBalanceError}</p>}
    </form>}
    <div className="register-view-controls" role="group" aria-label="Register view">
      <button className={view === "basic" ? "active" : ""} aria-pressed={view === "basic"}
        onClick={() => setView("basic")}>Basic Ledger</button>
      <button className={view === "auto-split" ? "active" : ""} aria-pressed={view === "auto-split"}
        onClick={() => setView("auto-split")}>Auto-Split Ledger</button>
      <button className={view === "journal" ? "active" : ""} aria-pressed={view === "journal"}
        onClick={() => setView("journal")}>Transaction Journal</button>
    </div>
    {error && <p className="error">{error}</p>}
    {loading ? <p className="register-message" aria-live="polite">Loading account transactions…</p>
      : !error && registerRows.length === 0 ? <p className="register-message">No posted transactions or known balances in this account.</p>
      : !error && <div className="register-table-wrap"><table className="register-table">
        <thead><tr><th>Date</th><th>Description</th><th>Split account</th>
          <th>Debit <span>({debitEffect} {account.type})</span></th>
          <th>Credit <span>({creditEffect} {account.type})</span></th><th>Running balance</th><th>Known balance</th></tr></thead>
        <tbody>{registerRows.map((row) => {
          if (row.kind === "assertion") {
            const { assertion } = row;
            return <tr className={`register-assertion-row ${assertion.matches ? "matches" : "mismatch"}`} key={`assertion-${assertion.id}`}>
              <td>{assertion.date}</td>
              <td><strong>Known balance</strong><small>{assertion.matches
                ? "Matches the ledger"
                : `Difference ${unitsToDecimal(assertion.differenceUnits, assertion.scale)} ${assertion.currencyCode}`}</small></td>
              <td>—</td><td></td><td></td>
              <td className="amount balance">{unitsToDecimal(assertion.calculatedBalanceUnits, assertion.scale)}</td>
              <td className="amount known-balance"><button type="button" className="known-balance-edit"
                aria-label={`Edit known balance for ${assertion.date}`} onClick={() => editKnownBalance(assertion)}>
                {unitsToDecimal(assertion.knownBalanceUnits, assertion.scale)} <span aria-hidden="true">✎</span></button></td>
            </tr>;
          }
          const { entry } = row;
          const splitLabel = entry.splitAccountNames.length === 0 ? "—"
            : entry.splitAccountNames.length === 1 ? entry.splitAccountNames[0] : "Split transaction";
          const expanded = view === "journal" || (view === "auto-split" && activeTransactionId === entry.transactionId);
          return <Fragment key={entry.lineItemId}>
            <tr className={`register-entry-row ${view === "auto-split" ? "selectable" : ""} ${expanded ? "expanded" : ""}`}
              tabIndex={view === "auto-split" ? 0 : undefined}
              aria-expanded={view === "auto-split" ? expanded : undefined}
              onClick={() => activateTransaction(entry.transactionId)}
              onKeyDown={(event) => {
                if (view === "auto-split" && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault(); activateTransaction(entry.transactionId);
                }
              }}>
              <td>{entry.date}</td>
              <td><strong>{entry.description || "Untitled transaction"}</strong>
                {entry.memo && <small>{entry.memo}</small>}</td>
              <td>{splitLabel}{entry.splitAccountNames.length > 1 && <small>{entry.splitAccountNames.join(", ")}</small>}</td>
              <td className={`amount ${debitIncreases ? "increase-effect" : "decrease-effect"}`}>
                {entry.debitUnits == null ? "" : unitsToDecimal(entry.debitUnits, account.scale)}</td>
              <td className={`amount ${debitIncreases ? "decrease-effect" : "increase-effect"}`}>
                {entry.creditUnits == null ? "" : unitsToDecimal(entry.creditUnits, account.scale)}</td>
              <td className="amount balance">{unitsToDecimal(entry.runningBalanceUnits, account.scale)}</td>
              <td className="amount known-balance"></td>
            </tr>
            {expanded && <tr className="register-splits-row"><td colSpan={7}>
              <div className="register-splits" aria-label={`Splits for ${entry.description || "untitled transaction"}`}>
                {entry.splits.map((split) => <div className="register-split" key={split.lineItemId}>
                  <div><strong>{split.accountName}</strong>{split.memo && <small>{split.memo}</small>}</div>
                  <span>{unitsToDecimal(split.amountUnits, split.scale)} {split.currencyCode}</span>
                </div>)}
              </div>
            </td></tr>}
          </Fragment>;
        })}</tbody>
      </table></div>}
    <div className="register-actions"><button className="primary" onClick={onNewTransaction}>＋ New transaction</button></div>
  </section>;
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

function AppMenu({ open, onToggle, onAgentAccess, onAccountData, onSignOut }: {
  open: boolean; onToggle: () => void; onAgentAccess: () => void; onAccountData: () => void; onSignOut: () => void;
}) {
  return <div className="app-menu"><button type="button" className="header-menu-button" aria-label="Open application menu"
    aria-expanded={open} onClick={onToggle}><span aria-hidden="true">☰</span></button>
    {open && <div className="app-menu-popover" role="menu">
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
      <p className="muted">Generate a private bearer token here, then enter this MCP URL and token in your agent's Add MCP dialog.</p>

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
  const [showTransactionComposer, setShowTransactionComposer] = useState(false);
  const [verification, setVerification] = useState("");
  const [showAgentAccess, setShowAgentAccess] = useState(false);
  const [showAccountData, setShowAccountData] = useState(false);
  const [showAppMenu, setShowAppMenu] = useState(false);
  const [deletionRequest, setDeletionRequest] = useState<{
    scope: "all" | "selected"; transactionIds: number[]; deleteAccounts: boolean;
    deleteImportHistory: boolean;
  } | null>(null);
  const [showMisfits, setShowMisfits] = useState(() => window.location.hash === "#import-misfits");
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
    setShowMisfits(false);
    if (window.location.hash === "#import-misfits") {
      window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    revealMainContent();
  }

  function selectMisfits() {
    setSelectedAccountId(null);
    setShowMisfits(true);
    if (window.location.hash !== "#import-misfits") {
      window.history.pushState(null, "", "#import-misfits");
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
      setShowMisfits(misfits);
      if (misfits) setSelectedAccountId(null);
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
    if (selectedAccountId != null && !accounts.some((account) => account.id === selectedAccountId)) setSelectedAccountId(null);
  }, [accounts, selectedAccountId]);

  function authenticated(nextToken: string, nextUser: User) {
    localStorage.setItem(tokenKey, nextToken); setToken(nextToken); setUser(nextUser);
  }
  function logout() {
    localStorage.removeItem(tokenKey); setToken(null); setUser(null); setSelectedAccountId(null);
    setImportJobs([]); setTransactions([]); setSelected(null); setShowMisfits(false);
    setShowAppMenu(false); setShowAgentAccess(false); setShowAccountData(false); setDeletionRequest(null);
  }
  async function refreshAfterTransaction() {
    await refresh();
    setAccountLedgerRefresh((current) => current + 1);
    setShowTransactionComposer(false);
  }
  async function selectTransaction(id: number) {
    if (!token) return;
    const result = await api<{ transaction: TransactionDetail }>(`/transactions/${id}`, {}, token); setSelected(result.transaction);
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
  return <div className="app-shell"><header><div><p className="eyebrow">Chapeaux Fous</p><h1>Accounting</h1></div><div className="user-menu"><span>{user.name}</span>
    <AppMenu open={showAppMenu} onToggle={() => setShowAppMenu((current) => !current)}
      onAccountData={() => { setShowAppMenu(false); setShowAccountData(true); }}
      onAgentAccess={() => { setShowAppMenu(false); setShowAgentAccess(true); }}
      onSignOut={logout} /></div></header>
    <main className="workspace"><AccountPanel accounts={accounts} currencies={currencies}
      importJobs={importJobs} selectedAccountId={selectedAccountId} misfitsSelected={showMisfits} token={token}
      onSelectAccount={selectAccount} onSelectMisfits={selectMisfits} onChanged={refresh} />
      <div id="import-misfits" className="main-column" ref={mainContentRef} tabIndex={-1}>{showMisfits
          ? <ImportMisfits jobs={importJobs} accounts={accounts} currencies={currencies} token={token} onChanged={refresh} />
          : selectedAccount
          ? <AccountRegister account={selectedAccount} entries={accountLedgerEntries} assertions={assertions}
              loading={accountLedgerLoading} error={accountLedgerError} token={token}
              onShowAll={() => setSelectedAccountId(null)} onNewTransaction={() => setShowTransactionComposer(true)}
              onChanged={refresh} />
          : <Ledger transactions={transactions} selected={selected} onSelect={(id) => void selectTransaction(id)}
              onDelete={(id) => setDeletionRequest({ scope: "selected", transactionIds: [id],
                deleteAccounts: false, deleteImportHistory: false })}
              onVerify={() => void verify()} verification={verification} />}</div></main>
    {showAgentAccess && <AgentAccessDialog loginToken={token} onClose={() => setShowAgentAccess(false)} />}
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
    {showTransactionComposer && <TransactionComposerDialog accounts={accounts} currencies={currencies}
      initialAccountId={selectedAccount && !selectedAccount.placeholder && !selectedAccount.archivedAt ? selectedAccount.id : null}
      token={token} onCreated={refreshAfterTransaction} onClose={() => setShowTransactionComposer(false)} />}
  </div>;
}
