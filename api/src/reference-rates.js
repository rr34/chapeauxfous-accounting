import { readCompleteArtifact } from "./artifact-upload.js";
import { decimalToUnits } from "./money.js";

const signedBigIntMaximum = (2n ** 63n) - 1n;
export const REFERENCE_RATE_BATCH_MAX = 10000;
export const REFERENCE_RATE_INLINE_MAX = 500;

export const referenceRateCanonicalJsonSchema = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["valid_at", "from_currency_id", "to_currency_id", "from_decimal", "to_decimal"],
  properties: {
    valid_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z)?$" },
    from_currency_id: { type: "integer", minimum: 1 },
    to_currency_id: { type: "integer", minimum: 1 },
    from_decimal: { type: "string", maxLength: 256, pattern: "^\\d+(?:\\.\\d+)?$" },
    to_decimal: { type: "string", maxLength: 256, pattern: "^\\d+(?:\\.\\d+)?$" },
    source_record_number: { type: "integer", minimum: 1 },
  },
});

function applicationError(message, status = 400, code = "INVALID_REFERENCE_RATE", details = undefined) {
  return Object.assign(new Error(message), { status, code, details });
}

function positiveId(value, field) {
  const resolved = Number(value);
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw applicationError(`${field} is required.`, 400, "CURRENCY_REQUIRED", { field });
  }
  return resolved;
}

function utcTimestamp(value, field = "valid_at") {
  let text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T00:00:00Z";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) {
    throw applicationError(`${field} must be a UTC ISO-8601 timestamp ending in Z.`, 400,
      "INVALID_REFERENCE_RATE_TIMESTAMP", { field });
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== text.slice(0, 19)) {
    throw applicationError(`${field} is not a valid timestamp.`, 400,
      "INVALID_REFERENCE_RATE_TIMESTAMP", { field });
  }
  return parsed.toISOString().replace("T", " ").replace("Z", "");
}

function positiveDecimal(value, field, index) {
  if (typeof value !== "string" || value.length > 256 || !/^\d+(?:\.\d+)?$/.test(value)
    || BigInt(value.replace(".", "")) === 0n) throw applicationError(
    `${field} must be a bounded positive decimal string.`, 400,
    "INVALID_REFERENCE_RATE_AMOUNT", { index, field });
  return value;
}

function nativeUnitRatio(fromDecimal, toDecimal, fromScale, toScale, index) {
  let fromUnits;
  try { fromUnits = BigInt(decimalToUnits(fromDecimal, fromScale)); } catch {
    throw applicationError(`from_decimal must fit the source currency's ${fromScale} decimal places.`,
      400, "INVALID_REFERENCE_RATE_AMOUNT", { index, field: "from_decimal" });
  }
  const [toWhole, toFraction = ""] = toDecimal.split(".");
  let toUnits = BigInt(`${toWhole}${toFraction.slice(0, toScale).padEnd(toScale, "0")}`);
  const discarded = toFraction.slice(toScale);
  if (discarded && discarded[0] >= "5") toUnits += 1n;
  if (fromUnits <= 0n || toUnits <= 0n
    || fromUnits > signedBigIntMaximum || toUnits > signedBigIntMaximum) {
    throw applicationError("The reference price cannot fit positive 64-bit native units.",
      400, "INVALID_REFERENCE_RATE_AMOUNT", { index });
  }
  return { from: fromUnits, to: toUnits, rounded: /[1-9]/.test(discarded) };
}

function sameRatio(row, rate) {
  if (row.from_units == null || row.to_units == null) throw applicationError(
    "Stored reference rate has no complete native-unit ratio.", 500,
    "REFERENCE_RATE_STATE_CONFLICT");
  return BigInt(row.from_units) * rate.toUnits === BigInt(row.to_units) * rate.fromUnits;
}

function normalizedBatch(rates, currencies) {
  if (!Array.isArray(rates) || rates.length < 1 || rates.length > REFERENCE_RATE_BATCH_MAX) {
    throw applicationError(`rates must contain 1 through ${REFERENCE_RATE_BATCH_MAX} records.`, 400,
      "INVALID_REFERENCE_RATE_BATCH");
  }
  const keys = new Set();
  return rates.map((rate, index) => {
    if (!rate || typeof rate !== "object" || Array.isArray(rate)) throw applicationError(
      "Every rate must be an object.", 400, "INVALID_REFERENCE_RATE", { index });
    const requiredFields = ["valid_at", "from_currency_id", "to_currency_id", "from_decimal", "to_decimal"];
    const allowedFields = new Set([...requiredFields, "source_record_number"]);
    if (requiredFields.some((field) => !Object.hasOwn(rate, field))
      || Object.keys(rate).some((field) => !allowedFields.has(field))
      || typeof rate.valid_at !== "string"
      || typeof rate.from_currency_id !== "number" || typeof rate.to_currency_id !== "number"
      || (Object.hasOwn(rate, "source_record_number") && (!Number.isInteger(rate.source_record_number)
        || rate.source_record_number < 1))) {
      throw applicationError("The reference rate record does not match the canonical schema.", 400,
        "INVALID_REFERENCE_RATE_RECORD", { index, source_record_number: rate.source_record_number ?? null });
    }
    const fromCurrencyId = positiveId(rate.from_currency_id, "from_currency_id");
    const toCurrencyId = positiveId(rate.to_currency_id, "to_currency_id");
    if (fromCurrencyId === toCurrencyId) throw applicationError(
      "A reference rate must connect two different currencies.", 400,
      "REFERENCE_RATE_SAME_CURRENCY", { index });
    const from = currencies.get(fromCurrencyId);
    const to = currencies.get(toCurrencyId);
    if (!from || !to) throw applicationError(
      "Both currencies must be accessible to this ledger.", 404,
      "REFERENCE_RATE_CURRENCY_NOT_FOUND", { index });
    const validAt = utcTimestamp(rate.valid_at);
    const key = `${fromCurrencyId}:${toCurrencyId}:${validAt}`;
    if (keys.has(key)) throw applicationError(
      "The batch contains the same currency pair and timestamp more than once.", 400,
      "DUPLICATE_REFERENCE_RATE_TARGET", { index,
        source_record_number: rate.source_record_number ?? null, valid_at: isoTimestamp(validAt) });
    keys.add(key);
    const fromDecimal = positiveDecimal(rate.from_decimal, "from_decimal", index);
    const toDecimal = positiveDecimal(rate.to_decimal, "to_decimal", index);
    const ratio = nativeUnitRatio(fromDecimal, toDecimal, Number(from.scale), Number(to.scale), index);
    return {
      index, key, validAt, fromCurrencyId, toCurrencyId,
      sourceRecordNumber: rate.source_record_number ?? null,
      fromUnits: ratio.from, toUnits: ratio.to, rounded: ratio.rounded,
    };
  });
}

function outcomeRuns(outcomes) {
  const runs = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    const status = outcomes[index];
    const last = runs.at(-1);
    if (last?.status === status && last.endIndex === index - 1) last.endIndex = index;
    else runs.push({ startIndex: index, endIndex: index, status });
  }
  return runs;
}

async function withRateTransaction(pool, work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function createReferenceRates({ pool, personId, rates }) {
  if (!Array.isArray(rates) || rates.length < 1 || rates.length > REFERENCE_RATE_BATCH_MAX) {
    throw applicationError(`rates must contain 1 through ${REFERENCE_RATE_BATCH_MAX} records.`, 400,
      "INVALID_REFERENCE_RATE_BATCH");
  }
  return withRateTransaction(pool, async (connection) => {
    // One owner lock serializes competing imports, including an exact retry after a lost response.
    const [owners] = await connection.query(
      "SELECT person_id FROM people2_people WHERE person_id = ? FOR UPDATE", [personId]);
    if (!owners.length) throw applicationError("Ledger owner not found.", 404, "REFERENCE_RATE_OWNER_NOT_FOUND");
    const currencyIds = [...new Set(rates.flatMap((rate) => [
      positiveId(rate?.from_currency_id, "from_currency_id"),
      positiveId(rate?.to_currency_id, "to_currency_id"),
    ]))];
    const [currencyRows] = await connection.query(
      `SELECT currency_id, scale FROM currencies WHERE currency_id IN (${currencyIds.map(() => "?").join(", ")})
        AND (owner_person_id IS NULL OR owner_person_id = ?)`, [...currencyIds, personId]);
    const normalized = normalizedBatch(rates,
      new Map(currencyRows.map((row) => [Number(row.currency_id), row])));
    const groups = new Map();
    for (const rate of normalized) {
      const pair = `${rate.fromCurrencyId}:${rate.toCurrencyId}`;
      if (!groups.has(pair)) groups.set(pair, []);
      groups.get(pair).push(rate);
    }
    const existing = new Map();
    for (const group of groups.values()) {
      const times = group.map((rate) => rate.validAt).sort();
      const [rows] = await connection.query(
        `SELECT xrate_id, ValidAt, from_units, to_units FROM xrates
          WHERE owner_person_id = ? AND xrate_type = 'reference' AND transaction_id IS NULL
            AND from_currency_id = ? AND to_currency_id = ? AND ValidAt BETWEEN ? AND ?
          ORDER BY xrate_id FOR UPDATE`,
        [personId, group[0].fromCurrencyId, group[0].toCurrencyId, times[0], times.at(-1)]);
      for (const row of rows) {
        const key = `${group[0].fromCurrencyId}:${group[0].toCurrencyId}:${String(row.ValidAt)}`;
        if (!existing.has(key)) existing.set(key, []);
        existing.get(key).push(row);
      }
    }
    // Detect every conflict before the first insert so a failed batch changes nothing.
    for (const rate of normalized) {
      for (const row of existing.get(rate.key) ?? []) {
        if (!sameRatio(row, rate)) {
          throw applicationError("An existing reference rate has a different value for this pair and time.",
            409, "REFERENCE_RATE_CONFLICT", { index: rate.index,
              source_record_number: rate.sourceRecordNumber, valid_at: isoTimestamp(rate.validAt),
              reference_rate_id: Number(row.xrate_id) });
        }
      }
    }
    const outcomes = [];
    const toCreate = [];
    for (const rate of normalized) {
      if (existing.has(rate.key)) {
        outcomes.push("reused");
        continue;
      }
      toCreate.push(rate);
      outcomes.push("created");
    }
    for (let offset = 0; offset < toCreate.length; offset += 500) {
      const chunk = toCreate.slice(offset, offset + 500);
      await connection.query(
        `INSERT INTO xrates (owner_person_id, xrate_type, ValidAt, transaction_id,
          from_units, from_currency_id, to_units, to_currency_id)
         VALUES ${chunk.map(() => "(?, 'reference', ?, NULL, ?, ?, ?, ?)").join(", ")}`,
        chunk.flatMap((rate) => [personId, rate.validAt, String(rate.fromUnits),
          rate.fromCurrencyId, String(rate.toUnits), rate.toCurrencyId]));
    }
    return { submittedCount: normalized.length, createdCount: toCreate.length,
      reusedCount: normalized.length - toCreate.length,
      roundedCount: normalized.filter((rate) => rate.rounded).length,
      outcomeRuns: outcomeRuns(outcomes) };
  });
}

export async function importReferenceRatesArtifact({ pool, artifactRoot, personId, artifactId }) {
  const { artifact, bytes } = await readCompleteArtifact({ artifactRoot, personId, artifactId });
  if (artifact.media_type !== "application/x-ndjson") throw applicationError(
    "Reference rate artifacts must be UTF-8 JSON Lines.", 415, "UNSUPPORTED_REFERENCE_RATE_ARTIFACT");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw applicationError("Reference rate artifact is not valid UTF-8.", 400,
      "INVALID_REFERENCE_RATE_ARTIFACT_UTF8");
  }
  const rates = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch {
      throw applicationError("Reference rate artifact contains invalid JSON.", 400,
        "INVALID_REFERENCE_RATE_ARTIFACT_JSON", { line_number: index + 1 });
    }
    rates.push(record);
  }
  const result = await createReferenceRates({ pool, personId, rates });
  return { ...result, artifactSha256: `sha256:${artifact.sha256}` };
}

function optionalUtcTimestamp(value, field) {
  return value == null ? null : utcTimestamp(value, field);
}

function isoTimestamp(value) {
  const text = String(value).replace(" ", "T");
  return text.endsWith("Z") ? text : `${text}Z`;
}

function mapRate(row) {
  return {
    id: Number(row.xrate_id),
    validAt: isoTimestamp(row.ValidAt),
    fromUnits: String(row.from_units),
    fromCurrencyId: Number(row.from_currency_id),
    fromCurrencyCode: String(row.from_currency_code).trim(),
    fromScale: Number(row.from_scale),
    toUnits: String(row.to_units),
    toCurrencyId: Number(row.to_currency_id),
    toCurrencyCode: String(row.to_currency_code).trim(),
    toScale: Number(row.to_scale),
  };
}

const rateSelect = `
  SELECT x.xrate_id, x.ValidAt, x.from_units, x.from_currency_id,
         fc.CurrencyAbbreviation AS from_currency_code, fc.scale AS from_scale,
         x.to_units, x.to_currency_id,
         tc.CurrencyAbbreviation AS to_currency_code, tc.scale AS to_scale
    FROM xrates x
    JOIN currencies fc ON fc.currency_id = x.from_currency_id
    JOIN currencies tc ON tc.currency_id = x.to_currency_id`;

export async function getReferenceRate(pool, personId, rateId) {
  const resolvedRateId = positiveId(rateId, "reference_rate_id");
  const [rows] = await pool.query(
    `${rateSelect}
      WHERE x.xrate_id = ? AND x.owner_person_id = ?
        AND x.xrate_type = 'reference' AND x.transaction_id IS NULL`,
    [resolvedRateId, personId],
  );
  if (!rows.length) throw applicationError("Reference rate not found.", 404,
    "REFERENCE_RATE_NOT_FOUND");
  return mapRate(rows[0]);
}

export async function listReferenceRatesPage(pool, personId, {
  fromCurrencyId = null,
  toCurrencyId = null,
  validAtFrom = null,
  validAtTo = null,
  limit = 100,
  beforeRateId = null,
} = {}) {
  const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const filters = ["x.owner_person_id = ?", "x.xrate_type = 'reference'", "x.transaction_id IS NULL"];
  const values = [personId];
  if (fromCurrencyId != null) {
    filters.push("x.from_currency_id = ?");
    values.push(positiveId(fromCurrencyId, "from_currency_id"));
  }
  if (toCurrencyId != null) {
    filters.push("x.to_currency_id = ?");
    values.push(positiveId(toCurrencyId, "to_currency_id"));
  }
  if (validAtFrom != null) {
    filters.push("x.ValidAt >= ?");
    values.push(optionalUtcTimestamp(validAtFrom, "valid_at_from"));
  }
  if (validAtTo != null) {
    filters.push("x.ValidAt <= ?");
    values.push(optionalUtcTimestamp(validAtTo, "valid_at_to"));
  }
  if (beforeRateId != null) {
    filters.push("x.xrate_id < ?");
    values.push(positiveId(beforeRateId, "cursor"));
  }
  values.push(resolvedLimit + 1);
  const [rows] = await pool.query(
    `${rateSelect} WHERE ${filters.join(" AND ")} ORDER BY x.xrate_id DESC LIMIT ?`, values,
  );
  const hasMore = rows.length > resolvedLimit;
  const rates = rows.slice(0, resolvedLimit).map(mapRate);
  return { rates, nextCursor: hasMore ? String(rates.at(-1).id) : null };
}
