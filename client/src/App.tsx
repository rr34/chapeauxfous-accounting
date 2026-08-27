import { FormEvent, Fragment, useEffect, useMemo, useState } from "react";
import { api, ApiError, mcpEndpointUrl } from "./api";
import { decimalToUnits, parseTags, unitsToDecimal } from "./money";
import type {
  Account, AccountLedgerEntry, ApiTokenCredential, BalanceAssertion, CreatedApiToken, Currency,
  CurrencyType, TransactionDetail, TransactionSummary, User,
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
  const [busyAction, setBusyAction] = useState<"save" | "delete" | "">("");
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
    if (!window.confirm(`Permanently delete “${account.name}”? Accounts with children, transactions, or balance assertions cannot be deleted.`)) return;
    setBusyAction("delete"); setError("");
    try {
      await api(`/accounts/${account.id}`, { method: "DELETE" }, token);
      await onChanged(); onClose();
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
        {error && <p className="error">{error}</p>}
        <div className="account-dialog-actions"><button type="button" className="danger-button" disabled={Boolean(busyAction)}
          onClick={() => void remove()}>{busyAction === "delete" ? "Deleting…" : "Delete account"}</button>
          <button className="primary" disabled={Boolean(busyAction)}>{busyAction === "save" ? "Saving…" : "Save changes"}</button></div>
      </form>
    </section>
  </div>;
}

function AccountPanel({ accounts, assertions, currencies, selectedAccountId, token, onSelectAccount, onChanged }: {
  accounts: Account[]; assertions: BalanceAssertion[]; currencies: Currency[];
  selectedAccountId: number | null; token: string;
  onSelectAccount: (account: Account) => void; onChanged: () => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [placeholder, setPlaceholder] = useState(false);
  const [type, setType] = useState<Account["type"] | "">("");
  const [currencyId, setCurrencyId] = useState<number | "">("");
  const [parentAccountId, setParentAccountId] = useState("");
  const [error, setError] = useState("");
  const [assertionAccountId, setAssertionAccountId] = useState("");
  const [assertionDate, setAssertionDate] = useState(today());
  const [knownBalance, setKnownBalance] = useState("");
  const [assertionError, setAssertionError] = useState("");
  const [assertionBusy, setAssertionBusy] = useState(false);
  const [showCurrencyForm, setShowCurrencyForm] = useState(false);
  const [currencyCode, setCurrencyCode] = useState("");
  const [currencyDisplayName, setCurrencyDisplayName] = useState("");
  const [currencyType, setCurrencyType] = useState<Exclude<CurrencyType, "iso_4217">>("security");
  const [currencyScale, setCurrencyScale] = useState("4");
  const [currencyError, setCurrencyError] = useState("");
  const [currencyBusy, setCurrencyBusy] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);

  useEffect(() => {
    if (assertionAccountId && !accounts.some((account) => account.id === Number(assertionAccountId))) setAssertionAccountId("");
  }, [accounts, assertionAccountId]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      await api("/accounts", { method: "POST", body: JSON.stringify({ name, description, placeholder, type, currencyId: Number(currencyId),
        parentAccountId: parentAccountId ? Number(parentAccountId) : null }) }, token);
      setName(""); setDescription(""); setPlaceholder(false); setShowForm(false); await onChanged();
    } catch (nextError) { setError(errorMessage(nextError)); }
  }

  async function saveAssertion(event: FormEvent) {
    event.preventDefault(); setAssertionBusy(true); setAssertionError("");
    try {
      const account = accounts.find((candidate) => candidate.id === Number(assertionAccountId));
      if (!account) throw new Error("Choose an account.");
      await api("/balance-assertions", { method: "POST", body: JSON.stringify({
        accountId: account.id,
        balanceDate: assertionDate,
        knownBalanceUnits: decimalToUnits(knownBalance, account.scale),
      }) }, token);
      setKnownBalance(""); await onChanged();
    } catch (nextError) { setAssertionError(errorMessage(nextError)); }
    finally { setAssertionBusy(false); }
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
    <section className="assertions-panel">
      <div><p className="eyebrow">Reconciliation</p><h3>Known balances</h3></div>
      <form className="assertion-form" onSubmit={saveAssertion}>
        <select aria-label="Account" required value={assertionAccountId} onChange={(event) => setAssertionAccountId(event.target.value)}>
          <option value="">Choose account…</option>
          {accounts.filter((account) => !account.archivedAt && !account.placeholder).map((account) =>
            <option key={account.id} value={account.id}>{account.name} ({account.currencyCode})</option>)}
        </select>
        <div className="form-row"><input aria-label="End of date" type="date" required value={assertionDate}
          onChange={(event) => setAssertionDate(event.target.value)} />
          <input aria-label="Known ending balance" required placeholder="Known balance" value={knownBalance}
            onChange={(event) => setKnownBalance(event.target.value)} /></div>
        {assertionError && <p className="error">{assertionError}</p>}
        <button className="secondary" disabled={assertionBusy}>{assertionBusy ? "Saving…" : "Save balance"}</button>
      </form>
      <div className="assertion-list">{assertions.map((assertion) =>
        <div className={`assertion-row ${assertion.matches ? "matches" : "mismatch"}`} key={assertion.id}>
          <div><strong>{assertion.accountName}</strong><span>{assertion.date} · {assertion.currencyCode}</span></div>
          <div className="assertion-values"><span>Known {unitsToDecimal(assertion.knownBalanceUnits, assertion.scale)}</span>
            <span>Ledger {unitsToDecimal(assertion.calculatedBalanceUnits, assertion.scale)}</span>
            <b>{assertion.matches ? "Matches" : `Difference ${unitsToDecimal(assertion.differenceUnits, assertion.scale)}`}</b></div>
        </div>)}
        {!assertions.length && <p className="assertion-empty">No known balances recorded.</p>}
      </div>
    </section>
    {editingAccount && <AccountEditDialog key={editingAccount.id} account={editingAccount} accounts={accounts} currencies={currencies}
      token={token} onClose={() => setEditingAccount(null)} onChanged={onChanged} />}
  </aside>;
}

type EditableLine = { accountId: string; amount: string; memo: string; tags: string };
type EditableRate = { fromAmount: string; toAmount: string };

function TransactionComposer({ accounts, currencies, initialAccountId, token, onCreated }: {
  accounts: Account[]; currencies: Currency[]; initialAccountId: number | null;
  token: string; onCreated: () => Promise<void>;
}) {
  const initialAccount = accounts.find((account) => account.id === initialAccountId);
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(today());
  const [valuationCurrencyId, setValuationCurrencyId] = useState<number | "">(initialAccount?.currencyId ?? "");
  const [lines, setLines] = useState<EditableLine[]>([
    { accountId: initialAccountId == null ? "" : String(initialAccountId), amount: "", memo: "", tags: "" },
    { accountId: "", amount: "", memo: "", tags: "" },
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
        return { accountId: account.id, amountUnits: decimalToUnits(line.amount, account.scale), memo: line.memo, tags: parseTags(line.tags) };
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
        { accountId: initialAccountId == null ? "" : String(initialAccountId), amount: "", memo: "", tags: "" },
        { accountId: "", amount: "", memo: "", tags: "" },
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
      <div className="line-editor"><div className="line-head"><span>Account</span><span>Native amount</span><span>Memo</span><span>Tags</span><span /></div>
        {lines.map((line, index) => <div className="line-grid" key={index}>
          <select value={line.accountId} onChange={(event) => updateLine(index, { accountId: event.target.value })}><option value="">Choose…</option>
            {accounts.filter((account) => !account.archivedAt && !account.placeholder).map((account) => <option key={account.id} value={account.id}>{account.name} ({account.currencyCode})</option>)}</select>
          <input value={line.amount} onChange={(event) => updateLine(index, { amount: event.target.value })} placeholder="+100 or -100" />
          <input value={line.memo} onChange={(event) => updateLine(index, { memo: event.target.value })} placeholder="Optional" />
          <input value={line.tags} onChange={(event) => updateLine(index, { tags: event.target.value })} placeholder="job:main, tax:repair" />
          <button type="button" className="quiet" disabled={lines.length <= 2} onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}>×</button>
        </div>)}</div>
      <button type="button" className="secondary" onClick={() => setLines((current) => [...current, { accountId: "", amount: "", memo: "", tags: "" }])}>Add split</button>
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
  return <div className="dialog-backdrop" role="presentation">
    <section className="agent-dialog transaction-dialog" role="dialog" aria-modal="true" aria-labelledby="transaction-dialog-title">
      <div className="dialog-heading"><div><p className="eyebrow">New entry</p>
        <h2 id="transaction-dialog-title">Balanced transaction</h2></div>
        <button className="dialog-close" aria-label="Close transaction composer" onClick={onClose}>×</button></div>
      <TransactionComposer accounts={accounts} currencies={currencies} initialAccountId={initialAccountId}
        token={token} onCreated={onCreated} />
    </section>
  </div>;
}

function Ledger({ transactions, selected, onSelect, onVerify, verification }: {
  transactions: TransactionSummary[]; selected: TransactionDetail | null; onSelect: (id: number) => void;
  onVerify: () => void; verification: string;
}) {
  return <section className="ledger card"><div className="section-heading"><div><p className="eyebrow">Activity</p><h2>Ledger</h2></div>
    <button className="secondary" onClick={onVerify}>Verify ledger</button></div>{verification && <p className="verification">{verification}</p>}
    <div className="ledger-layout"><div className="transaction-list">{transactions.map((transaction) => <button key={transaction.id}
      className={`transaction-row ${selected?.id === transaction.id ? "selected" : ""}`} onClick={() => onSelect(transaction.id)}>
      <span>{transaction.date}</span><strong>{transaction.description || "Untitled transaction"}</strong><small>{transaction.lineItemCount} lines · {transaction.state}</small>
    </button>)}</div>
    <div className="transaction-detail">{selected ? <><div className="detail-title"><div><h3>{selected.description || "Untitled transaction"}</h3><p>{selected.date} · {selected.state}</p></div><span>#{selected.id}</span></div>
      {selected.lineItems.map((line) => <div className="detail-line" key={line.id}><div><strong>{line.accountName}</strong><small>{line.memo}</small>
        {line.tags.length > 0 && <div className="tag-list">{line.tags.map((tag) => <span key={`${tag.key}:${tag.value}`}>{tag.key}:{tag.value}</span>)}</div>}</div>
        <b>{unitsToDecimal(line.amountUnits, line.scale)} {line.currencyCode}</b></div>)}</> : <p className="empty-state">Select a transaction to see its complete balanced entry.</p>}</div></div>
  </section>;
}

function AccountRegister({ account, entries, loading, error, onShowAll, onNewTransaction }: {
  account: Account; entries: AccountLedgerEntry[]; loading: boolean; error: string;
  onShowAll: () => void; onNewTransaction: () => void;
}) {
  const [view, setView] = useState<"basic" | "auto-split" | "journal">("basic");
  const [activeTransactionId, setActiveTransactionId] = useState<number | null>(null);
  const debitIncreases = account.type === "asset" || account.type === "expense";
  const debitEffect = debitIncreases ? "increases" : "decreases";
  const creditEffect = debitIncreases ? "decreases" : "increases";

  useEffect(() => { setActiveTransactionId(null); }, [account.id]);

  function activateTransaction(transactionId: number) {
    if (view === "auto-split") setActiveTransactionId(transactionId);
  }

  return <section className="account-register card">
    <div className="section-heading"><div><p className="eyebrow">Account register</p><h2>{account.name}</h2>
      <p className="register-subtitle">Posted transactions · {account.currencyCode}</p></div>
      <button className="secondary" onClick={onShowAll}>All activity</button></div>
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
      : !error && entries.length === 0 ? <p className="register-message">No posted transactions in this account.</p>
      : !error && <div className="register-table-wrap"><table className="register-table">
        <thead><tr><th>Date</th><th>Description</th><th>Split account</th>
          <th>Debit <span>({debitEffect} {account.type})</span></th>
          <th>Credit <span>({creditEffect} {account.type})</span></th><th>Running balance</th></tr></thead>
        <tbody>{entries.map((entry) => {
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
            </tr>
            {expanded && <tr className="register-splits-row"><td colSpan={6}>
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
  const [selected, setSelected] = useState<TransactionDetail | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [accountLedgerEntries, setAccountLedgerEntries] = useState<AccountLedgerEntry[]>([]);
  const [accountLedgerLoading, setAccountLedgerLoading] = useState(false);
  const [accountLedgerError, setAccountLedgerError] = useState("");
  const [accountLedgerRefresh, setAccountLedgerRefresh] = useState(0);
  const [showTransactionComposer, setShowTransactionComposer] = useState(false);
  const [verification, setVerification] = useState("");
  const [showAgentAccess, setShowAgentAccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setUser(null); setCurrencies([]); setLoading(false); return; }
    setLoading(true);
    api<{ user: User }>("/auth/me", {}, token).then((result) => setUser(result.user)).catch(() => {
      localStorage.removeItem(tokenKey); setToken(null);
    }).finally(() => setLoading(false));
  }, [token]);

  async function refresh() {
    if (!token) return;
    const [currencyResult, accountResult, assertionResult, transactionResult] = await Promise.all([
      api<{ currencies: Currency[] }>("/currencies", {}, token),
      api<{ accounts: Account[] }>("/accounts", {}, token),
      api<{ assertions: BalanceAssertion[] }>("/balance-assertions", {}, token),
      api<{ transactions: TransactionSummary[] }>("/transactions", {}, token),
    ]);
    setCurrencies(currencyResult.currencies); setAccounts(accountResult.accounts);
    setAssertions(assertionResult.assertions); setTransactions(transactionResult.transactions);
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
  function logout() { localStorage.removeItem(tokenKey); setToken(null); setUser(null); setSelectedAccountId(null); }
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
    <button className="header-action" onClick={() => setShowAgentAccess(true)}>Agent access</button>
    <button className="link-button" onClick={logout}>Sign out</button></div></header>
    <main className="workspace"><AccountPanel accounts={accounts} assertions={assertions} currencies={currencies}
      selectedAccountId={selectedAccountId} token={token} onSelectAccount={(account) => setSelectedAccountId(account.id)} onChanged={refresh} />
      <div className="main-column">{selectedAccount
          ? <AccountRegister account={selectedAccount} entries={accountLedgerEntries} loading={accountLedgerLoading}
              error={accountLedgerError} onShowAll={() => setSelectedAccountId(null)}
              onNewTransaction={() => setShowTransactionComposer(true)} />
          : <Ledger transactions={transactions} selected={selected} onSelect={(id) => void selectTransaction(id)}
              onVerify={() => void verify()} verification={verification} />}</div></main>
    {showAgentAccess && <AgentAccessDialog loginToken={token} onClose={() => setShowAgentAccess(false)} />}
    {showTransactionComposer && <TransactionComposerDialog accounts={accounts} currencies={currencies}
      initialAccountId={selectedAccount && !selectedAccount.placeholder && !selectedAccount.archivedAt ? selectedAccount.id : null}
      token={token} onCreated={refreshAfterTransaction} onClose={() => setShowTransactionComposer(false)} />}
  </div>;
}
