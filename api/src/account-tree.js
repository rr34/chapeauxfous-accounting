import { createHash } from "node:crypto";
import { withPoolTransaction } from "./db.js";
import { createOrMatchUserCurrencies, currencyKey } from "./currencies.js";

const allowedTypes = new Set(["asset", "liability", "equity", "income", "expense"]);
const importSourceSystem = "account_tree";

function importError(message, code, details = undefined) {
  return Object.assign(new Error(message), { status: 400, code, details });
}

function normalizedDescription(value) {
  return String(value ?? "").trim() || null;
}

function parsePath(value) {
  const fullName = String(value ?? "").trim();
  if (!fullName) throw importError("Every imported account requires a full name.", "ACCOUNT_PATH_REQUIRED");
  const parts = fullName.split(":").map((part) => part.trim());
  if (parts.some((part) => !part)) {
    throw importError(`Account path "${fullName}" contains an empty name.`, "INVALID_ACCOUNT_PATH", { fullName });
  }
  const path = parts.join(":");
  return {
    path,
    parts,
    name: parts.at(-1),
    parentPath: parts.length === 1 ? null : parts.slice(0, -1).join(":"),
  };
}

function normalizeImportRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw importError("At least one account is required.", "ACCOUNTS_REQUIRED");
  }
  if (rows.length > 1000) throw importError("At most 1,000 accounts can be imported at once.", "TOO_MANY_ACCOUNTS");

  const byPath = new Map();
  for (const row of rows) {
    const parsed = parsePath(row?.fullName);
    if (byPath.has(parsed.path)) {
      throw importError(`Account path "${parsed.path}" appears more than once.`, "DUPLICATE_ACCOUNT_PATH", { fullName: parsed.path });
    }
    const type = String(row?.type ?? "").trim().toLocaleLowerCase("en-US");
    if (!allowedTypes.has(type)) {
      throw importError(`Account "${parsed.path}" has unsupported type "${row?.type ?? ""}".`, "INVALID_ACCOUNT_TYPE", {
        fullName: parsed.path,
        allowedTypes: [...allowedTypes],
      });
    }
    const code = String(row?.currencyCode ?? "").trim();
    if (!code) {
      throw importError(`Account "${parsed.path}" requires a currency code.`, "CURRENCY_REQUIRED", { fullName: parsed.path });
    }
    byPath.set(parsed.path, {
      ...parsed,
      type,
      currencyCode: code,
      description: normalizedDescription(row?.description),
      placeholder: Boolean(row?.placeholder),
    });
  }
  return [...byPath.values()].sort((left, right) =>
    left.parts.length - right.parts.length || left.path.localeCompare(right.path));
}

function buildExistingPathMap(rows) {
  const byId = new Map(rows.map((row) => [Number(row.account_id), row]));
  const pathsById = new Map();
  const visiting = new Set();

  function resolve(row) {
    const id = Number(row.account_id);
    if (pathsById.has(id)) return pathsById.get(id);
    if (visiting.has(id)) {
      throw importError("The existing account hierarchy contains a cycle.", "INVALID_EXISTING_ACCOUNT_TREE", { accountId: id });
    }
    visiting.add(id);
    const name = String(row.AccountName ?? "").trim();
    if (!name || name.includes(":")) {
      throw importError("An existing account name cannot be represented as a colon-delimited path.", "INVALID_EXISTING_ACCOUNT_TREE", {
        accountId: id,
        accountName: row.AccountName,
      });
    }
    let path = name;
    if (row.parent_account_id != null) {
      const parent = byId.get(Number(row.parent_account_id));
      if (!parent) {
        throw importError("An existing account references a parent outside this ledger.", "INVALID_EXISTING_ACCOUNT_TREE", {
          accountId: id,
          parentAccountId: Number(row.parent_account_id),
        });
      }
      path = `${resolve(parent)}:${name}`;
    }
    visiting.delete(id);
    pathsById.set(id, path);
    return path;
  }

  const byPath = new Map();
  for (const row of rows) {
    const path = resolve(row);
    if (byPath.has(path)) {
      throw importError(`Existing account path "${path}" is ambiguous.`, "AMBIGUOUS_EXISTING_ACCOUNT_PATH", { fullName: path });
    }
    byPath.set(path, {
      id: Number(row.account_id),
      path,
      type: row.AccountType,
      currencyId: Number(row.account_currency_id),
      currencyCode: String(row.CurrencyAbbreviation ?? "").trim(),
      description: normalizedDescription(row.description),
      placeholder: Boolean(row.is_placeholder),
      archivedAt: row.archived_at,
    });
  }
  return byPath;
}

function assertExistingMatches(input, existing) {
  if (existing.archivedAt != null) {
    throw importError(`Account path "${input.path}" is archived.`, "ARCHIVED_ACCOUNT_PATH_CONFLICT", { fullName: input.path });
  }
  const differences = [];
  if (existing.type !== input.type) differences.push("account_type");
  if (currencyKey(existing.currencyCode) !== currencyKey(input.currencyCode)) differences.push("currency_code");
  if (existing.description !== input.description) differences.push("description");
  if (existing.placeholder !== input.placeholder) differences.push("placeholder");
  if (differences.length) {
    throw importError(`Existing account path "${input.path}" has different account data.`, "ACCOUNT_PATH_CONFLICT", {
      fullName: input.path,
      differingFields: differences,
    });
  }
}

function sourceId(path) {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

export async function importAccountTree({ pool, personId, accounts, currencies: currencyDefinitions = [], dryRun = true }) {
  const inputs = normalizeImportRows(accounts);
  return withPoolTransaction(pool, async (connection) => {
    const { currenciesByCode: currencies, results: currencyResults } = await createOrMatchUserCurrencies(
      connection,
      personId,
      currencyDefinitions,
      { dryRun },
    );
    for (const input of inputs) {
      const currency = currencies.get(currencyKey(input.currencyCode));
      if (!currency) {
        throw importError(`Currency "${input.currencyCode}" for account "${input.path}" is not supported.`, "CURRENCY_NOT_FOUND", {
          fullName: input.path,
          currencyCode: input.currencyCode,
        });
      }
      input.currencyId = currency.id;
      input.currencyCode = currency.code;
    }

    const [existingRows] = await connection.query(
      `SELECT a.account_id, a.AccountName, a.description, a.is_placeholder,
              a.parent_account_id, a.AccountType, a.account_currency_id,
              a.archived_at, c.CurrencyAbbreviation
         FROM accounts a
         JOIN currencies c ON c.currency_id = a.account_currency_id
        WHERE a.owner_person_id = ?
        ORDER BY a.account_id
        FOR UPDATE`,
      [personId],
    );
    const existingByPath = buildExistingPathMap(existingRows);
    const results = [];

    for (const input of inputs) {
      const existing = existingByPath.get(input.path);
      if (existing) {
        assertExistingMatches(input, existing);
        results.push({ fullName: input.path, status: "existing", accountId: existing.id });
        continue;
      }
      const parent = input.parentPath == null ? null : existingByPath.get(input.parentPath);
      if (input.parentPath != null && !parent) {
        throw importError(`Parent account "${input.parentPath}" is missing for "${input.path}".`, "MISSING_PARENT_ACCOUNT", {
          fullName: input.path,
          parentFullName: input.parentPath,
        });
      }

      if (dryRun) {
        const planned = { id: null, path: input.path };
        existingByPath.set(input.path, planned);
        results.push({ fullName: input.path, status: "planned", accountId: null });
        continue;
      }

      const [insert] = await connection.query(
        `INSERT INTO accounts
          (owner_person_id, AccountName, description, is_placeholder, parent_account_id,
           AccountType, account_currency_id, source_system, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [personId, input.name, input.description, input.placeholder, parent?.id ?? null,
          input.type, input.currencyId, importSourceSystem, sourceId(input.path)],
      );
      const created = { id: Number(insert.insertId), path: input.path };
      existingByPath.set(input.path, created);
      results.push({ fullName: input.path, status: "created", accountId: created.id });
    }

    return {
      dryRun: Boolean(dryRun),
      totalCount: results.length,
      createdCount: results.filter((result) => result.status === "created").length,
      existingCount: results.filter((result) => result.status === "existing").length,
      plannedCount: results.filter((result) => result.status === "planned").length,
      currencyCreatedCount: currencyResults.filter((result) => result.status === "created").length,
      currencyExistingCount: currencyResults.filter((result) => result.status === "existing").length,
      currencyPlannedCount: currencyResults.filter((result) => result.status === "planned").length,
      currencies: currencyResults,
      accounts: results,
    };
  });
}
