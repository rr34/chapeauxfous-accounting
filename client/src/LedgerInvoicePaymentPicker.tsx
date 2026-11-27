import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { InvoicePaymentCredit, InvoicePaymentTarget } from "./InvoicePaymentForm";
import type { TransactionDetail } from "./types";

export default function LedgerInvoicePaymentPicker({ target, transaction, token, onChoose }: {
  target: InvoicePaymentTarget; transaction: TransactionDetail; token: string;
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
      const result = await api<{ credits: InvoicePaymentCredit[] }>(
        `/invoices/${target.invoiceId}/payment-credits?transactionId=${transaction.id}`, {}, token);
      if (!active.current) return;
      if (result.credits.length === 1) onChoose(result.credits[0]);
      else setCredits(result.credits);
    } catch (error) {
      if (active.current) setError(error instanceof Error ? error.message : "Could not check this transaction.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency: target.currency });
  return <div className="ledger-invoice-payment">
    <button type="button" className="secondary" disabled={busy || transaction.state !== "posted"}
      onClick={() => void selectPayment()}>Use as payment for invoice #{target.invoiceNumber}</button>
    {transaction.state !== "posted" && <small>Only posted transactions can be applied.</small>}
    {busy && <small role="status">Checking payment splits…</small>}
    {error && <p className="error" role="alert">{error}</p>}
    {credits?.length === 0 && <p role="status">
      No available payment credit in this transaction. Look for a credit in this invoice’s A/R account or an unreconciled suspense account.
    </p>}
    {credits && credits.length > 1 && <div className="ledger-invoice-payment-splits">
      <strong>Choose a payment split</strong>
      {credits.map((credit) => {
        const line = transaction.lineItems.find((item) => item.id === credit.lineItemId);
        return <button type="button" className="secondary" key={credit.lineItemId} onClick={() => onChoose(credit)}>
          {credit.accountName} · {formatter.format(credit.availableMinor / 10 ** target.scale)} available
          {line?.memo ? ` · ${line.memo}` : ""} · Split #{credit.lineItemId}
        </button>;
      })}
    </div>}
  </div>;
}
