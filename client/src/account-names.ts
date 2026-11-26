import type { Account } from "./types";

export function accountFullNames(accounts: Account[]) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const names = new Map<number, string>();
  function resolve(account: Account, visiting = new Set<number>()): string {
    const known = names.get(account.id);
    if (known) return known;
    if (visiting.has(account.id)) return account.name;
    const parent = account.parentAccountId == null ? null : byId.get(account.parentAccountId);
    const fullName = parent ? `${resolve(parent, new Set(visiting).add(account.id))}:${account.name}` : account.name;
    names.set(account.id, fullName);
    return fullName;
  }
  for (const account of accounts) resolve(account);
  return names;
}
