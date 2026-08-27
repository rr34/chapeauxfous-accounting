import { withPoolTransaction } from "./db.js";

export const userCurrencyTypes = Object.freeze(["crypto", "security", "commodity", "custom"]);
const allowedUserCurrencyTypes = new Set(userCurrencyTypes);

function currencyError(message, status = 400, code = "INVALID_CURRENCY", details = undefined) {
  return Object.assign(new Error(message), { status, code, details });
}

export function currencyKey(value) {
  return String(value ?? "").trim().toLocaleUpperCase("en-US");
}

export function normalizeUserCurrency(input = {}) {
  const code = currencyKey(input.code);
  const displayName = String(input.displayName ?? "").trim();
  const type = String(input.type ?? "").trim().toLocaleLowerCase("en-US");
  const scale = Number(input.scale);
  if (!code) throw currencyError("Currency code is required.", 400, "CURRENCY_CODE_REQUIRED");
  if ([...code].length > 50) throw currencyError("Currency code cannot exceed 50 characters.", 400, "CURRENCY_CODE_TOO_LONG");
  if (!displayName) throw currencyError("Currency display name is required.", 400, "CURRENCY_DISPLAY_NAME_REQUIRED");
  if ([...displayName].length > 255) {
    throw currencyError("Currency display name cannot exceed 255 characters.", 400, "CURRENCY_DISPLAY_NAME_TOO_LONG");
  }
  if (!allowedUserCurrencyTypes.has(type)) {
    throw currencyError("Currency type must be crypto, security, commodity, or custom.", 400, "INVALID_CURRENCY_TYPE", {
      allowedTypes: userCurrencyTypes,
    });
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw currencyError("Currency scale must be an integer from 0 through 18.", 400, "INVALID_CURRENCY_SCALE");
  }
  return { code, displayName, type, scale };
}

function mapCurrency(row) {
  return {
    id: Number(row.currency_id),
    code: String(row.CurrencyAbbreviation).trim(),
    displayName: String(row.display_name).trim(),
    type: row.currency_type,
    scale: Number(row.scale),
    ownerPersonId: row.owner_person_id == null ? null : Number(row.owner_person_id),
    userDefined: row.owner_person_id != null,
  };
}

export async function listCurrencies(pool, personId) {
  const [rows] = await pool.query(
    `SELECT currency_id, owner_person_id, CurrencyAbbreviation, display_name,
            currency_type, scale
       FROM currencies
      WHERE owner_person_id IS NULL OR owner_person_id = ?
      ORDER BY owner_person_id IS NOT NULL, CurrencyAbbreviation`,
    [personId],
  );
  return rows.map(mapCurrency);
}

export async function listCurrenciesPage(pool, personId, { limit = 100, afterCurrencyId = null } = {}) {
  const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const cursor = afterCurrencyId == null ? 0 : Number(afterCurrencyId);
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw currencyError("Currency cursor is invalid.", 400, "INVALID_CURSOR");
  }
  const [rows] = await pool.query(
    `SELECT currency_id, owner_person_id, CurrencyAbbreviation, display_name,
            currency_type, scale
       FROM currencies
      WHERE (owner_person_id IS NULL OR owner_person_id = ?)
        AND currency_id > ?
      ORDER BY currency_id
      LIMIT ?`,
    [personId, cursor, resolvedLimit + 1],
  );
  const hasMore = rows.length > resolvedLimit;
  const currencies = rows.slice(0, resolvedLimit).map(mapCurrency);
  return { currencies, nextCursor: hasMore ? String(currencies.at(-1).id) : null };
}

export async function getCurrency(pool, personId, currencyId) {
  const resolvedCurrencyId = Number(currencyId);
  if (!Number.isInteger(resolvedCurrencyId) || resolvedCurrencyId <= 0) {
    throw currencyError("Currency not found.", 404, "CURRENCY_NOT_FOUND");
  }
  const [rows] = await pool.query(
    `SELECT currency_id, owner_person_id, CurrencyAbbreviation, display_name,
            currency_type, scale
       FROM currencies
      WHERE currency_id = ? AND (owner_person_id IS NULL OR owner_person_id = ?)`,
    [resolvedCurrencyId, personId],
  );
  if (!rows.length) throw currencyError("Currency not found.", 404, "CURRENCY_NOT_FOUND");
  return mapCurrency(rows[0]);
}

export async function loadAccessibleCurrencies(connection, personId, { lock = false } = {}) {
  const [rows] = await connection.query(
    `SELECT currency_id, owner_person_id, CurrencyAbbreviation, display_name,
            currency_type, scale
       FROM currencies
      WHERE owner_person_id IS NULL OR owner_person_id = ?
      ORDER BY currency_id${lock ? " FOR UPDATE" : ""}`,
    [personId],
  );
  return rows.map(mapCurrency);
}

export async function requireAccessibleCurrency(connection, personId, currencyId, { lock = false } = {}) {
  const resolvedCurrencyId = Number(currencyId);
  if (!Number.isInteger(resolvedCurrencyId) || resolvedCurrencyId <= 0) {
    throw currencyError("Currency is required.", 400, "CURRENCY_REQUIRED");
  }
  const [rows] = await connection.query(
    `SELECT currency_id, owner_person_id, CurrencyAbbreviation, display_name,
            currency_type, scale
       FROM currencies
      WHERE currency_id = ?
        AND (owner_person_id IS NULL OR owner_person_id = ?)${lock ? " FOR UPDATE" : ""}`,
    [resolvedCurrencyId, personId],
  );
  if (!rows.length) throw currencyError("Currency not found.", 404, "CURRENCY_NOT_FOUND");
  return mapCurrency(rows[0]);
}

function assertMatchingCurrency(existing, input) {
  const differences = [];
  if (existing.displayName !== input.displayName) differences.push("display_name");
  if (existing.type !== input.type) differences.push("currency_type");
  if (existing.scale !== input.scale) differences.push("scale");
  if (differences.length) {
    throw currencyError(`Currency "${input.code}" already exists with different data.`, 409, "CURRENCY_CONFLICT", {
      currencyCode: input.code,
      differingFields: differences,
    });
  }
}

export async function createOrMatchUserCurrencies(connection, personId, definitions, { dryRun = false } = {}) {
  if (definitions != null && !Array.isArray(definitions)) {
    throw currencyError("Currency definitions must be an array.", 400, "INVALID_CURRENCY_DEFINITIONS");
  }
  const inputs = (definitions ?? []).map(normalizeUserCurrency);
  if (inputs.length > 500) {
    throw currencyError("At most 500 currencies can be imported at once.", 400, "TOO_MANY_CURRENCIES");
  }
  const seen = new Set();
  for (const input of inputs) {
    if (seen.has(input.code)) {
      throw currencyError(`Currency "${input.code}" appears more than once.`, 400, "DUPLICATE_CURRENCY_CODE", {
        currencyCode: input.code,
      });
    }
    seen.add(input.code);
  }

  const accessible = await loadAccessibleCurrencies(connection, personId, { lock: true });
  const byCode = new Map(accessible.map((currency) => [currencyKey(currency.code), currency]));
  const results = [];
  for (const input of inputs) {
    const existing = byCode.get(input.code);
    if (existing) {
      if (!existing.userDefined) {
        throw currencyError(`Currency code "${input.code}" is reserved by the global catalog.`, 409, "GLOBAL_CURRENCY_CODE_RESERVED", {
          currencyCode: input.code,
        });
      }
      assertMatchingCurrency(existing, input);
      results.push({ ...existing, status: "existing" });
      continue;
    }

    if (dryRun) {
      const planned = { id: null, ownerPersonId: personId, userDefined: true, ...input, status: "planned" };
      byCode.set(input.code, planned);
      results.push(planned);
      continue;
    }

    const [insert] = await connection.query(
      `INSERT INTO currencies
        (owner_person_id, scope_owner_person_id, CurrencyAbbreviation, display_name, currency_type, scale)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [personId, personId, input.code, input.displayName, input.type, input.scale],
    );
    const created = { id: Number(insert.insertId), ownerPersonId: personId, userDefined: true, ...input, status: "created" };
    byCode.set(input.code, created);
    results.push(created);
  }
  return { currenciesByCode: byCode, results };
}

export async function createCurrency({ pool, personId, code, displayName, type, scale }) {
  const definition = normalizeUserCurrency({ code, displayName, type, scale });
  return withPoolTransaction(pool, async (connection) => {
    const { results } = await createOrMatchUserCurrencies(connection, personId, [definition]);
    const currency = results[0];
    if (currency.status === "existing") {
      throw currencyError(`Currency "${definition.code}" already exists.`, 409, "CURRENCY_ALREADY_EXISTS", {
        currencyCode: definition.code,
      });
    }
    const { status: _status, ...created } = currency;
    return created;
  });
}
