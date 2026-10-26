// Payer-only view for a pay page (/?invoice=...). Pure text so the browser code and the tests share it.

import { chainById } from "./chains.ts";
import type { PayLock } from "./paystate.ts";

/**
 * Elements that belong to the merchant. A pay page hides all of them, so the payer sees only the
 * invoice summary, the status, the QR code and the Pay action.
 */
export const MERCHANT_ELEMENT_IDS = ["steps", "live", "m-panel", "p-panel", "v-panel", "b-panel"] as const;

export interface PayerInvoice {
  chainId: number;
  to: string;
  amount: string;
  memo: string;
  link: string;
}

export interface PayerSummary {
  amount: string;
  recipient: string;
  token: string;
  network: string;
  reference: string;
  qrLabel: string;
}

/**
 * The payer limit on an invoice page is the invoice amount, not a hidden merchant default. The payer
 * sees the amount in the summary and confirms it with Pay. The token and recipient checks still run.
 */
export function payerMaxAmount(inv: Pick<PayerInvoice, "amount">): string {
  return inv.amount;
}

/** The fields of the payer summary. The token is the MUSD contract for the invoice chain. */
export function payerSummary(inv: PayerInvoice): PayerSummary {
  const chain = chainById(inv.chainId);
  return {
    amount: `${inv.amount} MUSD`,
    recipient: inv.to,
    token: chain?.musd ?? "",
    network: chain ? `${chain.name} (${chain.id})` : String(inv.chainId),
    reference: inv.memo,
    qrLabel: `QR code for invoice ${inv.memo}`,
  };
}

export interface PayerStatusInput {
  lock: PayLock;
  confirmations?: number;
  required?: number;
  head?: number;
  count?: number;
}

/**
 * One plain status line for the payer. The confirmation depth is always shown while the payment is
 * not final, so "confirming" never looks like "paid".
 */
export function payerStatus(a: PayerStatusInput): string {
  switch (a.lock) {
    case "paid":
      return "Paid. Do not pay it again.";
    case "confirming":
      return `Confirming. ${a.confirmations ?? 0} of ${a.required ?? 0} confirmations. Do not pay it again.`;
    case "not_found":
      return "This invoice was not found.";
    case "cannot_prove":
      return "This page cannot prove that the invoice is unpaid. Ask the merchant for a new invoice.";
    case "partial":
      return `${a.count ?? 0} payment(s) with this reference are smaller than the invoice. Ask the merchant how much is still open.`;
    case "possible":
      return `${a.count ?? 0} payment(s) of exactly this amount arrived without the reference. If one of them is yours, do not pay again.`;
    case "unavailable":
      return "The chain could not be checked, so Pay is locked.";
    default:
      return `Open. The chain shows no payment for this invoice up to block ${(a.head ?? 0).toLocaleString("en-US")}.`;
  }
}
