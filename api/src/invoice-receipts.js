import { PDFDocument, PDFName } from "pdf-lib";
import { withPoolTransaction } from "./db.js";
import { getEvidenceFile, listEvidenceFileObjectsPage, readAccountingEvidenceBytes, storeAccountingEvidence } from "./statement-import-jobs.js";

export const invoiceReceiptMediaTypes = ["application/pdf", "image/jpeg", "image/png"];
export const invoiceReceiptMaximumBytes = 20 * 1024 * 1024;
const maximumBundleBytes = 50 * 1024 * 1024;
const maximumPages = 500;
const maximumImagePixels = 40000000;
export const accountingReceiptRef = /^accounting:\/\/evidence-files\/([1-9][0-9]{0,15})$/u;

function receiptError(message, code = "INVOICE_RECEIPT_INVALID", status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function checkEvidence(row) {
  if (!invoiceReceiptMediaTypes.includes(row.media_type)) throw receiptError("Choose a PDF, JPEG, or PNG receipt.");
  if (Number(row.byte_size) > invoiceReceiptMaximumBytes) {
    throw receiptError("Each receipt must be 20 MiB or smaller.", "INVOICE_RECEIPT_TOO_LARGE", 413);
  }
}

async function receiptContent(output, mediaType, bytes) {
  try {
    if (mediaType === "application/pdf") {
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      if (pdf.getPageCount() > 0) return { pdf, pages: pdf.getPageCount() };
    } else {
      if (mediaType === "image/png" && bytes.length >= 24
        && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > maximumImagePixels) {
        throw receiptError("The receipt image is too large in pixels.", "INVOICE_RECEIPT_IMAGE_TOO_LARGE", 413);
      }
      const image = await (mediaType === "image/jpeg" ? output.embedJpg(bytes) : output.embedPng(bytes));
      if (image.width * image.height > maximumImagePixels) {
        throw receiptError("The receipt image is too large in pixels.", "INVOICE_RECEIPT_IMAGE_TOO_LARGE", 413);
      }
      return { image, pages: 1 };
    }
  } catch (error) {
    if (error.status) throw error;
  }
  throw receiptError("Choose a readable, unencrypted PDF, JPEG, or PNG receipt.");
}

function receiptIdentity(row) {
  const id = Number(row.evidence_file_id);
  return { id, sourceRef: `accounting://evidence-files/${id}`, displayName: row.original_file_name,
    mediaType: row.media_type, byteSize: Number(row.byte_size) };
}

export async function uploadInvoiceReceipt({ pool, evidenceRoot, personId, fileName, mediaType, bytes }) {
  checkEvidence({ media_type: mediaType, byte_size: bytes?.length });
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw receiptError("Choose a receipt file.");
  const { pages } = await receiptContent(await PDFDocument.create(), mediaType, bytes);
  if (pages > maximumPages) throw receiptError("The receipt has too many pages.", "INVOICE_RECEIPT_PAGE_LIMIT", 413);
  return withPoolTransaction(pool, async (db) => {
    const [[owner]] = await db.query("SELECT person_id FROM people2_people WHERE person_id = ? FOR UPDATE", [personId]);
    if (!owner) throw receiptError("Accounting owner not found.", "INVOICE_OWNER_NOT_FOUND", 404);
    return receiptIdentity(await storeAccountingEvidence({ db, evidenceRoot, personId, fileName, mediaType, bytes }));
  });
}

export function listInvoiceReceipts(pool, owner, cursor) {
  return listEvidenceFileObjectsPage(pool, owner, { limit: 50, cursor,
    mediaTypes: invoiceReceiptMediaTypes, maximumBytes: invoiceReceiptMaximumBytes });
}

// Lock evidence rows while saving strings as links, so statement cleanup can safely check references.
export async function validateInvoiceReceiptRefs(db, owner, refs) {
  const ids = [...new Set(refs.map((ref) => accountingReceiptRef.exec(ref ?? "")?.[1]).filter(Boolean))].sort();
  for (const id of ids) {
    const [[file]] = await db.execute(`SELECT media_type, byte_size FROM accounting_evidence_files
      WHERE owner_person_id = ? AND evidence_file_id = ? FOR UPDATE`, [owner, id]);
    if (!file) throw receiptError("Receipt file not found for this Accounting owner.", "INVOICE_RECEIPT_NOT_FOUND", 404);
    checkEvidence(file);
  }
}

export async function loadInvoiceReceipts({ pool, evidenceRoot, personId, lines }) {
  const files = new Map();
  let totalBytes = 0;
  for (const line of lines) {
    const id = accountingReceiptRef.exec(line.receiptRef ?? "")?.[1];
    if (!id || files.has(line.receiptRef)) continue;
    const row = await getEvidenceFile({ pool, personId, evidenceFileId: id });
    checkEvidence(row);
    totalBytes += Number(row.byte_size);
    if (totalBytes > maximumBundleBytes) {
      throw receiptError("The receipt bundle exceeds 50 MiB.", "INVOICE_RECEIPT_BUNDLE_LIMIT", 413);
    }
    files.set(line.receiptRef, { ...receiptIdentity(row), bytes: await readAccountingEvidenceBytes(evidenceRoot, row) });
  }
  return files;
}

export async function appendInvoiceReceipts(bytes, receipts) {
  if (!receipts.size) return bytes;
  const output = await PDFDocument.load(bytes);
  let pageCount = 0;
  for (const receipt of receipts.values()) {
    const { pdf, image, pages } = await receiptContent(output, receipt.mediaType, receipt.bytes);
    pageCount += pages;
    if (pageCount > maximumPages) throw receiptError("The receipt bundle exceeds 500 pages.", "INVOICE_RECEIPT_PAGE_LIMIT", 413);
    if (pdf) {
      for (const page of await output.copyPages(pdf, pdf.getPageIndices())) {
        page.node.delete(PDFName.of("Annots"));
        output.addPage(page);
      }
    } else {
      const page = output.addPage([612, 792]);
      const factor = Math.min(540 / image.width, 720 / image.height, 1);
      const width = image.width * factor;
      const height = image.height * factor;
      page.drawImage(image, { x: (612 - width) / 2, y: (792 - height) / 2, width, height });
    }
  }
  return Buffer.from(await output.save());
}
