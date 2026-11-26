import express from "express";
import cors from "cors";
import "./env.js";
import { pool } from "./db.js";
import { requireAuth } from "./auth.js";
import { createApiToken, listApiTokens, revokeApiToken } from "./api-tokens.js";
import { mountAccountingMcp } from "./mcp.js";
import { z } from "zod";
import { createInvoiceService, invoiceAccountAssignments, invoiceAccountId, invoiceDraft, invoiceId, invoiceIssue, invoiceReceiptAssignments, stripeBrowserKey, stripeInvoiceId } from "./invoices.js";
import { renderInvoicePdf } from "./invoice-pdf.js";
import { invoicePaymentInput } from "./invoice-payments.js";
import { appendInvoiceReceipts, invoiceReceiptMaximumBytes, invoiceReceiptMediaTypes, listInvoiceReceipts,
  loadInvoiceReceipts, uploadInvoiceReceipt } from "./invoice-receipts.js";
import { getUser, loginUser, registerUser } from "./users.js";
import { deleteBalanceAssertion, listBalanceAssertions, saveBalanceAssertion } from "./balance-assertions.js";
import {
  createAccount, createTransaction, getTransaction, listAccountLedger, listAccounts,
  listTransactions, recordAccountView, updateAccount, updateTransaction, verifyAllPostedTransactions,
} from "./accounting.js";
import { createCurrency, listCurrencies, updateCurrency } from "./currencies.js";
import { commitAccountDeletion, previewAccountDeletion } from "./account-delete.js";
import { commitTransactionDeletion, previewTransactionDeletion } from "./transaction-delete.js";
import { commitImportRestart, previewImportRestart } from "./import-restart.js";
import { commitUserDeletion, getUserDataSummary, previewUserDeletion } from "./user-delete.js";
import { TRANSACTION_IMPORT_HTTP_BODY_LIMIT } from "./transaction-import-limits.js";
import { reconcileAccountThroughDate } from "./account-reconciliation.js";
import {
  listAccountingQuestionsPage, resolveAccountingQuestion, resolveAccountingQuestions,
} from "./accounting-questions.js";
import {
  ARTIFACT_UPLOAD_MAX_CHUNK_BYTES, removeArtifactUpload, resolveArtifactUploadRoot,
} from "./artifact-upload.js";
import {
  STATEMENT_EVIDENCE_MAX_BYTES,
  STATEMENT_EVIDENCE_MEDIA_TYPES,
  createStatementImportFromFile,
  createTransactionListImportFromText,
  deleteStatementImportJob,
  getStatementImportJob,
  listStatementImportJobs,
  resolveEvidenceRoot,
  removeEvidenceStorageFile,
  restartStatementImportJob,
  sendEvidenceFileContent,
} from "./statement-import-jobs.js";
import {
  commitPurchaseEvidenceJob,
  createPurchaseEvidenceJob,
  getPurchaseEvidenceJob,
  listPurchaseEvidenceJobs,
  restartPurchaseEvidenceJob,
} from "./purchase-evidence-jobs.js";
import { mergeSuspenseTransferPair } from "./suspense-transfer-merge.js";
import {
  commitTransactionImportJob,
  excludeTransactionImportException,
  getTransactionImportJob,
  listTransactionImportExceptions,
  listTransactionImportJobs,
  previewTransactionImportJob,
  retryTransactionImportException,
} from "./transaction-import-job.js";
import {
  commitTransactionImportPlan,
  listAccountTransactionImportReviews,
  reverseTransactionImportReviewSigns,
  updateTransactionImportReviewDecision,
} from "./transaction-import.js";

const app = express();
const port = Number(process.env.API_PORT || 5004);
const host = process.env.API_HOST || "127.0.0.1";
const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const artifactRoot = resolveArtifactUploadRoot();
const evidenceRoot = resolveEvidenceRoot();

app.disable("x-powered-by");
app.use(cors({ origin: clientOrigin }));
mountAccountingMcp(app, {
  pool,
  artifactRoot,
  evidenceRoot,
  jsonBodyParser: express.json({ limit: TRANSACTION_IMPORT_HTTP_BODY_LIMIT }),
  artifactJsonBodyParser: express.json({ limit: "64kb" }),
  artifactRawBodyParser: express.raw({ type: "application/octet-stream", limit: ARTIFACT_UPLOAD_MAX_CHUNK_BYTES }),
});
const invoices = createInvoiceService(pool);
app.get("/api/payments/stripe/oauth/callback", async (req, res) => {
  const destination = new URL("/", clientOrigin);
  const result = new URLSearchParams();
  try {
    result.set("stripe_completion", await invoices.finishConnect(req.query));
  } catch {
    result.set("stripe_error", req.query.error === "access_denied" ? "cancelled" : "failed");
  }
  destination.hash = `invoices?${result}`;
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).redirect(303, destination.href);
});
app.post("/api/payments/stripe/webhook", express.raw({ type: "application/json", limit: "2mb" }),
  async (req, res, next) => {
    try {
      await invoices.webhook(req.body, req.get("stripe-signature"));
      res.json({ received: true });
    } catch (error) {
      if (error.code === "INVOICE_BUSY") return res.status(503).json({ received: false });
      next(error);
    }
  });
app.use(express.json({ limit: "2mb" }));

function invoiceRoute(operation, respond = (res, result) => res.json(result)) {
  return [requireAuth, async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      respond(res, await operation(req.auth.personId, req));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "INVALID_INVOICE_INPUT",
          message: error.issues.map(({ path, message }) => `${path.join(".")}: ${message}`).join(". ") });
      }
      if (error.code === "INVOICE_PDF_BROWSER_UNAVAILABLE") {
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      next(error);
    }
  }];
}

app.get("/api/payments/stripe", ...invoiceRoute((owner) => invoices.connectionStatus(owner)));
app.post("/api/payments/stripe/connect", ...invoiceRoute((owner, req) =>
  invoices.beginConnect(owner, stripeBrowserKey.parse(req.body?.browserKey))));
app.post("/api/payments/stripe/complete", ...invoiceRoute((owner, req) =>
  invoices.completeConnect(owner, z.string().max(2000).parse(req.body?.completionCode), req.body?.browserKey)));
app.get("/api/invoices", ...invoiceRoute((owner, req) => invoices.list(owner, {
  cursor: invoiceId.optional().parse(req.query.cursor),
  invoice_number: z.coerce.number().int().positive().optional().parse(req.query.invoice_number),
  text: z.string().trim().min(1).max(255).optional().parse(req.query.text),
})));
app.get("/api/invoice-receipts", ...invoiceRoute((owner, req) => listInvoiceReceipts(pool, owner,
  z.coerce.number().int().positive().optional().parse(req.query.cursor))));
app.post("/api/invoice-receipts", requireAuth,
  express.raw({ type: invoiceReceiptMediaTypes, limit: invoiceReceiptMaximumBytes }),
  ...invoiceRoute(async (owner, req) => {
    let fileName;
    try { fileName = decodeURIComponent(req.get("X-File-Name") ?? ""); }
    catch { throw Object.assign(new Error("The receipt filename is invalid."), { status: 400, code: "INVALID_RECEIPT_FILENAME" }); }
    const receipt = await uploadInvoiceReceipt({ pool, evidenceRoot, personId: owner, fileName,
      mediaType: req.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase(), bytes: req.body });
    return { receipt };
  }, (res, result) => res.status(201).json(result)));
app.post("/api/invoices", ...invoiceRoute(async (owner, req) => ({
  invoice: await invoices.saveDraft(owner, invoiceDraft.parse(req.body)),
})));
app.post("/api/invoices/adopt", ...invoiceRoute((owner, req) =>
  invoices.adopt(owner, stripeInvoiceId.parse(req.body?.stripeInvoiceId), {
    receivable_account_id: invoiceAccountId.optional().parse(req.body?.receivable_account_id),
    line_account_id: invoiceAccountId.optional().parse(req.body?.line_account_id),
  })));
app.get("/api/invoices/:id", ...invoiceRoute(async (owner, req) => {
  const { objects: [invoice] } = await invoices.list(owner, { invoice_id: invoiceId.parse(req.params.id) });
  return { invoice };
}));
app.get("/api/invoices/:id/preview-pdf", ...invoiceRoute(async (owner, req) => {
  const id = invoiceId.parse(req.params.id);
  const [invoice, issuer] = await Promise.all([invoices.readSavedInvoice(owner, id), getUser(pool, owner)]);
  const receipts = await loadInvoiceReceipts({ pool, evidenceRoot, personId: owner, lines: invoice.lines });
  const lines = invoice.lines.map((line) => {
    const receipt = receipts.get(line.receiptRef);
    const receiptName = receipt ? `Receipt attached: ${receipt.displayName}`
      : line.receiptRef ? "Agent receipt reference. Upload it to Accounting to include its pages." : null;
    return { ...line, receiptName };
  });
  const preview = await renderInvoicePdf({ ...invoice, lines }, issuer?.name ?? "Accounting");
  const bytes = await appendInvoiceReceipts(preview, receipts);
  return { bytes, invoiceNumber: invoice.invoiceNumber, download: req.query.download === "true" };
}, (res, { bytes, invoiceNumber, download }) => {
  res.type("application/pdf").set({
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="invoice-${invoiceNumber}.pdf"`,
    "X-Content-Type-Options": "nosniff",
  }).send(bytes);
}));
app.patch("/api/invoices/:id", ...invoiceRoute(async (owner, req) => ({
  invoice: await invoices.saveDraft(owner, invoiceDraft.parse(req.body), {
    id: invoiceId.parse(req.params.id), revision: invoiceId.parse(req.body?.revision),
  }),
})));
app.patch("/api/invoices/:id/payer", ...invoiceRoute(async (owner, req) => {
  const { revision, ...payer } = req.body ?? {};
  return { invoice: await invoices.correctPaidPayer(owner, invoiceId.parse(req.params.id),
    invoiceId.parse(revision), payer) };
}));
app.patch("/api/invoices/:id/accounts", ...invoiceRoute(async (owner, req) => ({
  invoice: await invoices.assignAccounts(owner, invoiceId.parse(req.params.id), invoiceAccountAssignments.parse(req.body)),
})));
app.patch("/api/invoices/:id/receipts", ...invoiceRoute(async (owner, req) => ({
  invoice: await invoices.assignReceipts(owner, invoiceId.parse(req.params.id), req.body),
})));
app.post("/api/invoices/:id/prepare-send", ...invoiceRoute((owner, req) =>
  invoices.prepareSend(owner, invoiceId.parse(req.params.id))));
app.post("/api/invoices/:id/issue", ...invoiceRoute(async (owner, req) => ({
  invoice: await invoices.issue(owner, invoiceId.parse(req.params.id), invoiceIssue.parse(req.body)),
})));
app.get("/api/invoices/:id/payment-credits", ...invoiceRoute(async (owner, req) => ({
  credits: await invoices.paymentCredits(owner, invoiceId.parse(req.params.id),
    z.string().trim().min(1).max(255).optional().parse(req.query.text)),
})));
app.post("/api/invoices/:id/payments", ...invoiceRoute((owner, req) =>
  invoices.applyPayment(owner, invoiceId.parse(req.params.id), invoicePaymentInput.parse(req.body))));
app.post("/api/invoices/send", ...invoiceRoute((owner, req) =>
  invoices.send(owner, z.string().max(2000).parse(req.body?.sendToken))));

app.get("/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get("/api/currencies", requireAuth, async (req, res, next) => {
  try { res.json({ currencies: await listCurrencies(pool, req.auth.personId) }); } catch (error) { next(error); }
});

app.post("/api/currencies", requireAuth, async (req, res, next) => {
  try {
    const currency = await createCurrency({ pool, personId: req.auth.personId, ...req.body });
    res.status(201).json({ currency });
  } catch (error) { next(error); }
});

app.patch("/api/currencies/:currencyId", requireAuth, async (req, res, next) => {
  try {
    const currency = await updateCurrency({ pool, personId: req.auth.personId,
      currencyId: req.params.currencyId, ...req.body });
    res.json({ currency });
  } catch (error) { next(error); }
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    if (String(process.env.ALLOW_REGISTRATION ?? "true").toLowerCase() !== "true") {
      return res.status(403).json({ error: "REGISTRATION_DISABLED" });
    }
    return res.status(201).json(await registerUser(req.body ?? {}));
  } catch (error) { return next(error); }
});

app.post("/api/auth/login", async (req, res, next) => {
  try { res.json(await loginUser(pool, req.body ?? {})); } catch (error) { next(error); }
});

app.get("/api/auth/me", requireAuth, async (req, res, next) => {
  try {
    const user = await getUser(pool, req.auth.personId);
    if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
    return res.json({ user });
  } catch (error) { return next(error); }
});

app.get("/api/auth/tokens", requireAuth, async (req, res, next) => {
  try { res.json({ tokens: await listApiTokens(pool, req.auth.personId) }); } catch (error) { next(error); }
});

app.post("/api/auth/tokens", requireAuth, async (req, res, next) => {
  try { res.status(201).json(await createApiToken(pool, req.auth.personId, req.body)); } catch (error) { next(error); }
});

app.delete("/api/auth/tokens/:tokenId", requireAuth, async (req, res, next) => {
  try { res.json(await revokeApiToken(pool, req.auth.personId, req.params.tokenId)); } catch (error) { next(error); }
});

app.get("/api/accounts", requireAuth, async (req, res, next) => {
  try { res.json({ accounts: await listAccounts(pool, req.auth.personId) }); } catch (error) { next(error); }
});

app.get("/api/accounts/:accountId/ledger", requireAuth, async (req, res, next) => {
  try { res.json(await listAccountLedger(pool, req.auth.personId, req.params.accountId)); } catch (error) { next(error); }
});

app.post("/api/accounts/:accountId/view", requireAuth, async (req, res, next) => {
  try { res.json(await recordAccountView(pool, req.auth.personId, req.params.accountId)); } catch (error) { next(error); }
});

app.get("/api/accounts/:accountId/import-reviews", requireAuth, async (req, res, next) => {
  try { res.json({ reviews: await listAccountTransactionImportReviews({ pool, personId: req.auth.personId,
    accountId: req.params.accountId }) }); } catch (error) { next(error); }
});

app.get("/api/accounts/:accountId/statement-import-jobs", requireAuth, async (req, res, next) => {
  try {
    res.json({ jobs: await listStatementImportJobs({ pool, personId: req.auth.personId,
      accountId: req.params.accountId, limit: req.query.limit ?? 25 }) });
  } catch (error) { next(error); }
});

app.post("/api/accounts/:accountId/statement-import-jobs", requireAuth,
  express.raw({ type: STATEMENT_EVIDENCE_MEDIA_TYPES, limit: STATEMENT_EVIDENCE_MAX_BYTES }), async (req, res, next) => {
    try {
      let fileName;
      try { fileName = decodeURIComponent(String(req.get("X-File-Name") ?? "")); } catch {
        return res.status(400).json({ error: "INVALID_STATEMENT_FILE_NAME",
          message: "The statement filename header is invalid." });
      }
      return res.status(201).json({ job: await createStatementImportFromFile({
        pool, evidenceRoot, personId: req.auth.personId, accountId: req.params.accountId,
        fileName, mediaType: req.get("Content-Type"), bytes: req.body,
      }) });
    } catch (error) { return next(error); }
  });

app.post("/api/accounts/:accountId/transaction-list-import-jobs", requireAuth, async (req, res, next) => {
  try {
    res.status(201).json({ job: await createTransactionListImportFromText({
      pool, evidenceRoot, personId: req.auth.personId, accountId: req.params.accountId,
      fileName: req.body?.fileName, text: req.body?.text,
    }) });
  } catch (error) { next(error); }
});

app.get("/api/statement-import-jobs/:statementImportJobId", requireAuth, async (req, res, next) => {
  try { res.json({ job: await getStatementImportJob({ pool, personId: req.auth.personId,
    statementImportJobId: req.params.statementImportJobId }) }); } catch (error) { next(error); }
});

app.post("/api/statement-import-jobs/:statementImportJobId/restart", requireAuth, async (req, res, next) => {
  try {
    const restarted = await restartStatementImportJob({ pool, personId: req.auth.personId,
      statementImportJobId: req.params.statementImportJobId });
    if (restarted.removedCanonicalArtifactId) {
      await removeArtifactUpload({ artifactRoot, personId: req.auth.personId,
        artifactId: restarted.removedCanonicalArtifactId });
    }
    res.status(201).json({ job: restarted.job });
  } catch (error) { next(error); }
});

app.delete("/api/statement-import-jobs/:statementImportJobId", requireAuth, async (req, res, next) => {
  try {
    const removed = await deleteStatementImportJob({ pool, personId: req.auth.personId,
      statementImportJobId: req.params.statementImportJobId });
    if (removed.removedCanonicalArtifactId) {
      await removeArtifactUpload({ artifactRoot, personId: req.auth.personId,
        artifactId: removed.removedCanonicalArtifactId });
    }
    await removeEvidenceStorageFile({ evidenceRoot, storageKey: removed.evidenceStorageKey });
    res.json({ deleted: true, statementImportJobId: removed.statementImportJobId,
      evidenceFileId: removed.evidenceFileId, evidenceDeleted: removed.evidenceDeleted });
  } catch (error) { next(error); }
});

app.get("/api/evidence-files/:evidenceFileId/content", requireAuth, async (req, res, next) => {
  try { await sendEvidenceFileContent({ pool, evidenceRoot, personId: req.auth.personId,
    evidenceFileId: req.params.evidenceFileId, rangeHeader: req.get("Range"), method: req.method,
    response: res }); } catch (error) { next(error); }
});

app.head("/api/evidence-files/:evidenceFileId/content", requireAuth, async (req, res, next) => {
  try { await sendEvidenceFileContent({ pool, evidenceRoot, personId: req.auth.personId,
    evidenceFileId: req.params.evidenceFileId, rangeHeader: req.get("Range"), method: req.method,
    response: res }); } catch (error) { next(error); }
});

app.patch("/api/accounts/:accountId/import-reviews/:importPlanId/rows/:externalId", requireAuth,
  async (req, res, next) => {
    try {
      res.json({ review: await updateTransactionImportReviewDecision({ pool, personId: req.auth.personId,
        accountId: req.params.accountId, importPlanId: req.params.importPlanId,
        externalId: req.params.externalId, decision: req.body?.decision }) });
    } catch (error) { next(error); }
  });

app.post("/api/accounts/:accountId/import-reviews/:importPlanId/reverse-signs", requireAuth,
  async (req, res, next) => {
    try {
      res.json({ review: await reverseTransactionImportReviewSigns({ pool, personId: req.auth.personId,
        accountId: req.params.accountId, importPlanId: req.params.importPlanId }) });
    } catch (error) { next(error); }
  });

app.post("/api/accounts/:accountId/import-reviews/:importPlanId/accept", requireAuth, async (req, res, next) => {
  try {
    const visible = await listAccountTransactionImportReviews({ pool, personId: req.auth.personId,
      accountId: req.params.accountId });
    if (!visible.some((review) => review.importPlanId === req.params.importPlanId)) {
      return res.status(404).json({ error: "IMPORT_REVIEW_NOT_FOUND", message: "Import review not found for this account." });
    }
    return res.json({ result: await commitTransactionImportPlan({ pool, personId: req.auth.personId,
      importPlanId: req.params.importPlanId }) });
  } catch (error) { return next(error); }
});

app.post("/api/accounts", requireAuth, async (req, res, next) => {
  try { res.status(201).json(await createAccount({ personId: req.auth.personId, ...req.body })); } catch (error) { next(error); }
});

app.patch("/api/accounts/:accountId", requireAuth, async (req, res, next) => {
  try {
    res.json(await updateAccount({ personId: req.auth.personId, accountId: req.params.accountId, ...req.body }));
  } catch (error) { next(error); }
});

app.get("/api/balance-assertions", requireAuth, async (req, res, next) => {
  try { res.json({ assertions: await listBalanceAssertions(pool, req.auth.personId) }); } catch (error) { next(error); }
});

app.post("/api/balance-assertions", requireAuth, async (req, res, next) => {
  try {
    res.status(201).json({ assertion: await saveBalanceAssertion({ personId: req.auth.personId, ...req.body }) });
  } catch (error) { next(error); }
});

app.delete("/api/balance-assertions/:assertionId", requireAuth, async (req, res, next) => {
  try { res.json(await deleteBalanceAssertion(pool, req.auth.personId, req.params.assertionId)); } catch (error) { next(error); }
});

app.post("/api/accounts/:accountId/reconcile", requireAuth, async (req, res, next) => {
  try { res.json(await reconcileAccountThroughDate({ pool, personId: req.auth.personId,
    accountId: req.params.accountId, balanceDate: req.body?.balanceDate })); } catch (error) { next(error); }
});

app.get("/api/accounting-questions", requireAuth, async (req, res, next) => {
  try { res.json(await listAccountingQuestionsPage(pool, req.auth.personId, {
    status: req.query.status ?? "open", audience: req.query.audience ?? null,
    accountId: req.query.accountId ?? null, limit: req.query.limit ?? 100,
    afterLineItemId: req.query.cursor ?? null,
  })); } catch (error) { next(error); }
});

app.post("/api/accounting-questions/resolve-batch", requireAuth, async (req, res, next) => {
  try { res.json(await resolveAccountingQuestions({ pool, personId: req.auth.personId,
    lineItemIds: req.body?.lineItemIds, targetAccountId: req.body?.targetAccountId,
    resolution: req.body?.resolution })); } catch (error) { next(error); }
});

app.post("/api/accounting-questions/merge-transfer", requireAuth, async (req, res, next) => {
  try {
    res.json(await mergeSuspenseTransferPair({
      pool,
      personId: req.auth.personId,
      lineItemIds: req.body?.lineItemIds,
      retainedTransactionId: req.body?.retainedTransactionId,
    }));
  } catch (error) { next(error); }
});

app.post("/api/accounting-questions/:lineItemId/resolve", requireAuth, async (req, res, next) => {
  try { res.json(await resolveAccountingQuestion({ pool, personId: req.auth.personId,
    lineItemId: req.params.lineItemId, targetAccountId: req.body?.targetAccountId,
    resolution: req.body?.resolution })); } catch (error) { next(error); }
});

app.get("/api/accounts/:accountId/purchase-evidence-jobs", requireAuth, async (req, res, next) => {
  try {
    res.json({ jobs: await listPurchaseEvidenceJobs({ pool, personId: req.auth.personId,
      accountId: req.params.accountId, limit: req.query.limit ?? 25 }) });
  } catch (error) { next(error); }
});

app.post("/api/purchase-evidence-jobs", requireAuth, async (req, res, next) => {
  try {
    res.status(201).json({ job: await createPurchaseEvidenceJob({ pool, personId: req.auth.personId,
      lineItemIds: req.body?.lineItemIds }) });
  } catch (error) { next(error); }
});

app.get("/api/purchase-evidence-jobs/:purchaseEvidenceJobId", requireAuth, async (req, res, next) => {
  try {
    res.json({ job: await getPurchaseEvidenceJob({ pool, personId: req.auth.personId,
      purchaseEvidenceJobId: req.params.purchaseEvidenceJobId, includePreview: true }) });
  } catch (error) { next(error); }
});

app.post("/api/purchase-evidence-jobs/:purchaseEvidenceJobId/commit", requireAuth, async (req, res, next) => {
  try {
    res.json(await commitPurchaseEvidenceJob({ pool, personId: req.auth.personId,
      purchaseEvidenceJobId: req.params.purchaseEvidenceJobId }));
  } catch (error) { next(error); }
});

app.post("/api/purchase-evidence-jobs/:purchaseEvidenceJobId/restart", requireAuth, async (req, res, next) => {
  try {
    const restarted = await restartPurchaseEvidenceJob({ pool, personId: req.auth.personId,
      purchaseEvidenceJobId: req.params.purchaseEvidenceJobId });
    if (restarted.removedCanonicalArtifactId) await removeArtifactUpload({
      artifactRoot, personId: req.auth.personId, artifactId: restarted.removedCanonicalArtifactId,
    });
    res.json({ job: restarted.job });
  } catch (error) { next(error); }
});

app.get("/api/transactions", requireAuth, async (req, res, next) => {
  try { res.json({ transactions: await listTransactions(pool, req.auth.personId, req.query.limit) }); } catch (error) { next(error); }
});

app.get("/api/transactions/:transactionId", requireAuth, async (req, res, next) => {
  try { res.json({ transaction: await getTransaction(pool, req.auth.personId, Number(req.params.transactionId)) }); } catch (error) { next(error); }
});

app.post("/api/transactions", requireAuth, async (req, res, next) => {
  try { res.status(201).json(await createTransaction({ personId: req.auth.personId, ...req.body })); } catch (error) { next(error); }
});

app.patch("/api/transactions/:transactionId", requireAuth, async (req, res, next) => {
  try {
    res.json(await updateTransaction({ ...req.body, personId: req.auth.personId,
      transactionId: req.params.transactionId }));
  } catch (error) { next(error); }
});

app.get("/api/transaction-import-jobs", requireAuth, async (req, res, next) => {
  try {
    res.json({ jobs: await listTransactionImportJobs({ pool, personId: req.auth.personId,
      limit: req.query.limit ?? 100 }) });
  } catch (error) { next(error); }
});

app.get("/api/transaction-import-jobs/:importJobId", requireAuth, async (req, res, next) => {
  try {
    res.json({ job: await getTransactionImportJob({ pool, personId: req.auth.personId,
      importJobId: req.params.importJobId }) });
  } catch (error) { next(error); }
});

app.get("/api/transaction-import-jobs/:importJobId/exceptions", requireAuth, async (req, res, next) => {
  try {
    res.json({ job: await listTransactionImportExceptions({ pool, personId: req.auth.personId,
      importJobId: req.params.importJobId, limit: req.query.limit ?? 100,
      afterExternalId: req.query.cursor ?? null }) });
  } catch (error) { next(error); }
});

app.post("/api/transaction-import-jobs/:importJobId/exceptions/:transactionExternalId/retry", requireAuth,
  async (req, res, next) => {
    try {
      res.json({ job: await retryTransactionImportException({ pool, personId: req.auth.personId,
        importJobId: req.params.importJobId, transactionExternalId: req.params.transactionExternalId,
        retryId: req.body?.retryId, records: req.body?.records }) });
    } catch (error) { next(error); }
  });

app.post("/api/transaction-import-jobs/:importJobId/exceptions/:transactionExternalId/exclude", requireAuth,
  async (req, res, next) => {
    try {
      res.json({ job: await excludeTransactionImportException({ pool, personId: req.auth.personId,
        importJobId: req.params.importJobId, transactionExternalId: req.params.transactionExternalId,
        exclusionId: req.body?.exclusionId, reason: req.body?.reason }) });
    } catch (error) { next(error); }
  });

app.post("/api/transaction-import-jobs/:importJobId/preview", requireAuth, async (req, res, next) => {
  try {
    res.json({ job: await previewTransactionImportJob({ pool, personId: req.auth.personId,
      importJobId: req.params.importJobId }) });
  } catch (error) { next(error); }
});

app.post("/api/transaction-import-jobs/:importJobId/commit", requireAuth, async (req, res, next) => {
  try {
    res.json({ job: await commitTransactionImportJob({ pool, personId: req.auth.personId,
      importJobId: req.params.importJobId, previewDigest: req.body?.previewDigest }) });
  } catch (error) { next(error); }
});

app.post("/api/transaction-import-jobs/:importJobId/restart-preview", requireAuth, async (req, res, next) => {
  try {
    res.json(await previewImportRestart({ pool, personId: req.auth.personId,
      importJobId: req.params.importJobId }));
  } catch (error) { next(error); }
});

app.post("/api/transaction-import-jobs/:importJobId/restart-commit", requireAuth, async (req, res, next) => {
  try {
    res.json(await commitImportRestart({ pool, personId: req.auth.personId,
      restartPlanId: req.body?.restartPlanId, previewDigest: req.body?.previewDigest }));
  } catch (error) { next(error); }
});

app.post("/api/data/transactions/delete-preview", requireAuth, async (req, res, next) => {
  try {
    res.json(await previewTransactionDeletion({ pool, personId: req.auth.personId,
      scope: req.body?.scope, transactionIds: req.body?.transactionIds,
      deleteAccounts: req.body?.deleteAccounts,
      deleteImportHistory: req.body?.deleteImportHistory }));
  } catch (error) { next(error); }
});

app.post("/api/data/transactions/delete-commit", requireAuth, async (req, res, next) => {
  try {
    res.json(await commitTransactionDeletion({ pool, personId: req.auth.personId,
      deletionPlanId: req.body?.deletionPlanId, previewDigest: req.body?.previewDigest }));
  } catch (error) { next(error); }
});

app.post("/api/data/accounts/:accountId/delete-preview", requireAuth, async (req, res, next) => {
  try {
    res.json(await previewAccountDeletion({ pool, personId: req.auth.personId,
      accountId: req.params.accountId }));
  } catch (error) { next(error); }
});

app.post("/api/data/accounts/:accountId/delete-commit", requireAuth, async (req, res, next) => {
  try {
    res.json(await commitAccountDeletion({ pool, personId: req.auth.personId,
      deletionPlanId: req.body?.deletionPlanId }));
  } catch (error) { next(error); }
});

app.post("/api/data/user/delete-preview", requireAuth, async (req, res, next) => {
  try {
    res.json(await previewUserDeletion({ pool, personId: req.auth.personId,
      currentPassword: req.body?.currentPassword }));
  } catch (error) { next(error); }
});

app.get("/api/data/summary", requireAuth, async (req, res, next) => {
  try {
    res.json({ summary: await getUserDataSummary({ pool, personId: req.auth.personId }) });
  } catch (error) { next(error); }
});

app.post("/api/data/user/delete-commit", requireAuth, async (req, res, next) => {
  try {
    res.json(await commitUserDeletion({ pool, evidenceRoot, personId: req.auth.personId,
      deletionPlanId: req.body?.deletionPlanId, previewDigest: req.body?.previewDigest,
      currentPassword: req.body?.currentPassword, confirmationText: req.body?.confirmationText }));
  } catch (error) { next(error); }
});

app.post("/api/ledger/verify", requireAuth, async (req, res, next) => {
  try {
    const report = await verifyAllPostedTransactions(pool, req.auth.personId);
    res.status(report.valid ? 200 : 409).json(report);
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error?.status) || 500;
  res.status(status).json({
    error: error?.code || "INTERNAL_ERROR",
    message: status >= 500 ? "Unexpected server error." : error.message,
    details: error?.details,
  });
});

const server = app.listen(port, host, () => {
  console.log(`Chapeaux Fous Accounting API listening on http://${host}:${port}`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down.`);
  const forcedExit = setTimeout(() => {
    console.error("Shutdown timed out; forcing exit.");
    process.exit(1);
  }, 5000);
  forcedExit.unref();
  try {
    const serverClosed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await pool.end();
    await serverClosed;
    process.exit(0);
  } catch (error) {
    console.error("Shutdown failed.", error);
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
