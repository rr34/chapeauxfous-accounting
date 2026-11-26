import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
import AccountCombobox from "./AccountCombobox";
import { accountFullNames } from "./account-names";
import { decimalToUnits } from "./money";
import type { Account } from "./types";

export type PaymentMethods = "ach_only" | "card_only" | "card_and_ach";
export type EditableInvoiceLine = {
  key: string; description: string; amount: string; accountId?: number; receiptRef?: string | null;
};
export type InvoiceDraftFields = {
  payer: string; email: string; description: string; currency: string; due: string;
  methods: PaymentMethods; receivableAccountId?: number; lines: EditableInvoiceLine[];
};
export type InvoiceReceiptOption = { sourceRef: string; displayName: string };

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

export default function InvoiceEditor({ draft, existingLineCount, invoiceNumber, mode, receivableAccountLocked, paymentStatus, savedTotal, busy, error,
  accounts, receipts, hasMoreReceipts, onMoreReceipts, onReceiptChange, onUploadReceipt,
  dirty, actions, details, confirmation, onChange, onClose, onSave }: {
  draft: InvoiceDraftFields; existingLineCount: number | null; mode: "draft" | "payer" | "accounts" | "read";
  receivableAccountLocked: boolean;
  accounts: Account[];
  receipts: InvoiceReceiptOption[]; hasMoreReceipts: boolean; onMoreReceipts: () => void;
  onReceiptChange: (lineId: string, receiptRef: string | null) => void;
  onUploadReceipt: (lineId: string, file: File) => void;
  invoiceNumber?: number;
  paymentStatus?: string; savedTotal?: string; busy: boolean; error: string; dirty: boolean;
  actions?: ReactNode; details?: ReactNode; confirmation?: ReactNode;
  onChange: (fields: InvoiceDraftFields) => void; onClose: () => void; onSave: (event: FormEvent) => void;
}) {
  const creating = existingLineCount === null;
  const editable = mode === "draft";
  const payerEditable = editable || mode === "payer";
  const accountsEditable = editable || mode === "accounts";
  const receiptsEditable = mode !== "accounts";
  const selectable = accounts.filter((account) => !account.placeholder && account.archivedAt == null
    && account.currencyCode === draft.currency);
  const accountNames = accountFullNames(accounts);
  const lineAccountChoices = selectable.filter((account) => account.id !== draft.receivableAccountId)
    .map((account) => ({
      value: String(account.id), label: accountNames.get(account.id) ?? account.name, currencyCode: account.currencyCode,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const defaultLineAccountLabel = "Default suspense account";
  if (editable) lineAccountChoices.unshift({ value: "", label: defaultLineAccountLabel, currencyCode: draft.currency });
  const editingLocked = busy || Boolean(confirmation);
  const started = draft.lines.some((line) => line.description.trim() || line.amount.trim() || line.receiptRef);
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
    eyebrow={creating ? "Payments" : `Invoice #${invoiceNumber}`} busy={busy} onClose={onClose}>
    <form className="invoice-editor-form" onSubmit={onSave}>
      <fieldset disabled={editingLocked}>
        <div className="invoice-create-grid">
          <label>Payer name {editable && <small>Optional until sending</small>}<input value={draft.payer} maxLength={500} readOnly={!payerEditable}
            onChange={(event) => onChange({ ...draft, payer: event.target.value })} /></label>
          <label>Payer email {editable && <small>Optional until sending</small>}<input type="email" value={draft.email} maxLength={320} readOnly={!payerEditable}
            onChange={(event) => onChange({ ...draft, email: event.target.value })} /></label>
          <label>Payment due date {editable && <small>Optional · when the customer should pay</small>}<input type="date" value={draft.due} readOnly={!editable}
            onChange={(event) => onChange({ ...draft, due: event.target.value })} /></label>
          <label>Currency<input value={draft.currency} placeholder="USD" maxLength={3} pattern="[A-Z]{3}" required readOnly={!creating}
            onChange={(event) => onChange({ ...draft, currency: event.target.value.toUpperCase(),
              receivableAccountId: undefined, lines: draft.lines.map((line) => ({ ...line, accountId: undefined })) })} /></label>
        </div>
        <label>Accounts Receivable<select value={draft.receivableAccountId ?? ""} disabled={!accountsEditable || receivableAccountLocked}
          onChange={(event) => onChange({ ...draft, receivableAccountId: Number(event.target.value) || undefined })}>
          <option value="" disabled={!creating}>Default Accounts Receivable</option>
          {selectable.filter((account) => account.type === "asset" && !account.suspense)
            .map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select></label>
        {!creating && <div className="invoice-editor-summary">
          <div><small>Email</small><strong>{draft.email || "Not set"}</strong></div>
          <div><small>Due</small><strong>{draft.due || "Not set"}</strong></div>
          <div><small>Payment status</small><strong>{paymentStatus}</strong></div>
          <div><small>Total</small><strong>{editable ? total : savedTotal}</strong></div>
        </div>}
        <label>Invoice description {editable && <small>Optional</small>}<textarea value={draft.description} maxLength={1000} readOnly={!editable}
          onChange={(event) => onChange({ ...draft, description: event.target.value })} placeholder="What this invoice covers" /></label>
        <label>Payment methods<select value={draft.methods} disabled={!editable}
          onChange={(event) => onChange({ ...draft, methods: event.target.value as PaymentMethods })}>
          <option value="ach_only">Bank account only (no credit cards)</option>
          <option value="card_and_ach">Credit card and bank account</option>
          <option value="card_only">Credit card only</option>
        </select></label>
        <div className="invoice-line-heading"><h3>Invoice lines</h3>
          <div className="invoice-actions">
            {receiptsEditable && hasMoreReceipts && <button className="secondary" type="button" onClick={onMoreReceipts}>Load more receipts</button>}
            {editable && <button className="secondary" type="button" disabled={draft.lines.length >= 100} onClick={addLine}>Add line</button>}
          </div></div>
        {receiptsEditable && !editable && draft.lines.length > 0 && <small>Receipt changes save automatically.</small>}
        <div className="invoice-line-list">{draft.lines.map((line, index) => <article className="invoice-line-card" key={line.key}>
          <div className="invoice-line-heading"><span>Line {index + 1}</span><div className="invoice-actions">
            {editable && index >= (existingLineCount ?? 0) && <button className="secondary" type="button"
              onClick={() => onChange({ ...draft, lines: draft.lines.filter((entry) => entry.key !== line.key) })}>Remove</button>}
          </div></div>
          <label>Description<textarea value={line.description} maxLength={1000} placeholder={`Manual line ${index + 1}`} readOnly={!editable}
            onChange={(event) => setLine(line.key, { description: event.target.value })} /></label>
          <label>Amount ({draft.currency || "currency"}) {editable && <small>Use 0.00 for no charge</small>}<input inputMode="decimal"
            value={line.amount} placeholder="0.00" readOnly={!editable} onChange={(event) => setLine(line.key, { amount: event.target.value })} /></label>
          <div className="invoice-line-references invoice-line-account">
            <label htmlFor={`line-account-${line.key}`}>Line account</label>
            <AccountCombobox id={`line-account-${line.key}`} label={`Line account for line ${index + 1}`}
              value={line.accountId == null ? "" : String(line.accountId)} choices={lineAccountChoices}
              selectedLabel={line.accountId == null ? defaultLineAccountLabel : accountNames.get(line.accountId)}
              disabled={!accountsEditable || editingLocked} clearOnType={false}
              onChange={(accountId) => setLine(line.key, { accountId: accountId ? Number(accountId) : undefined })} />
          </div>
          {(receiptsEditable || line.receiptRef) && <div className="invoice-create-grid invoice-line-references">
            <label>Receipt<select value={line.receiptRef ?? ""} disabled={!receiptsEditable}
              onChange={(event) => onReceiptChange(line.key, event.target.value || null)}>
              <option value="">No receipt</option>
              {line.receiptRef && !receipts.some((file) => file.sourceRef === line.receiptRef) &&
                <option value={line.receiptRef}>{line.receiptRef.startsWith("agent-slayer:")
                  ? "Agent receipt · Upload in Accounting to include it" : `Receipt #${line.receiptRef.split("/").at(-1)}`}</option>}
              {receipts.map((file) => <option key={file.sourceRef} value={file.sourceRef}>{file.displayName}</option>)}
            </select></label>
            {receiptsEditable && <label>Upload receipt<input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) onUploadReceipt(line.key, file);
              }} /></label>}
          </div>}
        </article>)}</div>
      </fieldset>
      {creating && <p className="muted">You only need one line to start. Payer, due date, and prices can be filled in later.</p>}
      {mode === "payer" && <p className="muted">You can correct the recipient on this locally paid invoice.</p>}
      {mode === "accounts" && receivableAccountLocked && <p className="muted">Saving changes updates the original ledger posting.</p>}
      {details}
      {confirmation}
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="invoice-actions invoice-dialog-footer">
        {actions}
        <button className="secondary" type="button" disabled={busy} onClick={onClose}>{mode === "read" ? "Close" : "Cancel"}</button>
        {mode !== "read" && <button className="primary" type="submit" disabled={editingLocked || !dirty || (editable && !started)}>
          {creating ? "Create draft" : mode === "payer" ? "Save recipient" : mode === "accounts" ? "Save accounts" : "Save changes"}
        </button>}
      </footer>
    </form>
  </InvoiceDialog>;
}
