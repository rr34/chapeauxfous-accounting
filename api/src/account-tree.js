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

const planFailureMetadata = Object.freeze({
  IMPORT_PLAN_NOT_FOUND: { recoverable: true, requiredAction: "RUN_NEW_DRY_RUN", status: 404 },
  IMPORT_PLAN_EXPIRED: { recoverable: true, requiredAction: "RUN_NEW_DRY_RUN", status: 410 },
  IMPORT_PLAN_INVALIDATED: { recoverable: true, requiredAction: "RUN_NEW_DRY_RUN", status: 409 },
  IMPORT_PLAN_STATE_CONFLICT: { recoverable: true, requiredAction: "RUN_NEW_DRY_RUN", status: 409 },
  IMPORT_PLAN_OWNER_MISMATCH: { recoverable: true, requiredAction: "RUN_NEW_DRY_RUN", status: 404 },
});

function planError(code, message) {
  const metadata = planFailureMetadata[code] ?? planFailureMetadata.IMPORT_PLAN_STATE_CONFLICT;
  return Object.assign(new Error(message), { code, ...metadata });
}

export function accountTreeImportPlanFailure(error) {
  const metadata = planFailureMetadata[error?.code];
  if (!metadata) return null;
  return {
    code: error.code,
    message: error.message,
    details: error.details ?? null,
    recoverable: metadata.recoverable,
    requiredAction: metadata.requiredAction,
  };
}

function accountTreePlanSummary(preview) {
  const createdCurrencyCodes = new Set(preview.currencies
    .filter((currency) => currency.status === "planned")
    .map((currency) => currencyKey(currency.code)));
  const reusedCurrencyCodes = new Set(preview.currencies
    .filter((currency) => currency.status === "existing")
    .map((currency) => currencyKey(currency.code)));
  for (const account of preview.accounts) {
    const code = currencyKey(account.currencyCode);
    if (!createdCurrencyCodes.has(code)) reusedCurrencyCodes.add(code);
  }
  return {
    accountsCreated: preview.wouldCreateAccountCount,
    accountsReused: preview.wouldReuseAccountCount,
    currenciesCreated: createdCurrencyCodes.size,
    currenciesReused: reusedCurrencyCodes.size,
    rejectedRows: 0,
  };
}

function digest(value) {
  return hashPayload(JSON.stringify(value));
}

function previewDigest(hash) {
  return `sha256:${String(hash)}`;
}

function isoTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? "").trim();
  if (!text) throw planError("IMPORT_PLAN_STATE_CONFLICT", "Import plan has no expiration timestamp.");
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  if (Number.isNaN(date.getTime())) throw planError("IMPORT_PLAN_STATE_CONFLICT", "Import plan expiration is invalid.");
  return date.toISOString();
}

function parsePlanJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch {
    throw planError("IMPORT_PLAN_STATE_CONFLICT", `Import plan ${label} is invalid.`);
  }
}

function parsePlanSummary(value) {
  const summary = parsePlanJson(value, "summary");
  const fields = ["accountsCreated", "accountsReused", "currenciesCreated", "currenciesReused", "rejectedRows"];
  if (!summary || typeof summary !== "object" || fields.some((field) =>
    !Number.isSafeInteger(summary[field]) || summary[field] < 0)) {
    throw planError("IMPORT_PLAN_STATE_CONFLICT", "Import plan summary has an invalid shape.");
  }
  return Object.fromEntries(fields.map((field) => [field, summary[field]]));
}

function planIdentity(row) {
  const storedPreviewHash = String(row.preview_sha256 ?? "");
  if (!/^[0-9a-f]{64}$/.test(storedPreviewHash)) {
    throw planError("IMPORT_PLAN_STATE_CONFLICT", "Import plan preview digest is invalid.");
  }
  return {
    importPlanId: String(row.import_plan_id),
    expiresAt: isoTimestamp(row.expires_at),
    previewDigest: previewDigest(storedPreviewHash),
    summary: parsePlanSummary(row.summary_json),
  };
}

function readyPlanEnvelope({ importPlanId, expiresAt, previewHash, summary, preview }) {
  return {
    readyToCommit: true,
    importPlanId,
    status: "ready",
    expiresAt,
    previewDigest: previewDigest(previewHash),
    summary,
    preview,
  };
}

function planStatusEnvelope(row) {
  const identity = planIdentity(row);
  if (row.plan_status === "committed") {
    if (!row.result_json) throw planError("IMPORT_PLAN_STATE_CONFLICT", "Committed import plan has no stored result.");
    const stored = parsePlanJson(row.result_json, "commit result");
    return { readyToCommit: false, status: "committed", ...identity, commitResult: stored.commitResult };
  }
  if (row.plan_status === "invalidated") {
    return { readyToCommit: false, status: "invalidated", ...identity,
      invalidationCode: row.invalidation_code ?? "DATABASE_STATE_CHANGED" };
  }
  if (row.plan_status !== "ready") {
    throw planError("IMPORT_PLAN_STATE_CONFLICT", "Import plan has an unsupported state.");
  }
  if (Boolean(row.is_expired)) return { readyToCommit: false, status: "expired", ...identity };
  return { readyToCommit: true, status: "ready", ...identity };
}

async function loadAccountTreePlan(connection, personId, importPlanId, { lock = false } = {}) {
  const [rows] = await connection.query(
    `SELECT import_plan_id, plan_status, payload_sha256, preview_sha256, payload_json,
            summary_json, expires_at, committed_at, invalidated_at, invalidation_code,
            result_json, expires_at <= UTC_TIMESTAMP(6) AS is_expired
       FROM accounting_import_plans
      WHERE import_plan_id = ? AND owner_person_id = ? AND import_kind = 'account_tree'${lock ? " FOR UPDATE" : ""}`,
    [importPlanId, personId],
  );
  const plan = rows[0];
  // Deliberately do not distinguish a missing plan from another owner's plan.
  if (!plan) throw planError("IMPORT_PLAN_NOT_FOUND", "Account-tree import plan not found.");
  return plan;
}

export async function previewAccountTreeImport({ pool, personId, accounts, currencies = [] }) {
  return withPoolTransaction(pool, async (connection) => {
    const preview = await importAccountTreeWithConnection({ connection, personId, accounts, currencies, dryRun: true });
    const normalizedPayload = {
      accounts: preview.accounts.map((account) => ({
        fullName: account.fullName,
        type: account.accountType,
        currencyCode: account.currencyCode,
        description: account.description,
        placeholder: account.placeholder,
      })),
      currencies: preview.currencies.map((currency) => ({
        code: currency.code,
        displayName: currency.displayName,
        type: currency.type,
        scale: currency.scale,
      })),
    };
    const payloadJson = JSON.stringify(normalizedPayload);
    const importPlanId = randomUUID();
    const expiresAtDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const previewHash = digest(preview);
    const summary = accountTreePlanSummary(preview);
    await connection.query(
      `INSERT INTO accounting_import_plans
        (import_plan_id, owner_person_id, import_kind, plan_status, source_system,
         payload_sha256, preview_sha256, payload_json, summary_json, expires_at)
       VALUES (?, ?, 'account_tree', 'ready', NULL, ?, ?, ?, ?, ?)`,
      [importPlanId, personId, hashPayload(payloadJson), previewHash, payloadJson,
        JSON.stringify(summary), expiresAtTimestamp(expiresAtDate)],
    );
    return readyPlanEnvelope({ importPlanId, expiresAt: expiresAtDate.toISOString(), previewHash, summary, preview });
  });
}

export async function getAccountTreeImportPlan({ pool, personId, importPlanId }) {
  const resolvedPlanId = String(importPlanId ?? "").trim();
  if (!resolvedPlanId) throw planError("IMPORT_PLAN_NOT_FOUND", "Account-tree import plan not found.");
  return withPoolTransaction(pool, async (connection) =>
    planStatusEnvelope(await loadAccountTreePlan(connection, personId, resolvedPlanId)));
}

export async function commitAccountTreeImport({ pool, personId, importPlanId }) {
  const resolvedPlanId = String(importPlanId ?? "").trim();
  if (!resolvedPlanId) throw planError("IMPORT_PLAN_NOT_FOUND", "Account-tree import plan not found.");
  const outcome = await withPoolTransaction(pool, async (connection) => {
    const plan = await loadAccountTreePlan(connection, personId, resolvedPlanId, { lock: true });
    if (plan.committed_at != null) {
      if (plan.plan_status !== "committed" || !plan.result_json) {
        return { failure: planError("IMPORT_PLAN_STATE_CONFLICT", "Committed import plan state is inconsistent.") };
      }
      return { result: parsePlanJson(plan.result_json, "commit result") };
    }
    if (plan.plan_status === "invalidated") {
      return { failure: planError("IMPORT_PLAN_INVALIDATED", "Account-tree import plan was invalidated.") };
    }
    if (plan.plan_status !== "ready") {
      return { failure: planError("IMPORT_PLAN_STATE_CONFLICT", "Account-tree import plan is not ready.") };
    }
    if (Boolean(plan.is_expired)) {
      return { failure: planError("IMPORT_PLAN_EXPIRED", "Account-tree import plan has expired.") };
    }
    if (hashPayload(plan.payload_json) !== String(plan.payload_sha256)) {
      await connection.query(
        `UPDATE accounting_import_plans
            SET plan_status = 'invalidated', invalidated_at = UTC_TIMESTAMP(6),
                invalidation_code = 'PAYLOAD_INTEGRITY_FAILURE'
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [resolvedPlanId, personId],
      );
      return { failure: planError("IMPORT_PLAN_INVALIDATED", "Account-tree import plan failed its integrity check.") };
    }
    const payload = parsePlanJson(plan.payload_json, "payload");
    try {
      await importAccountTreeWithConnection({ connection, personId, ...payload, dryRun: true });
    } catch (error) {
      if (!(Number(error?.status) >= 400 && Number(error?.status) < 500)) throw error;
      await connection.query(
        `UPDATE accounting_import_plans
            SET plan_status = 'invalidated', invalidated_at = UTC_TIMESTAMP(6),
                invalidation_code = 'DATABASE_STATE_CHANGED'
          WHERE import_plan_id = ? AND owner_person_id = ?`,
        [resolvedPlanId, personId],
      );
      return { failure: planError("IMPORT_PLAN_INVALIDATED", `Account-tree import plan is no longer valid: ${error.message}`) };
    }
    const commitResult = await importAccountTreeWithConnection({ connection, personId, ...payload, dryRun: false });
    const identity = planIdentity(plan);
    const result = { readyToCommit: false, importPlanId: resolvedPlanId, status: "committed",
      expiresAt: identity.expiresAt, previewDigest: identity.previewDigest,
      summary: identity.summary, commitResult };
    await connection.query(
      `UPDATE accounting_import_plans
          SET plan_status = 'committed', committed_at = UTC_TIMESTAMP(6), result_json = ?
        WHERE import_plan_id = ? AND owner_person_id = ?`,
      [JSON.stringify(result), resolvedPlanId, personId],
    );
    return { result };
  });
  if (outcome.failure) throw outcome.failure;
  return outcome.result;
}
