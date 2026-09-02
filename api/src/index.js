import express from "express";
import cors from "cors";
import "./env.js";
import { pool } from "./db.js";
import { requireAuth } from "./auth.js";
import { createApiToken, listApiTokens, revokeApiToken } from "./api-tokens.js";
import { mountAccountingMcp } from "./mcp.js";
import { getUser, loginUser, registerUser } from "./users.js";
import { listBalanceAssertions, saveBalanceAssertion } from "./balance-assertions.js";
import {
  createAccount, createTransaction, getTransaction, listAccountLedger, listAccounts,
  listTransactions, updateAccount, verifyAllPostedTransactions,
} from "./accounting.js";
import { createCurrency, listCurrencies } from "./currencies.js";
import { commitAccountDeletion, previewAccountDeletion } from "./account-delete.js";
import { commitTransactionDeletion, previewTransactionDeletion } from "./transaction-delete.js";
import { commitImportRestart, previewImportRestart } from "./import-restart.js";
import { commitUserDeletion, getUserDataSummary, previewUserDeletion } from "./user-delete.js";
import { TRANSACTION_IMPORT_HTTP_BODY_LIMIT } from "./transaction-import-limits.js";
import { ARTIFACT_UPLOAD_MAX_CHUNK_BYTES, resolveArtifactUploadRoot } from "./artifact-upload.js";
import {
  commitTransactionImportJob,
  excludeTransactionImportException,
  getTransactionImportJob,
  listTransactionImportExceptions,
  listTransactionImportJobs,
  previewTransactionImportJob,
  retryTransactionImportException,
} from "./transaction-import-job.js";

const app = express();
const port = Number(process.env.API_PORT || 5004);
const host = process.env.API_HOST || "127.0.0.1";
const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";

app.disable("x-powered-by");
app.use(cors({ origin: clientOrigin }));
mountAccountingMcp(app, {
  pool,
  artifactRoot: resolveArtifactUploadRoot(),
  jsonBodyParser: express.json({ limit: TRANSACTION_IMPORT_HTTP_BODY_LIMIT }),
  artifactJsonBodyParser: express.json({ limit: "64kb" }),
  artifactRawBodyParser: express.raw({ type: "application/octet-stream", limit: ARTIFACT_UPLOAD_MAX_CHUNK_BYTES }),
});
app.use(express.json({ limit: "2mb" }));

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

app.get("/api/transactions", requireAuth, async (req, res, next) => {
  try { res.json({ transactions: await listTransactions(pool, req.auth.personId, req.query.limit) }); } catch (error) { next(error); }
});

app.get("/api/transactions/:transactionId", requireAuth, async (req, res, next) => {
  try { res.json({ transaction: await getTransaction(pool, req.auth.personId, Number(req.params.transactionId)) }); } catch (error) { next(error); }
});

app.post("/api/transactions", requireAuth, async (req, res, next) => {
  try { res.status(201).json(await createTransaction({ personId: req.auth.personId, ...req.body })); } catch (error) { next(error); }
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
      deleteAccounts: req.body?.deleteAccounts }));
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
    res.json(await commitUserDeletion({ pool, personId: req.auth.personId,
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
