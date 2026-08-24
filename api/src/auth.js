import { promisify } from "node:util";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { requireEnv } from "./env.js";

const scrypt = promisify(scryptCallback);
const jwtSecret = requireEnv("JWT_SECRET");
const tokenLifetime = "30d";

export async function hashPassword(password) {
  const normalized = String(password ?? "");
  if (normalized.length < 10) {
    const error = new Error("Password must contain at least 10 characters.");
    error.status = 400;
    error.code = "PASSWORD_TOO_SHORT";
    throw error;
  }
  const salt = randomBytes(16);
  const derived = await scrypt(normalized, salt, 64);
  return `scrypt$${salt.toString("hex")}$${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, saltHex, expectedHex] = String(encoded ?? "").split("$");
  if (algorithm !== "scrypt" || !saltHex || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(await scrypt(String(password ?? ""), Buffer.from(saltHex, "hex"), expected.length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function signUserToken(personId) {
  return jwt.sign(
    { personId: Number(personId), scope: [`accounting:${Number(personId)}`] },
    jwtSecret,
    { expiresIn: tokenLifetime },
  );
}

export function requireAuth(req, res, next) {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "NO_TOKEN" });
  }
  try {
    const payload = jwt.verify(authorization.slice(7), jwtSecret);
    const personId = Number(payload?.personId);
    if (!Number.isInteger(personId) || personId <= 0) throw new Error("Invalid person identity");
    req.auth = { personId };
    return next();
  } catch (error) {
    return res.status(401).json({ error: error?.name === "TokenExpiredError" ? "TOKEN_EXPIRED" : "INVALID_TOKEN" });
  }
}

