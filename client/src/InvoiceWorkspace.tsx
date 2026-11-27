import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { accountFullNames } from "./account-names";
import { api, fetchInvoicePdf, uploadInvoiceReceipt } from "./api";
import { decimalToUnits, unitsToDecimal } from "./money";
import type { Account } from "./types";
import InvoiceEditor, { blankInvoiceLine, invoiceCurrencyScale as scale,
  type InvoiceDraftFields, type InvoiceReceiptOption, type PaymentMethods } from "./InvoiceEditor";
import InvoicePaymentForm, { type InvoicePayment, type InvoicePaymentCredit, type InvoicePaymentReturn,
  type InvoicePaymentTarget } from "./InvoicePaymentForm";

type StripeConnection = { configured: boolean; stripeAccountId: string | null;
  webhookConfigured?: boolean; missingConnectSettings?: string[] };
type InvoiceLine = { id: string; description: string; amountMinor: number; accountId: number; receiptRef: string | null };
type Invoice = {
  id: string; invoiceNumber: number; revision: string; displayName: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible"; payerName: string | null;
  payerEmail: string | null; description: string | null; currency: string; dueOn: string | null;
  amountMinor: number; amountPaidMinor: number; amountRemainingMinor: number;
  paymentMethods: PaymentMethods; stripeInvoiceId: string | null; refreshFailed: boolean;
  hostedInvoiceUrl: string | null; stripePdfUrl: string | null; adoptedAt: string | null;
  sentAt: string | null; lines?: InvoiceLine[];
  sendPending: boolean; sendReviewRequired: boolean;
  receivableAccountId: number;
  postingTransactionId?: number | null;
  payments?: InvoicePayment[];
};
type Draft = InvoiceDraftFields & { invoice: Invoice | null };
type Page = { objects: Invoice[]; nextCursor: string | null };
type ReceiptPage = { objects: InvoiceReceiptOption[]; nextCursor: string | null };
type Confirmation = { instruction: string; onApproval: { arguments: { send_token: string } } };

const browserKeyName = "accounting-stripe-browser-key";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The request failed.";
const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });
const formatter = (currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency });
const money = (amount: number, currency: string) => formatter(currency).format(amount / 10 ** scale(currency));
function localDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const statusLabel = (status: Invoice["status"]) => ({
  draft: "Draft", open: "Open", paid: "Paid", void: "Void", uncollectible: "Uncollectible",
}[status]);

function invoiceDraft(invoice: Invoice | null = null): Draft {
  return {
    invoice, payer: invoice?.payerName ?? "", email: invoice?.payerEmail ?? "", description: invoice?.description ?? "",
    currency: invoice?.currency ?? "USD", due: invoice?.dueOn ?? "", methods: invoice?.paymentMethods ?? "ach_only",
    receivableAccountId: invoice?.receivableAccountId,
    lines: invoice?.lines?.map((line) => ({
      key: line.id, description: line.description, amount: unitsToDecimal(String(line.amountMinor), scale(invoice.currency)),
      receiptRef: line.receiptRef, accountId: line.accountId,
    })) ?? [blankInvoiceLine()],
  };
}

function editorMode(invoice: Invoice | null) {
  if (!invoice || (invoice.status === "draft" && !invoice.stripeInvoiceId
    && !invoice.sendPending && !invoice.sendReviewRequired)) return "draft";
  if (invoice.status === "paid" && !invoice.stripeInvoiceId) return "payer";
  return "read";
}

async function openInvoicePdf(invoice: Invoice, token: string, download: boolean) {
  const tab = download ? null : window.open("about:blank", "_blank");
  if (!download && !tab) throw new Error("Allow pop-ups for Accounting to open the invoice PDF.");
  if (tab) {
    tab.opener = null;
    tab.document.title = "Opening invoice PDF…";
    if (tab.document.body) tab.document.body.textContent = "Opening invoice PDF…";
  }
  try {
    const { pdf, filename } = await fetchInvoicePdf(invoice.id, token, download);
    if (tab?.closed) return;
    const url = URL.createObjectURL(pdf);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (tab) {
      tab.location.replace(url);
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename ?? `invoice-${invoice.invoiceNumber}.pdf`;
      document.body.append(link);
      link.click();
      link.remove();
    }
  } catch (error) {
    tab?.close();
    throw error;
  }
}

async function finishStripeReturn(token: string) {
  const { hash } = window.location;
  if (!hash.startsWith("#invoices?")) return;
  const params = new URLSearchParams(hash.slice("#invoices?".length));
  window.history.replaceState(null, "", "#invoices");
  const completionCode = params.get("stripe_completion");
  const failure = params.get("stripe_error");
  if (failure) throw new Error(failure === "cancelled" ? "Stripe setup was canceled." : "Stripe authorization failed. Try connecting again.");
  if (!completionCode) return;
  const browserKey = sessionStorage.getItem(browserKeyName);
  if (!browserKey) throw new Error("Start and complete Stripe setup in the same tab.");
  try {
    await api("/payments/stripe/complete", json({ completionCode, browserKey }), token);
  } finally {
    sessionStorage.removeItem(browserKeyName);
  }
}

export default function InvoiceWorkspace({ token, accounts, onOpenPosting, onPostingChanged,
  paymentReturn, onPaymentReturnHandled, onFindPayment }: {
  token: string; accounts: Account[]; onOpenPosting: (id: number) => Promise<void>; onPostingChanged: () => Promise<void>;
  paymentReturn: InvoicePaymentReturn | null; onPaymentReturnHandled: (value: null) => void;
  onFindPayment: (target: InvoicePaymentTarget) => void;
}) {
  const fullAccountNames = useMemo(() => accountFullNames(accounts), [accounts]);
  const [connection, setConnection] = useState<StripeConnection | null>(null);
  const [page, setPage] = useState<Page>({ objects: [], nextCursor: null });
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingAccounts, setEditingAccounts] = useState(false);
  const [receipts, setReceipts] = useState<ReceiptPage>({ objects: [], nextCursor: null });
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [issueDate, setIssueDate] = useState<string | null>(null);
  const [applyingPayment, setApplyingPayment] = useState(false);
  const [paymentCredit, setPaymentCredit] = useState<InvoicePaymentCredit | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const stripeReturn = useRef<Promise<void> | null>(null);

  async function fetchPage(text = query, cursor?: string) {
    const params = new URLSearchParams();
    if (text) params.set("text", text);
    if (cursor) params.set("cursor", cursor);
    return api<Page>(`/invoices?${params}`, {}, token);
  }

  useEffect(() => {
    let current = true;
    stripeReturn.current ??= finishStripeReturn(token);
    const pending = stripeReturn.current.catch((error) => {
      if (current) setError(errorMessage(error));
    });
    void pending.then(async () => {
      const [stripe, initial, receiptPage] = await Promise.allSettled([
        api<StripeConnection>("/payments/stripe", {}, token), api<Page>("/invoices", {}, token),
        api<ReceiptPage>("/invoice-receipts", {}, token),
      ]);
      if (!current) return;
      if (stripe.status === "fulfilled") setConnection(stripe.value);
      else setError(errorMessage(stripe.reason));
      if (initial.status === "fulfilled") setPage(initial.value);
      else setError(errorMessage(initial.reason));
      if (receiptPage.status === "fulfilled") setReceipts(receiptPage.value);
      else setError(errorMessage(receiptPage.reason));
      setBusy(false);
    });
    return () => { current = false; };
  }, [token]);

  useEffect(() => {
    if (!paymentReturn) return;
    let current = true;
    void api<{ invoice: Invoice }>(`/invoices/${paymentReturn.invoiceId}`, {}, token)
      .then(({ invoice }) => {
        if (!current) return;
        showInvoice(invoice);
        setFocusId(paymentReturn.focusId ?? null);
        if (paymentReturn.credit && invoice.status === "open" && invoice.amountRemainingMinor > 0
          && invoice.postingTransactionId != null && !invoice.stripeInvoiceId
          && paymentReturn.credit.receivableAccountId === invoice.receivableAccountId) {
          setPaymentCredit(paymentReturn.credit);
          setApplyingPayment(true);
        } else if (paymentReturn.credit) {
          setError("The invoice changed while you were browsing. Select the deposit again if the invoice is still open.");
        }
      })
      .catch((error) => { if (current) setError(errorMessage(error)); })
      .finally(() => { if (current) onPaymentReturnHandled(null); });
    return () => { current = false; };
  }, [token, paymentReturn, onPaymentReturnHandled]);

  useEffect(() => {
    if (!focusId || busy || paymentReturn) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(focusId);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
      setFocusId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusId, busy, paymentReturn]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await work(); } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function connectStripe() {
    const browserKey = crypto.randomUUID();
    sessionStorage.setItem(browserKeyName, browserKey);
    const { url } = await api<{ url: string }>("/payments/stripe/connect", json({ browserKey }), token);
    window.location.assign(url);
  }

  async function openInvoice(id: string) {
    const { invoice } = await api<{ invoice: Invoice }>(`/invoices/${id}`, {}, token);
    showInvoice(invoice);
  }

  function findPaymentInLedger(invoice: Invoice) {
    onFindPayment({ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber,
      currency: invoice.currency, scale: scale(invoice.currency), receivableAccountId: invoice.receivableAccountId });
  }

  function showInvoice(invoice: Invoice) {
    setSelected(invoice);
    setPage((current) => ({ ...current, objects: current.objects.map((item) => item.id === invoice.id ? invoice : item) }));
    setDraft(invoiceDraft(invoice));
    setEditingAccounts(false);
    setConfirm(null);
    setApplyingPayment(false);
    setPaymentCredit(null);
  }

  async function reloadAfterChange(invoice: Invoice, message: string) {
    setSelected(invoice);
    setDraft(invoiceDraft(invoice));
    setEditingAccounts(false);
    setConfirm(null);
    setNotice(message);
    setPage(await fetchPage());
  }

  async function saveLineReceipt(value: Draft, lineId: string, receiptRef: string | null) {
    let invoice = value.invoice;
    if (invoice && editorMode(invoice) !== "draft") {
      const { invoice: updated } = await api<{ invoice: Invoice }>(`/invoices/${invoice.id}/receipts`,
        json({ revision: invoice.revision, lines: [{ invoice_line_id: lineId, receipt_ref: receiptRef }] }, "PATCH"), token);
      invoice = updated;
      setSelected(updated);
    }
    setDraft((current) => current && { ...current, invoice, lines: current.lines.map((line) =>
      line.key === lineId ? { ...line, receiptRef } : line) });
  }

  function saveDraft(event: FormEvent, value: Draft) {
    event.preventDefault();
    const mode = editingAccounts ? "accounts" : editorMode(value.invoice);
    if (mode === "read") return;
    void run(async () => {
      if (mode === "accounts" && value.invoice) {
        const original = new Map(value.invoice.lines?.map((line) => [line.id, line.accountId]));
        const { invoice } = await api<{ invoice: Invoice }>(`/invoices/${value.invoice.id}/accounts`,
          json({ revision: value.invoice.revision,
            receivable_account_id: value.receivableAccountId !== value.invoice.receivableAccountId ? value.receivableAccountId : undefined,
            lines: value.lines.filter((line) => original.get(line.key) !== line.accountId)
              .map((line) => ({ invoice_line_id: line.key, account_id: line.accountId })),
          }, "PATCH"), token);
        await reloadAfterChange(invoice, "Invoice accounts saved.");
        if (invoice.postingTransactionId != null) await onPostingChanged();
        return;
      }
      const payer = { payer_name: value.payer.trim() || null, payer_email: value.email.trim() || null };
      if (mode === "payer" && value.invoice) {
        const { invoice } = await api<{ invoice: Invoice }>(`/invoices/${value.invoice.id}/payer`,
          json({ ...payer, revision: value.invoice.revision }, "PATCH"), token);
        await reloadAfterChange(invoice, "Recipient saved.");
        return;
      }
      const digits = scale(value.currency);
      const payload = {
        ...payer,
        description: value.description.trim() || null, currency: value.currency, due_on: value.due || null,
        payment_methods: value.methods, revision: value.invoice?.revision,
        receivable_account_id: value.receivableAccountId,
        lines: value.lines.filter((line, index) => index < (value.invoice?.lines?.length ?? 0)
          || line.description.trim() || line.amount.trim() || line.receiptRef?.trim())
          .map((line) => ({
            description: line.description, amount_minor: Number(decimalToUnits(line.amount.trim() || "0", digits)),
            account_id: line.accountId,
            receipt_ref: line.receiptRef?.trim() || null,
          })),
      };
      const path = value.invoice ? `/invoices/${value.invoice.id}` : "/invoices";
      const { invoice } = await api<{ invoice: Invoice }>(path, json(payload, value.invoice ? "PATCH" : "POST"), token);
      await reloadAfterChange(invoice, "Draft saved.");
    });
  }

  const disabled = busy || paymentReturn !== null || confirm !== null || issueDate !== null || applyingPayment;
  const postingTransactionId = selected?.postingTransactionId;
  const dirty = Boolean(draft && (!draft.invoice || JSON.stringify(draft) !== JSON.stringify(invoiceDraft(draft.invoice))));
  const closeEditor = () => {
    if (editingAccounts && selected) {
      setEditingAccounts(false); setDraft(invoiceDraft(selected)); setError(""); return;
    }
    setDraft(null); setSelected(null); setConfirm(null); setIssueDate(null); setApplyingPayment(false); setPaymentCredit(null); setError("");
  };
  return <section className="account-register invoice-workspace" aria-label="Invoices">
    <div className="section-heading"><h2>Invoices</h2><button className="secondary" type="button"
      disabled={disabled} onClick={() => { setDraft(invoiceDraft()); setSelected(null); }}>New invoice</button></div>
    {connection && !connection.stripeAccountId && (connection.configured || connection.missingConnectSettings?.length === 0) &&
      <div className="invoice-actions">
        <button className="primary" type="button" disabled={disabled}
          onClick={() => void run(connectStripe)}>Connect Stripe</button>
      </div>}
    {connection && (!connection.configured || !connection.stripeAccountId) && <details className="invoice-setup"
      open={Boolean(connection.missingConnectSettings?.length)}>
      <summary>Stripe setup</summary>
      <p>Use the existing live Stripe Connect platform and choose the connected account that owns your invoices.</p>
      {!!connection.missingConnectSettings?.length &&
        <p>Set these in Accounting’s server environment: <code>{connection.missingConnectSettings.join(", ")}</code>.</p>}
      <p>Register the OAuth redirect <code>{window.location.origin}/api/payments/stripe/oauth/callback</code> on the platform.</p>
      {connection.webhookConfigured !== true && <p>Add a connected-account webhook at <code>{window.location.origin}/api/payments/stripe/webhook</code>.
        Save its signing secret as <code>STRIPE_CONNECT_WEBHOOK_SECRET</code> to enable sending.</p>}
    </details>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">Working…</p>}
    {draft && <InvoiceEditor key={draft.invoice?.id ?? "new"} draft={draft}
      existingLineCount={draft.invoice ? draft.invoice.lines?.length ?? 0 : null}
      invoiceNumber={draft.invoice?.invoiceNumber}
      accounts={accounts} mode={editingAccounts ? "accounts" : editorMode(draft.invoice)}
      posted={draft.invoice?.postingTransactionId != null}
      receipts={receipts.objects} hasMoreReceipts={receipts.nextCursor != null}
      onMoreReceipts={() => void run(async () => {
        const next = await api<ReceiptPage>(`/invoice-receipts?cursor=${encodeURIComponent(receipts.nextCursor ?? "")}`, {}, token);
        setReceipts((current) => ({ nextCursor: next.nextCursor,
          objects: [...current.objects, ...next.objects.filter((file) => !current.objects.some((known) => known.sourceRef === file.sourceRef))] }));
      })}
      onReceiptChange={(lineId, receiptRef) => void run(() => saveLineReceipt(draft, lineId, receiptRef))}
      onUploadReceipt={(lineId, file) => void run(async () => {
        const { receipt } = await uploadInvoiceReceipt<{ receipt: InvoiceReceiptOption }>(file, token);
        setReceipts((current) => ({ ...current,
          objects: [receipt, ...current.objects.filter((entry) => entry.sourceRef !== receipt.sourceRef)] }));
        await saveLineReceipt(draft, lineId, receipt.sourceRef);
      })}
      paymentStatus={selected && statusLabel(selected.status) || undefined}
      savedTotal={selected ? money(selected.amountMinor, selected.currency) : undefined}
      busy={busy} dirty={dirty} error={error} onChange={(fields) => setDraft({ ...fields, invoice: draft.invoice })}
      onClose={closeEditor} onSave={(event) => saveDraft(event, draft)}
      actions={selected && !editingAccounts && <>
        {editorMode(selected) !== "draft" && (!selected.sendPending || postingTransactionId != null) &&
          <button type="button" className="secondary" disabled={disabled || dirty}
          onClick={() => { setEditingAccounts(true); setError(""); }}>Edit accounts</button>}
        <button type="button" className="secondary" disabled={disabled || dirty}
          onClick={() => void run(() => openInvoicePdf(selected, token, false))}>Preview PDF</button>
        <button type="button" className="secondary" disabled={disabled || dirty}
          onClick={() => void run(() => openInvoicePdf(selected, token, true))}>Download PDF</button>
        {editorMode(selected) !== "draft" && !selected.sendPending && !selected.sendReviewRequired
          && selected.lines?.length && selected.lines.length <= 100
          && selected.lines.every((line) => line.amountMinor >= 0) ? <button type="button" className="secondary"
          disabled={disabled || dirty} onClick={() => {
            setDraft({ ...invoiceDraft(selected), invoice: null, due: "" });
            setSelected(null);
            setError("");
          }}>Copy to new draft</button> : null}
        {editorMode(selected) === "draft" && selected.amountMinor > 0 && selected.payerName && !confirm && issueDate === null &&
          <button className="secondary" type="button" disabled={busy || dirty} onClick={() => {
            setIssueDate(localDate());
            setError("");
          }}>Post invoice</button>}
        {selected.status === "open" && selected.amountRemainingMinor > 0 && postingTransactionId != null
          && !selected.stripeInvoiceId && !applyingPayment && <>
          <button className="primary" type="button" disabled={disabled || dirty}
            onClick={() => { setApplyingPayment(true); setError(""); }}>Apply payment</button>
          <button className="secondary" type="button" disabled={disabled || dirty}
            onClick={() => findPaymentInLedger(selected)}>Find payment in ledger</button>
        </>}
        {connection?.configured && connection.stripeAccountId && !selected.sentAt && !selected.adoptedAt
          && !selected.sendReviewRequired && (selected.status === "draft" || selected.sendPending) && !confirm && issueDate === null &&
          <button className="primary" type="button" disabled={busy || dirty} onClick={() => void run(async () => {
            const result = await api<{ nextAction: Confirmation }>(`/invoices/${selected.id}/prepare-send`, json({}), token);
            setConfirm(result.nextAction);
          })}>{selected.sendPending ? "Resume sending" : "Send invoice"}</button>}
        {selected.stripeInvoiceId && <button type="button" className="secondary" disabled={disabled}
          onClick={() => void run(() => openInvoice(selected.id))}>Refresh Stripe status</button>}
        {postingTransactionId != null && <button type="button" className="secondary" disabled={disabled || dirty}
          onClick={() => void run(() => onOpenPosting(postingTransactionId))}>View ledger posting</button>}
        {selected.hostedInvoiceUrl && <a href={selected.hostedInvoiceUrl} target="_blank" rel="noreferrer">Hosted invoice</a>}
        {selected.stripePdfUrl && <a href={selected.stripePdfUrl} target="_blank" rel="noreferrer">Stripe PDF</a>}
      </>}
      details={<>
        {selected?.sendReviewRequired && <p className="error">Review the previous delivery attempt before editing or sending this invoice.</p>}
        {selected?.refreshFailed && <p className="error">Stripe could not be refreshed. Showing the last saved status.</p>}
        {selected?.payments && selected.payments.length > 0 && <div>
          <h3>Payments</h3>
          <ul className="invoice-list invoice-payment-list">{selected.payments.map((payment) => {
            const names = payment.receivingAccounts?.map(({ accountId, accountName }) => fullAccountNames.get(accountId) ?? accountName)
              ?? payment.receivingAccountNames ?? [];
            return <li key={payment.id}>
              <button type="button" id={`invoice-payment-${payment.id}`} className="invoice-payment-row" disabled={disabled || dirty}
                onClick={() => void run(() => onOpenPosting(payment.transactionId))}>
                <time dateTime={payment.date}>{payment.date}</time>
                <span className="invoice-payment-description">{payment.description || "Payment"}</span>
                <span className="invoice-payment-account" title={names.join("\n") || undefined}>
                  {names.join(", ") || "Receiving account unavailable"}
                </span>
                <strong className="invoice-payment-amount">{money(payment.amountMinor, selected.currency)}</strong>
              </button>
            </li>;
          })}</ul>
        </div>}
        {selected && (selected.stripeInvoiceId || selected.postingTransactionId || Boolean(selected.payments?.length)) &&
          <p className="invoice-outstanding"><strong>{money(selected.amountRemainingMinor, selected.currency)}</strong> outstanding</p>}
      </>}
      confirmation={applyingPayment && selected ? <InvoicePaymentForm key={paymentCredit?.lineItemId ?? "record"} currency={selected.currency}
        scale={scale(selected.currency)} remaining={selected.amountRemainingMinor} revision={selected.revision}
        receivableAccountId={selected.receivableAccountId} accounts={accounts} today={localDate()} busy={busy}
        credit={paymentCredit}
        onFindPayment={() => findPaymentInLedger(selected)}
        onApply={(input) => void run(async () => {
          const { invoice } = await api<{ invoice: Invoice }>(`/invoices/${selected.id}/payments`, json(input), token);
          setApplyingPayment(false);
          setPaymentCredit(null);
          await reloadAfterChange(invoice, "Payment applied.");
          await onPostingChanged();
        })}
        onCancel={() => { setApplyingPayment(false); setPaymentCredit(null); setError(""); }}
      /> : confirm ? <div className="invoice-confirmation" role="group" aria-label="Confirm sending">
          <p>{confirm.instruction}</p>
          <div className="invoice-actions">
            <button className="primary" type="button" disabled={busy} onClick={() => void run(async () => {
              setConfirm(null);
              const { invoice } = await api<{ invoice: Invoice }>("/invoices/send",
                json({ sendToken: confirm.onApproval.arguments.send_token }), token);
              await reloadAfterChange(invoice, "Stripe accepted the invoice send.");
            })}>Yes, send invoice</button>
            <button className="secondary" type="button" disabled={busy} onClick={() => setConfirm(null)}>Not yet</button>
          </div>
        </div>
        : issueDate !== null && selected && <div className="invoice-confirmation" role="group" aria-label="Post invoice">
        <p>Post {money(selected.amountMinor, selected.currency)} to Accounts Receivable for invoice #{selected.invoiceNumber}. This action records the invoice in the ledger without sending it to the customer.</p>
        <label>Posting date<input type="date" value={issueDate} disabled={busy}
          onChange={(event) => setIssueDate(event.target.value)} /></label>
        <div className="invoice-actions">
          <button className="primary" type="button" disabled={busy || !issueDate} onClick={() => void run(async () => {
            const { invoice } = await api<{ invoice: Invoice }>(`/invoices/${selected.id}/issue`,
              json({ revision: selected.revision, issue_date: issueDate }), token);
            setIssueDate(null);
            await reloadAfterChange(invoice, "Invoice posted to the ledger.");
          })}>Post invoice</button>
          <button className="secondary" type="button" disabled={busy} onClick={() => setIssueDate(null)}>Cancel</button>
        </div>
      </div>} />}
    <form className="invoice-inline-form" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        const text = filter.trim();
        setPage(await fetchPage(text));
        setQuery(text);
      });
    }}>
      <label>Find invoices<input type="search" value={filter} maxLength={255} disabled={disabled}
        onChange={(event) => setFilter(event.target.value)} /></label>
      <button className="secondary" disabled={disabled}>Search</button>
    </form>
    {!busy && page.objects.length === 0 && <p>No invoices found.</p>}
    <ul className="invoice-list">{page.objects.map((invoice) => <li key={invoice.id}>
      <button className="secondary" type="button" disabled={disabled} aria-pressed={selected?.id === invoice.id}
        onClick={() => void run(() => openInvoice(invoice.id))}>{invoice.displayName}</button>
      <span>{statusLabel(invoice.status)}</span>
    </li>)}</ul>
    {page.nextCursor && <button className="secondary" disabled={disabled} type="button" onClick={() => void run(async () => {
      const next = await fetchPage(query, page.nextCursor ?? undefined);
      setPage({ objects: [...page.objects, ...next.objects], nextCursor: next.nextCursor });
    })}>Load more</button>}
  </section>;
}
