import { randomUUID } from "node:crypto";
import { withPoolTransaction } from "./db.js";
import { attachTags, validateTransaction } from "./accounting.js";
import { accountingQuestionTagKeys, accountingQuestionTags } from "./accounting-questions.js";
import { decimalToUnits, unitsToDecimal } from "./money.js";

export const PURCHASE_EVIDENCE_SCHEMA_URI = "accounting://schemas/purchase-evidence-record/v2";
export const PURCHASE_EVIDENCE_MAX_TARGETS = 500;
export const PURCHASE_EVIDENCE_MAX_ITEMS = 5000;

export const purchaseEvidenceCanonicalJsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PURCHASE_EVIDENCE_SCHEMA_URI,
  title: "Canonical purchase evidence record",
  description: "One selected suspense charge, its provider-neutral evidence references, receipt items, sales tax, and explicit signed order-level adjustments.",
  type: "object",
  additionalProperties: false,
  required: ["target_line_item_id", "sources", "merchant", "purchase_date", "charge_amount_decimal",
    "tax_amount_decimal", "adjustments", "items"],
  properties: {
    target_line_item_id: { type: "integer", minimum: 1,
      description: "Exact selected suspense posting this evidence supports." },
    sources: { type: "array", minItems: 1, maxItems: 20, items: { type: "object",
      additionalProperties: false, required: ["kind", "source_ref", "source_record_id", "display_name"],
      properties: {
        kind: { enum: ["email", "amazon_export", "receipt", "file", "other"] },
        source_ref: { type: "string", minLength: 1, maxLength: 2048 },
        source_record_id: { type: ["string", "null"], maxLength: 255 },
        display_name: { type: ["string", "null"], maxLength: 1024 },
      } } },
    merchant: { type: ["string", "null"], maxLength: 1024 },
    purchase_date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    charge_amount_decimal: { type: "string", pattern: "^\\d+(?:\\.\\d+)?$", maxLength: 128,
      description: "Positive final charge magnitude; it must exactly equal the selected suspense posting magnitude." },
    tax_amount_decimal: { type: "string", pattern: "^\\d+(?:\\.\\d+)?$", maxLength: 128,
      description: "Receipt-level sales tax. Accounting allocates it proportionally and preserves it separately." },
    adjustments: { type: "array", maxItems: 100, items: { type: "object",
      additionalProperties: false, required: ["kind", "description", "amount_decimal"],
      properties: {
        kind: { enum: ["discount", "shipping", "handling", "fee", "tip", "other"] },
        description: { type: "string", minLength: 1, maxLength: 1024 },
        amount_decimal: { type: "string", pattern: "^[+-]?\\d+(?:\\.\\d+)?$", maxLength: 128,
          description: "Signed receipt adjustment. Discounts are negative; added costs are positive." },
      } } },
    items: { type: "array", minItems: 1, maxItems: 500, items: { type: "object",
      additionalProperties: false, required: ["source_item_id", "description", "quantity_decimal", "pre_tax_amount_decimal"],
      properties: {
        source_item_id: { type: ["string", "null"], maxLength: 255 },
        description: { type: "string", minLength: 1, maxLength: 16000 },
        quantity_decimal: { type: ["string", "null"], pattern: "^\\d+(?:\\.\\d+)?$", maxLength: 128 },
        pre_tax_amount_decimal: { type: "string", pattern: "^\\d+(?:\\.\\d+)?$", maxLength: 128 },
      } } },
  },
});

function purchaseError(message, code, details = undefined, status = 400) {
  return Object.assign(new Error(message), { message, code, details, status });
}

function ownerId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw purchaseError("Authenticated owner is invalid.",
    "INVALID_PURCHASE_EVIDENCE_OWNER", undefined, 500);
  return id;
}

function positiveId(value, label = "Identifier") {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw purchaseError(`${label} is invalid.`,
    "INVALID_PURCHASE_EVIDENCE_IDENTIFIER");
  return id;
}

function jobId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(id)) {
    throw purchaseError("Purchase-evidence job not found.", "PURCHASE_EVIDENCE_JOB_NOT_FOUND", undefined, 404);
  }
  return id;
}

function boundedText(value, maximum, label, { required = false } = {}) {
  const text = value == null ? "" : String(value).trim();
  if (!text) {
    if (required) throw purchaseError(`${label} is required.`, "INVALID_PURCHASE_EVIDENCE_RECORD");
    return null;
  }
  if ([...text].length > maximum) throw purchaseError(`${label} cannot exceed ${maximum} characters.`,
    "INVALID_PURCHASE_EVIDENCE_RECORD");
  return text;
}

function absolute(value) { return value < 0n ? -value : value; }

function accountPaths(rows) {
  const byId = new Map(rows.map((row) => [Number(row.account_id), row]));
  const paths = new Map();
  const resolve = (id, visiting = new Set()) => {
    if (paths.has(id)) return paths.get(id);
    const row = byId.get(id);
    if (!row || visiting.has(id)) return row?.AccountName ?? String(id);
    const parent = row.parent_account_id == null ? null
      : resolve(Number(row.parent_account_id), new Set(visiting).add(id));
    const value = parent == null ? String(row.AccountName) : `${parent}:${row.AccountName}`;
    paths.set(id, value);
    return value;
  };
  for (const id of byId.keys()) resolve(id);
  return paths;
}

export function allocateProportionally(totalUnits, weights) {
  const total = BigInt(totalUnits);
  const resolved = weights.map((value) => BigInt(value));
  if (total < 0n || resolved.some((value) => value < 0n)) {
    throw purchaseError("Allocation amounts cannot be negative.", "INVALID_PURCHASE_EVIDENCE_ALLOCATION");
  }
  if (resolved.length === 0) throw purchaseError("Allocation requires at least one item.",
    "INVALID_PURCHASE_EVIDENCE_ALLOCATION");
  const weightTotal = resolved.reduce((sum, value) => sum + value, 0n);
  if (weightTotal === 0n) {
    if (total === 0n) return resolved.map(() => 0n);
    throw purchaseError("A nonzero amount cannot be allocated across zero-value items.",
      "INVALID_PURCHASE_EVIDENCE_ALLOCATION");
  }
  const allocations = resolved.map((weight) => total * weight / weightTotal);
  const remainders = resolved.map((weight, index) => ({ index, remainder: total * weight % weightTotal }));
  let remaining = total - allocations.reduce((sum, value) => sum + value, 0n);
  remainders.sort((left, right) => left.remainder === right.remainder
    ? left.index - right.index : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; remaining > 0n; index += 1, remaining -= 1n) {
    allocations[remainders[index % remainders.length].index] += 1n;
  }
  return allocations;
}

export function allocateSignedProportionally(totalUnits, weights) {
  const total = BigInt(totalUnits);
  const sign = total < 0n ? -1n : 1n;
  return allocateProportionally(absolute(total), weights).map((value) => value * sign);
}

function copiedPrompt(id) {
  return [
    "Prepare purchase evidence for these selected Accounting suspense postings:",
    "",
    `accounting://purchase-evidence-jobs/${id}`,
    "",
    "Use the Accounting MCP to resolve and start this exact job. Search my connected receipt emails and use any receipt exports, saved order-history pages, archives, or files I supplied with this request. Match only evidence supported by the amount and source facts, produce the complete canonical purchase-evidence JSON Lines artifact, and submit it to Accounting. Do not guess expense accounts and do not commit the preview. Stop after reporting matched and unmatched charges and asking for my approval.",
  ].join("\n");
}

const jobBaseSelect = `
  SELECT pej.purchase_evidence_job_id, pej.suspense_account_id, pej.currency_id, pej.job_status,
         pej.canonical_artifact_id, pej.created_at, pej.updated_at, pej.committed_at,
         a.AccountName, c.CurrencyAbbreviation, c.scale
    FROM accounting_purchase_evidence_jobs pej
    JOIN accounts a ON a.account_id = pej.suspense_account_id AND a.owner_person_id = pej.owner_person_id
    JOIN currencies c ON c.currency_id = pej.currency_id`;

const jobSelect = `
  SELECT pej.purchase_evidence_job_id, pej.suspense_account_id, pej.currency_id, pej.job_status,
         pej.canonical_artifact_id, pej.created_at, pej.updated_at, pej.committed_at,
         a.AccountName, c.CurrencyAbbreviation, c.scale,
         COUNT(DISTINCT pejl.line_item_id) AS target_count,
         COUNT(DISTINCT per.purchase_evidence_record_id) AS matched_count,
         COUNT(DISTINCT pei.purchase_evidence_item_id) AS item_count
    FROM accounting_purchase_evidence_jobs pej
    JOIN accounts a ON a.account_id = pej.suspense_account_id AND a.owner_person_id = pej.owner_person_id
    JOIN currencies c ON c.currency_id = pej.currency_id
    JOIN accounting_purchase_evidence_job_lines pejl
      ON pejl.purchase_evidence_job_id = pej.purchase_evidence_job_id
    LEFT JOIN accounting_purchase_evidence_records per
      ON per.purchase_evidence_job_id = pej.purchase_evidence_job_id
    LEFT JOIN accounting_purchase_evidence_items pei
      ON pei.purchase_evidence_record_id = per.purchase_evidence_record_id`;

function jobValue(row) {
  const id = String(row.purchase_evidence_job_id);
  const targetCount = Number(row.target_count);
  const matchedCount = Number(row.matched_count);
  return {
    objectType: "accounting.purchase_evidence_job",
    id,
    sourceRef: `accounting://purchase-evidence-jobs/${id}`,
    displayName: `${String(row.AccountName)} · ${targetCount} selected · ${String(row.job_status)}`,
    status: String(row.job_status),
    suspenseAccount: {
      objectType: "accounting.account", id: Number(row.suspense_account_id),
      sourceRef: `accounting://accounts/${row.suspense_account_id}`,
      displayName: String(row.AccountName), objectRole: "designated_suspense_account",
      currencyId: Number(row.currency_id),
      currencyCode: String(row.CurrencyAbbreviation).trim(), scale: Number(row.scale),
    },
    targetCount, matchedCount, unmatchedCount: targetCount - matchedCount,
    itemCount: Number(row.item_count),
    canonicalArtifactId: row.canonical_artifact_id == null ? null : String(row.canonical_artifact_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    committedAt: row.committed_at == null ? null : String(row.committed_at),
    copiedPrompt: copiedPrompt(id),
  };
}

async function loadJob(connection, personId, purchaseEvidenceJobId, { lock = false } = {}) {
  const id = jobId(purchaseEvidenceJobId);
  const [rows] = await connection.query(
    `${jobBaseSelect}
      WHERE pej.purchase_evidence_job_id = ? AND pej.owner_person_id = ?${lock ? " FOR UPDATE" : ""}`,
    [id, ownerId(personId)],
  );
  if (!rows.length) throw purchaseError("Purchase-evidence job not found.",
    "PURCHASE_EVIDENCE_JOB_NOT_FOUND", undefined, 404);
  const [counts] = await connection.query(
    `SELECT COUNT(DISTINCT pejl.line_item_id) AS target_count,
            COUNT(DISTINCT per.purchase_evidence_record_id) AS matched_count,
            COUNT(DISTINCT pei.purchase_evidence_item_id) AS item_count
       FROM accounting_purchase_evidence_job_lines pejl
       LEFT JOIN accounting_purchase_evidence_records per
         ON per.purchase_evidence_job_id = pejl.purchase_evidence_job_id
       LEFT JOIN accounting_purchase_evidence_items pei
         ON pei.purchase_evidence_record_id = per.purchase_evidence_record_id
      WHERE pejl.purchase_evidence_job_id = ?`,
    [id],
  );
  return { ...rows[0], ...counts[0] };
}

async function loadPurchaseEvidencePreview(connection, personId, purchaseEvidenceJobId) {
  const [records] = await connection.query(
    `SELECT per.purchase_evidence_record_id, per.target_line_item_id, per.merchant,
            per.purchase_date, per.charge_amount_units, per.receipt_tax_amount_units,
            t.TransactionDate, t.description AS transaction_description
       FROM accounting_purchase_evidence_records per
       JOIN accounting_purchase_evidence_jobs pej
         ON pej.purchase_evidence_job_id = per.purchase_evidence_job_id
       JOIN line_items li ON li.line_item_id = per.target_line_item_id
       JOIN transactions t ON t.transaction_id = li.transaction_id
      WHERE per.purchase_evidence_job_id = ? AND pej.owner_person_id = ?
      ORDER BY t.TransactionDate, per.target_line_item_id`,
    [jobId(purchaseEvidenceJobId), ownerId(personId)],
  );
  if (!records.length) return [];
  const recordIds = records.map((record) => Number(record.purchase_evidence_record_id));
  const placeholders = recordIds.map(() => "?").join(", ");
  const [items] = await connection.query(
    `SELECT purchase_evidence_record_id, purchase_evidence_item_id, item_ordinal, source_item_id,
            description, quantity_decimal, source_pre_tax_amount_units,
            allocated_tax_amount_units, allocated_adjustment_amount_units,
            final_amount_units, resulting_line_item_id
       FROM accounting_purchase_evidence_items
      WHERE purchase_evidence_record_id IN (${placeholders})
      ORDER BY purchase_evidence_record_id, item_ordinal`,
    recordIds,
  );
  const [sources] = await connection.query(
    `SELECT purchase_evidence_record_id, source_kind, source_ref, source_record_id, display_name
       FROM accounting_purchase_evidence_sources
      WHERE purchase_evidence_record_id IN (${placeholders})
      ORDER BY purchase_evidence_record_id, source_ordinal`,
    recordIds,
  );
  const [adjustments] = await connection.query(
    `SELECT purchase_evidence_record_id, adjustment_kind, description, source_amount_units
       FROM accounting_purchase_evidence_adjustments
      WHERE purchase_evidence_record_id IN (${placeholders})
      ORDER BY purchase_evidence_record_id, adjustment_ordinal`,
    recordIds,
  );
  const itemsByRecord = new Map();
  for (const item of items) {
    const id = Number(item.purchase_evidence_record_id);
    const values = itemsByRecord.get(id) ?? [];
    values.push({
      purchaseEvidenceItemId: Number(item.purchase_evidence_item_id),
      sourceItemId: item.source_item_id == null ? null : String(item.source_item_id),
      description: String(item.description),
      quantityDecimal: item.quantity_decimal == null ? null : String(item.quantity_decimal),
      preTaxAmountUnits: String(item.source_pre_tax_amount_units),
      allocatedTaxAmountUnits: String(item.allocated_tax_amount_units),
      allocatedAdjustmentAmountUnits: String(item.allocated_adjustment_amount_units),
      finalAmountUnits: String(item.final_amount_units),
      resultingLineItemId: item.resulting_line_item_id == null ? null : Number(item.resulting_line_item_id),
    });
    itemsByRecord.set(id, values);
  }
  const sourcesByRecord = new Map();
  for (const source of sources) {
    const id = Number(source.purchase_evidence_record_id);
    const values = sourcesByRecord.get(id) ?? [];
    values.push({ kind: String(source.source_kind), sourceRef: String(source.source_ref),
      sourceRecordId: source.source_record_id == null ? null : String(source.source_record_id),
      displayName: source.display_name == null ? null : String(source.display_name) });
    sourcesByRecord.set(id, values);
  }
  const adjustmentsByRecord = new Map();
  for (const adjustment of adjustments) {
    const id = Number(adjustment.purchase_evidence_record_id);
    const values = adjustmentsByRecord.get(id) ?? [];
    values.push({ kind: String(adjustment.adjustment_kind), description: String(adjustment.description),
      amountUnits: String(adjustment.source_amount_units) });
    adjustmentsByRecord.set(id, values);
  }
  return records.map((record) => ({
    targetLineItemId: Number(record.target_line_item_id),
    transactionDate: String(record.TransactionDate),
    transactionDescription: record.transaction_description == null ? null : String(record.transaction_description),
    merchant: record.merchant == null ? null : String(record.merchant),
    purchaseDate: record.purchase_date == null ? null : String(record.purchase_date),
    chargeAmountUnits: String(record.charge_amount_units),
    taxAmountUnits: String(record.receipt_tax_amount_units),
    sources: sourcesByRecord.get(Number(record.purchase_evidence_record_id)) ?? [],
    adjustments: adjustmentsByRecord.get(Number(record.purchase_evidence_record_id)) ?? [],
    items: itemsByRecord.get(Number(record.purchase_evidence_record_id)) ?? [],
  }));
}

export async function getPurchaseEvidenceJob({
  pool, personId, purchaseEvidenceJobId, includePreview = false,
}) {
  const job = jobValue(await loadJob(pool, personId, purchaseEvidenceJobId));
  return includePreview ? { ...job, previewPurchases: await loadPurchaseEvidencePreview(
    pool, personId, purchaseEvidenceJobId) } : job;
}

export async function listPurchaseEvidenceJobs({ pool, personId, accountId = null, limit = 25 }) {
  const clauses = ["pej.owner_person_id = ?"];
  const params = [ownerId(personId)];
  if (accountId != null) { clauses.push("pej.suspense_account_id = ?"); params.push(positiveId(accountId, "Account ID")); }
  const resolvedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const [rows] = await pool.query(
    `${jobSelect} WHERE ${clauses.join(" AND ")}
      GROUP BY pej.purchase_evidence_job_id, pej.suspense_account_id, pej.currency_id, pej.job_status,
               pej.canonical_artifact_id, pej.created_at, pej.updated_at, pej.committed_at,
               a.AccountName, c.CurrencyAbbreviation, c.scale
      ORDER BY pej.updated_at DESC, pej.purchase_evidence_job_id DESC LIMIT ?`,
    [...params, resolvedLimit],
  );
  return rows.map(jobValue);
}

export async function listPurchaseEvidenceJobObjectsPage(pool, personId, {
  limit = 100, cursor = null, purchaseEvidenceJobId = null,
} = {}) {
  const clauses = ["pej.owner_person_id = ?"];
  const params = [ownerId(personId)];
  if (purchaseEvidenceJobId != null) {
    if (cursor != null) throw purchaseError("An exact job ID cannot be combined with a cursor.",
      "INVALID_PURCHASE_EVIDENCE_JOB_FILTER");
    clauses.push("pej.purchase_evidence_job_id = ?"); params.push(jobId(purchaseEvidenceJobId));
  } else if (cursor != null) {
    clauses.push("pej.purchase_evidence_job_id < ?"); params.push(jobId(cursor));
  }
  const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [rows] = await pool.query(
    `${jobSelect} WHERE ${clauses.join(" AND ")}
      GROUP BY pej.purchase_evidence_job_id, pej.suspense_account_id, pej.currency_id, pej.job_status,
               pej.canonical_artifact_id, pej.created_at, pej.updated_at, pej.committed_at,
               a.AccountName, c.CurrencyAbbreviation, c.scale
      ORDER BY pej.purchase_evidence_job_id DESC LIMIT ?`,
    [...params, resolvedLimit + 1],
  );
  const objects = rows.slice(0, resolvedLimit).map(jobValue);
  return { objects, nextCursor: rows.length > resolvedLimit ? objects.at(-1).id : null };
}

export async function createPurchaseEvidenceJob({ pool, personId, lineItemIds }) {
  if (!Array.isArray(lineItemIds) || lineItemIds.length < 1 || lineItemIds.length > PURCHASE_EVIDENCE_MAX_TARGETS) {
    throw purchaseError(`Choose between 1 and ${PURCHASE_EVIDENCE_MAX_TARGETS} open suspense postings.`,
      "INVALID_PURCHASE_EVIDENCE_TARGETS");
  }
  const ids = [...new Set(lineItemIds.map((id) => positiveId(id, "Line item ID")))].sort((a, b) => a - b);
  if (ids.length !== lineItemIds.length) throw purchaseError("A suspense posting cannot be selected twice.",
    "DUPLICATE_PURCHASE_EVIDENCE_TARGET");
  const id = randomUUID();
  await withPoolTransaction(pool, async (connection) => {
    const placeholders = ids.map(() => "?").join(", ");
    const [rows] = await connection.query(
      `SELECT li.line_item_id, li.account_id, li.amount_units, li.reconciliation_state,
              a.account_currency_id, a.is_suspense, a.is_placeholder, a.archived_at, t.TransactionState,
              EXISTS (
                SELECT 1 FROM lineitems_tags_join tagged
                JOIN tags tag ON tag.tag_id = tagged.tag_id
                WHERE tagged.tagged_line_item_id = li.line_item_id AND tag.owner_person_id = ?
                  AND tag.tag_key = ? AND tag.tag_value = 'open') AS is_open
         FROM line_items li
         JOIN transactions t ON t.transaction_id = li.transaction_id
         JOIN accounts a ON a.account_id = li.account_id
        WHERE t.owner_person_id = ? AND li.line_item_id IN (${placeholders})
        ORDER BY li.line_item_id FOR UPDATE`,
      [ownerId(personId), accountingQuestionTagKeys.status, ownerId(personId), ...ids],
    );
    if (rows.length !== ids.length) throw purchaseError("Every selected suspense posting must still exist.",
      "PURCHASE_EVIDENCE_TARGET_NOT_FOUND", undefined, 409);
    const accountIds = new Set(rows.map((row) => Number(row.account_id)));
    const currencyIds = new Set(rows.map((row) => Number(row.account_currency_id)));
    if (accountIds.size !== 1 || currencyIds.size !== 1 || rows.some((row) => !Boolean(row.is_suspense))) {
      throw purchaseError("All selected postings must belong to one designated suspense account and currency.",
        "PURCHASE_EVIDENCE_TARGET_SCOPE_MISMATCH");
    }
    if (rows.some((row) => row.TransactionState !== "posted" || !Boolean(row.is_open)
      || row.reconciliation_state === "reconciled" || Boolean(row.is_placeholder) || row.archived_at != null)) {
      throw purchaseError("Every selected posting must be an open, unreconciled, posted suspense question.",
        "PURCHASE_EVIDENCE_TARGET_NOT_OPEN", undefined, 409);
    }
    const [activeSelections] = await connection.query(
      `SELECT pejl.line_item_id, pej.purchase_evidence_job_id
         FROM accounting_purchase_evidence_job_lines pejl
         JOIN accounting_purchase_evidence_jobs pej
           ON pej.purchase_evidence_job_id = pejl.purchase_evidence_job_id
        WHERE pej.owner_person_id = ? AND pej.job_status <> 'committed'
          AND pejl.line_item_id IN (${placeholders})
        ORDER BY pejl.line_item_id FOR UPDATE`,
      [ownerId(personId), ...ids],
    );
    if (activeSelections.length) throw purchaseError(
      "A selected suspense posting already belongs to an active purchase-evidence job.",
      "PURCHASE_EVIDENCE_TARGET_ALREADY_ACTIVE", {
        lineItemIds: activeSelections.map((selected) => Number(selected.line_item_id)),
        existingJobIds: [...new Set(activeSelections.map((selected) => String(selected.purchase_evidence_job_id)))],
      }, 409);
    await connection.query(
      `INSERT INTO accounting_purchase_evidence_jobs
        (purchase_evidence_job_id, owner_person_id, suspense_account_id, currency_id)
       VALUES (?, ?, ?, ?)`,
      [id, ownerId(personId), Number(rows[0].account_id), Number(rows[0].account_currency_id)],
    );
    for (const row of rows) await connection.query(
      `INSERT INTO accounting_purchase_evidence_job_lines
        (purchase_evidence_job_id, line_item_id, original_amount_units) VALUES (?, ?, ?)`,
      [id, Number(row.line_item_id), String(row.amount_units)],
    );
  });
  return getPurchaseEvidenceJob({ pool, personId, purchaseEvidenceJobId: id });
}

export async function getPurchaseEvidenceTargets({ pool, personId, purchaseEvidenceJobId }) {
  const id = jobId(purchaseEvidenceJobId);
  await loadJob(pool, personId, id);
  const [rows] = await pool.query(
    `SELECT pejl.line_item_id, pejl.original_amount_units, li.transaction_id,
            t.TransactionDate, t.description, c.CurrencyAbbreviation, c.scale,
            GROUP_CONCAT(DISTINCT CASE WHEN other.account_id <> li.account_id THEN other.account_id END
              ORDER BY other.account_id SEPARATOR ',') AS counterpart_account_ids
       FROM accounting_purchase_evidence_job_lines pejl
       JOIN accounting_purchase_evidence_jobs pej
         ON pej.purchase_evidence_job_id = pejl.purchase_evidence_job_id
       JOIN line_items li ON li.line_item_id = pejl.line_item_id
       JOIN transactions t ON t.transaction_id = li.transaction_id AND t.owner_person_id = pej.owner_person_id
       JOIN currencies c ON c.currency_id = pej.currency_id
       LEFT JOIN line_items other ON other.transaction_id = li.transaction_id
      WHERE pejl.purchase_evidence_job_id = ? AND pej.owner_person_id = ?
      GROUP BY pejl.line_item_id, pejl.original_amount_units, li.transaction_id,
               t.TransactionDate, t.description, c.CurrencyAbbreviation, c.scale
      ORDER BY t.TransactionDate, pejl.line_item_id`,
    [id, ownerId(personId)],
  );
  const [accounts] = await pool.query(
    "SELECT account_id, AccountName, parent_account_id FROM accounts WHERE owner_person_id = ? ORDER BY account_id",
    [ownerId(personId)],
  );
  const paths = accountPaths(accounts);
  return rows.map((row) => ({
    objectType: "accounting.line_item", id: Number(row.line_item_id),
    sourceRef: `accounting://line-items/${row.line_item_id}`,
    displayName: `${String(row.TransactionDate)} · ${String(row.description ?? "Untitled transaction")} · ${unitsToDecimal(String(row.original_amount_units), Number(row.scale))} ${String(row.CurrencyAbbreviation).trim()}`,
    objectRole: "purchase_evidence_target",
    lineItemId: Number(row.line_item_id), transactionId: Number(row.transaction_id),
    transactionDate: String(row.TransactionDate), description: row.description == null ? null : String(row.description),
    amountUnits: String(row.original_amount_units),
    amountDecimal: unitsToDecimal(String(row.original_amount_units), Number(row.scale)),
    absoluteChargeDecimal: unitsToDecimal(absolute(BigInt(row.original_amount_units)).toString(), Number(row.scale)),
    currencyCode: String(row.CurrencyAbbreviation).trim(), scale: Number(row.scale),
    counterpartAccounts: row.counterpart_account_ids == null ? []
      : String(row.counterpart_account_ids).split(",").map((accountId) =>
        paths.get(Number(accountId)) ?? accountId),
  }));
}

export async function startPurchaseEvidenceJob({ pool, personId, purchaseEvidenceJobId }) {
  const job = await withPoolTransaction(pool, async (connection) => {
    const row = await loadJob(connection, personId, purchaseEvidenceJobId, { lock: true });
    if (row.job_status === "ready") {
      await connection.query(
        `UPDATE accounting_purchase_evidence_jobs SET job_status = 'processing', updated_at = UTC_TIMESTAMP(6)
          WHERE purchase_evidence_job_id = ? AND owner_person_id = ?`,
        [row.purchase_evidence_job_id, ownerId(personId)],
      );
    } else if (row.job_status !== "processing") {
      throw purchaseError(row.job_status === "preview_ready"
        ? "This purchase-evidence job already has a pending preview."
        : "This purchase-evidence job is already committed.",
      row.job_status === "preview_ready" ? "PURCHASE_EVIDENCE_PREVIEW_ALREADY_READY"
        : "PURCHASE_EVIDENCE_ALREADY_COMMITTED", undefined, 409);
    }
    return getPurchaseEvidenceJob({ pool: connection, personId,
      purchaseEvidenceJobId: row.purchase_evidence_job_id });
  });
  return { job, targets: await getPurchaseEvidenceTargets({ pool, personId, purchaseEvidenceJobId }) };
}

export async function restartPurchaseEvidenceJob({ pool, personId, purchaseEvidenceJobId }) {
  return withPoolTransaction(pool, async (connection) => {
    const row = await loadJob(connection, personId, purchaseEvidenceJobId, { lock: true });
    if (row.job_status === "committed") throw purchaseError(
      "Committed purchase evidence cannot be restarted because its item lines are already in the ledger.",
      "COMMITTED_PURCHASE_EVIDENCE_RESTART_FORBIDDEN", undefined, 409);
    const removedCanonicalArtifactId = row.canonical_artifact_id == null
      ? null : String(row.canonical_artifact_id);
    await connection.query(
      "DELETE FROM accounting_purchase_evidence_records WHERE purchase_evidence_job_id = ?",
      [row.purchase_evidence_job_id],
    );
    await connection.query(
      `UPDATE accounting_purchase_evidence_jobs
          SET job_status = 'ready', canonical_artifact_id = NULL, updated_at = UTC_TIMESTAMP(6)
        WHERE purchase_evidence_job_id = ? AND owner_person_id = ?`,
      [row.purchase_evidence_job_id, ownerId(personId)],
    );
    return {
      job: await getPurchaseEvidenceJob({ pool: connection, personId,
        purchaseEvidenceJobId: row.purchase_evidence_job_id }),
      removedCanonicalArtifactId,
    };
  });
}

export function normalizePurchaseEvidenceRecord(record, scale) {
  const targetLineItemId = positiveId(record.target_line_item_id, "Target line item ID");
  const charge = BigInt(decimalToUnits(String(record.charge_amount_decimal), scale));
  const tax = BigInt(decimalToUnits(String(record.tax_amount_decimal), scale));
  if (charge <= 0n || tax < 0n) throw purchaseError("Charge must be positive and tax cannot be negative.",
    "INVALID_PURCHASE_EVIDENCE_AMOUNT", { targetLineItemId });
  if (!Array.isArray(record.sources) || record.sources.length < 1 || record.sources.length > 20) {
    throw purchaseError("Each purchase requires 1 through 20 evidence sources.",
      "INVALID_PURCHASE_EVIDENCE_RECORD", { targetLineItemId });
  }
  if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > 500) {
    throw purchaseError("Each purchase requires 1 through 500 item lines.",
      "INVALID_PURCHASE_EVIDENCE_RECORD", { targetLineItemId });
  }
  if (!Array.isArray(record.adjustments) || record.adjustments.length > 100) {
    throw purchaseError("Each purchase requires an adjustments array containing at most 100 entries.",
      "INVALID_PURCHASE_EVIDENCE_RECORD", { targetLineItemId });
  }
  const items = record.items.map((item, index) => {
    const preTax = BigInt(decimalToUnits(String(item.pre_tax_amount_decimal), scale));
    if (preTax < 0n) throw purchaseError("Item pre-tax amounts cannot be negative.",
      "INVALID_PURCHASE_EVIDENCE_AMOUNT", { targetLineItemId, itemIndex: index });
    return {
      sourceItemId: boundedText(item.source_item_id, 255, "Source item ID"),
      description: boundedText(item.description, 16000, "Item description", { required: true }),
      quantityDecimal: boundedText(item.quantity_decimal, 128, "Item quantity"), preTax,
    };
  });
  const adjustments = record.adjustments.map((adjustment) => ({
    kind: String(adjustment.kind),
    description: boundedText(adjustment.description, 1024, "Adjustment description", { required: true }),
    amount: BigInt(decimalToUnits(String(adjustment.amount_decimal), scale)),
  }));
  const subtotal = items.reduce((sum, item) => sum + item.preTax, 0n);
  const adjustmentTotal = adjustments.reduce((sum, adjustment) => sum + adjustment.amount, 0n);
  if (subtotal + tax + adjustmentTotal !== charge) throw purchaseError(
    "Item pre-tax amounts plus receipt tax and explicit adjustments must exactly equal the selected charge.",
    "PURCHASE_EVIDENCE_RECEIPT_DOES_NOT_TOTAL", {
      targetLineItemId, subtotalUnits: subtotal.toString(), taxUnits: tax.toString(),
      adjustmentUnits: adjustmentTotal.toString(), chargeUnits: charge.toString(),
    });
  const taxAllocations = allocateProportionally(tax, items.map((item) => item.preTax));
  const adjustmentAllocations = items.map(() => 0n);
  for (const adjustment of adjustments) {
    const allocated = allocateSignedProportionally(adjustment.amount, items.map((item) => item.preTax));
    allocated.forEach((value, index) => { adjustmentAllocations[index] += value; });
  }
  const normalizedItems = items.map((item, index) => ({ ...item,
    allocatedTax: taxAllocations[index], allocatedAdjustment: adjustmentAllocations[index],
    finalAmount: item.preTax + taxAllocations[index] + adjustmentAllocations[index] }));
  if (normalizedItems.some((item) => item.finalAmount < 0n)) throw purchaseError(
    "Receipt adjustments cannot make an allocated item amount negative.",
    "PURCHASE_EVIDENCE_NEGATIVE_ITEM_TOTAL", { targetLineItemId });
  return {
    targetLineItemId, charge, tax, adjustments,
    merchant: boundedText(record.merchant, 1024, "Merchant"),
    purchaseDate: record.purchase_date == null ? null : String(record.purchase_date),
    sources: record.sources.map((source) => ({
      kind: String(source.kind), sourceRef: boundedText(source.source_ref, 2048, "Source reference", { required: true }),
      sourceRecordId: boundedText(source.source_record_id, 255, "Source record ID"),
      displayName: boundedText(source.display_name, 1024, "Source display name"),
    })),
    items: normalizedItems,
  };
}

export async function submitPurchaseEvidencePreview({
  pool, personId, purchaseEvidenceJobId, canonicalArtifactId, records,
}) {
  if (!Array.isArray(records) || records.length < 1 || records.length > PURCHASE_EVIDENCE_MAX_TARGETS) {
    throw purchaseError(`Submit between 1 and ${PURCHASE_EVIDENCE_MAX_TARGETS} matched purchase records.`,
      "INVALID_PURCHASE_EVIDENCE_BATCH");
  }
  return withPoolTransaction(pool, async (connection) => {
    const row = await loadJob(connection, personId, purchaseEvidenceJobId, { lock: true });
    if (row.job_status === "preview_ready") {
      if (String(row.canonical_artifact_id) !== String(canonicalArtifactId)) {
        throw purchaseError("This job is already bound to a different purchase-evidence artifact.",
          "PURCHASE_EVIDENCE_PREVIEW_BINDING_CONFLICT", undefined, 409);
      }
      return getPurchaseEvidenceJob({ pool: connection, personId,
        purchaseEvidenceJobId: row.purchase_evidence_job_id });
    }
    if (row.job_status !== "processing") throw purchaseError("Start this purchase-evidence job before submitting evidence.",
      "PURCHASE_EVIDENCE_JOB_NOT_PROCESSING", undefined, 409);
    const [targetRows] = await connection.query(
      `SELECT pejl.line_item_id, pejl.original_amount_units, li.amount_units, li.account_id,
              li.reconciliation_state, t.TransactionState
         FROM accounting_purchase_evidence_job_lines pejl
         JOIN line_items li ON li.line_item_id = pejl.line_item_id
         JOIN transactions t ON t.transaction_id = li.transaction_id
        WHERE pejl.purchase_evidence_job_id = ? ORDER BY pejl.line_item_id FOR UPDATE`,
      [row.purchase_evidence_job_id],
    );
    const targets = new Map(targetRows.map((target) => [Number(target.line_item_id), target]));
    const normalized = records.map((record) => normalizePurchaseEvidenceRecord(record, Number(row.scale)));
    const itemCount = normalized.reduce((sum, record) => sum + record.items.length, 0);
    if (itemCount > PURCHASE_EVIDENCE_MAX_ITEMS) throw purchaseError(
      `A purchase-evidence preview may contain at most ${PURCHASE_EVIDENCE_MAX_ITEMS} item lines.`,
      "PURCHASE_EVIDENCE_ITEM_LIMIT", { itemCount, maximum: PURCHASE_EVIDENCE_MAX_ITEMS });
    if (new Set(normalized.map((record) => record.targetLineItemId)).size !== normalized.length) {
      throw purchaseError("A selected suspense posting may appear only once in the artifact.",
        "DUPLICATE_PURCHASE_EVIDENCE_TARGET");
    }
    for (const record of normalized) {
      const target = targets.get(record.targetLineItemId);
      if (!target) throw purchaseError("Evidence targeted a line outside this job's exact selection.",
        "PURCHASE_EVIDENCE_TARGET_NOT_SELECTED", { lineItemId: record.targetLineItemId });
      if (String(target.original_amount_units) !== String(target.amount_units)
          || Number(target.account_id) !== Number(row.suspense_account_id)
          || target.TransactionState !== "posted" || target.reconciliation_state === "reconciled") {
        throw purchaseError("A selected suspense posting changed after this job was created.",
          "PURCHASE_EVIDENCE_TARGET_CHANGED", { lineItemId: record.targetLineItemId }, 409);
      }
      if (absolute(BigInt(target.amount_units)) !== record.charge) throw purchaseError(
        "The evidence charge must exactly equal the selected suspense posting magnitude.",
        "PURCHASE_EVIDENCE_CHARGE_MISMATCH", {
          lineItemId: record.targetLineItemId, expectedUnits: absolute(BigInt(target.amount_units)).toString(),
          receivedUnits: record.charge.toString(),
        });
    }
    for (const record of normalized) {
      const [inserted] = await connection.query(
        `INSERT INTO accounting_purchase_evidence_records
          (purchase_evidence_job_id, target_line_item_id, merchant, purchase_date,
           charge_amount_units, receipt_tax_amount_units)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.purchase_evidence_job_id, record.targetLineItemId, record.merchant, record.purchaseDate,
          record.charge.toString(), record.tax.toString()],
      );
      const recordId = Number(inserted.insertId);
      for (const [index, source] of record.sources.entries()) await connection.query(
        `INSERT INTO accounting_purchase_evidence_sources
          (purchase_evidence_record_id, source_ordinal, source_kind, source_ref, source_record_id, display_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [recordId, index + 1, source.kind, source.sourceRef, source.sourceRecordId, source.displayName],
      );
      for (const [index, adjustment] of record.adjustments.entries()) await connection.query(
        `INSERT INTO accounting_purchase_evidence_adjustments
          (purchase_evidence_record_id, adjustment_ordinal, adjustment_kind, description, source_amount_units)
         VALUES (?, ?, ?, ?, ?)`,
        [recordId, index + 1, adjustment.kind, adjustment.description, adjustment.amount.toString()],
      );
      for (const [index, item] of record.items.entries()) await connection.query(
        `INSERT INTO accounting_purchase_evidence_items
          (purchase_evidence_record_id, item_ordinal, source_item_id, description, quantity_decimal,
           source_pre_tax_amount_units, allocated_tax_amount_units,
           allocated_adjustment_amount_units, final_amount_units)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [recordId, index + 1, item.sourceItemId, item.description, item.quantityDecimal,
          item.preTax.toString(), item.allocatedTax.toString(), item.allocatedAdjustment.toString(),
          item.finalAmount.toString()],
      );
    }
    await connection.query(
      `UPDATE accounting_purchase_evidence_jobs
          SET job_status = 'preview_ready', canonical_artifact_id = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE purchase_evidence_job_id = ? AND owner_person_id = ?`,
      [String(canonicalArtifactId), row.purchase_evidence_job_id, ownerId(personId)],
    );
    return getPurchaseEvidenceJob({ pool: connection, personId,
      purchaseEvidenceJobId: row.purchase_evidence_job_id });
  });
}

async function replaceQuestionTag(connection, personId, lineItemId, key, value) {
  await connection.query(
    `DELETE tagged FROM lineitems_tags_join tagged
       JOIN tags tag ON tag.tag_id = tagged.tag_id
      WHERE tagged.tagged_line_item_id = ? AND tag.owner_person_id = ? AND tag.tag_key = ?`,
    [lineItemId, personId, key],
  );
  if (value != null) await attachTags(connection, personId, lineItemId, [{ key, value }]);
}

function itemQuestion(description, merchant) {
  return `Which final account should receive ${JSON.stringify(description)}${merchant ? ` from ${merchant}` : ""}? The amount includes its proportional share of receipt sales tax.`;
}

export async function commitPurchaseEvidenceJob({ pool, personId, purchaseEvidenceJobId }) {
  return withPoolTransaction(pool, async (connection) => {
    const row = await loadJob(connection, personId, purchaseEvidenceJobId, { lock: true });
    if (row.job_status === "committed") return {
      job: jobValue(row), changed: false, matchedChargeCount: Number(row.matched_count),
      createdLineCount: Math.max(0, Number(row.item_count) - Number(row.matched_count)),
      resultingItemCount: Number(row.item_count),
    };
    if (row.job_status !== "preview_ready") throw purchaseError("This job does not have a purchase-evidence preview to commit.",
      "PURCHASE_EVIDENCE_PREVIEW_NOT_READY", undefined, 409);
    const [records] = await connection.query(
      `SELECT per.purchase_evidence_record_id, per.target_line_item_id, per.merchant,
              pejl.original_amount_units, li.amount_units, li.value_units, li.account_id,
              li.transaction_id, li.reconciliation_state, t.TransactionState
         FROM accounting_purchase_evidence_records per
         JOIN accounting_purchase_evidence_job_lines pejl
           ON pejl.purchase_evidence_job_id = per.purchase_evidence_job_id
          AND pejl.line_item_id = per.target_line_item_id
         JOIN line_items li ON li.line_item_id = per.target_line_item_id
         JOIN transactions t ON t.transaction_id = li.transaction_id
        WHERE per.purchase_evidence_job_id = ? ORDER BY per.purchase_evidence_record_id FOR UPDATE`,
      [row.purchase_evidence_job_id],
    );
    const affectedTransactions = new Set();
    let createdLineCount = 0;
    for (const record of records) {
      if (String(record.amount_units) !== String(record.original_amount_units)
          || Number(record.account_id) !== Number(row.suspense_account_id)
          || record.TransactionState !== "posted" || record.reconciliation_state === "reconciled") {
        throw purchaseError("A selected suspense posting changed after preview.",
          "PURCHASE_EVIDENCE_TARGET_CHANGED", { lineItemId: Number(record.target_line_item_id) }, 409);
      }
      const [items] = await connection.query(
        `SELECT purchase_evidence_item_id, item_ordinal, description, final_amount_units
           FROM accounting_purchase_evidence_items
          WHERE purchase_evidence_record_id = ? ORDER BY item_ordinal FOR UPDATE`,
        [record.purchase_evidence_record_id],
      );
      const originalAmount = BigInt(record.original_amount_units);
      const amountSign = originalAmount < 0n ? -1n : 1n;
      const originalValue = record.value_units == null ? null : BigInt(record.value_units);
      const valueAllocations = originalValue == null ? null
        : allocateProportionally(absolute(originalValue), items.map((item) => BigInt(item.final_amount_units)));
      const valueSign = originalValue != null && originalValue < 0n ? -1n : 1n;
      for (const [index, item] of items.entries()) {
        const amountUnits = BigInt(item.final_amount_units) * amountSign;
        const valueUnits = valueAllocations == null ? null : valueAllocations[index] * valueSign;
        let resultingLineItemId;
        if (index === 0) {
          resultingLineItemId = Number(record.target_line_item_id);
          await connection.query(
            `UPDATE line_items SET amount_units = ?, value_units = ?, memo = ?, source_id = ?
              WHERE line_item_id = ?`,
            [amountUnits.toString(), valueUnits?.toString() ?? null, String(item.description),
              `purchase-evidence:${record.purchase_evidence_record_id}:${item.item_ordinal}`, resultingLineItemId],
          );
          await replaceQuestionTag(connection, personId, resultingLineItemId,
            accountingQuestionTagKeys.prompt, itemQuestion(String(item.description), record.merchant));
        } else {
          const [inserted] = await connection.query(
            `INSERT INTO line_items
              (transaction_id, amount_units, value_units, memo, account_id, source_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [Number(record.transaction_id), amountUnits.toString(), valueUnits?.toString() ?? null,
              String(item.description), Number(record.account_id),
              `purchase-evidence:${record.purchase_evidence_record_id}:${item.item_ordinal}`],
          );
          resultingLineItemId = Number(inserted.insertId);
          await attachTags(connection, personId, resultingLineItemId, accountingQuestionTags({
            audience: "human", prompt: itemQuestion(String(item.description), record.merchant),
          }));
          createdLineCount += 1;
        }
        await connection.query(
          `UPDATE accounting_purchase_evidence_items SET resulting_line_item_id = ?
            WHERE purchase_evidence_item_id = ?`,
          [resultingLineItemId, Number(item.purchase_evidence_item_id)],
        );
      }
      affectedTransactions.add(Number(record.transaction_id));
    }
    for (const transactionId of affectedTransactions) {
      await connection.query(
        "UPDATE transactions SET UpdatedAt = CURRENT_TIMESTAMP() WHERE transaction_id = ? AND owner_person_id = ?",
        [transactionId, ownerId(personId)],
      );
      await validateTransaction(connection, transactionId, ownerId(personId), { lock: true });
    }
    await connection.query(
      `UPDATE accounting_purchase_evidence_jobs
          SET job_status = 'committed', committed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
        WHERE purchase_evidence_job_id = ? AND owner_person_id = ?`,
      [row.purchase_evidence_job_id, ownerId(personId)],
    );
    return {
      job: await getPurchaseEvidenceJob({ pool: connection, personId,
        purchaseEvidenceJobId: row.purchase_evidence_job_id }),
      changed: true, matchedChargeCount: records.length, createdLineCount,
      resultingItemCount: records.length + createdLineCount,
    };
  });
}
