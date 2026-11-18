export function knownBalanceOrderForSameDate(
  leftDate: string,
  leftIsKnownBalance: boolean,
  rightDate: string,
  rightIsKnownBalance: boolean,
) {
  if (leftDate !== rightDate || leftIsKnownBalance === rightIsKnownBalance) return null;
  return leftIsKnownBalance ? 1 : -1;
}
