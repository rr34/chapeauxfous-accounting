import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "dotenv";
import mysql from "mysql2/promise";

const sourceStatuses = new Set(["prepared", "sending", "open", "processing", "paid", "failed", "voided", "uncollectible"]);
const stripeStatuses = new Set(["draft", "open", "paid", "void", "uncollectible"]);
const paymentMethods = new Set(["ach_only", "card_only", "card_and_ach"]);

function personId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} must be a positive person ID.`);
  return id;
}

function minorUnits(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid invoice amount in minor units.");
  return amount;
}

export function normalizeAgentInvoice(row, sourceLines) {
  if (!sourceStatuses.has(row.status) || !paymentMethods.has(row.payment_method_policy) || !/^[A-Z]{3}$/.test(row.currency)) {
    throw new Error(`Agent invoice ${row.payment_invoice_id} has an unrecognized status, payment method, or currency.`);
  }
  if (row.stripe_invoice_id && !row.stripe_connected_account_id) {
    throw new Error(`Agent invoice ${row.payment_invoice_id} has a Stripe invoice ID without a connected account ID.`);
  }
  const amount = minorUnits(row.amount_minor);
  const paid = minorUnits(row.amount_paid_minor);
  const lines = sourceLines.map((line) => ({
    position: Number(line.line_position), description: line.description_snapshot,
    amount: minorUnits(line.amount_minor_snapshot),
    receiptRef: line.file_id == null ? null : `agent-slayer://files/${line.file_id}`,
  }));
  if (!lines.length || lines.some((line, index) => line.position !== index + 1)
      || lines.reduce((sum, line) => sum + line.amount, 0) !== amount || paid > amount) {
    throw new Error(`Agent invoice ${row.payment_invoice_id} failed line position or total validation.`);
  }
  const stripeStatus = row.stripe_invoice_id
    ? stripeStatuses.has(row.processor_status) ? row.processor_status
      : ({ paid: "paid", voided: "void", uncollectible: "uncollectible", open: "open", processing: "open",
        prepared: "draft" }[row.status] ?? null)
    : null;
  const remaining = ["paid", "voided", "uncollectible"].includes(row.status) ? 0 : amount - paid;
  return { row, lines, amount, paid, remaining, stripeStatus };
}

async function snapshot(source, sourcePerson) {
  // Agent's logical views select rows using a connection-local person context.
  await source.query("SET @timev3_person_id = ?", [personId(sourcePerson, "Source person")]);
  await source.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  try {
    const [invoices] = await source.query(`SELECT payment_invoice_id, status, currency, amount_minor, due_on,
      payment_method_policy, description, payer_name_snapshot, payer_email_snapshot, stripe_connected_account_id,
      stripe_customer_id, stripe_invoice_id, processor_status, hosted_invoice_url, amount_paid_minor,
      created_at_utc, opened_at_utc
      FROM payment_invoices ORDER BY payment_invoice_id`);
    const [lines] = await source.query(`SELECT line.payment_invoice_id, line.line_position, line.description_snapshot,
      line.amount_minor_snapshot, receipt.file_id FROM payment_invoice_lines line
      LEFT JOIN payment_invoice_line_receipts_join receipt USING (payment_invoice_line_id)
      ORDER BY line.payment_invoice_id, line.line_position`);
    const byInvoice = new Map();
    for (const line of lines) {
      const id = String(line.payment_invoice_id);
      if (!byInvoice.has(id)) byInvoice.set(id, []);
      byInvoice.get(id).push(line);
    }
    return invoices.map((row) => normalizeAgentInvoice(row, byInvoice.get(String(row.payment_invoice_id)) ?? []));
  } finally {
    await source.rollback();
  }
}

async function createInvoice(db, owner, invoice) {
  const { row, lines, amount, paid, remaining, stripeStatus } = invoice;
  const id = randomUUID();
  await db.execute(`INSERT INTO accounting_invoices (
    invoice_id, owner_person_id, payer_name, payer_email, description, currency, due_on, payment_methods,
    amount_minor, amount_paid_minor, amount_remaining_minor, stripe_status, revision, stripe_account_id,
    stripe_customer_id, stripe_invoice_id, stripe_hosted_url, sent_at, adopted_at, created_at,
    agent_invoice_id, agent_invoice_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? IS NULL, NULL, UTC_TIMESTAMP(6)), ?, ?, ?)`,
  [id, owner, row.payer_name_snapshot, row.payer_email_snapshot, row.description, row.currency, row.due_on,
    row.payment_method_policy, amount, paid, remaining, stripeStatus, randomUUID(), row.stripe_connected_account_id,
    row.stripe_customer_id, row.stripe_invoice_id, row.hosted_invoice_url, row.opened_at_utc, row.stripe_invoice_id,
    row.created_at_utc, row.payment_invoice_id, row.status]);
  await db.query(`INSERT INTO accounting_invoice_lines
    (invoice_line_id, invoice_id, position, description, amount_minor, receipt_ref) VALUES ?`,
  [lines.map((line) => [randomUUID(), id, line.position, line.description, line.amount, line.receiptRef])]);
}

async function findAction(db, owner, account, invoice, apply) {
  const { row, lines, amount } = invoice;
  if (row.stripe_invoice_id && row.stripe_connected_account_id !== account) {
    throw new Error(`Agent invoice ${row.payment_invoice_id} belongs to a different Stripe account. Connect the original account first.`);
  }
  const lock = apply ? " FOR UPDATE" : "";
  const [[previous]] = await db.execute(`SELECT owner_person_id, stripe_account_id, stripe_invoice_id
    FROM accounting_invoices WHERE agent_invoice_id = ?${lock}`, [row.payment_invoice_id]);
  if (previous) {
    if (Number(previous.owner_person_id) !== owner || previous.stripe_invoice_id !== row.stripe_invoice_id) {
      throw new Error(`Agent invoice ${row.payment_invoice_id} already maps to a different Accounting owner or Stripe invoice.`);
    }
    return { kind: "alreadyImported" };
  }
  if (!row.stripe_invoice_id) return { kind: "create" };
  const [[existing]] = await db.execute(`SELECT invoice_id, owner_person_id, adopted_at, agent_invoice_id, currency, amount_minor
    FROM accounting_invoices WHERE stripe_account_id = ? AND stripe_invoice_id = ?${lock}`,
  [row.stripe_connected_account_id, row.stripe_invoice_id]);
  if (!existing) return { kind: "create" };
  if (Number(existing.owner_person_id) !== owner || !existing.adopted_at || existing.agent_invoice_id != null
      || existing.currency !== row.currency || Number(existing.amount_minor) !== amount) {
    throw new Error(`Agent invoice ${row.payment_invoice_id} conflicts with an existing Accounting invoice.`);
  }
  const [existingLines] = await db.execute(`SELECT position, amount_minor FROM accounting_invoice_lines
    WHERE invoice_id = ? ORDER BY position${lock}`, [existing.invoice_id]);
  if (existingLines.length !== lines.length || existingLines.some((line, index) =>
    Number(line.position) !== lines[index].position || Number(line.amount_minor) !== lines[index].amount)) {
    throw new Error(`Agent invoice ${row.payment_invoice_id} has different lines from the existing Stripe import.`);
  }
  return { kind: "enrichStripeImport", id: existing.invoice_id };
}

async function enrichInvoice(db, id, invoice) {
  const { row, lines } = invoice;
  await db.execute(`UPDATE accounting_invoices SET agent_invoice_id = ?, agent_invoice_status = ?,
    payer_name = ?, payer_email = ?, description = ?, due_on = ?, payment_methods = ?, created_at = ?,
    sent_at = COALESCE(sent_at, ?) WHERE invoice_id = ?`,
  [row.payment_invoice_id, row.status, row.payer_name_snapshot, row.payer_email_snapshot, row.description,
    row.due_on, row.payment_method_policy, row.created_at_utc, row.opened_at_utc, id]);
  for (const line of lines) {
    await db.execute(`UPDATE accounting_invoice_lines SET description = ?, receipt_ref = ?
      WHERE invoice_id = ? AND position = ?`, [line.description, line.receiptRef, id, line.position]);
  }
}

export async function importAgentInvoices({ source, destination, sourcePerson, owner, apply = false }) {
  const invoices = await snapshot(source, sourcePerson);
  if (apply && !invoices.length) throw new Error(`No invoices found for Agent person ${sourcePerson}. Check the source before applying.`);
  if (apply) await destination.beginTransaction();
  else await destination.query("START TRANSACTION READ ONLY");
  const counts = { sourceInvoices: invoices.length, create: 0, enrichStripeImport: 0, alreadyImported: 0,
    localPaid: 0, stripeBacked: 0, needsReview: 0, receiptReferences: 0 };
  try {
    const [[person]] = await destination.execute(
      `SELECT person_id FROM people2_people WHERE person_id = ?${apply ? " FOR UPDATE" : ""}`, [owner],
    );
    if (!person) throw new Error(`Accounting person ${owner} does not exist.`);
    const [[connection]] = await destination.execute(
      "SELECT stripe_account_id FROM accounting_stripe_accounts WHERE owner_person_id = ?", [owner],
    );
    for (const invoice of invoices) {
      const { row, lines } = invoice;
      const action = await findAction(destination, owner, connection?.stripe_account_id, invoice, apply);
      counts[action.kind]++;
      if (row.stripe_invoice_id) counts.stripeBacked++;
      else if (row.status === "paid") counts.localPaid++;
      else if (!["prepared", "voided", "uncollectible"].includes(row.status)) counts.needsReview++;
      counts.receiptReferences += lines.filter((line) => line.receiptRef).length;
      if (apply && action.kind === "create") await createInvoice(destination, owner, invoice);
      if (apply && action.kind === "enrichStripeImport") await enrichInvoice(destination, action.id, invoice);
    }
    if (apply) await destination.commit();
    else await destination.rollback();
    return counts;
  } catch (error) {
    await destination.rollback();
    throw error;
  }
}

async function main() {
  const { values: args } = parseArgs({ options: {
    "agent-env": { type: "string" }, "source-person": { type: "string" },
    "accounting-person": { type: "string" }, apply: { type: "boolean" },
  } });
  if (!args["agent-env"]) throw new Error("Pass --agent-env with the Agent server .env path.");
  const sourcePerson = personId(args["source-person"], "--source-person");
  const owner = personId(args["accounting-person"], "--accounting-person");
  const env = parse(await readFile(args["agent-env"]));
  // Agent's payment tables are restricted by the app to the configured legacy person.
  if (sourcePerson !== personId(env.SLAYER_LEGACY_PERSON_ID ?? "1", "SLAYER_LEGACY_PERSON_ID")) {
    throw new Error("The requested source person does not own the Agent's legacy payment store.");
  }
  if (!env.MARIADB_NAME || !env.MARIADB_USER) throw new Error("Agent MariaDB settings are incomplete.");
  const { pool, databaseName } = await import("../src/db.js");
  let source;
  let destination;
  try {
    if (env.MARIADB_NAME === databaseName) throw new Error("Agent and Accounting must use distinct database names.");
    destination = await pool.getConnection();
    const [[schema]] = await destination.query("SELECT schema_version FROM accounting_schema_metadata WHERE singleton = 1");
    if (Number(schema?.schema_version) !== 27) {
      throw new Error("The one-time Agent importer only supports Accounting schema 27. Accounting owns invoice numbers from schema 28 onward.");
    }
    source = await mysql.createConnection({
      host: env.MARIADB_HOST || "localhost", port: Number(env.MARIADB_PORT || 3306),
      socketPath: env.MARIADB_SOCKET || undefined, database: env.MARIADB_NAME,
      user: env.MARIADB_USER, password: env.MARIADB_PASSWORD ?? "", dateStrings: true,
      supportBigNumbers: true, bigNumberStrings: true, charset: "utf8mb4",
    });
    const counts = await importAgentInvoices({ source, destination, sourcePerson, owner, apply: args.apply });
    console.log(JSON.stringify({ mode: args.apply ? "applied" : "dry-run", sourcePerson, accountingPerson: owner, ...counts }, null, 2));
  } finally {
    destination?.release();
    try { await source?.end(); }
    finally { await pool.end(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // mysql2 errors can include source data and statement text.
    console.error(error.code ? `Invoice transfer failed (${error.code}).` : error.message);
    process.exitCode = 1;
  });
}
