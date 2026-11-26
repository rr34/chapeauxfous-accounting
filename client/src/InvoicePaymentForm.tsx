import { useRef, useState } from "react";
import AccountCombobox from "./AccountCombobox";
import { accountFullNames } from "./account-names";
import { decimalToUnits, unitsToDecimal } from "./money";
import type { Account } from "./types";

export type InvoicePayment = { id: string; transactionId: number; amountMinor: number; date: string };
export type InvoicePaymentCredit = {
  lineItemId: number; transactionId: number; date: string; description: string | null;
  accountName: string; fromSuspense: boolean; availableMinor: number;
};
type PaymentDetails = { method: "record"; receiving_account_id: number; payment_date: string; memo: string }
  | { method: "link"; line_item_id: number };
export type InvoicePaymentInput = PaymentDetails & { amount_minor: number; request_id: string; revision: string };

export default function InvoicePaymentForm({ currency, scale, remaining, revision, receivableAccountId, accounts, today,
  busy, onFindCredits, onApply, onCancel }: {
  currency: string; scale: number; remaining: number; revision: string; receivableAccountId: number; accounts: Account[];
  today: string; busy: boolean;
  onFindCredits: (text: string) => Promise<InvoicePaymentCredit[]>;
  onApply: (input: InvoicePaymentInput) => void;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState<"record" | "link">("record");
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [text, setText] = useState("");
  const [credits, setCredits] = useState<InvoicePaymentCredit[] | null>(null);
  const [creditId, setCreditId] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [amount, setAmount] = useState(unitsToDecimal(String(remaining), scale));
  const request = useRef<{ key: string; id: string } | null>(null);
  const names = accountFullNames(accounts);
  const choices = accounts.filter((item) => item.type === "asset" && item.currencyCode === currency
    && !item.placeholder && !item.suspense && item.archivedAt == null && item.id !== receivableAccountId)
    .map((item) => ({ value: String(item.id), label: names.get(item.id) ?? item.name, currencyCode: currency }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const credit = credits?.find((item) => String(item.lineItemId) === creditId);
  const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
  const money = (value: number) => formatter.format(value / 10 ** scale);
  const amountMinor = (() => {
    try { return Number(decimalToUnits(amount, scale)); }
    catch { return NaN; }
  })();
  const limit = Math.min(remaining, credit?.availableMinor ?? remaining);
  const validAmount = Number.isSafeInteger(amountMinor) && amountMinor > 0 && amountMinor <= limit;
  const canApply = validAmount && (method === "record" ? Boolean(account && date) : Boolean(credit));

  async function search(query: string) {
    setSearching(true);
    setSearchError("");
    setCreditId("");
    try { setCredits(await onFindCredits(query.trim())); }
    catch (error) {
      setCredits(null);
      setSearchError(error instanceof Error ? error.message : "Could not load ledger payments.");
    } finally { setSearching(false); }
  }

  function apply() {
    if (!canApply) return;
    const details: PaymentDetails = method === "record"
      ? { method, receiving_account_id: Number(account), payment_date: date, memo }
      : { method, line_item_id: Number(creditId) };
    const input = { ...details, revision, amount_minor: amountMinor };
    const key = JSON.stringify(input);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    onApply({ ...input, request_id: request.current.id });
  }

  return <section className="invoice-confirmation" aria-label="Apply payment">
    <h3>Apply payment</h3>
    <label>Payment source<select value={method} disabled={busy || searching} onChange={(event) => {
      const next = event.target.value as typeof method;
      setMethod(next);
      if (next === "link" && credits == null) void search(text);
      if (next === "record") setCreditId("");
    }}>
      <option value="record">Record a new payment</option>
      <option value="link">Link an existing payment</option>
    </select></label>
    {method === "record" ? <>
      <div className="invoice-create-grid">
        <div className="invoice-line-account">
          <label htmlFor="invoice-payment-account">Receiving account</label>
          <AccountCombobox id="invoice-payment-account" label="Receiving account" value={account}
            choices={choices} onChange={setAccount} disabled={busy} clearOnType={false} />
        </div>
        <label>Payment date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} disabled={busy} /></label>
      </div>
      <label>Memo<input value={memo} maxLength={500} onChange={(event) => setMemo(event.target.value)} disabled={busy} /></label>
    </> : <>
      <div className="invoice-inline-form">
        <label>Find a ledger payment<input type="search" value={text} maxLength={255} disabled={busy || searching}
          onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void search(text); }
          }} /></label>
        <button type="button" className="secondary" disabled={busy || searching} onClick={() => void search(text)}>Search ledger</button>
      </div>
      {searchError && <p className="error" role="alert">{searchError}</p>}
      {searching && <p role="status">Finding ledger payments…</p>}
      {credits && credits.length > 0 && <label>Ledger payment<select value={creditId} disabled={busy || searching}
        onChange={(event) => {
          const value = event.target.value;
          setCreditId(value);
          const next = credits.find((item) => String(item.lineItemId) === value);
          if (next) setAmount(unitsToDecimal(String(Math.min(remaining, next.availableMinor)), scale));
        }}>
        <option value="">Choose a payment</option>
        {credits.map((item) => <option key={item.lineItemId} value={item.lineItemId}>
          {item.date} · {item.description || `Transaction #${item.transactionId}`} · {item.accountName} · {money(item.availableMinor)} available
        </option>)}
      </select></label>}
      {credits?.length === 0 && !searching && <p>No eligible receipts found.</p>}
      {credit?.fromSuspense && <p>The applied amount will move from {credit.accountName} to Accounts Receivable.</p>}
    </>}
    <label>Payment amount ({currency})<input inputMode="decimal" value={amount} disabled={busy}
      onChange={(event) => setAmount(event.target.value)} /></label>
    {validAmount ? <p>Balance after payment <strong>{money(remaining - amountMinor)}</strong></p>
      : <p>Enter a positive amount up to {money(limit)}.</p>}
    <div className="invoice-actions">
      <button type="button" className="primary" disabled={busy || searching || !canApply} onClick={apply}>Apply payment</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel payment</button>
    </div>
  </section>;
}
