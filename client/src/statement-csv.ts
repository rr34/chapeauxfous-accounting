export type CsvTable = { headers: string[]; rows: string[][]; delimiter: string };

function detectDelimiter(firstLine: string) {
  const candidates = [",", "\t", ";"];
  return candidates.sort((left, right) => firstLine.split(right).length - firstLine.split(left).length)[0];
}

export function parseStatementCsv(input: string): CsvTable {
  const source = input.replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      record.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      record.push(field); field = "";
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
    } else field += char;
  }
  if (quoted) throw new Error("The CSV ends inside a quoted field.");
  record.push(field);
  if (record.some((value) => value.trim())) records.push(record);
  const headers = (records.shift() ?? []).map((value) => value.trim());
  if (!headers.length || headers.every((value) => !value)) throw new Error("The CSV has no header row.");
  const rows = records.map((values) => headers.map((_, index) => values[index]?.trim() ?? ""));
  return { headers, rows, delimiter };
}

export function suggestedColumn(headers: string[], patterns: RegExp[]) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header.trim())));
}

export function normalizedStatementDate(value: string) {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!slash) throw new Error(`Date ${JSON.stringify(value)} must be YYYY-MM-DD or MM/DD/YYYY.`);
  return `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
}

export function normalizedStatementAmount(value: string) {
  const text = value.trim().replaceAll(",", "").replace(/^[^\d(+-]+/, "");
  const negative = text.startsWith("(") && text.endsWith(")");
  const decimal = negative ? `-${text.slice(1, -1)}` : text;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(decimal)) {
    throw new Error(`Amount ${JSON.stringify(value)} is not a signed decimal.`);
  }
  return decimal;
}
