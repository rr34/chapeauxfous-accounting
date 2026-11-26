import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, fetchInvoicePdf, uploadInvoiceReceipt } from "./api";
import { decimalToUnits, unitsToDecimal } from "./money";
import type { Account } from "./types";
import InvoiceEditor, { blankInvoiceLine, invoiceCurrencyScale as scale,
  type InvoiceDraftFields, type InvoiceReceiptOption, type PaymentMethods } from "./InvoiceEditor";

type StripeConnection = { configured: boolean; stripeAccountId: string | null;
  webhookConfigured?: boolean; missingConnectSettings?: string[] };
type InvoiceLine = { id: string; description: string; amountMinor: number; accountId: number; todoRef: string | null; receiptRef: string | null };
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
      todoRef: line.todoRef, receiptRef: line.receiptRef, accountId: line.accountId,
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
    const pdf = await fetchInvoicePdf(invoice.id, token, download);
    if (tab?.closed) return;
    const url = URL.createObjectURL(pdf);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (tab) {
      tab.location.replace(url);
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = `invoice-${invoice.invoiceNumber}.pdf`;
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

export default function InvoiceWorkspace({ token, accounts }: { token: string; accounts: Account[] }) {
  const [connection, setConnection] = useState<StripeConnection | null>(null);
  const [page, setPage] = useState<Page>({ objects: [], nextCursor: null });
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editSection, setEditSection] = useState<"accounts" | "receipts" | null>(null);
  const [receipts, setReceipts] = useState<ReceiptPage>({ objects: [], nextCursor: null });
  const [adoptId, setAdoptId] = useState("");
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
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
    setSelected(invoice);
    setPage((current) => ({ ...current, objects: current.objects.map((item) => item.id === id ? invoice : item) }));
    setDraft(invoiceDraft(invoice));
    setEditSection(null);
    setConfirm(null);
  }

  async function reloadAfterChange(invoice: Invoice, message: string) {
    setSelected(invoice);
    setDraft(invoiceDraft(invoice));
    setEditSection(null);
    setConfirm(null);
    setNotice(message);
    setPage(await fetchPage());
  }

  function saveDraft(event: FormEvent, value: Draft) {
    event.preventDefault();
    const mode = editSection ?? editorMode(value.invoice);
    if (mode === "read") return;
    void run(async () => {
      if (mode === "receipts" && value.invoice) {
        const original = new Map(value.invoice.lines?.map((line) => [line.id, line.receiptRef ?? null]));
        const { invoice } = await api<{ invoice: Invoice }>(`/invoices/${value.invoice.id}/receipts`,
          json({ revision: value.invoice.revision,
            lines: value.lines.filter((line) => original.get(line.key) !== (line.receiptRef ?? null))
              .map((line) => ({ invoice_line_id: line.key, receipt_ref: line.receiptRef ?? null })),
          }, "PATCH"), token);
        await reloadAfterChange(invoice, "Invoice receipts saved.");
        return;
      }
      if (mode === "accounts" && value.invoice) {
        const original = new Map(value.invoice.lines?.map((line) => [line.id, line.accountId]));
        const { invoice } = await api<{ invoice: Invoice }>(`/invoices/${value.invoice.id}/accounts`,
          json({ revision: value.invoice.revision,
            receivable_account_id: value.receivableAccountId !== value.invoice.receivableAccountId ? value.receivableAccountId : undefined,
            lines: value.lines.filter((line) => original.get(line.key) !== line.accountId)
              .map((line) => ({ invoice_line_id: line.key, account_id: line.accountId })),
          }, "PATCH"), token);
        await reloadAfterChange(invoice, "Invoice accounts saved.");
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
          || line.description.trim() || line.amount.trim() || line.todoRef?.trim() || line.receiptRef?.trim())
          .map((line) => ({
            description: line.description, amount_minor: Number(decimalToUnits(line.amount.trim() || "0", digits)),
            account_id: line.accountId,
            todo_ref: line.todoRef?.trim() || null, receipt_ref: line.receiptRef?.trim() || null,
          })),
      };
      const path = value.invoice ? `/invoices/${value.invoice.id}` : "/invoices";
      const { invoice } = await api<{ invoice: Invoice }>(path, json(payload, value.invoice ? "PATCH" : "POST"), token);
      await reloadAfterChange(invoice, "Draft saved.");
    });
  }

  const disabled = busy || confirm !== null;
  const dirty = Boolean(draft && (!draft.invoice || JSON.stringify(draft) !== JSON.stringify(invoiceDraft(draft.invoice))));
  const closeEditor = () => {
    if (editSection && selected) {
      setEditSection(null); setDraft(invoiceDraft(selected)); setError(""); return;
    }
    setDraft(null); setSelected(null); setConfirm(null); setError("");
  };
  return <section className="account-register invoice-workspace" aria-label="Invoices">
    <div className="section-heading"><h2>Invoices</h2><button className="secondary" type="button"
      disabled={disabled} onClick={() => { setDraft(invoiceDraft()); setSelected(null); }}>New invoice</button></div>
    <div className="invoice-actions">
      {connection?.stripeAccountId ? <span>Stripe connected · {connection.stripeAccountId}</span>
        : connection && (connection.configured || connection.missingConnectSettings?.length === 0)
          ? <button className="primary" type="button" disabled={disabled}
            onClick={() => void run(connectStripe)}>Connect Stripe</button>
          : null}
      {connection?.stripeAccountId && <form className="invoice-inline-form" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const { invoice, idempotentReplay } = await api<{ invoice: Invoice; idempotentReplay: boolean }>(
            "/invoices/adopt", json({ stripeInvoiceId: adoptId.trim() }), token);
          setAdoptId("");
          await reloadAfterChange(invoice, idempotentReplay ? "Invoice already in Accounting." : "Stripe invoice imported.");
        });
      }}>
        <label>Existing Stripe invoice ID<input value={adoptId} placeholder="in_…" required
          onChange={(event) => setAdoptId(event.target.value)} disabled={disabled} /></label>
        <button className="secondary" disabled={disabled}>Import invoice</button>
      </form>}
    </div>
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
      accounts={accounts} mode={editSection ?? editorMode(draft.invoice)}
      receipts={receipts.objects} hasMoreReceipts={receipts.nextCursor != null}
      onMoreReceipts={() => void run(async () => {
        const next = await api<ReceiptPage>(`/invoice-receipts?cursor=${encodeURIComponent(receipts.nextCursor ?? "")}`, {}, token);
        setReceipts((current) => ({ nextCursor: next.nextCursor,
          objects: [...current.objects, ...next.objects.filter((file) => !current.objects.some((known) => known.sourceRef === file.sourceRef))] }));
      })}
      onUploadReceipt={(lineId, file) => void run(async () => {
        const { receipt } = await uploadInvoiceReceipt<{ receipt: InvoiceReceiptOption }>(file, token);
        setReceipts((current) => ({ ...current,
          objects: [receipt, ...current.objects.filter((entry) => entry.sourceRef !== receipt.sourceRef)] }));
        setDraft((current) => current && { ...current, lines: current.lines.map((line) =>
          line.key === lineId ? { ...line, receiptRef: receipt.sourceRef } : line) });
      })}
      paymentStatus={selected && statusLabel(selected.status) || undefined}
      savedTotal={selected ? money(selected.amountMinor, selected.currency) : undefined}
      busy={busy} dirty={dirty} error={error} onChange={(fields) => setDraft({ ...fields, invoice: draft.invoice })}
      onClose={closeEditor} onSave={(event) => saveDraft(event, draft)}
      actions={selected && !editSection && <>
        {editorMode(selected) !== "draft" && <button type="button" className="secondary" disabled={disabled || dirty}
          onClick={() => { setEditSection("accounts"); setError(""); }}>Edit accounts</button>}
        {editorMode(selected) !== "draft" && Boolean(selected.lines?.length) && <button type="button" className="secondary"
          disabled={disabled || dirty} onClick={() => { setEditSection("receipts"); setError(""); }}>Edit receipts</button>}
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
        {connection?.configured && connection.stripeAccountId && !selected.sentAt && !selected.adoptedAt
          && !selected.sendReviewRequired && (selected.status === "draft" || selected.sendPending) && !confirm &&
          <button className="primary" type="button" disabled={busy || dirty} onClick={() => void run(async () => {
            const result = await api<{ nextAction: Confirmation }>(`/invoices/${selected.id}/prepare-send`, json({}), token);
            setConfirm(result.nextAction);
          })}>{selected.sendPending ? "Resume sending" : "Send invoice"}</button>}
        {selected.stripeInvoiceId && <button type="button" className="secondary" disabled={disabled}
          onClick={() => void run(() => openInvoice(selected.id))}>Refresh Stripe status</button>}
        {selected.hostedInvoiceUrl && <a href={selected.hostedInvoiceUrl} target="_blank" rel="noreferrer">Hosted invoice</a>}
        {selected.stripePdfUrl && <a href={selected.stripePdfUrl} target="_blank" rel="noreferrer">Stripe PDF</a>}
      </>}
      details={<>
        {selected?.sendReviewRequired && <p className="error">Review the previous delivery attempt before editing or sending this invoice.</p>}
        {selected?.refreshFailed && <p className="error">Stripe could not be refreshed. Showing the last saved status.</p>}
        {selected?.stripeInvoiceId && <p>{money(selected.amountRemainingMinor, selected.currency)} outstanding</p>}
      </>}
      confirmation={confirm && <div className="invoice-confirmation" role="group" aria-label="Confirm sending">
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
