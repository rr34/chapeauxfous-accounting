import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_DATABASE = "accounting_test";
const { appendInvoiceReceipts, loadInvoiceReceipts, uploadInvoiceReceipt, validateInvoiceReceiptRefs } =
  await import("../src/invoice-receipts.js");

test("one invoice PDF appends each owned PDF or image once in first-line order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accounting-receipts-"));
  const rows = [];
  const pool = {
    getConnection: async () => pool, beginTransaction: async () => {}, commit: async () => {},
    rollback: async () => {}, release() {},
    async query(sql, args) {
      if (sql.includes("FROM people2_people")) return [[{ person_id: args[0] }]];
      if (sql.startsWith("INSERT INTO accounting_evidence_files")) {
        const [owner_person_id, original_file_name, media_type, byte_size, sha256, storage_key] = args;
        const existing = rows.find((row) => row.owner_person_id === owner_person_id && row.sha256 === sha256);
        if (existing) return [{ insertId: existing.evidence_file_id }];
        const evidence_file_id = rows.length + 1;
        rows.push({ evidence_file_id, owner_person_id, original_file_name, media_type, byte_size, sha256, storage_key });
        return [{ insertId: evidence_file_id }];
      }
      assert.match(sql, /FROM accounting_evidence_files/);
      return [rows.filter((row) => row.evidence_file_id === Number(args[0]) && row.owner_person_id === args[1])];
    },
    async execute(sql, [owner, id]) {
      assert.match(sql, /WHERE owner_person_id = \? AND evidence_file_id = \? FOR UPDATE/);
      return [rows.filter((row) => row.evidence_file_id === Number(id) && row.owner_person_id === owner)];
    },
  };
  const invoice = await PDFDocument.create();
  invoice.addPage([612, 792]);
  const receipt = await PDFDocument.create();
  receipt.addPage([200, 300]);
  receipt.addPage([300, 400]);
  const pdf = Buffer.from(await receipt.save());
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1j0AAAAASUVORK5CYII=", "base64");
  const upload = (bytes, mediaType, fileName) => uploadInvoiceReceipt({ pool, evidenceRoot: root,
    personId: 7, fileName, mediaType, bytes });
  try {
    const first = await upload(pdf, "application/pdf", "receipt.pdf");
    const reused = await upload(pdf, "application/pdf", "same file.pdf");
    const second = await upload(png, "image/png", "receipt.png");
    assert.equal(first.sourceRef, reused.sourceRef);
    const lines = [first, reused, second].map(({ sourceRef }) => ({ receiptRef: sourceRef }));
    const receipts = await loadInvoiceReceipts({ pool, evidenceRoot: root, personId: 7, lines });
    assert.equal(receipts.size, 2);
    const composed = await PDFDocument.load(await appendInvoiceReceipts(await invoice.save(), receipts));
    assert.deepEqual(composed.getPages().map((page) => page.getWidth()), [612, 200, 300, 612]);
    await assert.rejects(validateInvoiceReceiptRefs(pool, 8, [first.sourceRef]), { code: "INVOICE_RECEIPT_NOT_FOUND" });
    await assert.rejects(upload(Buffer.from("wrong"), "application/pdf", "invalid.pdf"), { code: "INVOICE_RECEIPT_INVALID" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
