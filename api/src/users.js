import { hashPassword, signUserToken, verifyPassword } from "./auth.js";
import { withTransaction } from "./db.js";

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export async function registerUser({ name, email, password, functionalCurrencyId }) {
  const normalizedName = String(name ?? "").trim();
  const normalizedEmail = normalizeEmail(email);
  const currencyId = Number(functionalCurrencyId);
  if (!normalizedName) throw Object.assign(new Error("Name is required."), { status: 400, code: "NAME_REQUIRED" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw Object.assign(new Error("A valid email is required."), { status: 400, code: "INVALID_EMAIL" });
  }
  if (!Number.isInteger(currencyId) || currencyId <= 0) {
    throw Object.assign(new Error("Functional currency is required."), { status: 400, code: "CURRENCY_REQUIRED" });
  }
  const passwordHash = await hashPassword(password);

  return withTransaction(async (connection) => {
    const [currencyRows] = await connection.query("SELECT currency_id FROM currencies WHERE currency_id = ?", [currencyId]);
    if (!currencyRows.length) throw Object.assign(new Error("Currency not found."), { status: 400, code: "CURRENCY_NOT_FOUND" });
    let result;
    try {
      [result] = await connection.query(
        "INSERT INTO people2_people (Name, OwnerEmail, OwnerPasscode) VALUES (?, ?, ?)",
        [normalizedName, normalizedEmail, passwordHash],
      );
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        throw Object.assign(new Error("An account already uses that email."), { status: 409, code: "USER_EXISTS" });
      }
      throw error;
    }
    const personId = Number(result.insertId);
    await connection.query(
      "INSERT INTO accounting_profiles (person_id, functional_currency_id) VALUES (?, ?)",
      [personId, currencyId],
    );
    const roots = [
      ["Assets", "asset"], ["Liabilities", "liability"], ["Equity", "equity"],
      ["Income", "income"], ["Expenses", "expense"],
    ];
    for (const [accountName, accountType] of roots) {
      await connection.query(
        `INSERT INTO accounts
          (owner_person_id, AccountName, parent_account_id, AccountType, account_currency_id)
         VALUES (?, ?, NULL, ?, ?)`,
        [personId, accountName, accountType, currencyId],
      );
    }
    return { token: signUserToken(personId), user: { personId, name: normalizedName, email: normalizedEmail, functionalCurrencyId: currencyId } };
  });
}

export async function loginUser(pool, { email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const [rows] = await pool.query(
    `SELECT p.person_id, p.Name, p.OwnerEmail, p.OwnerPasscode, ap.functional_currency_id
       FROM people2_people p
       JOIN accounting_profiles ap ON ap.person_id = p.person_id
      WHERE LOWER(p.OwnerEmail) = ? LIMIT 1`,
    [normalizedEmail],
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.OwnerPasscode))) {
    throw Object.assign(new Error("Invalid email or password."), { status: 401, code: "INVALID_CREDENTIALS" });
  }
  const personId = Number(user.person_id);
  return {
    token: signUserToken(personId),
    user: {
      personId,
      name: user.Name,
      email: user.OwnerEmail,
      functionalCurrencyId: Number(user.functional_currency_id),
    },
  };
}

export async function getUser(pool, personId) {
  const [rows] = await pool.query(
    `SELECT p.person_id, p.Name, p.OwnerEmail, ap.functional_currency_id
       FROM people2_people p
       JOIN accounting_profiles ap ON ap.person_id = p.person_id
      WHERE p.person_id = ?`,
    [personId],
  );
  const row = rows[0];
  if (!row) return null;
  return { personId: Number(row.person_id), name: row.Name, email: row.OwnerEmail, functionalCurrencyId: Number(row.functional_currency_id) };
}

