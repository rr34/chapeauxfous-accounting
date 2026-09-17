const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function normalizeTransactionAt(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!utcTimestampPattern.test(text)) throw Object.assign(
    new Error("transaction_at must be a UTC ISO timestamp ending in Z."),
    { code: "INVALID_TRANSACTION_AT", status: 400, details: { value: text } },
  );
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== text.slice(0, 19)) {
    throw Object.assign(new Error("transaction_at is not a valid UTC timestamp."),
      { code: "INVALID_TRANSACTION_AT", status: 400, details: { value: text } });
  }
  return parsed.toISOString();
}

export function transactionAtForDatabase(value) {
  return value == null ? null : value.replace("T", " ").replace("Z", "");
}

export function transactionAtFromDatabase(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return normalizeTransactionAt(`${String(value).trim().replace(" ", "T")}Z`);
}
