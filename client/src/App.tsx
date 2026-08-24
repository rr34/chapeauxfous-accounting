import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, ApiError, mcpEndpointUrl } from "./api";
import { decimalToUnits, parseTags, unitsToDecimal } from "./money";
import type {
  Account, ApiTokenCredential, BalanceAssertion, CreatedApiToken, Currency,
  TransactionDetail, TransactionSummary, User,
} from "./types";

const tokenKey = "cf-accounting-token";
const today = () => new Date().toISOString().slice(0, 10);

function errorMessage(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong.";
}

type AuthProps = { onAuthenticated: (token: string, user: User) => void };

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

function AccountPanel({ accounts, assertions, currencies, token, onChanged }: {
  accounts: Account[]; assertions: BalanceAssertion[]; currencies: Currency[];
  token: string; onChanged: () => Promise<void>;
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
        {currencies.map((currency) => <option key={currency.id} value={currency.id}>{currency.code}</option>)}
      </select></div>
      <select value={parentAccountId} onChange={(event) => setParentAccountId(event.target.value)}>
        <option value="">No parent</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select>
      <label className="checkbox-field"><input type="checkbox" checked={placeholder}
        onChange={(event) => setPlaceholder(event.target.checked)} />Placeholder (cannot receive transactions)</label>
      {error && <p className="error">{error}</p>}<button className="primary">Add account</button>
    </form>}
    <div className="account-list">{accounts.map((account) => <div className="account-row" key={account.id}>
      <div><strong>{account.name}</strong><span>{account.type} · {account.currencyCode}{account.placeholder ? " · placeholder" : ""}</span>
        {account.description && <small>{account.description}</small>}</div>
      <b>{unitsToDecimal(account.balanceUnits, account.scale)}</b>
    </div>)}</div>
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
  </aside>;
}

type EditableLine = { accountId: string; amount: string; memo: string; tags: string };
type EditableRate = { fromAmount: string; toAmount: string };

function TransactionComposer({ accounts, currencies, token, onCreated }: {
  accounts: Account[]; currencies: Currency[]; token: string; onCreated: () => Promise<void>;
}) {
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(today());
  const [valuationCurrencyId, setValuationCurrencyId] = useState<number | "">("");
  const [lines, setLines] = useState<EditableLine[]>([
    { accountId: "", amount: "", memo: "", tags: "" }, { accountId: "", amount: "", memo: "", tags: "" },
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
      setDescription(""); setDate(today()); setLines([{ accountId: "", amount: "", memo: "", tags: "" }, { accountId: "", amount: "", memo: "", tags: "" }]);
      setRates({}); await onCreated();
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  return <section className="composer card">
    <div className="section-heading"><div><p className="eyebrow">New entry</p><h2>Balanced transaction</h2></div></div>
    <form onSubmit={submit}>
      <div className="transaction-meta"><label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What happened?" /></label>
        <label>Value currency<select required value={valuationCurrencyId}
          onChange={(event) => setValuationCurrencyId(event.target.value ? Number(event.target.value) : "")}>
          <option value="">Choose currency…</option>
          {currencies.map((currency) => <option key={currency.id} value={currency.id}>{currency.code}</option>)}</select></label></div>
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
  const [verification, setVerification] = useState("");
  const [showAgentAccess, setShowAgentAccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => { api<{ currencies: Currency[] }>("/currencies").then((result) => setCurrencies(result.currencies)).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    if (!token) { setUser(null); return; }
    api<{ user: User }>("/auth/me", {}, token).then((result) => setUser(result.user)).catch(() => {
      localStorage.removeItem(tokenKey); setToken(null);
    });
  }, [token]);

  async function refresh() {
    if (!token) return;
    const [accountResult, assertionResult, transactionResult] = await Promise.all([
      api<{ accounts: Account[] }>("/accounts", {}, token),
      api<{ assertions: BalanceAssertion[] }>("/balance-assertions", {}, token),
      api<{ transactions: TransactionSummary[] }>("/transactions", {}, token),
    ]);
    setAccounts(accountResult.accounts); setAssertions(assertionResult.assertions); setTransactions(transactionResult.transactions);
  }
  useEffect(() => { if (token && user) void refresh(); }, [token, user]);

  function authenticated(nextToken: string, nextUser: User) {
    localStorage.setItem(tokenKey, nextToken); setToken(nextToken); setUser(nextUser);
  }
  function logout() { localStorage.removeItem(tokenKey); setToken(null); setUser(null); }
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
  return <div className="app-shell"><header><div><p className="eyebrow">Chapeaux Fous</p><h1>Accounting</h1></div><div className="user-menu"><span>{user.name}</span>
    <button className="header-action" onClick={() => setShowAgentAccess(true)}>Agent access</button>
    <button className="link-button" onClick={logout}>Sign out</button></div></header>
    <main className="workspace"><AccountPanel accounts={accounts} assertions={assertions} currencies={currencies}
      token={token} onChanged={refresh} />
      <div className="main-column"><TransactionComposer accounts={accounts} currencies={currencies} token={token} onCreated={refresh} />
        <Ledger transactions={transactions} selected={selected} onSelect={(id) => void selectTransaction(id)} onVerify={() => void verify()} verification={verification} /></div></main>
    {showAgentAccess && <AgentAccessDialog loginToken={token} onClose={() => setShowAgentAccess(false)} />}
  </div>;
}
