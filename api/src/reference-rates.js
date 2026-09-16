const signedBigIntMaximum = (2n ** 63n) - 1n;

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

function positiveUnits(value, field) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n || BigInt(text) > signedBigIntMaximum) {
    throw applicationError(`${field} must be a positive signed-64-bit integer.`, 400,
      "INVALID_REFERENCE_RATE_UNITS", { field, value: text });
  }
  return text;
}

function utcTimestamp(value, field = "valid_at") {
  const text = String(value ?? "").trim();
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

export async function createReferenceRate({ pool, personId, validAt, fromUnits, fromCurrencyId,
  toUnits, toCurrencyId }) {
  const resolvedFromCurrencyId = positiveId(fromCurrencyId, "from_currency_id");
  const resolvedToCurrencyId = positiveId(toCurrencyId, "to_currency_id");
  if (resolvedFromCurrencyId === resolvedToCurrencyId) {
    throw applicationError("A reference rate must connect two different currencies.", 400,
      "REFERENCE_RATE_SAME_CURRENCY");
  }
  const resolvedValidAt = utcTimestamp(validAt);
  const resolvedFromUnits = positiveUnits(fromUnits, "from_units");
  const resolvedToUnits = positiveUnits(toUnits, "to_units");
  const [currencies] = await pool.query(
    `SELECT currency_id FROM currencies
      WHERE currency_id IN (?, ?) AND (owner_person_id IS NULL OR owner_person_id = ?)`,
    [resolvedFromCurrencyId, resolvedToCurrencyId, personId],
  );
  if (currencies.length !== 2) {
    throw applicationError("Both currencies must be accessible to this ledger.", 404,
      "REFERENCE_RATE_CURRENCY_NOT_FOUND");
  }
  const [result] = await pool.query(
    `INSERT INTO xrates
      (owner_person_id, xrate_type, ValidAt, transaction_id,
       from_units, from_currency_id, to_units, to_currency_id)
     VALUES (?, 'reference', ?, NULL, ?, ?, ?, ?)`,
    [personId, resolvedValidAt, resolvedFromUnits, resolvedFromCurrencyId,
      resolvedToUnits, resolvedToCurrencyId],
  );
  const [rows] = await pool.query(
    `${rateSelect}
      WHERE x.xrate_id = ? AND x.owner_person_id = ?
        AND x.xrate_type = 'reference' AND x.transaction_id IS NULL`,
    [Number(result.insertId), personId],
  );
  if (!rows.length) throw applicationError("Created reference rate could not be read.", 500,
    "REFERENCE_RATE_STATE_CONFLICT");
  return mapRate(rows[0]);
}
