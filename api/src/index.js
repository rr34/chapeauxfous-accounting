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
  createAccount, createTransaction, getTransaction, listAccounts,
  listTransactions, verifyAllPostedTransactions,
} from "./accounting.js";
import { createCurrency, listCurrencies } from "./currencies.js";

const app = express();
const port = Number(process.env.API_PORT || 5004);
const host = process.env.API_HOST || "127.0.0.1";
const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";

app.disable("x-powered-by");
app.use(cors({ origin: clientOrigin }));
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

app.post("/api/accounts", requireAuth, async (req, res, next) => {
  try { res.status(201).json(await createAccount({ personId: req.auth.personId, ...req.body })); } catch (error) { next(error); }
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

app.post("/api/ledger/verify", requireAuth, async (req, res, next) => {
  try {
    const report = await verifyAllPostedTransactions(pool, req.auth.personId);
    res.status(report.valid ? 200 : 409).json(report);
  } catch (error) { next(error); }
});

mountAccountingMcp(app, { pool });

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

async function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
