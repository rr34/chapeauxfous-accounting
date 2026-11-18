import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateProportionally,
  normalizePurchaseEvidenceRecord,
  purchaseEvidenceCanonicalJsonSchema,
} from "../src/purchase-evidence-jobs.js";

test("purchase evidence tax uses deterministic largest-remainder allocation", () => {
  assert.deepEqual(allocateProportionally(10n, [100n, 100n, 100n]), [4n, 3n, 3n]);
  assert.deepEqual(allocateProportionally(7n, [200n, 100n]), [5n, 2n]);
  assert.deepEqual(allocateProportionally(0n, [0n, 0n]), [0n, 0n]);
});

test("purchase evidence refuses nonzero allocation across zero-value items", () => {
  assert.throws(() => allocateProportionally(1n, [0n, 0n]), {
    code: "INVALID_PURCHASE_EVIDENCE_ALLOCATION",
  });
});

test("canonical purchase evidence mirrors receipt item lines and preserves receipt tax", () => {
  assert.equal(purchaseEvidenceCanonicalJsonSchema.$id,
    "accounting://schemas/purchase-evidence-record/v1");
  assert.deepEqual(purchaseEvidenceCanonicalJsonSchema.required, [
    "target_line_item_id", "sources", "merchant", "purchase_date", "charge_amount_decimal",
    "tax_amount_decimal", "items",
  ]);
  assert.equal(purchaseEvidenceCanonicalJsonSchema.properties.items.items.properties
    .pre_tax_amount_decimal.type, "string");
});

test("canonical purchase evidence preserves source pre-tax units and derives exact tax-inclusive lines", () => {
  const normalized = normalizePurchaseEvidenceRecord({
    target_line_item_id: 325,
    sources: [{ kind: "email", source_ref: "email://messages/abc",
      source_record_id: "114-1", display_name: "Amazon receipt" }],
    merchant: "Amazon", purchase_date: "2026-09-30",
    charge_amount_decimal: "10.00", tax_amount_decimal: "0.67",
    items: [
      { source_item_id: "a", description: "First item", quantity_decimal: "1",
        pre_tax_amount_decimal: "3.11" },
      { source_item_id: "b", description: "Second item", quantity_decimal: "1",
        pre_tax_amount_decimal: "6.22" },
    ],
  }, 2);
  assert.deepEqual(normalized.items.map((item) => ({
    preTax: item.preTax.toString(), tax: item.allocatedTax.toString(), final: item.finalAmount.toString(),
  })), [
    { preTax: "311", tax: "22", final: "333" },
    { preTax: "622", tax: "45", final: "667" },
  ]);
});

test("purchase evidence rejects a receipt that does not reconcile exactly to the charge", () => {
  assert.throws(() => normalizePurchaseEvidenceRecord({
    target_line_item_id: 325,
    sources: [{ kind: "email", source_ref: "email://messages/abc",
      source_record_id: null, display_name: null }],
    merchant: "Amazon", purchase_date: "2026-09-30",
    charge_amount_decimal: "10.00", tax_amount_decimal: "0.67",
    items: [{ source_item_id: null, description: "Item", quantity_decimal: null,
      pre_tax_amount_decimal: "9.32" }],
  }, 2), { code: "PURCHASE_EVIDENCE_RECEIPT_DOES_NOT_TOTAL" });
});
