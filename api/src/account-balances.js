const creditNormalAccountTypes = new Set(["liability", "income", "equity"]);

export function normalBalanceSign(accountType) {
  return creditNormalAccountTypes.has(accountType) ? -1n : 1n;
}

export function normalBalanceUnits(accountType, rawPostingUnits) {
  return (BigInt(rawPostingUnits) * normalBalanceSign(accountType)).toString();
}
