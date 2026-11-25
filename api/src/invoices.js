import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { z } from "zod";
import { withPoolTransaction } from "./db.js";

const policies = {
  ach_only: ["us_bank_account"],
  card_only: ["card"],
  card_and_ach: ["card", "us_bank_account"],
};
const reference = (kind) => z.string().max(512)
  .regex(new RegExp(`^agent-slayer://${kind}/[1-9][0-9]*$`)).nullable().optional();
export const invoiceId = z.uuid();
export const invoicePayer = z.object({
  payer_name: z.string().trim().min(1).max(500).nullable().optional(),
  payer_email: z.email().max(320).nullable().optional(),
});
export const stripeBrowserKey = z.uuid();
export const stripeInvoiceId = z.string().regex(/^in_[a-zA-Z0-9]+$/).max(255);
export const invoiceDraft = z.object({
  ...invoicePayer.shape,
  description: z.string().trim().max(1000).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  due_on: z.iso.date().nullable().optional(),
  payment_methods: z.enum(["ach_only", "card_only", "card_and_ach"]).default("ach_only"),
  lines: z.array(z.object({
    description: z.string().trim().min(1).max(1000),
    amount_minor: z.number().int().min(0).max(99999999).default(0),
    todo_ref: reference("todos"),
    receipt_ref: reference("files"),
  })).min(1).max(100),
});

function fail(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function sign(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

function verify(token, secret, purpose) {
  const [data, signature, extra] = String(token ?? "").split(".");
  if (!data || !signature || extra != null) throw fail("The authorization is invalid.", "INVOICE_TOKEN_INVALID", 400);
  const expected = createHmac("sha256", secret).update(data).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw fail("The authorization is invalid.", "INVOICE_TOKEN_INVALID", 400);
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(data, "base64url").toString()); }
  catch { throw fail("The authorization is invalid.", "INVOICE_TOKEN_INVALID", 400); }
  if (payload.purpose !== purpose || payload.expires <= Date.now()) {
    throw fail("The authorization expired. Prepare it again.", "INVOICE_TOKEN_EXPIRED");
  }
  return payload;
}

async function getRow(db, owner, id, forUpdate = false) {
  const [[row]] = await db.execute(
    `SELECT * FROM accounting_invoices WHERE owner_person_id = ? AND invoice_id = ?${forUpdate ? " FOR UPDATE" : ""}`,
    [owner, id],
  );
  if (!row) throw fail("Invoice not found.", "INVOICE_NOT_FOUND", 404);
  return row;
}

async function invoiceObject(db, row, { refreshFailed = false, includeLines = true } = {}) {
  const [lines] = includeLines ? await db.execute(
    "SELECT * FROM accounting_invoice_lines WHERE invoice_id = ? ORDER BY position", [row.invoice_id],
  ) : [[]];
  const id = row.invoice_id;
  const status = row.stripe_status && row.stripe_status !== "draft" ? row.stripe_status
    : row.stripe_status === "draft" && row.invoice_status === "issued" ? "stripe_draft"
      : row.invoice_status;
  const invoiceNumber = Number(row.invoice_number);
  const formatter = new Intl.NumberFormat("en", { style: "currency", currency: row.currency });
  const total = formatter.format(Number(row.amount_minor) / (10 ** formatter.resolvedOptions().maximumFractionDigits));
  return {
    id, invoiceNumber, sourceRef: `accounting://invoices/${id}`,
    displayName: `#${invoiceNumber} · ${row.payer_name ?? "Payer not set"} · ${total}`,
    status, invoiceStatus: row.invoice_status, stripeStatus: row.stripe_status ?? null,
    revision: row.revision, payerName: row.payer_name, payerEmail: row.payer_email,
    description: row.description, currency: row.currency, dueOn: row.due_on,
    paymentMethods: row.payment_methods, amountMinor: Number(row.amount_minor),
    amountPaidMinor: Number(row.amount_paid_minor),
    amountRemainingMinor: Number(row.amount_remaining_minor ?? row.amount_minor),
    stripeInvoiceId: row.stripe_invoice_id, hostedInvoiceUrl: row.stripe_hosted_url,
    stripePdfUrl: row.stripe_pdf_url, sentAt: row.sent_at, adoptedAt: row.adopted_at, refreshFailed,
    ...(includeLines ? { lines: lines.map((line) => ({
      id: line.invoice_line_id, sourceRef: `accounting://invoice-lines/${line.invoice_line_id}`,
      position: line.position, description: line.description, amountMinor: Number(line.amount_minor),
      todoRef: line.todo_ref, receiptRef: line.receipt_ref,
    })) } : {}),
  };
}

async function nextInvoiceNumber(db, owner) {
  const [[person]] = await db.execute("SELECT person_id FROM people2_people WHERE person_id = ? FOR UPDATE", [owner]);
  if (!person) throw fail("Accounting owner not found.", "INVOICE_OWNER_NOT_FOUND", 404);
  const [[last]] = await db.execute(`SELECT invoice_number FROM accounting_invoices
    WHERE owner_person_id = ? ORDER BY invoice_number DESC LIMIT 1 FOR UPDATE`, [owner]);
  const next = Number(last?.invoice_number ?? 0) + 1;
  if (!Number.isSafeInteger(next)) throw fail("The invoice number sequence is exhausted.", "INVOICE_NUMBER_LIMIT");
  return next;
}

async function saveLines(db, id, lines) {
  await db.query(
    `INSERT INTO accounting_invoice_lines
     (invoice_line_id, invoice_id, position, description, amount_minor, todo_ref, receipt_ref) VALUES ?`,
    [lines.map((line, index) => [
      line.id ?? randomUUID(), id, index + 1, line.description, line.amount_minor,
      line.todo_ref ?? null, line.receipt_ref ?? null,
    ])],
  );
}

async function withInvoiceLock(pool, id, work) {
  const db = await pool.getConnection();
  const key = `accounting-invoice:${id}`;
  let acquired = false;
  try {
    const [[row]] = await db.execute("SELECT GET_LOCK(?, 0) AS acquired", [key]);
    acquired = Number(row.acquired) === 1;
    if (!acquired) throw fail("This invoice is being updated. Check its current status shortly.", "INVOICE_BUSY");
    return await work(db);
  } finally {
    try { if (acquired) await db.execute("SELECT RELEASE_LOCK(?)", [key]); }
    catch (error) { db.destroy(); throw error; }
    finally { db.release(); }
  }
}

function stripeDate(date, endOfDay = false) {
  return Math.floor(Date.parse(`${date}T${endOfDay ? "23:59:59" : "00:00:00"}Z`) / 1000);
}

export function createInvoiceService(pool, {
  env = process.env,
  stripeFactory = (key) => new Stripe(key, { timeout: 20000, maxNetworkRetries: 1 }),
} = {}) {
  const secret = env.ACCOUNTING_STRIPE_STATE_SECRET;
  const browserDigest = (key) => createHash("sha256").update(stripeBrowserKey.parse(key)).digest("hex");
  function stripe() {
    if (!env.STRIPE_SECRET_KEY || !secret || secret.length < 32) {
      throw fail("Configure Stripe and the Accounting Stripe state secret first.", "STRIPE_NOT_CONFIGURED");
    }
    return stripeFactory(env.STRIPE_SECRET_KEY);
  }

  async function account(owner, db = pool) {
    const [[row]] = await db.execute(
      "SELECT stripe_account_id FROM accounting_stripe_accounts WHERE owner_person_id = ?", [owner],
    );
    if (!row) throw fail("Connect the existing Stripe account first.", "STRIPE_NOT_CONNECTED");
    return row.stripe_account_id;
  }

  async function sync(db, owner, id, remote, sent = false) {
    await db.execute(`UPDATE accounting_invoices SET stripe_status = ?, amount_paid_minor = ?,
      amount_remaining_minor = ?, stripe_hosted_url = ?, stripe_pdf_url = ?,
      sent_at = IF(?, COALESCE(sent_at, UTC_TIMESTAMP(6)), sent_at),
      invoice_status = IF(?, 'issued', invoice_status)
      WHERE owner_person_id = ? AND invoice_id = ?`,
    [remote.status, remote.amount_paid, remote.amount_remaining, remote.hosted_invoice_url ?? null,
      remote.invoice_pdf ?? null, sent, sent, owner, id]);
    return getRow(db, owner, id);
  }

  async function refresh(owner, id) {
    return withInvoiceLock(pool, id, async (db) => {
      const row = await getRow(db, owner, id);
      if (!row.stripe_invoice_id) return invoiceObject(db, row);
      const remote = await stripe().invoices.retrieve(row.stripe_invoice_id, {}, { stripeAccount: row.stripe_account_id });
      return invoiceObject(db, await sync(db, owner, id, remote));
    });
  }

  async function saveDraft(owner, input, { id = randomUUID(), revision = null } = {}) {
    const data = invoiceDraft.parse(input);
    return withPoolTransaction(pool, async (db) => {
      const total = data.lines.reduce((sum, line) => sum + line.amount_minor, 0);
      if (total > 99999999) throw fail("The invoice total exceeds the supported limit.", "INVOICE_AMOUNT_LIMIT", 400);
      const values = [data.payer_name ?? null, data.payer_email ?? null, data.description ?? null,
        data.currency, data.due_on ?? null, data.payment_methods, total, randomUUID()];
      if (revision == null) {
        const invoiceNumber = await nextInvoiceNumber(db, owner);
        await db.execute(`INSERT INTO accounting_invoices (payer_name, payer_email, description,
          currency, due_on, payment_methods, amount_minor, revision, owner_person_id, invoice_id, invoice_number)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...values, owner, id, invoiceNumber]);
      } else {
        const row = await getRow(db, owner, id, true);
        if (row.revision !== revision || row.invoice_status !== "draft" || row.stripe_invoice_id) {
          throw fail("The draft changed or sending has started. Read the current invoice.", "INVOICE_REVISION_CONFLICT");
        }
        const [existing] = await db.execute(
          "SELECT invoice_line_id, description, amount_minor, todo_ref, receipt_ref FROM accounting_invoice_lines WHERE invoice_id = ? ORDER BY position",
          [id],
        );
        if (data.lines.length < existing.length) {
          throw fail("Keep the existing lines in their original positions.", "INVOICE_LINE_REMOVAL_UNSUPPORTED", 400);
        }
        await db.execute(`UPDATE accounting_invoices SET payer_name = ?, payer_email = ?, description = ?,
          currency = ?, due_on = ?, payment_methods = ?, amount_minor = ?, revision = ?, amount_remaining_minor = NULL
          WHERE owner_person_id = ? AND invoice_id = ?`, [...values, owner, id]);
        await db.execute("DELETE FROM accounting_invoice_lines WHERE invoice_id = ?", [id]);
        // Preserve positional identities for the existing lines, including edited amounts and text.
        data.lines.forEach((line, index) => { line.id = existing[index]?.invoice_line_id; });
      }
      await saveLines(db, id, data.lines);
      return invoiceObject(db, await getRow(db, owner, id));
    });
  }

  async function correctPaidPayer(owner, id, revision, input) {
    const payer = invoicePayer.required().strict().parse(input);
    return withPoolTransaction(pool, async (db) => {
      const row = await getRow(db, owner, id, true);
      if (row.revision !== revision) {
        throw fail("The invoice changed. Reopen it before editing the recipient.", "INVOICE_REVISION_CONFLICT");
      }
      if (row.stripe_invoice_id || row.invoice_status !== "paid") {
        throw fail("Recipient correction is available for locally paid invoices.", "INVOICE_PAYER_LOCKED");
      }
      await db.execute(`UPDATE accounting_invoices SET payer_name = ?, payer_email = ?, revision = ?
        WHERE owner_person_id = ? AND invoice_id = ?`, [payer.payer_name, payer.payer_email, randomUUID(), owner, id]);
      return invoiceObject(db, await getRow(db, owner, id));
    });
  }

  async function list(owner, { invoice_id, invoice_number, cursor, text, limit = 25 }) {
    if (invoice_number != null) {
      if (invoice_id || cursor || text) throw fail("Use the invoice number by itself.", "INVOICE_FILTER_CONFLICT", 400);
      const [[match]] = await pool.execute(`SELECT invoice_id FROM accounting_invoices
        WHERE owner_person_id = ? AND invoice_number = ?`, [owner, invoice_number]);
      if (!match) throw fail("Invoice not found.", "INVOICE_NOT_FOUND", 404);
      invoice_id = match.invoice_id;
    }
    if (invoice_id) {
      const row = await getRow(pool, owner, invoice_id);
      if (!row.stripe_invoice_id) return { objects: [await invoiceObject(pool, row)], nextCursor: null };
      try { return { objects: [await refresh(owner, invoice_id)], nextCursor: null }; }
      catch { return { objects: [await invoiceObject(pool, row, { refreshFailed: true })], nextCursor: null }; }
    }
    const [rows] = await pool.execute(`SELECT * FROM accounting_invoices WHERE owner_person_id = ?
      AND (? IS NULL OR invoice_number < (SELECT invoice_number FROM accounting_invoices WHERE owner_person_id = ? AND invoice_id = ?))
      AND (? IS NULL OR LOCATE(LOWER(?), LOWER(CONCAT_WS(' ', CONCAT('#', invoice_number), payer_name, payer_email, description, stripe_invoice_id))) > 0)
      ORDER BY invoice_number DESC LIMIT ?`, [owner, cursor ?? null, owner, cursor ?? null, text ?? null, text ?? null, limit + 1]);
    return {
      objects: await Promise.all(rows.slice(0, limit).map((row) => invoiceObject(pool, row, { includeLines: false }))),
      nextCursor: rows.length > limit ? rows[limit - 1].invoice_id : null,
    };
  }

  async function connectionStatus(owner) {
    const [[row]] = await pool.execute(
      "SELECT stripe_account_id FROM accounting_stripe_accounts WHERE owner_person_id = ?", [owner],
    );
    const missingConnectSettings = [
      !env.STRIPE_SECRET_KEY && "STRIPE_SECRET_KEY",
      !(secret?.length >= 32) && "ACCOUNTING_STRIPE_STATE_SECRET",
      !env.STRIPE_CONNECT_CLIENT_ID && "STRIPE_CONNECT_CLIENT_ID",
      !env.ACCOUNTING_STRIPE_CALLBACK_URL && "ACCOUNTING_STRIPE_CALLBACK_URL",
    ].filter(Boolean);
    const webhookConfigured = Boolean(env.STRIPE_CONNECT_WEBHOOK_SECRET);
    return { stripeAccountId: row?.stripe_account_id ?? null, missingConnectSettings, webhookConfigured,
      configured: missingConnectSettings.length === 0 && webhookConfigured };
  }

  async function beginConnect(owner, browserKey) {
    stripe();
    if (!env.STRIPE_CONNECT_CLIENT_ID || !env.ACCOUNTING_STRIPE_CALLBACK_URL) {
      throw fail("Configure the Stripe Connect application and callback URL.", "STRIPE_CONNECT_NOT_CONFIGURED");
    }
    const url = new URL("https://connect.stripe.com/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code", client_id: env.STRIPE_CONNECT_CLIENT_ID, scope: "read_write",
      redirect_uri: env.ACCOUNTING_STRIPE_CALLBACK_URL,
      state: sign({ purpose: "connect", owner, browserDigest: browserDigest(browserKey), expires: Date.now() + 600000 }, secret),
    });
    return { url: url.href };
  }

  async function finishConnect({ state, code }) {
    const client = stripe();
    const { owner, browserDigest: digest } = verify(state, secret, "connect");
    if (typeof code !== "string" || !code) throw fail("Stripe did not authorize the account.", "STRIPE_CONNECT_DECLINED", 400);
    const token = await client.oauth.token({ grant_type: "authorization_code", code });
    const accountId = token.stripe_user_id;
    if (!accountId) throw fail("Stripe did not return a connected account.", "STRIPE_ACCOUNT_MISSING");
    return sign({ purpose: "connect-complete", owner, accountId, browserDigest: digest, expires: Date.now() + 600000 }, secret);
  }

  async function completeConnect(owner, token, browserKey) {
    stripe();
    const connection = verify(token, secret, "connect-complete");
    if (connection.owner !== owner) throw fail("This authorization belongs to another owner.", "STRIPE_OWNER_MISMATCH", 403);
    if (connection.browserDigest !== browserDigest(browserKey)) {
      throw fail("Complete Stripe setup in the tab where you started.", "STRIPE_BROWSER_MISMATCH", 403);
    }
    const { accountId } = connection;
    await withPoolTransaction(pool, async (db) => {
      // Serialize connection changes for a person even before their first connection exists.
      await db.execute("SELECT person_id FROM people2_people WHERE person_id = ? FOR UPDATE", [owner]);
      const [[existing]] = await db.execute(
        "SELECT stripe_account_id FROM accounting_stripe_accounts WHERE owner_person_id = ?", [owner],
      );
      if (existing?.stripe_account_id === accountId) return;
      if (existing) throw fail("This owner already has a different Stripe account.", "STRIPE_ACCOUNT_CONFLICT");
      try {
        await db.execute("INSERT INTO accounting_stripe_accounts VALUES (?, ?)", [owner, accountId]);
      } catch (error) {
        if (error.code !== "ER_DUP_ENTRY") throw error;
        throw fail("This Stripe account already belongs to a different Accounting owner.", "STRIPE_ACCOUNT_CONFLICT");
      }
    });
    return { connected: true, stripeAccountId: accountId };
  }

  async function prepareSend(owner, id) {
    const row = await getRow(pool, owner, id);
    if (row.adopted_at || row.sent_at || !["draft", "sending"].includes(row.invoice_status) || ["paid", "void", "uncollectible"].includes(row.stripe_status)) {
      throw fail("This invoice has already been issued or adopted.", "INVOICE_ALREADY_ISSUED");
    }
    if (!row.payer_name || !row.payer_email || !row.due_on || !Number(row.amount_minor)
      || stripeDate(row.due_on, true) <= Date.now() / 1000) {
      throw fail("Set a payer name, email, current or future due date, and positive total.", "INVOICE_INCOMPLETE");
    }
    const accountId = await account(owner);
    const provider = await stripe().accounts.retrieve(accountId);
    if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) {
      throw fail("Configure the Accounting Stripe webhook secret before sending.", "STRIPE_WEBHOOK_NOT_CONFIGURED");
    }
    if (!provider.charges_enabled) throw fail("Stripe has not enabled charges for this account.", "STRIPE_CHARGES_DISABLED");
    const formatter = new Intl.NumberFormat("en", { style: "currency", currency: row.currency });
    const divisor = 10 ** formatter.resolvedOptions().maximumFractionDigits;
    const total = formatter.format(Number(row.amount_minor) / divisor);
    const token = sign({ purpose: "send", owner, id, revision: row.revision, accountId,
      expires: Date.now() + 900000 }, secret);
    const methods = { ach_only: "bank account only", card_only: "card only", card_and_ach: "card or bank account" };
    return { contractVersion: 1, status: "ready", nextAction: {
      type: "request_user_confirmation",
      instruction: `Send invoice #${row.invoice_number} for ${row.currency} ${total} to ${row.payer_name} at ${row.payer_email}, due ${row.due_on}, accepting ${methods[row.payment_methods]}?`,
      onApproval: { tool: "send_invoice", arguments: { send_token: token } },
    } };
  }

  async function send(owner, token) {
    const client = stripe();
    const plan = verify(token, secret, "send");
    if (plan.owner !== owner) throw fail("Invoice authorization belongs to another owner.", "INVOICE_OWNER_MISMATCH", 403);
    return withInvoiceLock(pool, plan.id, async (db) => {
      let row;
      await db.beginTransaction();
      try {
        row = await getRow(db, owner, plan.id, true);
        if (row.revision !== plan.revision || await account(owner, db) !== plan.accountId) {
          throw fail("The invoice or Stripe account changed. Prepare a fresh confirmation.", "INVOICE_REVISION_CONFLICT");
        }
        if (!row.sent_at) {
          if (row.adopted_at || !["draft", "sending"].includes(row.invoice_status) || ["paid", "void", "uncollectible"].includes(row.stripe_status)) {
            throw fail("This invoice can no longer be sent.", "INVOICE_ALREADY_ISSUED");
          }
          const started = row.send_started_at && Date.parse(row.send_started_at.replace(" ", "T") + "Z");
          if (started && Date.now() - started >= 23 * 3600000) {
            throw fail("Check this attempt in Stripe before sending again. Its automatic retry window expired.", "INVOICE_RETRY_EXPIRED");
          }
          await db.execute(`UPDATE accounting_invoices SET stripe_account_id = ?, invoice_status = 'sending',
            send_started_at = COALESCE(send_started_at, UTC_TIMESTAMP(6))
            WHERE owner_person_id = ? AND invoice_id = ?`, [plan.accountId, owner, plan.id]);
        }
        await db.commit();
      } catch (error) { await db.rollback(); throw error; }
      if (row.sent_at) return { invoice: await invoiceObject(db, row), idempotentReplay: true };
      const options = (step) => ({ stripeAccount: plan.accountId, idempotencyKey: `accounting-${plan.id}-${step}` });
      try {
        let remoteId = row.stripe_invoice_id;
        if (!remoteId) {
          const customer = await client.customers.create({ name: row.payer_name, email: row.payer_email }, options("customer"));
          const remote = await client.invoices.create({
            customer: customer.id, collection_method: "send_invoice", auto_advance: false,
            due_date: stripeDate(row.due_on, true), description: row.description ?? undefined,
            payment_settings: { payment_method_types: policies[row.payment_methods] },
            metadata: { accounting_invoice_id: plan.id },
          }, options("create"));
          remoteId = remote.id;
          await db.execute(`UPDATE accounting_invoices SET stripe_invoice_id = ?, stripe_customer_id = ?
            WHERE owner_person_id = ? AND invoice_id = ?`, [remoteId, customer.id, owner, plan.id]);
        }
        const remote = await client.invoices.retrieve(remoteId, {}, { stripeAccount: plan.accountId });
        if (remote.status === "draft") {
          const invoice = await invoiceObject(db, row);
          for (const line of invoice.lines) {
            await client.invoiceItems.create({
              customer: remote.customer, invoice: remoteId, description: line.description,
              amount: line.amountMinor, currency: row.currency.toLowerCase(),
            }, options(`line-${line.id}`));
          }
          await client.invoices.finalizeInvoice(remoteId, {}, options("finalize"));
        } else if (remote.status !== "open") {
          await sync(db, owner, plan.id, remote);
          throw fail(`Stripe reports this invoice as ${remote.status}.`, "INVOICE_NOT_OPEN");
        }
        const sent = await client.invoices.sendInvoice(remoteId, {}, options("send"));
        return { invoice: await invoiceObject(db, await sync(db, owner, plan.id, sent, true)), idempotentReplay: false };
      } catch (error) {
        if (error.status) throw error;
        throw fail("Stripe send could not be confirmed. Check the invoice before retrying.", "STRIPE_SEND_UNCONFIRMED");
      }
    });
  }

  async function adopt(owner, remoteId) {
    const accountId = await account(owner);
    const client = stripe();
    const options = { stripeAccount: accountId };
    const remote = await client.invoices.retrieve(remoteId, {}, options);
    if (!["open", "paid", "void", "uncollectible"].includes(remote.status)) {
      throw fail("Only finalized Stripe invoices can be adopted.", "STRIPE_INVOICE_NOT_FINALIZED");
    }
    const lines = [];
    for await (const line of client.invoices.listLineItems(remoteId, { limit: 100 }, options)) {
      if (lines.length === 500) throw fail("This invoice exceeds 500 lines.", "INVOICE_LINE_LIMIT");
      lines.push({ description: (line.description || "Stripe invoice line").slice(0, 1000), amount_minor: line.amount });
    }
    const id = randomUUID();
    let savedId;
    try {
      savedId = await withPoolTransaction(pool, async (db) => {
        const invoiceNumber = await nextInvoiceNumber(db, owner);
        await db.execute(`INSERT INTO accounting_invoices
          (invoice_id, owner_person_id, payer_name, payer_email, description, currency, due_on,
           payment_methods, amount_minor, revision, stripe_account_id, stripe_customer_id, stripe_invoice_id,
           invoice_number, invoice_status, adopted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', UTC_TIMESTAMP(6))`,
        [id, owner, remote.customer_name ?? null, remote.customer_email ?? null,
          remote.description?.slice(0, 1000) ?? null, remote.currency.toUpperCase(),
          remote.due_date ? new Date(remote.due_date * 1000).toISOString().slice(0, 10) : null,
          remote.payment_settings?.payment_method_types?.includes("card")
            ? remote.payment_settings.payment_method_types.includes("us_bank_account") ? "card_and_ach" : "card_only"
            : "ach_only",
          remote.total, randomUUID(), accountId, remote.customer, remoteId, invoiceNumber]);
        if (lines.length) await saveLines(db, id, lines);
        await sync(db, owner, id, remote);
        return id;
      });
    } catch (error) {
      if (error.code !== "ER_DUP_ENTRY") throw error;
      const [[existing]] = await pool.execute(`SELECT invoice_id FROM accounting_invoices
        WHERE owner_person_id = ? AND stripe_account_id = ? AND stripe_invoice_id = ?`, [owner, accountId, remoteId]);
      if (!existing) throw error;
      savedId = existing.invoice_id;
    }
    // Once the local mapping is visible, reread Stripe to close the adoption/webhook race.
    const { objects: [invoice] } = await list(owner, { invoice_id: savedId });
    return { invoice, idempotentReplay: savedId !== id };
  }

  async function webhook(body, signature) {
    const client = stripe();
    if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) throw fail("Stripe webhook is unconfigured.", "STRIPE_WEBHOOK_NOT_CONFIGURED");
    let event;
    try { event = client.webhooks.constructEvent(body, signature, env.STRIPE_CONNECT_WEBHOOK_SECRET); }
    catch { throw fail("Invalid Stripe webhook signature.", "STRIPE_WEBHOOK_SIGNATURE", 400); }
    if (!event.account || event.data.object?.object !== "invoice" || !event.type.startsWith("invoice.")) return;
    const [[row]] = await pool.execute(`SELECT owner_person_id, invoice_id FROM accounting_invoices
      WHERE stripe_account_id = ? AND stripe_invoice_id = ?`, [event.account, event.data.object.id]);
    if (row) await refresh(row.owner_person_id, row.invoice_id);
  }

  const readSavedInvoice = (owner, id) => withPoolTransaction(pool, async (db) =>
    invoiceObject(db, await getRow(db, owner, id)));
  return { saveDraft, correctPaidPayer, readSavedInvoice, list, connectionStatus, beginConnect, finishConnect, completeConnect, prepareSend, send, adopt, webhook };
}
