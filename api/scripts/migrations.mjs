import fs from "node:fs";

const startPattern = /^-- migration (\d{4,}): ([a-z0-9][a-z0-9-]*)$/;
const endPattern = /^-- end migration (\d{4,})$/;

function executableSql(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").replace(/#[^\n]*/g, "").trim();
}

export function parseMigrationLedger(source, filename = "migration ledger") {
  const migrations = [];
  let current = null;
  for (const [offset, rawLine] of String(source).replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").split("\n").entries()) {
    const lineNumber = offset + 1;
    const start = startPattern.exec(rawLine);
    const end = endPattern.exec(rawLine);
    if (start) {
      if (current) throw new Error(`${filename}:${lineNumber}: migration ${current.label} has no end marker`);
      current = { version: Number(start[1]), label: start[1], name: start[2], lines: [], startLine: lineNumber };
      continue;
    }
    if (end) {
      if (!current || end[1] !== current.label) throw new Error(`${filename}:${lineNumber}: invalid migration end marker`);
      const sql = current.lines.join("\n").trim();
      if (!executableSql(sql)) throw new Error(`${filename}:${current.startLine}: migration is empty`);
      migrations.push({ version: current.version, name: current.name, label: `${current.label}:${current.name}`, sql });
      current = null;
      continue;
    }
    if (current) current.lines.push(rawLine);
    else if (rawLine.trim() && !rawLine.startsWith("--")) throw new Error(`${filename}:${lineNumber}: SQL outside migration block`);
  }
  if (current) throw new Error(`${filename}:${current.startLine}: migration ${current.label} has no end marker`);
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version <= migrations[index].version) throw new Error("Migrations must be ordered newest first");
  }
  return migrations.toSorted((left, right) => left.version - right.version);
}

export function readMigrationLedger(filename) {
  return parseMigrationLedger(fs.readFileSync(filename, "utf8"), filename);
}

export function pendingMigrations(migrations, currentVersion) {
  const pending = migrations.filter((migration) => migration.version > currentVersion);
  let expected = currentVersion + 1;
  for (const migration of pending) {
    if (migration.version !== expected) throw new Error(`Expected migration ${expected}, found ${migration.version}`);
    expected += 1;
  }
  return pending;
}

export function splitMariaDbStatements(source, filename = "migration SQL") {
  const statements = [];
  let statement = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  const text = String(source).replaceAll("\r\n", "\n");
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    statement += character;
    if (lineComment) { if (character === "\n") lineComment = false; continue; }
    if (blockComment) {
      if (character === "*" && next === "/") { statement += next; index += 1; blockComment = false; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\" && quote !== "`") escaped = true;
      else if (character === quote) {
        if (next === quote) { statement += next; index += 1; } else quote = null;
      }
      continue;
    }
    if ((character === "-" && next === "-" && /\s/.test(text[index + 2] ?? "")) || character === "#") { lineComment = true; continue; }
    if (character === "/" && next === "*") { statement += next; index += 1; blockComment = true; continue; }
    if (["'", "\"", "`"].includes(character)) { quote = character; continue; }
    if (character === ";") {
      if (executableSql(statement)) statements.push(statement.trim());
      statement = "";
    }
  }
  if (quote || blockComment) throw new Error(`${filename}: unterminated SQL`);
  if (executableSql(statement)) statements.push(statement.trim());
  return statements;
}

