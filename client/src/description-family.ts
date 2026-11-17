export type DescriptionFamily = { key: string; label: string };

export function descriptionFamily(value: string): DescriptionFamily {
  const boilerplate = new Set(["ach", "card", "credit", "debit", "gmt", "online", "payment", "pos",
    "purchase", "transaction", "transfer", "utc"]);
  const ignoredWords = new Set(["current", "on", "the"]);
  const referenceLabels = new Set(["auth", "confirmation", "id", "order", "post", "ref", "reference",
    "trace", "trans"]);
  const tokens = value.normalize("NFKC").trim().replace(/(?<=\p{L})-(?=\p{L})/gu, " ").split(/\s+/);
  const stable: string[] = [];
  for (const sourceToken of tokens) {
    const token = sourceToken.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!token) continue;
    const normalized = token.toLocaleLowerCase("en-US");
    const namedNumericSuffix = token.match(/^([\p{L}][\p{L}.'-]{1,})[#*_-]?\d{3,}$/u);
    if (namedNumericSuffix) {
      stable.push(namedNumericSuffix[1]);
      break;
    }
    const merchantBeforeIdentifier = token.match(/^([\p{L}][\p{L}.'-]{1,})[*#](?=[\p{L}\p{N}]*\d)/u);
    if (merchantBeforeIdentifier) {
      stable.push(merchantBeforeIdentifier[1]);
      break;
    }
    const dateOrTime = /^\d{1,4}[-/:]\d{1,2}(?:[-/:]\d{1,4})?(?:t\d{1,2})?$/i.test(normalized);
    const amount = /^[+-]?(?:\p{Sc})?\d+(?:[.,]\d+)+$/u.test(normalized);
    const identifier = /\d{3,}/.test(normalized)
      || (/[a-z]/i.test(normalized) && /\d/.test(normalized) && normalized.length >= 5
        && normalized !== "7eleven");
    const referenceLabel = referenceLabels.has(normalized.replace(/[:#]$/, ""));
    if (dateOrTime || amount || identifier || referenceLabel) {
      if (stable.length > 0) break;
      continue;
    }
    if (stable.length === 0 && boilerplate.has(normalized)) continue;
    if (ignoredWords.has(normalized)) continue;
    stable.push(token);
    if (stable.length === 5) break;
  }
  if (stable.slice(0, 2).map((token) => token.toLocaleLowerCase("en-US")).join(" ") === "interest charge") {
    stable.splice(2);
  }
  if (stable.length > 0) return { key: stable.join(" ").toLocaleLowerCase("en-US"), label: stable.join(" ") };
  const fallback = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return { key: fallback.toLocaleLowerCase("en-US"), label: fallback || "Untitled transaction" };
}
