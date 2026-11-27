import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { InvoicePaymentCredit, InvoicePaymentTarget } from "./InvoicePaymentForm";
import type { Account } from "./types";

export function isInvoiceDeposit(target: InvoicePaymentTarget, account: Account | undefined, amountUnits: string) {
  return account?.type === "asset" && account.id !== target.receivableAccountId && !account.suspense
    && !account.placeholder && account.currencyCode === target.currency && BigInt(amountUnits) > 0n;
}

export default function LedgerInvoicePaymentPicker({ target, lineItemId, token, onChoose, label }: {
  target: InvoicePaymentTarget; lineItemId: number; token: string; label?: string;
  onChoose: (credit: InvoicePaymentCredit) => void;
}) {
  const [credits, setCredits] = useState<InvoicePaymentCredit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function selectPayment() {
    setBusy(true);
    setError("");
    setCredits(null);
    try {
      const result = await api<{ options: InvoicePaymentCredit[] }>(
        `/invoices/${target.invoiceId}/payment-deposit/${lineItemId}`, {}, token);
      if (!active.current) return;
      if (result.options.length === 1) onChoose(result.options[0]);
      else setCredits(result.options);
    } catch (error) {
      if (active.current) setError(error instanceof Error ? error.message : "Could not check this transaction.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency: target.currency });
  return <div className="ledger-invoice-payment">
    <button type="button" className="secondary" disabled={busy}
      onClick={(event) => { event.stopPropagation(); void selectPayment(); }}
      onKeyDown={(event) => event.stopPropagation()}
      aria-label={`Apply deposit${label ? ` ${label}` : ""} to invoice #${target.invoiceNumber}`}>
      {label ? `Apply ${label}` : "Apply deposit"}
    </button>
    {busy && <small role="status">Checking deposit…</small>}
    {error && <p className="error" role="alert">{error}</p>}
    {credits && credits.length > 1 && <div className="ledger-invoice-payment-splits">
      <strong>Which part of this deposit pays the invoice?</strong>
      {credits.map((credit) => <button type="button" className="secondary" key={credit.lineItemId}
        onClick={(event) => { event.stopPropagation(); onChoose(credit); }} onKeyDown={(event) => event.stopPropagation()}>
        {credit.offsetAccountName} · {formatter.format(credit.availableMinor / 10 ** target.scale)} available
        {credit.offsetMemo ? ` · ${credit.offsetMemo}` : ""}
      </button>)}
    </div>}
  </div>;
}
