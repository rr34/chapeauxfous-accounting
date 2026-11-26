import { chromium } from "playwright-core";

function filenamePart(value) {
  return String(value ?? "").normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*]+/gu, " ")
    .replace(/\s+/gu, " ").replace(/^[ .]+|[ .]+$/gu, "");
}

export function invoicePdfFilename({ invoiceNumber, pdfDate, payerName, description }) {
  const details = [filenamePart(payerName), filenamePart(description)].filter(Boolean);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(pdfDate ?? "") || !details.length) return `invoice-${invoiceNumber}.pdf`;
  let basename = `invoice ${pdfDate} `;
  for (const character of details.join(" ")) {
    if (Buffer.byteLength(basename + character, "utf8") > 200) break;
    basename += character;
  }
  return `${basename.replace(/[ .]+$/u, "")}.pdf`;
}

function escapedHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function invoicePdfHtml(invoice, issuerName) {
  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: invoice.currency });
  const divisor = 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2);
  const money = (amount) => escapedHtml(formatter.format(amount / divisor));
  const due = invoice.dueOn ? new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${invoice.dueOn}T00:00:00Z`)) : "Not set";
  const lineRows = invoice.lines.map((line) => `<tr>
    <td class="line-number">${escapedHtml(line.position)}</td>
    <td class="line-description">${escapedHtml(line.description)}${line.receiptName
      ? `<div class="line-receipt">${escapedHtml(line.receiptName)}</div>` : ""}</td>
    <td>${money(line.amountMinor)}</td>
  </tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice #${escapedHtml(invoice.invoiceNumber)}</title>
  <style>
    @page { size: Letter; margin: .65in; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #20241f; font: 14px/1.45 Arial, sans-serif; }
    header { display: flex; justify-content: space-between; gap: 32px; padding-bottom: 26px; border-bottom: 2px solid #58634f; }
    h1 { margin: 0 0 4px; font: 700 34px/1.1 Georgia, serif; }
    .muted { color: #62695e; }
    .meta { min-width: 220px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 16px; }
    .meta strong { text-align: right; overflow-wrap: anywhere; }
    .recipient { margin: 28px 0; overflow-wrap: anywhere; }
    .recipient p { margin: 3px 0; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 9px 10px; color: #62695e; border-bottom: 1px solid #abb2a5; font-size: 11px; letter-spacing: .08em; text-align: left; text-transform: uppercase; }
    td { padding: 13px 10px; border-bottom: 1px solid #dde1d8; vertical-align: top; }
    .line-number { width: 54px; color: #62695e; text-align: center; font-variant-numeric: tabular-nums; }
    .line-description { white-space: pre-wrap; overflow-wrap: anywhere; }
    .line-receipt { margin-top: 7px; color: #58634f; font-size: 11px; white-space: normal; }
    th:last-child, td:last-child { width: 150px; text-align: right; }
    .total { display: flex; justify-content: flex-end; gap: 30px; margin-top: 18px; font-size: 18px; }
    .description { margin: 0 0 28px; padding: 14px 16px; background: #f4f5f1; white-space: pre-wrap; overflow-wrap: anywhere; }
    footer { margin-top: 36px; padding-top: 12px; color: #62695e; border-top: 1px solid #dde1d8; font-size: 11px; }
  </style></head><body>
    <header><div><h1>Invoice</h1><div class="muted">From ${escapedHtml(issuerName)}</div></div>
      <div class="meta"><span>Invoice</span><strong>#${escapedHtml(invoice.invoiceNumber)}</strong><span>Due</span><strong>${escapedHtml(due)}</strong><span>Currency</span><strong>${escapedHtml(invoice.currency)}</strong></div>
    </header>
    <section class="recipient"><strong>Bill to</strong><p>${escapedHtml(invoice.payerName || "Not set")}</p><p class="muted">${escapedHtml(invoice.payerEmail)}</p></section>
    ${invoice.description ? `<div class="description">${escapedHtml(invoice.description)}</div>` : ""}
    <table><thead><tr><th class="line-number">Line</th><th>Description</th><th>Amount</th></tr></thead><tbody>${lineRows}</tbody></table>
    <div class="total"><strong>Total</strong><strong>${money(invoice.amountMinor)}</strong></div>
    ${invoice.amountPaidMinor > 0 ? `<div class="total"><strong>Payments applied</strong><strong>${money(invoice.amountPaidMinor)}</strong></div>
    <div class="total"><strong>Balance due</strong><strong>${money(invoice.amountRemainingMinor)}</strong></div>` : ""}
    <footer>${invoice.status === "draft" ? "Draft invoice preview." : "Accounting invoice preview."}</footer>
  </body></html>`;
}

export async function renderInvoicePdf(invoice, issuerName, {
  executablePath = process.env.ACCOUNTING_PDF_BROWSER_EXECUTABLE?.trim() || undefined,
  launch = (options) => chromium.launch(options),
} = {}) {
  let browser;
  try {
    browser = await launch({ headless: true, executablePath, timeout: 15000 });
  } catch (cause) {
    throw Object.assign(new Error("The PDF browser is unavailable. Install Chromium for Accounting with npm run install:pdf-browser.", { cause }),
      { status: 503, code: "INVOICE_PDF_BROWSER_UNAVAILABLE" });
  }
  try {
    const page = await browser.newPage({ javaScriptEnabled: false, offline: true });
    await page.setContent(invoicePdfHtml(invoice, issuerName), { waitUntil: "load", timeout: 15000 });
    return await page.pdf({ format: "Letter", printBackground: true, tagged: true, outline: true });
  } finally {
    await browser.close();
  }
}
