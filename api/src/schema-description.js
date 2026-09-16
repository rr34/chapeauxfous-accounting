const accountingTables = Object.freeze([
  "account_balance_assertions", "accounting_import_plans", "accounting_schema_metadata", "accounting_transaction_import_items",
  "accounting_transaction_import_jobs", "accounting_transaction_import_requests", "accounts",
  "api_tokens", "currencies", "line_items", "lineitems_tags_join", "people2_people", "tags", "transactions", "xrates",
]);

const ignoredWords = new Set(["a", "an", "and", "are", "by", "for", "how", "in", "is", "of", "on", "or", "the", "to", "what", "with"]);

export async function describeAccountingSchema(pool, databaseName, request) {
  const placeholders = accountingTables.map(() => "?").join(", ");
  const [rows] = await pool.query(
    `SELECT t.TABLE_NAME AS tableName, t.TABLE_COMMENT AS tableComment,
            c.COLUMN_NAME AS columnName, c.COLUMN_TYPE AS columnType,
            c.IS_NULLABLE AS isNullable, c.COLUMN_COMMENT AS columnComment
       FROM information_schema.TABLES t
       JOIN information_schema.COLUMNS c
         ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME IN (${placeholders})
      ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION`,
    [databaseName, ...accountingTables],
  );
  const terms = [...new Set(String(request).toLowerCase().match(/[a-z0-9_]+/g) ?? [])]
    .filter((term) => !ignoredWords.has(term));
  const tables = new Map();
  for (const row of rows) {
    if (!tables.has(row.tableName)) tables.set(row.tableName, {
      name: row.tableName,
      comment: row.tableComment ?? "",
      columns: [],
    });
    tables.get(row.tableName).columns.push({
      name: row.columnName,
      type: row.columnType,
      nullable: row.isNullable === "YES",
      comment: row.columnComment ?? "",
    });
  }
  const matches = [...tables.values()].filter((table) => {
    const searchable = [table.name, table.comment,
      ...table.columns.flatMap((column) => [column.name, column.comment])].join(" ").toLowerCase();
    return terms.some((term) => searchable.includes(term));
  });
  return { request, tables: matches };
}
