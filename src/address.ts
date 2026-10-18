import { getAddress, isAddress } from "viem";

export type AddressCheck =
  | { ok: true; address: `0x${string}`; checksummed: boolean }
  | { ok: false; code: "bad_address" | "bad_checksum" | "no_checksum"; message: string };

/**
 * Validate a 20-byte hex address.
 * Mixed case is an EIP-55 checksum and must match. All-lowercase or all-uppercase carries no checksum;
 * it is refused when requireChecksum is true, because a typo in such an address cannot be detected.
 */
export function checkAddress(value: string, requireChecksum: boolean): AddressCheck {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return { ok: false, code: "bad_address", message: "Not a 20-byte hex address (expected 0x followed by 40 hex characters)." };
  }
  const hex = value.slice(2);
  const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex);
  if (mixed) {
    if (!isAddress(value, { strict: true })) {
      return {
        ok: false,
        code: "bad_checksum",
        message: "The EIP-55 checksum does not match. The address was mistyped or altered.",
      };
    }
    return { ok: true, address: getAddress(value), checksummed: true };
  }
  const canonical = getAddress(value.toLowerCase());
  // Rare but real: the correct checksum can itself be all one case (an EIP-55 test vector is all caps).
  if (canonical === value) return { ok: true, address: canonical, checksummed: true };
  if (requireChecksum && /[a-fA-F]/.test(hex)) {
    return {
      ok: false,
      code: "no_checksum",
      message: "The address has no EIP-55 checksum (all one case), so a typo cannot be detected. Ask for a checksummed link.",
    };
  }
  return { ok: true, address: canonical, checksummed: false };
}

/** Lookalike test: same first 4 and last 4 hex characters, different address. */
export function looksLike(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x !== y && x.slice(2, 6) === y.slice(2, 6) && x.slice(-4) === y.slice(-4);
}
