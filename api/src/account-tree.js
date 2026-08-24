import { createHash, randomUUID } from "node:crypto";
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

function accountResult(input, status, accountId) {
  return {
    fullName: input.path,
    accountType: input.type,
    currencyCode: input.currencyCode,
    description: input.description,
    placeholder: input.placeholder,
    parentFullName: input.parentPath,
    topLevelBranch: input.parts[0],
    status,
    accountId,
  };
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function summarizeAccounts(results) {
  return {
    byStatus: {
      planned: results.filter((result) => result.status === "planned").length,
      existing: results.filter((result) => result.status === "existing").length,
      created: results.filter((result) => result.status === "created").length,
    },
    byAccountType: countBy(results, (result) => result.accountType),
    byCurrencyCode: countBy(results, (result) => result.currencyCode),
    byPlaceholderStatus: {
      placeholder: results.filter((result) => result.placeholder).length,
      postable: results.filter((result) => !result.placeholder).length,
    },
    byTopLevelBranch: countBy(results, (result) => result.topLevelBranch),
  };
}

export async function importAccountTreeWithConnection({ connection, personId, accounts, currencies: currencyDefinitions = [], dryRun = true }) {
  const inputs = normalizeImportRows(accounts);
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
      results.push(accountResult(input, "existing", existing.id));
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
      results.push(accountResult(input, "planned", null));
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
    results.push(accountResult(input, "created", created.id));
  }

  const plannedCount = results.filter((result) => result.status === "planned").length;
  const existingCount = results.filter((result) => result.status === "existing").length;
  const currencyPlannedCount = currencyResults.filter((result) => result.status === "planned").length;
  const currencyExistingCount = currencyResults.filter((result) => result.status === "existing").length;

  return {
    dryRun: Boolean(dryRun),
    ledgerChanged: !dryRun,
    totalCount: results.length,
    createdCount: results.filter((result) => result.status === "created").length,
    existingCount,
    plannedCount,
    currencyCreatedCount: currencyResults.filter((result) => result.status === "created").length,
    currencyExistingCount,
    currencyPlannedCount,
    wouldCreateAccountCount: dryRun ? plannedCount : 0,
    wouldReuseAccountCount: dryRun ? existingCount : 0,
    wouldCreateCurrencyCount: dryRun ? currencyPlannedCount : 0,
    wouldReuseCurrencyCount: dryRun ? currencyExistingCount : 0,
    accountSummary: summarizeAccounts(results),
    currencies: currencyResults,
    accounts: results,
  };
}

export async function importAccountTree({ pool, ...input }) {
  return withPoolTransaction(pool, (connection) => importAccountTreeWithConnection({ connection, ...input }));
}

function hashPayload(payloadJson) {
  return createHash("sha256").update(payloadJson, "utf8").digest("hex");
}

function expiresAtTimestamp(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

export async function previewAccountTreeImport({ pool, personId, accounts, currencies = [] }) {
  return withPoolTransaction(pool, async (connection) => {
    const result = await importAccountTreeWithConnection({ connection, personId, accounts, currencies, dryRun: true });
    const payloadJson = JSON.stringify({ accounts, currencies });
    const importPlanId = randomUUID();
    const expiresAtDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await connection.query(
      `INSERT INTO accounting_import_plans
        (import_plan_id, owner_person_id, import_kind, source_system, payload_sha256,
         payload_json, item_count, expires_at)
       VALUES (?, ?, 'account_tree', NULL, ?, ?, ?, ?)`,
      [importPlanId, personId, hashPayload(payloadJson), payloadJson, accounts.length, expiresAtTimestamp(expiresAtDate)],
    );
    return { ...result, readyToCommit: true, importPlanId, importPlanExpiresAt: expiresAtDate.toISOString() };
  });
}

export async function commitAccountTreeImport({ pool, personId, importPlanId }) {
  const resolvedPlanId = String(importPlanId ?? "").trim();
  if (!resolvedPlanId || [...resolvedPlanId].length > 36) {
    throw importError("A valid account-tree import plan ID is required.", "IMPORT_PLAN_ID_REQUIRED");
  }
  return withPoolTransaction(pool, async (connection) => {
    const [rows] = await connection.query(
      `SELECT payload_sha256, payload_json, committed_at, result_json,
              expires_at <= UTC_TIMESTAMP(6) AS is_expired
         FROM accounting_import_plans
        WHERE import_plan_id = ? AND owner_person_id = ? AND import_kind = 'account_tree'
        FOR UPDATE`,
      [resolvedPlanId, personId],
    );
    const plan = rows[0];
    if (!plan) throw importError("Account-tree import plan not found.", "IMPORT_PLAN_NOT_FOUND");
    if (plan.committed_at != null) {
      if (!plan.result_json) throw importError("The committed import plan has no stored result.", "IMPORT_PLAN_RESULT_MISSING");
      return { ...JSON.parse(plan.result_json), alreadyCommitted: true };
    }
    if (Boolean(plan.is_expired)) throw importError("Account-tree import plan has expired; run a new dry run.", "IMPORT_PLAN_EXPIRED");
    if (hashPayload(plan.payload_json) !== String(plan.payload_sha256)) {
      throw importError("Stored account-tree import plan failed its integrity check.", "IMPORT_PLAN_INTEGRITY_FAILURE");
    }
    const payload = JSON.parse(plan.payload_json);
    const imported = await importAccountTreeWithConnection({ connection, personId, ...payload, dryRun: false });
    const result = { ...imported, readyToCommit: false, importPlanId: resolvedPlanId,
      committed: true, alreadyCommitted: false };
    await connection.query(
      `UPDATE accounting_import_plans
          SET committed_at = UTC_TIMESTAMP(6), result_json = ?
        WHERE import_plan_id = ? AND owner_person_id = ?`,
      [JSON.stringify(result), resolvedPlanId, personId],
    );
    return result;
  });
}
