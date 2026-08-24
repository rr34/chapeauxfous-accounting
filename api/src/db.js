import mysql from "mysql2/promise";
import "./env.js";
import { requireEnv } from "./env.js";

export const databaseName = requireEnv("MYSQL_DATABASE");

export const pool = mysql.createPool({
  host: requireEnv("MYSQL_HOST"),
  user: requireEnv("MYSQL_USER"),
  password: process.env.MYSQL_PASSWORD ?? "",
  database: databaseName,
  connectionLimit: 10,
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: "utf8mb4",
});

export async function withTransaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

