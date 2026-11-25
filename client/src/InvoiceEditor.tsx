import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { decimalToUnits } from "./money";

export type PaymentMethods = "ach_only" | "card_only" | "card_and_ach";
export type EditableInvoiceLine = {
  key: string; description: string; amount: string; todoRef?: string | null; receiptRef?: string | null;
};
export type InvoiceDraftFields = {
  payer: string; email: string; description: string; currency: string; due: string;
  methods: PaymentMethods; lines: EditableInvoiceLine[];
};

export function invoiceCurrencyScale(currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export const blankInvoiceLine = (): EditableInvoiceLine => ({ key: crypto.randomUUID(), description: "", amount: "" });

export function InvoiceDialog({ title, eyebrow, busy, onClose, children }: {
  title: string; eyebrow: string; busy: boolean; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog className="invoice-dialog" ref={dialog} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="invoice-dialog-content">
      <header className="invoice-dialog-heading">
        <div><p className="eyebrow">{eyebrow}</p><h2 id={titleId}>{title}</h2></div>
        <button className="secondary" type="button" disabled={busy} onClick={onClose}>Close</button>
      </header>
      {children}
    </div>
  </dialog>;
}

export default function InvoiceEditor({ draft, existingLineCount, busy, error, onChange, onClose, onSave }: {
  draft: InvoiceDraftFields; existingLineCount: number | null; busy: boolean; error: string;
  onChange: (fields: InvoiceDraftFields) => void; onClose: () => void; onSave: (event: FormEvent) => void;
}) {
  const [references, setReferences] = useState<string | null>(null);
  const creating = existingLineCount === null;
  const started = draft.lines.some((line) => line.description.trim() || line.amount.trim() || line.todoRef || line.receiptRef);
  const total = (() => {
    try {
      const scale = invoiceCurrencyScale(draft.currency);
      const amount = draft.lines.reduce((sum, line) => sum + Number(decimalToUnits(line.amount.trim() || "0", scale)), 0);
      return new Intl.NumberFormat(undefined, { style: "currency", currency: draft.currency }).format(amount / 10 ** scale);
    } catch { return "Invalid total"; }
  })();
  const setLine = (key: string, changes: Partial<EditableInvoiceLine>) =>
    onChange({ ...draft, lines: draft.lines.map((line) => line.key === key ? { ...line, ...changes } : line) });
  const addLine = () => onChange({ ...draft, lines: [...draft.lines, blankInvoiceLine()] });

  return <InvoiceDialog title={creating ? "Create invoice" : draft.payer || "Invoice draft"}
    eyebrow={creating ? "Payments" : "Invoice"} busy={busy} onClose={onClose}>
    <form className="invoice-editor-form" onSubmit={onSave}>
      <fieldset disabled={busy}>
        <div className="invoice-create-grid">
          <label>Payer name <small>Optional until sending</small><input value={draft.payer} maxLength={500}
            onChange={(event) => onChange({ ...draft, payer: event.target.value })} /></label>
          <label>Payer email <small>Optional until sending</small><input type="email" value={draft.email} maxLength={320}
            onChange={(event) => onChange({ ...draft, email: event.target.value })} /></label>
          <label>Payment due date <small>Optional · when the customer should pay</small><input type="date" value={draft.due}
            onChange={(event) => onChange({ ...draft, due: event.target.value })} /></label>
          <label>Currency<input value={draft.currency} placeholder="USD" maxLength={3} pattern="[A-Z]{3}" required
            onChange={(event) => onChange({ ...draft, currency: event.target.value.toUpperCase() })} /></label>
        </div>
        {!creating && <div className="invoice-editor-summary">
          <div><small>Email</small><strong>{draft.email || "Not set"}</strong></div>
          <div><small>Due</small><strong>{draft.due || "Not set"}</strong></div>
          <div><small>Payment status</small><strong>Unpaid</strong></div>
          <div><small>Total</small><strong>{total}</strong></div>
        </div>}
        <label>Invoice description <small>Optional</small><textarea value={draft.description} maxLength={1000}
          onChange={(event) => onChange({ ...draft, description: event.target.value })} placeholder="What this invoice covers" /></label>
        <label>Payment methods<select value={draft.methods}
          onChange={(event) => onChange({ ...draft, methods: event.target.value as PaymentMethods })}>
          <option value="ach_only">Bank account only (no credit cards)</option>
          <option value="card_and_ach">Credit card and bank account</option>
          <option value="card_only">Credit card only</option>
        </select></label>
        <div className="invoice-line-heading"><h3>Invoice lines</h3>
          <button className="secondary" type="button" disabled={draft.lines.length >= 100} onClick={addLine}>Add line</button></div>
        <div className="invoice-line-list">{draft.lines.map((line, index) => <article className="invoice-line-card" key={line.key}>
          <div className="invoice-line-heading"><span>Line {index + 1}</span><div className="invoice-actions">
            <strong>{line.todoRef ? "To-do" : "Manual line"}</strong>
            <button className="secondary" type="button" aria-expanded={references === line.key}
              onClick={() => setReferences(references === line.key ? null : line.key)}>References</button>
            {index >= (existingLineCount ?? 0) && <button className="secondary" type="button"
              onClick={() => onChange({ ...draft, lines: draft.lines.filter((entry) => entry.key !== line.key) })}>Remove</button>}
          </div></div>
          <label>Description<textarea value={line.description} maxLength={1000} placeholder={`Manual line ${index + 1}`}
            onChange={(event) => setLine(line.key, { description: event.target.value })} /></label>
          <label>Amount ({draft.currency || "currency"}) <small>Use 0.00 for no charge</small><input inputMode="decimal"
            value={line.amount} placeholder="0.00" onChange={(event) => setLine(line.key, { amount: event.target.value })} /></label>
          {(references === line.key || line.todoRef || line.receiptRef) && <div className="invoice-create-grid invoice-line-references">
            <label>Agent to-do reference<input value={line.todoRef ?? ""} placeholder="agent-slayer://todos/…"
              onChange={(event) => setLine(line.key, { todoRef: event.target.value })} /></label>
            <label>Agent receipt reference<input value={line.receiptRef ?? ""} placeholder="agent-slayer://files/…"
              onChange={(event) => setLine(line.key, { receiptRef: event.target.value })} /></label>
          </div>}
        </article>)}</div>
      </fieldset>
      <p className="muted">You only need one line to start. Payer, due date, and prices can be filled in later.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="invoice-actions invoice-dialog-footer">
        <button className="secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" type="submit" disabled={busy || !started}>{creating ? "Create draft" : "Save changes"}</button>
      </footer>
    </form>
  </InvoiceDialog>;
}
