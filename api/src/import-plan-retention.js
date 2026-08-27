export const ACCOUNTING_IMPORT_PLAN_RETENTION_HOURS = 48;

export async function pruneOwnerAccountingImportPlans(connection, personId) {
  const resolvedPersonId = Number(personId);
  if (!Number.isInteger(resolvedPersonId) || resolvedPersonId <= 0) {
    throw new Error("A valid plan owner is required for retention cleanup.");
  }
  const [result] = await connection.query(
    `DELETE FROM accounting_import_plans
      WHERE owner_person_id = ?
        AND (
          (plan_status = 'committed'
            AND committed_at < UTC_TIMESTAMP(6) - INTERVAL ${ACCOUNTING_IMPORT_PLAN_RETENTION_HOURS} HOUR)
          OR (plan_status = 'invalidated'
            AND invalidated_at < UTC_TIMESTAMP(6) - INTERVAL ${ACCOUNTING_IMPORT_PLAN_RETENTION_HOURS} HOUR)
          OR (plan_status = 'ready'
            AND expires_at < UTC_TIMESTAMP(6) - INTERVAL ${ACCOUNTING_IMPORT_PLAN_RETENTION_HOURS} HOUR)
        )`,
    [resolvedPersonId],
  );
  return { deletedPlanCount: Number(result.affectedRows ?? 0) };
}
