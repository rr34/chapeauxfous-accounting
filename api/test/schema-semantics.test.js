import test from "node:test";
import assert from "node:assert/strict";
import { inspectSemanticForm } from "schema-semantic-compiler";
import { AccountingSchemaSemantics } from "../src/schema-semantics.js";

test("the tracked accounting semantic form is complete", () => {
  const semantics = new AccountingSchemaSemantics();
  const report = inspectSemanticForm(semantics.form);
  assert.equal(report.activeSchemaObjectCount, 9);
  assert.equal(report.retiredSchemaObjectCount, 0);
  assert.equal(report.unresolvedCount, 0);
  assert.equal(semantics.form.database.schemaVersion, 13);
  assert.match(
    semantics.form.schemaObjects.accounting_import_plans.fields.payload_json.semantics.sensitivity,
    /Server-only private financial data/,
  );
  assert.match(
    semantics.form.schemaObjects.line_items.fields.amount_units.semantics.units,
    /currency's scale/,
  );
  assert.match(
    semantics.form.schemaObjects.transactions.fields.TransactionDate.semantics.format,
    /without a time zone/,
  );
  assert.equal(semantics.form.schemaObjects.transactions.fields.source_fingerprint.mechanics.generated, false);
  assert.match(semantics.form.schemaObjects.transactions.fields.source_fingerprint.semantics.meaning, /conflicting retries/);
});

test("request routing can explain provider-owned accounting plan state", () => {
  const semantics = new AccountingSchemaSemantics();
  const projection = semantics.route("How long is a committed import plan retained and can its raw payload be searched?");
  assert.equal(Object.hasOwn(projection.schemaProjection.schemaObjects, "accounting_import_plans"), true);
  assert.match(
    projection.schemaProjection.schemaObjects.accounting_import_plans.importantRules.join(" "),
    /48 hours/,
  );
});

test("request routing returns a small inspectable compiler projection", () => {
  const semantics = new AccountingSchemaSemantics();
  const projection = semantics.route("How is a foreign currency transaction exchange rate represented?");
  assert.equal(projection.product, "schema-semantic-compiler/schema-semantic-projection");
  assert.equal(projection.compiler.name, "schema-semantic-compiler");
  assert.equal(Object.hasOwn(projection.schemaProjection.schemaObjects, "xrates"), true);
  assert.equal(Object.hasOwn(projection.schemaProjection.schemaObjects, "transactions"), true);
  assert.match(
    projection.schemaProjection.schemaObjects.xrates.fields.from_units.meaning,
    /Positive integer source-currency units/,
  );
});
