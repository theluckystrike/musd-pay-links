// Exact decimal <-> integer conversion for 18-decimal tokens. No floating point.

import { MUSD_DECIMALS } from "./chains.ts";

export const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_DECIMAL_INPUT = 96;

/**
 * Parse a human amount such as "12.5" into base units (12500000000000000000n).
 * Accepts only ASCII digits with at most one dot and at most 18 fraction digits.
 * Returns null for anything else (signs, commas, exponents, spaces, unicode digits).
 */
export function parseAmount(text: string, decimals = MUSD_DECIMALS): bigint | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_DECIMAL_INPUT) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return value <= MAX_UINT256 ? value : null;
}

/** Format base units as a plain decimal string without trailing zeros, e.g. 12.5 */
export function formatAmount(units: bigint, decimals = MUSD_DECIMALS): string {
  if (units < 0n) throw new RangeError("negative amount");
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Parse an EIP-681 number into an exact non-negative integer.
 * EIP-681 allows "2014000000000000000", "2.014e18" and "2014e15".
 * The result must be a whole number; "1.5e0" or a negative exponent that leaves a fraction is refused.
 * Returns null on any other syntax or when the value does not fit in uint256.
 */
export function parseEip681Number(text: string): bigint | null {
  if (text.length === 0 || text.length > 100) return null;
  const m = /^(\d+)(?:\.(\d+))?(?:[eE](\d{1,3}))?$/.exec(text);
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? "";
  const exp = m[3] === undefined ? 0 : Number(m[3]);
  if (exp > 78) return null; // 10^78 is already above uint256
  // The fraction digits not covered by the exponent must all be zero.
  if (frac.length > exp && !/^0*$/.test(frac.slice(exp))) return null;
  const used = frac.slice(0, exp);
  const value = BigInt(whole + used) * 10n ** BigInt(exp - used.length);
  return value <= MAX_UINT256 ? value : null;
}
