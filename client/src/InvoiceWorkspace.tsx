import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { decimalToUnits, unitsToDecimal } from "./money";

type StripeConnection = { configured: boolean; stripeAccountId: string | null };
type PaymentMethods = "ach_only" | "card_only" | "card_and_ach";
type InvoiceLine = { id: string; description: string; amountMinor: number; todoRef: string | null; receiptRef: string | null };
type Invoice = {
  id: string; revision: string; displayName: string; status: string; payerName: string | null;
  payerEmail: string | null; description: string | null; currency: string; dueOn: string | null;
  amountMinor: number; amountPaidMinor: number; amountRemainingMinor: number;
  paymentMethods: PaymentMethods; stripeInvoiceId: string | null; refreshFailed: boolean;
  hostedInvoiceUrl: string | null; stripePdfUrl: string | null; adoptedAt: string | null;
  sentAt: string | null; lines?: InvoiceLine[];
};
type Draft = {
  invoice: Invoice | null; payer: string; email: string; description: string; currency: string; due: string;
  methods: PaymentMethods; lines: Array<{ key: string; description: string; amount: string; todoRef?: string | null; receiptRef?: string | null }>;
};
type Page = { objects: Invoice[]; nextCursor: string | null };
type Confirmation = { instruction: string; onApproval: { arguments: { send_token: string } } };

const browserKeyName = "accounting-stripe-browser-key";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The request failed.";
const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });
const formatter = (currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency });
const scale = (currency: string) => formatter(currency).resolvedOptions().maximumFractionDigits ?? 2;
const money = (amount: number, currency: string) => formatter(currency).format(amount / 10 ** scale(currency));
const blankLine = () => ({ key: crypto.randomUUID(), description: "", amount: "" });
const statusLabel = (status: string) => ({
  draft: "Draft", sending: "Sending", open: "Awaiting payment", paid: "Paid", void: "Void", uncollectible: "Uncollectible",
}[status] ?? status);

function invoiceDraft(invoice: Invoice | null = null): Draft {
  return {
    invoice, payer: invoice?.payerName ?? "", email: invoice?.payerEmail ?? "", description: invoice?.description ?? "",
    currency: invoice?.currency ?? "", due: invoice?.dueOn ?? "", methods: invoice?.paymentMethods ?? "card_only",
    lines: invoice?.lines?.map((line) => ({
      key: line.id, description: line.description, amount: unitsToDecimal(String(line.amountMinor), scale(invoice.currency)),
      todoRef: line.todoRef, receiptRef: line.receiptRef,
    })) ?? [blankLine()],
  };
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

export default function InvoiceWorkspace({ token }: { token: string }) {
  const [connection, setConnection] = useState<StripeConnection | null>(null);
  const [page, setPage] = useState<Page>({ objects: [], nextCursor: null });
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
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
      const [stripe, initial] = await Promise.allSettled([
        api<StripeConnection>("/payments/stripe", {}, token), api<Page>("/invoices", {}, token),
      ]);
      if (!current) return;
      if (stripe.status === "fulfilled") setConnection(stripe.value);
      else setError(errorMessage(stripe.reason));
      if (initial.status === "fulfilled") setPage(initial.value);
      else setError(errorMessage(initial.reason));
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
    setDraft(null);
    setConfirm(null);
  }

  async function reloadAfterChange(invoice: Invoice, message: string) {
    setSelected(invoice);
    setDraft(null);
    setConfirm(null);
    setNotice(message);
    setPage(await fetchPage());
  }

  function saveDraft(event: FormEvent, value: Draft) {
    event.preventDefault();
    void run(async () => {
      const digits = scale(value.currency);
      const payload = {
        payer_name: value.payer.trim() || null, payer_email: value.email.trim() || null,
        description: value.description.trim() || null, currency: value.currency, due_on: value.due || null,
        payment_methods: value.methods, revision: value.invoice?.revision,
        lines: value.lines.map((line) => ({
          description: line.description, amount_minor: Number(decimalToUnits(line.amount || "0", digits)),
          todo_ref: line.todoRef, receipt_ref: line.receiptRef,
        })),
      };
      const path = value.invoice ? `/invoices/${value.invoice.id}` : "/invoices";
      const { invoice } = await api<{ invoice: Invoice }>(path, json(payload, value.invoice ? "PATCH" : "POST"), token);
      await reloadAfterChange(invoice, "Draft saved.");
    });
  }

  const disabled = busy || confirm !== null;
  return <section className="account-register invoice-workspace" aria-label="Invoices">
    <div className="section-heading"><h2>Invoices</h2><button className="secondary" type="button"
      disabled={disabled} onClick={() => { setDraft(invoiceDraft()); setSelected(null); }}>New invoice</button></div>
    <div className="invoice-actions">
      {connection?.stripeAccountId ? <span>Stripe connected · {connection.stripeAccountId}</span>
        : connection?.configured ? <button className="primary" type="button" disabled={disabled}
            onClick={() => void run(connectStripe)}>Connect Stripe</button>
          : connection ? <span>Stripe needs server configuration.</span> : null}
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
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">Working…</p>}
    {draft && <form className="invoice-editor" onSubmit={(event) => saveDraft(event, draft)}>
      <h3>{draft.invoice ? "Edit draft" : "New invoice"}</h3>
      <div className="invoice-fields">
        <label>Payer name<input value={draft.payer} maxLength={500} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, payer: event.target.value })} /></label>
        <label>Payer email<input type="email" value={draft.email} maxLength={320} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
        <label>Currency code<input value={draft.currency} placeholder="USD" maxLength={3} pattern="[A-Z]{3}" required disabled={disabled}
          onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })} /></label>
        <label>Due date<input type="date" value={draft.due} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, due: event.target.value })} /></label>
        <label>Payment methods<select value={draft.methods} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, methods: event.target.value as PaymentMethods })}>
          <option value="card_only">Card</option><option value="ach_only">US bank account</option>
          <option value="card_and_ach">Card or US bank account</option>
        </select></label>
        <label>Invoice description<input value={draft.description} maxLength={1000} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      </div>
      {draft.lines.map((line, index) => <div key={line.key} className="invoice-line">
        <label>Line {index + 1} description<input value={line.description} required maxLength={1000} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, lines: draft.lines.map((entry) =>
            entry.key === line.key ? { ...entry, description: event.target.value } : entry) })} /></label>
        <label>Amount<input inputMode="decimal" value={line.amount} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, lines: draft.lines.map((entry) =>
            entry.key === line.key ? { ...entry, amount: event.target.value } : entry) })} /></label>
        {index >= Math.max(1, draft.invoice?.lines?.length ?? 0) && <button className="secondary" type="button" disabled={disabled}
          onClick={() => setDraft({ ...draft, lines: draft.lines.filter((entry) => entry.key !== line.key) })}>Remove line</button>}
      </div>)}
      <div className="invoice-actions">
        <button type="button" className="secondary" disabled={disabled || draft.lines.length === 100}
          onClick={() => setDraft({ ...draft, lines: [...draft.lines, blankLine()] })}>Add line</button>
        <button type="submit" className="primary" disabled={disabled}>Save draft</button>
        <button type="button" className="secondary" disabled={disabled} onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </form>}
    {selected && !draft && <section className="invoice-editor" aria-label="Invoice details">
      <h3>{selected.displayName}</h3>
      <p>{statusLabel(selected.status)} · {money(selected.amountRemainingMinor, selected.currency)} outstanding
        {selected.dueOn ? ` · Due ${selected.dueOn}` : ""}</p>
      {selected.payerEmail && <p>{selected.payerEmail}</p>}
      {selected.description && <p>{selected.description}</p>}
      {selected.stripeInvoiceId && <p>Stripe invoice {selected.stripeInvoiceId}</p>}
      {selected.refreshFailed && <p className="error">Stripe could not be refreshed. Showing the last saved status.</p>}
      <ul>{selected.lines?.map((line) => <li key={line.id}>{line.description} · {money(line.amountMinor, selected.currency)}</li>)}</ul>
      <div className="invoice-actions">
        {selected.status === "draft" && <button type="button" className="secondary" disabled={disabled}
          onClick={() => setDraft(invoiceDraft(selected))}>Edit draft</button>}
        {connection?.configured && connection.stripeAccountId && !selected.sentAt && !selected.adoptedAt
          && ["draft", "sending", "open"].includes(selected.status) &&
          <button className="primary" type="button" disabled={disabled} onClick={() => void run(async () => {
            const result = await api<{ nextAction: Confirmation }>(`/invoices/${selected.id}/prepare-send`, json({}), token);
            setConfirm(result.nextAction);
          })}>Send invoice</button>}
        {selected.stripeInvoiceId && <button type="button" className="secondary" disabled={disabled}
          onClick={() => void run(() => openInvoice(selected.id))}>Refresh status</button>}
        {selected.hostedInvoiceUrl && <a href={selected.hostedInvoiceUrl} target="_blank" rel="noreferrer">Hosted invoice</a>}
        {selected.stripePdfUrl && <a href={selected.stripePdfUrl} target="_blank" rel="noreferrer">Invoice PDF</a>}
      </div>
      {confirm && <div className="invoice-confirmation" role="group" aria-label="Confirm sending">
        <p>{confirm.instruction}</p>
        <div className="invoice-actions">
          <button className="primary" type="button" disabled={busy} onClick={() => void run(async () => {
            setConfirm(null);
            const { invoice } = await api<{ invoice: Invoice }>("/invoices/send",
              json({ sendToken: confirm.onApproval.arguments.send_token }), token);
            await reloadAfterChange(invoice, "Stripe accepted the invoice send.");
          })}>Confirm send</button>
          <button className="secondary" type="button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      </div>}
    </section>}
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
