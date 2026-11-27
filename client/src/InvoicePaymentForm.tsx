import { useRef, useState } from "react";
import AccountCombobox from "./AccountCombobox";
import { accountFullNames } from "./account-names";
import { decimalToUnits, unitsToDecimal } from "./money";
import type { Account } from "./types";

export type InvoicePayment = {
  id: string; transactionId: number; amountMinor: number; date: string;
  description?: string | null; receivingAccountNames?: string[];
  receivingAccounts?: { accountId: number; accountName: string }[];
};
export type InvoicePaymentCredit = {
  lineItemId: number; transactionId: number; date: string; description: string | null;
  accountName: string; fromSuspense: boolean; availableMinor: number;
};
export type InvoicePaymentTarget = { invoiceId: string; invoiceNumber: number; currency: string; scale: number };
export type InvoicePaymentReturn = { invoiceId: string; credit?: InvoicePaymentCredit };
type PaymentDetails = { method: "record"; receiving_account_id: number; payment_date: string; memo: string }
  | { method: "link"; line_item_id: number };
export type InvoicePaymentInput = PaymentDetails & { amount_minor: number; request_id: string; revision: string };

export default function InvoicePaymentForm({ currency, scale, remaining, revision, receivableAccountId, accounts, today,
  busy, credit, onFindPayment, onApply, onCancel }: {
  currency: string; scale: number; remaining: number; revision: string; receivableAccountId: number; accounts: Account[];
  today: string; busy: boolean;
  credit: InvoicePaymentCredit | null; onFindPayment: () => void;
  onApply: (input: InvoicePaymentInput) => void;
  onCancel: () => void;
}) {
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(today);
  const [memo, setMemo] = useState("");
  const limit = Math.min(remaining, credit?.availableMinor ?? remaining);
  const [amount, setAmount] = useState(unitsToDecimal(String(limit), scale));
  const request = useRef<{ key: string; id: string } | null>(null);
  const names = accountFullNames(accounts);
  const choices = accounts.filter((item) => item.type === "asset" && item.currencyCode === currency
    && !item.placeholder && !item.suspense && item.archivedAt == null && item.id !== receivableAccountId)
    .map((item) => ({ value: String(item.id), label: names.get(item.id) ?? item.name, currencyCode: currency }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
  const money = (value: number) => formatter.format(value / 10 ** scale);
  const amountMinor = (() => {
    try { return Number(decimalToUnits(amount, scale)); }
    catch { return NaN; }
  })();
  const validAmount = Number.isSafeInteger(amountMinor) && amountMinor > 0 && amountMinor <= limit;
  const canApply = validAmount && Boolean(credit || (account && date));

  function apply() {
    if (!canApply) return;
    const details: PaymentDetails = credit
      ? { method: "link", line_item_id: credit.lineItemId }
      : { method: "record", receiving_account_id: Number(account), payment_date: date, memo };
    const input = { ...details, revision, amount_minor: amountMinor };
    const key = JSON.stringify(input);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    onApply({ ...input, request_id: request.current.id });
  }

  return <section className="invoice-confirmation" aria-label="Apply payment">
    <h3>Apply payment</h3>
    <div className="invoice-actions">
      <button type="button" className="secondary" disabled={busy} onClick={onFindPayment}>
        {credit ? "Choose a different payment in ledger" : "Find payment in ledger"}
      </button>
    </div>
    {!credit ? <>
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
      <p>Transaction #{credit.transactionId} · {credit.date} · {credit.description || "Payment"}</p>
      <p>{credit.accountName} · {money(credit.availableMinor)} available</p>
      {credit.fromSuspense && <p>The applied amount will move from {credit.accountName} to {names.get(receivableAccountId) ?? "Accounts Receivable"}.</p>}
    </>}
    <label>Payment amount ({currency})<input inputMode="decimal" value={amount} disabled={busy}
      onChange={(event) => setAmount(event.target.value)} /></label>
    {validAmount ? <p>Balance after payment <strong>{money(remaining - amountMinor)}</strong></p>
      : <p>Enter a positive amount up to {money(limit)}.</p>}
    {credit && validAmount && credit.availableMinor > amountMinor &&
      <p>{money(credit.availableMinor - amountMinor)} will remain available on this payment.</p>}
    <div className="invoice-actions">
      <button type="button" className="primary" disabled={busy || !canApply} onClick={apply}>Apply payment</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel payment</button>
    </div>
  </section>;
}
