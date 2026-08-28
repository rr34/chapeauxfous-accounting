import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSemanticForm, syncSemanticForm } from "schema-semantic-compiler";
import { extractMariaDbCatalog } from "schema-semantic-compiler/mariadb";

const here = path.dirname(fileURLToPath(import.meta.url));
export const semanticFormFilename = path.resolve(here, "../../db/schema-semantics.json");

const publicSchemaObjects = new Set([
  "account_balance_assertions",
  "accounting_import_plans",
  "accounting_transaction_import_items",
  "accounting_transaction_import_jobs",
  "accounting_transaction_import_requests",
  "accounts",
  "currencies",
  "line_items",
  "lineitems_tags_join",
  "tags",
  "transactions",
  "xrates",
]);

function publicCatalog(catalog) {
  return {
    ...catalog,
    objects: catalog.objects
      .filter((schemaObject) => publicSchemaObjects.has(schemaObject.name))
      .map((schemaObject) => ({
        ...schemaObject,
        relationships: schemaObject.relationships.filter((relationship) =>
          publicSchemaObjects.has(relationship.targetObject)),
      })),
  };
}

export function readAccountingSemanticForm(filename = semanticFormFilename) {
  if (!fs.existsSync(filename)) return null;
  let form;
  try {
    form = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse accounting schema semantic form ${filename}: ${error.message}`);
  }
  return assertSemanticForm(form);
}

async function schemaVersion(pool) {
  const [rows] = await pool.query(
    "SELECT schema_version FROM accounting_schema_metadata WHERE singleton = 1",
  );
  const version = Number(rows[0]?.schema_version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("accounting_schema_metadata does not contain a valid schema version");
  }
  return version;
}

export async function compileAccountingSemanticForm(pool, databaseName, {
  existingForm = readAccountingSemanticForm(),
  seedComments = false,
  now = new Date(),
} = {}) {
  const catalog = await extractMariaDbCatalog({
    databaseName,
    schemaVersion: await schemaVersion(pool),
    query: pool.query.bind(pool),
  });
  return syncSemanticForm({
    catalog: publicCatalog(catalog),
    existingForm,
    seedComments,
    now,
  });
}

export async function writeAccountingSemanticForm(pool, databaseName, {
  filename = semanticFormFilename,
  seedComments = false,
} = {}) {
  const existingForm = readAccountingSemanticForm(filename);
  const compiled = await compileAccountingSemanticForm(pool, databaseName, {
    existingForm,
    seedComments: seedComments || existingForm == null,
  });
  const temporaryFilename = `${filename}.tmp`;
  fs.writeFileSync(temporaryFilename, `${JSON.stringify(compiled.form, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryFilename, filename);
  return compiled.report;
}

export async function assertAccountingSemanticFormMatches(pool, databaseName, filename = semanticFormFilename) {
  const existingForm = readAccountingSemanticForm(filename);
  if (!existingForm) throw new Error(`Tracked schema semantic form not found: ${filename}`);
  const extractedAt = new Date(existingForm.database.extractedAt);
  if (Number.isNaN(extractedAt.getTime())) {
    throw new Error(`Schema semantic form has an invalid extractedAt value: ${existingForm.database.extractedAt}`);
  }
  const { form: expected } = await compileAccountingSemanticForm(pool, databaseName, {
    existingForm,
    now: extractedAt,
  });
  if (`${JSON.stringify(existingForm, null, 2)}\n` !== `${JSON.stringify(expected, null, 2)}\n`) {
    throw new Error(
      `Accounting schema semantic form drift detected. Run npm run schema:semantics:sync and inspect ${filename}.`,
    );
  }
}
