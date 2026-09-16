import { withPoolTransaction } from "./db.js";
import { attachTags, validateTransaction } from "./accounting.js";

export const accountingQuestionTagKeys = Object.freeze({
  status: "accounting.question.status",
  audience: "accounting.question.audience",
  prompt: "accounting.question.prompt",
  resolution: "accounting.question.resolution",
  resolvedAt: "accounting.question.resolved-at",
  targetAccountId: "accounting.question.target-account-id",
});

function questionError(message, code, details = undefined, status = 400) {
  return Object.assign(new Error(message), { status, code, details });
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw questionError(`${label} is invalid.`, "INVALID_ACCOUNTING_QUESTION");
  return id;
}

function limitedText(value, label, maximum, { required = true, lowercase = false } = {}) {
  let text = String(value ?? "").trim();
  if (lowercase) text = text.toLocaleLowerCase("en-US");
  if (!text) {
    if (!required) return null;
    throw questionError(`${label} is required.`, "INVALID_ACCOUNTING_QUESTION");
  }
  if ([...text].length > maximum) {
    throw questionError(`${label} cannot exceed ${maximum} characters.`, "INVALID_ACCOUNTING_QUESTION");
  }
  return text;
}

export function normalizeAccountingQuestion(value) {
  if (value == null) return null;
  return {
    audience: limitedText(value.audience, "Question audience", 50, { lowercase: true }),
    prompt: limitedText(value.prompt, "Question prompt", 16000),
  };
}

export function accountingQuestionTags(value) {
  const question = normalizeAccountingQuestion(value);
  if (question == null) return [];
  return [
    { key: accountingQuestionTagKeys.status, value: "open" },
    { key: accountingQuestionTagKeys.audience, value: question.audience },
    { key: accountingQuestionTagKeys.prompt, value: question.prompt },
  ];
}

function accountPaths(rows) {
  const byId = new Map(rows.map((row) => [Number(row.account_id), row]));
  const memo = new Map();
  const resolve = (id, visiting = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return byId.get(id)?.AccountName ?? String(id);
    const row = byId.get(id);
    if (!row) return String(id);
    visiting.add(id);
    const parent = row.parent_account_id == null ? null : resolve(Number(row.parent_account_id), visiting);
    visiting.delete(id);
    const path = parent == null ? row.AccountName : `${parent}:${row.AccountName}`;
    memo.set(id, path);
    return path;
  };
  return new Map(rows.map((row) => [Number(row.account_id), resolve(Number(row.account_id))]));
}

function mapQuestion(rows, paths) {
  const first = rows[0];
  const tags = new Map(rows.filter((row) => row.tag_key != null)
    .map((row) => [String(row.tag_key), String(row.tag_value)]));
  const status = tags.get(accountingQuestionTagKeys.status);
  if (!status) return null;
  return {
    lineItemId: Number(first.line_item_id),
    transactionId: Number(first.transaction_id),
    transactionDate: first.TransactionDate,
    transactionDescription: first.transaction_description,
    transactionState: first.TransactionState,
    accountId: Number(first.account_id),
    accountName: first.AccountName,
    accountFullName: paths.get(Number(first.account_id)) ?? first.AccountName,
    currencyId: Number(first.account_currency_id),
    currencyCode: String(first.CurrencyAbbreviation).trim(),
    scale: Number(first.scale),
    amountUnits: String(first.amount_units),
    valueUnits: first.value_units == null ? null : String(first.value_units),
    reconciliationState: first.reconciliation_state,
    reconciledAt: first.reconciled_at ?? null,
    memo: first.memo,
    status,
    audience: tags.get(accountingQuestionTagKeys.audience) ?? "human",
    prompt: tags.get(accountingQuestionTagKeys.prompt) ?? "How should this line be classified?",
    resolution: tags.get(accountingQuestionTagKeys.resolution) ?? null,
    resolvedAt: tags.get(accountingQuestionTagKeys.resolvedAt) ?? null,
    targetAccountId: tags.has(accountingQuestionTagKeys.targetAccountId)
      ? Number(tags.get(accountingQuestionTagKeys.targetAccountId)) : null,
  };
}

async function loadQuestionsByLineIds(connection, personId, lineItemIds) {
  if (!lineItemIds.length) return [];
  const placeholders = lineItemIds.map(() => "?").join(", ");
  const [rows] = await connection.query(
    `SELECT li.line_item_id, li.transaction_id, li.amount_units, li.value_units, li.memo, li.account_id,
            li.reconciliation_state, li.reconciled_at,
            t.TransactionDate, t.description AS transaction_description, t.TransactionState,
            a.AccountName, a.account_currency_id, c.CurrencyAbbreviation, c.scale,
            tag.tag_key, tag.tag_value
       FROM line_items li
       JOIN transactions t ON t.transaction_id = li.transaction_id
       JOIN accounts a ON a.account_id = li.account_id
       JOIN currencies c ON c.currency_id = a.account_currency_id
       LEFT JOIN lineitems_tags_join tagged ON tagged.tagged_line_item_id = li.line_item_id
       LEFT JOIN tags tag ON tag.tag_id = tagged.tag_id AND tag.owner_person_id = ?
      WHERE t.owner_person_id = ? AND li.line_item_id IN (${placeholders})
      ORDER BY li.line_item_id, tag.tag_key, tag.tag_id`,
    [personId, personId, ...lineItemIds],
  );
  const [accounts] = await connection.query(
    "SELECT account_id, AccountName, parent_account_id FROM accounts WHERE owner_person_id = ? ORDER BY account_id",
    [personId],
  );
  const paths = accountPaths(accounts);
  const grouped = new Map();
  for (const row of rows) {
    const id = Number(row.line_item_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return lineItemIds.map((id) => mapQuestion(grouped.get(Number(id)) ?? [], paths)).filter(Boolean);
}

export async function getAccountingQuestion(pool, personId, lineItemId) {
  const id = positiveId(lineItemId, "Question line item ID");
  const questions = await loadQuestionsByLineIds(pool, personId, [id]);
  if (!questions.length) throw questionError("Accounting question not found.", "ACCOUNTING_QUESTION_NOT_FOUND", undefined, 404);
  return questions[0];
}

export async function listAccountingQuestionsPage(pool, personId, {
  status = "open", audience = null, accountId = null, limit = 100, afterLineItemId = null,
} = {}) {
  const resolvedStatus = String(status ?? "open").trim().toLocaleLowerCase("en-US");
  if (!new Set(["open", "resolved"]).has(resolvedStatus)) {
    throw questionError("Question status must be open or resolved.", "INVALID_ACCOUNTING_QUESTION_FILTER");
  }
  const resolvedAudience = audience == null ? null
    : limitedText(audience, "Question audience", 50, { lowercase: true });
  const resolvedAccountId = accountId == null ? null : positiveId(accountId, "Account ID");
  const cursor = afterLineItemId == null ? 0 : positiveId(afterLineItemId, "Question cursor");
  const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const params = [personId, accountingQuestionTagKeys.status, resolvedStatus, cursor];
  const filters = [];
  if (resolvedAudience != null) {
    filters.push(`EXISTS (
      SELECT 1 FROM lineitems_tags_join audience_join
      JOIN tags audience_tag ON audience_tag.tag_id = audience_join.tag_id
      WHERE audience_join.tagged_line_item_id = li.line_item_id
        AND audience_tag.owner_person_id = ? AND audience_tag.tag_key = ? AND audience_tag.tag_value = ?)`);
    params.push(personId, accountingQuestionTagKeys.audience, resolvedAudience);
  }
  if (resolvedAccountId != null) {
    filters.push("li.account_id = ?");
    params.push(resolvedAccountId);
  }
  params.push(resolvedLimit + 1);
  const [rows] = await pool.query(
    `SELECT li.line_item_id
       FROM line_items li
       JOIN transactions t ON t.transaction_id = li.transaction_id
      WHERE t.owner_person_id = ?
        AND t.TransactionState = 'posted'
        AND EXISTS (
          SELECT 1 FROM lineitems_tags_join status_join
          JOIN tags status_tag ON status_tag.tag_id = status_join.tag_id
          WHERE status_join.tagged_line_item_id = li.line_item_id
            AND status_tag.owner_person_id = ? AND status_tag.tag_key = ? AND status_tag.tag_value = ?)
        AND li.line_item_id > ?${filters.length ? ` AND ${filters.join(" AND ")}` : ""}
      ORDER BY li.line_item_id
      LIMIT ?`,
    [personId, ...params],
  );
  const ids = rows.map((row) => Number(row.line_item_id));
  const hasMore = ids.length > resolvedLimit;
  const pageIds = ids.slice(0, resolvedLimit);
  const questions = await loadQuestionsByLineIds(pool, personId, pageIds);
  return { questions, nextCursor: hasMore ? String(pageIds.at(-1)) : null };
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

async function requireOwnedPostedLine(connection, personId, lineItemId) {
  const [rows] = await connection.query(
    `SELECT li.line_item_id, li.transaction_id, li.account_id, li.reconciliation_state, a.account_currency_id,
            t.TransactionState
       FROM line_items li
       JOIN transactions t ON t.transaction_id = li.transaction_id
       JOIN accounts a ON a.account_id = li.account_id
      WHERE li.line_item_id = ? AND t.owner_person_id = ?
      FOR UPDATE`,
    [lineItemId, personId],
  );
  if (!rows.length) throw questionError("Line item not found.", "LINE_ITEM_NOT_FOUND", undefined, 404);
  if (rows[0].TransactionState !== "posted") {
    throw questionError("Accounting questions can only track posted ledger lines.", "QUESTION_LINE_NOT_POSTED");
  }
  return rows[0];
}

async function currentQuestionStatus(connection, personId, lineItemId) {
  const [rows] = await connection.query(
    `SELECT tag.tag_value
       FROM lineitems_tags_join tagged
       JOIN tags tag ON tag.tag_id = tagged.tag_id
      WHERE tagged.tagged_line_item_id = ? AND tag.owner_person_id = ? AND tag.tag_key = ?
      ORDER BY tag.tag_id`,
    [lineItemId, personId, accountingQuestionTagKeys.status],
  );
  return rows.at(-1)?.tag_value ?? null;
}

export async function openAccountingQuestion({ pool, personId, lineItemId, audience, prompt }) {
  const id = positiveId(lineItemId, "Question line item ID");
  const normalized = normalizeAccountingQuestion({ audience, prompt });
  return withPoolTransaction(pool, async (connection) => {
    await requireOwnedPostedLine(connection, personId, id);
    const status = await currentQuestionStatus(connection, personId, id);
    if (status === "resolved") {
      throw questionError("This accounting question is already resolved.", "ACCOUNTING_QUESTION_ALREADY_RESOLVED", { lineItemId: id }, 409);
    }
    await replaceQuestionTag(connection, personId, id, accountingQuestionTagKeys.status, "open");
    await replaceQuestionTag(connection, personId, id, accountingQuestionTagKeys.audience, normalized.audience);
    await replaceQuestionTag(connection, personId, id, accountingQuestionTagKeys.prompt, normalized.prompt);
    return getAccountingQuestion(connection, personId, id);
  });
}

export async function resolveAccountingQuestion({ pool, personId, lineItemId, targetAccountId, resolution = null }) {
  const id = positiveId(lineItemId, "Question line item ID");
  const targetId = positiveId(targetAccountId, "Target account ID");
  const note = limitedText(resolution, "Resolution", 16000, { required: false });
  return withPoolTransaction(pool, async (connection) => {
    const line = await requireOwnedPostedLine(connection, personId, id);
    const status = await currentQuestionStatus(connection, personId, id);
    if (status == null) throw questionError("Accounting question not found.", "ACCOUNTING_QUESTION_NOT_FOUND", undefined, 404);
    if (line.reconciliation_state === "reconciled") {
      throw questionError("A reconciled account line is immutable; resolve the question on its suspense counterline.",
        "RECONCILED_LINE_IMMUTABLE", { lineItemId: id }, 409);
    }
    if (status === "resolved") {
      const question = await getAccountingQuestion(connection, personId, id);
      if (question.targetAccountId !== targetId) {
        throw questionError("This question was already resolved to a different account.",
          "ACCOUNTING_QUESTION_RESOLUTION_CONFLICT", {
            lineItemId: id, existingTargetAccountId: question.targetAccountId, requestedTargetAccountId: targetId,
          }, 409);
      }
      return { question, changed: false };
    }
    const [targets] = await connection.query(
      `SELECT account_id, account_currency_id, is_placeholder, archived_at
         FROM accounts WHERE account_id = ? AND owner_person_id = ?
         FOR UPDATE`,
      [targetId, personId],
    );
    const target = targets[0];
    if (!target) throw questionError("Target account not found.", "ACCOUNT_NOT_FOUND", undefined, 404);
    if (targetId === Number(line.account_id)) {
      throw questionError("Choose a final account different from the current suspense account.",
        "QUESTION_TARGET_IS_SUSPENSE_ACCOUNT");
    }
    if (Boolean(target.is_placeholder) || target.archived_at != null) {
      throw questionError("The target account must be active and postable.", "QUESTION_TARGET_NOT_POSTABLE");
    }
    if (Number(target.account_currency_id) !== Number(line.account_currency_id)) {
      throw questionError("The target account must use the same currency as the suspense line so its proven amount and value remain unchanged.",
        "QUESTION_TARGET_CURRENCY_MISMATCH", { lineItemId: id, targetAccountId: targetId });
    }
    await connection.query("UPDATE line_items SET account_id = ? WHERE line_item_id = ?", [targetId, id]);
    await connection.query(
      "UPDATE transactions SET UpdatedAt = CURRENT_TIMESTAMP() WHERE transaction_id = ? AND owner_person_id = ?",
      [Number(line.transaction_id), personId],
    );
    await replaceQuestionTag(connection, personId, id, accountingQuestionTagKeys.status, "resolved");
    await replaceQuestionTag(connection, personId, id, accountingQuestionTagKeys.resolution, note);
    await replaceQuestionTag(connection, personId, id, accountingQuestionTagKeys.resolvedAt, new Date().toISOString());
    await replaceQuestionTag(connection, personId, id, accountingQuestionTagKeys.targetAccountId, String(targetId));
    await validateTransaction(connection, Number(line.transaction_id), personId, { lock: true });
    return { question: await getAccountingQuestion(connection, personId, id), changed: true };
  });
}
