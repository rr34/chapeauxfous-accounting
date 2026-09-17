function rateTime(value) {
  const text = value instanceof Date ? value.toISOString() : String(value).trim().replace(" ", "T");
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
  if (!Number.isFinite(parsed)) throw new Error("Reference rate has an invalid UTC timestamp");
  return parsed;
}

export function referenceRatePairKey(leftCurrencyId, rightCurrencyId) {
  return [Number(leftCurrencyId), Number(rightCurrencyId)].sort((left, right) => left - right).join(":");
}

export function nearestReferenceRate(rates, timestamp, fromCurrencyId, toCurrencyId) {
  const targetTime = rateTime(timestamp);
  let best = null;
  for (const rate of rates ?? []) {
    const direct = Number(rate.from_currency_id) === Number(fromCurrencyId)
      && Number(rate.to_currency_id) === Number(toCurrencyId);
    const inverse = Number(rate.from_currency_id) === Number(toCurrencyId)
      && Number(rate.to_currency_id) === Number(fromCurrencyId);
    if (!direct && !inverse) continue;
    const validAtMs = rateTime(rate.ValidAt);
    const distance = Math.abs(validAtMs - targetTime);
    if (best != null && validAtMs === best.validAtMs) {
      const numerator = BigInt(direct ? rate.to_units : rate.from_units);
      const denominator = BigInt(direct ? rate.from_units : rate.to_units);
      const bestNumerator = BigInt(best.direct ? best.rate.to_units : best.rate.from_units);
      const bestDenominator = BigInt(best.direct ? best.rate.from_units : best.rate.to_units);
      if (numerator * bestDenominator !== bestNumerator * denominator) {
        throw Object.assign(new Error("Direct and reciprocal reference rates conflict at the same timestamp."),
          { code: "CONFLICTING_REFERENCE_RATES" });
      }
    }
    if (best == null || distance < best.distance
      || (distance === best.distance && validAtMs < best.validAtMs)
      || (distance === best.distance && validAtMs === best.validAtMs
        && Number(rate.xrate_id) < Number(best.rate.xrate_id))) {
      best = { rate, direct, validAtMs, distance };
    }
  }
  return best;
}

export function valueAtReferenceRate(amountUnits, selection) {
  const amount = BigInt(amountUnits);
  const numerator = BigInt(selection.direct ? selection.rate.to_units : selection.rate.from_units);
  const denominator = BigInt(selection.direct ? selection.rate.from_units : selection.rate.to_units);
  if (numerator <= 0n || denominator <= 0n) throw new Error("Reference rate has an invalid native-unit ratio");
  const magnitude = amount < 0n ? -amount : amount;
  const rounded = (magnitude * numerator * 2n + denominator) / (denominator * 2n);
  return (amount < 0n ? -rounded : rounded).toString();
}
