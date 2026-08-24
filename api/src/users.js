import { hashPassword, signUserToken, verifyPassword } from "./auth.js";
import { withTransaction } from "./db.js";

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export async function registerUser({ name, email, password }, runInTransaction = withTransaction) {
  const normalizedName = String(name ?? "").trim();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedName) throw Object.assign(new Error("Name is required."), { status: 400, code: "NAME_REQUIRED" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw Object.assign(new Error("A valid email is required."), { status: 400, code: "INVALID_EMAIL" });
  }
  const passwordHash = await hashPassword(password);

  return runInTransaction(async (connection) => {
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
    return { token: signUserToken(personId), user: { personId, name: normalizedName, email: normalizedEmail } };
  });
}

export async function loginUser(pool, { email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const [rows] = await pool.query(
    `SELECT p.person_id, p.Name, p.OwnerEmail, p.OwnerPasscode
       FROM people2_people p
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
    },
  };
}

export async function getUser(pool, personId) {
  const [rows] = await pool.query(
    `SELECT p.person_id, p.Name, p.OwnerEmail
       FROM people2_people p
      WHERE p.person_id = ?`,
    [personId],
  );
  const row = rows[0];
  if (!row) return null;
  return { personId: Number(row.person_id), name: row.Name, email: row.OwnerEmail };
}
