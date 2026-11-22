function absolute(value) {
  return value < 0n ? -value : value;
}

const currencySymbol = "[$¢£¤¥֏؋৲৳৻૱௹฿៛₠-₿꠸﷼﹩＄￠￡￥￦]";
const decimalWhole = String.raw`(?:\d+|\d{1,3}(?:,\d{3})+)`;
const currencyPrefix = String.raw`(?:${currencySymbol}\s*)?`;
const signedPrefix = String.raw`(?:[+-]?${currencySymbol}\s*|${currencySymbol}\s*[+-]?|[+-]?)`;

export const SIGNED_DECIMAL_INPUT_PATTERN_SOURCE =
  String.raw`^${signedPrefix}${decimalWhole}(?:\.\d+)?$`;
export const UNSIGNED_DECIMAL_INPUT_PATTERN_SOURCE =
  String.raw`^${currencyPrefix}${decimalWhole}(?:\.\d+)?$`;
export const UNSIGNED_DECIMAL_18_INPUT_PATTERN_SOURCE =
  String.raw`^${currencyPrefix}${decimalWhole}(?:\.\d{1,18})?$`;
export const SIGNED_DECIMAL_INPUT_PATTERN = new RegExp(SIGNED_DECIMAL_INPUT_PATTERN_SOURCE, "u");
export const UNSIGNED_DECIMAL_INPUT_PATTERN = new RegExp(UNSIGNED_DECIMAL_INPUT_PATTERN_SOURCE, "u");
export const UNSIGNED_DECIMAL_18_INPUT_PATTERN = new RegExp(UNSIGNED_DECIMAL_18_INPUT_PATTERN_SOURCE, "u");

const decimalPartsPattern = new RegExp(
  String.raw`^(?:([+-]?)${currencySymbol}\s*|${currencySymbol}\s*([+-]?)|([+-]?))(${decimalWhole})(?:\.(\d+))?$`,
  "u",
);

export function normalizeDecimalInput(value) {
  const normalized = String(value ?? "").trim();
  const match = normalized.match(decimalPartsPattern);
  if (!match) throw new Error(`Invalid amount: ${normalized || "empty"}`);
  const sign = match[1] || match[2] || match[3] || "";
  return `${sign}${match[4].replaceAll(",", "")}${match[5] == null ? "" : `.${match[5]}`}`;
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

export function decimalToUnits(value, scale, { round = false } = {}) {
  const resolvedScale = Number(scale);
  if (!Number.isInteger(resolvedScale) || resolvedScale < 0 || resolvedScale > 18) {
    throw new Error("Invalid commodity scale");
  }
  const normalized = normalizeDecimalInput(value);
  const match = normalized.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  const fractional = match[3] ?? "";
  if (fractional.length > resolvedScale && !round) throw new Error(`Amount exceeds ${resolvedScale} decimal places`);
  let magnitude = BigInt(`${match[2]}${fractional.slice(0, resolvedScale).padEnd(resolvedScale, "0")}`);
  if (round && fractional.length > resolvedScale && fractional[resolvedScale] >= "5") magnitude += 1n;
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
