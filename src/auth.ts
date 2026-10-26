// Merchant authentication for invoice creation. The merchant signs a canonical message with the wallet
// that receives the payment (EIP-191 personal_sign). The Worker checks that the signer is the recipient,
// so nobody can create invoices for an address they do not control. No account, no API key, no stored secret.

import { verifyMessage } from "viem";

/** A signed create request is accepted for this many seconds before or after its timestamp. */
export const SIGNATURE_MAX_AGE_SECONDS = 600;

export interface InvoiceClaim {
  chainId: number;
  /** Recipient, EIP-55 checksummed, as the guard normalises it. */
  to: `0x${string}`;
  /** Decimal MUSD amount, as the guard normalises it ("12.50" becomes "12.5"). */
  amount: string;
  memo: string;
  /** Unix time in seconds. */
  timestamp: number;
}

/** The exact text the merchant signs. Both sides build it from normalised values, so "12.50" and "12.5" sign the same text. */
export function invoiceMessage(c: InvoiceClaim): string {
  return [
    "MUSD Pay Links, create invoice",
    `chain ${c.chainId}`,
    `to ${c.to}`,
    `amount ${c.amount} MUSD`,
    `reference ${c.memo}`,
    `time ${c.timestamp}`,
  ].join("\n");
}

export type AuthCode = "signature_required" | "bad_timestamp" | "signature_expired" | "bad_signature";
export type AuthResult = { ok: true } | { ok: false; code: AuthCode; message: string };

export interface AcceptClaim {
  chainId: number;
  /** Recipient of the invoice, EIP-55 checksummed. It is the signer and the only address that may accept. */
  to: `0x${string}`;
  memo: string;
  /** Transaction hash the merchant accepts as the possible payment. */
  txHash: string;
  /** Unix time in seconds. */
  timestamp: number;
}

/**
 * The exact text the merchant signs to accept a payment that arrived without the reference.
 * The signature covers the reference and the transaction hash, so one signature accepts one payment.
 */
export function acceptMessage(c: AcceptClaim): string {
  return [
    "MUSD Pay Links, accept possible payment",
    `chain ${c.chainId}`,
    `to ${c.to}`,
    `reference ${c.memo}`,
    `tx ${c.txHash.toLowerCase()}`,
    `time ${c.timestamp}`,
  ].join("\n");
}

/**
 * Check a signed accept request. It uses the same rules as a signed create: a plain wallet, a fresh
 * timestamp and a 65-byte personal_sign signature by the invoice recipient. A smart-contract wallet is
 * refused. A replay is safe because a transaction hash can pay only one invoice.
 */
export async function checkAcceptSignature(
  claim: Omit<AcceptClaim, "timestamp"> & { timestamp: unknown },
  signature: unknown,
  nowMs: number = Date.now(),
): Promise<AuthResult> {
  if (signature === undefined || signature === null || signature === "") {
    return { ok: false, code: "signature_required", message: "Sign the accept request with the wallet of the invoice recipient. Send timestamp and signature with the request." };
  }
  const ts = claim.timestamp;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) {
    return { ok: false, code: "bad_timestamp", message: "timestamp must be the Unix time in whole seconds." };
  }
  if (Math.abs(nowMs / 1000 - ts) > SIGNATURE_MAX_AGE_SECONDS) {
    return { ok: false, code: "signature_expired", message: `The signed time is more than ${SIGNATURE_MAX_AGE_SECONDS / 60} minutes away from the time of the server. Sign again.` };
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { ok: false, code: "bad_signature", message: "signature must be a 65-byte hex signature from personal_sign." };
  }
  let valid = false;
  try {
    valid = await verifyMessage({ address: claim.to, message: acceptMessage({ ...claim, timestamp: ts }), signature: signature as `0x${string}` });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, code: "bad_signature", message: `The signature is not from ${claim.to}, or it signs another reference or transaction. Only the wallet that receives the payment can accept a possible match.` };
  }
  return { ok: true };
}

/**
 * Check a signed create request. A replay of the same request is refused by the store, because the
 * reference is part of the signed text and a reference is used only once on a chain (409 reference_taken).
 * Only plain wallets (EOA) are supported. A smart-contract wallet signature (EIP-1271) is refused.
 */
export async function checkInvoiceSignature(
  claim: Omit<InvoiceClaim, "timestamp"> & { timestamp: unknown },
  signature: unknown,
  nowMs: number = Date.now(),
): Promise<AuthResult> {
  if (signature === undefined || signature === null || signature === "") {
    return { ok: false, code: "signature_required", message: "Sign the invoice with the wallet of the recipient. Send timestamp and signature with the request." };
  }
  const ts = claim.timestamp;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) {
    return { ok: false, code: "bad_timestamp", message: "timestamp must be the Unix time in whole seconds." };
  }
  if (Math.abs(nowMs / 1000 - ts) > SIGNATURE_MAX_AGE_SECONDS) {
    return { ok: false, code: "signature_expired", message: `The signed time is more than ${SIGNATURE_MAX_AGE_SECONDS / 60} minutes away from the time of the server. Sign again.` };
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { ok: false, code: "bad_signature", message: "signature must be a 65-byte hex signature from personal_sign." };
  }
  let valid = false;
  try {
    valid = await verifyMessage({ address: claim.to, message: invoiceMessage({ ...claim, timestamp: ts }), signature: signature as `0x${string}` });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, code: "bad_signature", message: `The signature is not from ${claim.to}, or it signs other invoice details. Only the wallet that receives the payment can create its invoices.` };
  }
  return { ok: true };
}
