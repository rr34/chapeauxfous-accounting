export function decimalToUnits(value: string, scale: number): string {
  const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`Invalid amount: ${value || "empty"}`);
  const fractional = match[3] || "";
  if (fractional.length > scale) throw new Error(`Amount exceeds ${scale} decimal places`);
  const magnitude = BigInt(`${match[2]}${fractional.padEnd(scale, "0")}`);
  return String(match[1] === "-" ? -magnitude : magnitude);
}

export function unitsToDecimal(value: string, scale: number): string {
  const units = BigInt(value);
  const sign = units < 0n ? "-" : "";
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${sign}${digits}`;
  const whole = digits.slice(0, -scale);
  const decimals = digits.slice(-scale);
  return `${sign}${whole}.${decimals}`;
}

export function parseTags(value: string): Array<{ key: string; value: string }> {
  if (!value.trim()) return [];
  return value.split(",").map((part) => {
    const separator = part.indexOf(":");
    if (separator <= 0 || separator === part.length - 1) throw new Error(`Invalid tag: ${part.trim()}`);
    return { key: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim() };
  });
}
