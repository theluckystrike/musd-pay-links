// Merchant side: create a MUSD payment link. The link is parsed back through the payer guard before it is returned,
// so a merchant can never hand out a link that the guard would refuse.

import { checkAddress } from "./address.ts";
import { parseAmount } from "./amount.ts";
import { chainById } from "./chains.ts";
import { MEMO_PATTERN, type Reason } from "./eip681.ts";
import { checkPaymentLink, type CheckedPayment } from "./guard.ts";

export interface LinkInput {
  chainId: number;
  recipient: string;
  /** Decimal MUSD amount, for example "12.50". */
  amount: string;
  memo?: string;
}

export type CreateResult = { ok: true; link: string; payment: CheckedPayment } | { ok: false; reasons: Reason[] };

export function createPaymentLink(input: LinkInput): CreateResult {
  const reasons: Reason[] = [];
  const chain = chainById(input.chainId);
  if (!chain) reasons.push({ code: "wrong_chain", message: `Chain ${input.chainId} is not Mezo (31611 or 31612).` });

  const recipient = checkAddress(String(input.recipient ?? "").trim(), false);
  if (!recipient.ok) reasons.push({ code: `recipient_${recipient.code}`, message: `Recipient: ${recipient.message}` });

  const units = parseAmount(String(input.amount ?? "").trim());
  if (units === null) {
    reasons.push({ code: "bad_amount", message: "Amount must be digits with an optional dot and up to 18 decimals, for example 12.50" });
  } else if (units === 0n) {
    reasons.push({ code: "zero_amount", message: "Amount must be greater than zero." });
  }

  const memo = input.memo?.trim() ? input.memo.trim() : undefined;
  if (memo !== undefined && !MEMO_PATTERN.test(memo)) {
    reasons.push({ code: "bad_memo", message: "Memo must be 1 to 32 characters from A-Z a-z 0-9 . _ : # / -" });
  }
  if (reasons.length > 0 || !chain || !recipient.ok || units === null) return { ok: false, reasons };

  let link = `ethereum:${chain.musd}@${chain.id}/transfer?address=${recipient.address}&uint256=${units.toString()}`;
  if (memo !== undefined) link += `&memo=${memo}`;

  // Round trip: the payer guard must accept exactly what we produced.
  const back = checkPaymentLink(link, { maxAmount: units, allowedChains: [chain.id] });
  if (!back.ok) return { ok: false, reasons: back.reasons };
  return { ok: true, link, payment: back.payment };
}
