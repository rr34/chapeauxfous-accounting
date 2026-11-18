export const SUSPENSE_TRANSFER_MAX_DATE_GAP_DAYS = 3;

export type SuspenseTransferCandidate = {
  lineItemId: number;
  transactionId: number;
  date: string;
  amountUnits: string;
  counterpartAccountIds: number[];
};

export type SuspenseTransferPair = {
  firstLineItemId: number;
  secondLineItemId: number;
  dateGapDays: number;
};

function calendarDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.slice(0, 10));
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
}

function uniqueCounterpart(candidate: SuspenseTransferCandidate) {
  const ids = [...new Set(candidate.counterpartAccountIds)];
  return ids.length === 1 ? ids[0] : null;
}

export function findUnambiguousSuspenseTransferPairs(
  candidates: SuspenseTransferCandidate[],
): SuspenseTransferPair[] {
  const eligible = candidates.filter((candidate) => {
    try {
      return BigInt(candidate.amountUnits) !== 0n && calendarDay(candidate.date) != null
        && uniqueCounterpart(candidate) != null;
    } catch {
      return false;
    }
  });
  const matches = new Map<number, Array<{ candidate: SuspenseTransferCandidate; gap: number }>>();
  for (const candidate of eligible) {
    const accountId = uniqueCounterpart(candidate);
    const day = calendarDay(candidate.date) as number;
    const possible = eligible.flatMap((other) => {
      if (other.lineItemId === candidate.lineItemId
        || other.transactionId === candidate.transactionId
        || uniqueCounterpart(other) === accountId) return [];
      const otherDay = calendarDay(other.date) as number;
      const gap = Math.abs(day - otherDay);
      try {
        return BigInt(candidate.amountUnits) === -BigInt(other.amountUnits)
          && gap <= SUSPENSE_TRANSFER_MAX_DATE_GAP_DAYS ? [{ candidate: other, gap }] : [];
      } catch {
        return [];
      }
    });
    matches.set(candidate.lineItemId, possible);
  }

  const paired = new Set<number>();
  const pairs: SuspenseTransferPair[] = [];
  for (const candidate of eligible) {
    if (paired.has(candidate.lineItemId)) continue;
    const possible = matches.get(candidate.lineItemId) ?? [];
    if (possible.length !== 1) continue;
    const other = possible[0].candidate;
    const reverse = matches.get(other.lineItemId) ?? [];
    if (reverse.length !== 1 || reverse[0].candidate.lineItemId !== candidate.lineItemId) continue;
    paired.add(candidate.lineItemId);
    paired.add(other.lineItemId);
    pairs.push({
      firstLineItemId: candidate.lineItemId,
      secondLineItemId: other.lineItemId,
      dateGapDays: possible[0].gap,
    });
  }
  return pairs;
}
