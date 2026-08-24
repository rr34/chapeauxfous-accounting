function absolute(value) {
  return value < 0n ? -value : value;
}

export function greatestCommonDivisor(left, right) {
  let a = absolute(BigInt(left));
  let b = absolute(BigInt(right));
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}

export function fraction(numerator, denominator = 1n) {
  let top = BigInt(numerator);
  let bottom = BigInt(denominator);
  if (bottom === 0n) throw new Error("Fraction denominator cannot be zero");
  if (bottom < 0n) {
    top = -top;
    bottom = -bottom;
  }
  const divisor = greatestCommonDivisor(top, bottom);
  return { numerator: top / divisor, denominator: bottom / divisor };
}

export function addFractions(left, right) {
  return fraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function decimalToUnits(value, scale) {
  const normalized = String(value ?? "").trim();
  const resolvedScale = Number(scale);
  if (!Number.isInteger(resolvedScale) || resolvedScale < 0 || resolvedScale > 18) {
    throw new Error("Invalid commodity scale");
  }
  const match = normalized.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`Invalid amount: ${normalized || "empty"}`);
  const fractional = match[3] ?? "";
  if (fractional.length > resolvedScale) throw new Error(`Amount exceeds ${resolvedScale} decimal places`);
  const magnitude = BigInt(`${match[2]}${fractional.padEnd(resolvedScale, "0")}`);
  return `${match[1] === "-" ? -magnitude : magnitude}`;
}

export function unitsToDecimal(value, scale) {
  const units = BigInt(value);
  const resolvedScale = Number(scale);
  const sign = units < 0n ? "-" : "";
  const digits = absolute(units).toString().padStart(resolvedScale + 1, "0");
  if (resolvedScale === 0) return `${sign}${digits}`;
  const whole = digits.slice(0, -resolvedScale);
  const decimal = digits.slice(-resolvedScale).replace(/0+$/, "");
  return decimal ? `${sign}${whole}.${decimal}` : `${sign}${whole}`;
}

