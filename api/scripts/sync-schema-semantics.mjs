import process from "node:process";
import { pool, databaseName } from "../src/db.js";
import { writeAccountingSemanticForm } from "./accounting-schema-semantics.mjs";

try {
  const report = await writeAccountingSemanticForm(pool, databaseName, {
    seedComments: process.argv.includes("--seed-comments"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await pool.end();
}
