export function knownBalanceOrderForSameDate(
  leftDate: string,
  leftIsKnownBalance: boolean,
  rightDate: string,
  rightIsKnownBalance: boolean,
  dateDirection: "asc" | "desc" | null,
) {
  if (dateDirection == null || leftDate !== rightDate
    || leftIsKnownBalance === rightIsKnownBalance) return null;
  const chronologicalOrder = leftIsKnownBalance ? 1 : -1;
  return dateDirection === "asc" ? chronologicalOrder : -chronologicalOrder;
}

export function sameDateChronologicalOrder(
  leftOrder: number,
  rightOrder: number,
  dateDirection: "asc" | "desc",
) {
  const chronologicalOrder = leftOrder - rightOrder;
  return dateDirection === "asc" ? chronologicalOrder : -chronologicalOrder;
}
