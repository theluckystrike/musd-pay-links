// Pay page decision: may the payer press Pay for this invoice? Shared by the web client and the tests.

export type PayLock = "not_found" | "paid" | "confirming" | "cannot_prove" | "partial" | "possible" | "unavailable" | null;

/** The part of a GET /api/invoices/:memo answer that the decision reads. */
export interface InvoiceStateAnswer {
  status?: string;
  invoice?: unknown;
  /** HTTP status of the answer. Only a 404 means that the invoice does not exist. A 429 or a 503 does not. */
  http?: number;
  /** false when the answer came from the store only (check=0). Only a chain check can unlock Pay. */
  checked?: boolean;
  clamped?: boolean;
  truncated?: boolean;
  /** Payments of exactly the amount that carry no reference. One may be the payer's own, from a wallet that dropped it. */
  possible?: unknown[];
  /** Payments with the reference but less than the amount. */
  partial?: unknown[];
}

/**
 * Pay stays locked unless a chain check says the invoice is open and the search covered every block
 * since the invoice was created. A payment that is on chain but not deep enough locks Pay too.
 * An answer the page does not know locks Pay. Locked is the safe default, because a second payment is lost money.
 */
export function payPageLock(a: InvoiceStateAnswer): PayLock {
  if (!a.invoice) return a.http === 404 ? "not_found" : "unavailable";
  if (a.status === "paid") return "paid";
  if (a.status === "confirming") return "confirming";
  if (a.status !== "open" || a.checked !== true) return "unavailable";
  if (a.clamped || a.truncated) return "cannot_prove";
  // The payer must say that none of them is theirs before Pay unlocks.
  if (a.partial && a.partial.length > 0) return "partial";
  if (a.possible && a.possible.length > 0) return "possible";
  return null;
}
