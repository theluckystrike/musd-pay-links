// Merchant invoices kept in Cloudflare KV, so an invoice survives a reload and works across devices.
//
// The Worker, not the browser, stamps each invoice with the current block and gives it a reference that is
// unique on its chain. A payment is matched to an invoice by that reference, after that block, for at least
// the amount. A transaction that paid one invoice is recorded and cannot pay a second one.
// The store holds only what is public on chain anyway (address, amount, reference, transaction hash).

import { CONFIRMATIONS_REQUIRED, type MezoChain } from "./chains.ts";
import { type Reason } from "./eip681.ts";
import { createPaymentLink } from "./merchant.ts";
import { findPayments, verifyPayment, type Fetch, type FindResult } from "./rpc.ts";

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface StoredInvoice {
  chainId: number;
  to: `0x${string}`;
  /** Decimal MUSD amount, as the merchant typed it after normalising, for example "12.5". */
  amount: string;
  /** Base units as a decimal string. */
  units: string;
  memo: string;
  fromBlock: number;
  createdAt: string;
  link: string;
  paid?: { txHash: string; block: number; from: string; amount: string; at: string };
  /** true when the recipient wallet signed the create request (src/auth.ts). Older invoices have no flag. */
  signed?: boolean;
}

/** Invoices and their index expire after 30 days. */
export const INVOICE_TTL_SECONDS = 30 * 24 * 3600;
/** Most invoices listed per merchant address. */
export const MAX_LISTED = 20;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** "INV-" and 8 random characters from a 32-character alphabet, 40 bits. */
export function newReference(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return "INV-" + [...random(8)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

const invKey = (chainId: number, memo: string) => `inv:${chainId}:${memo}`;
const idxKey = (chainId: number, to: string) => `idx:${chainId}:${to.toLowerCase()}`;
const txKey = (chainId: number, hash: string) => `tx:${chainId}:${hash.toLowerCase()}`;

export async function getInvoice(kv: KV, chainId: number, memo: string): Promise<StoredInvoice | null> {
  const raw = await kv.get(invKey(chainId, memo));
  return raw ? (JSON.parse(raw) as StoredInvoice) : null;
}

export type CreateInvoiceResult = { ok: true; invoice: StoredInvoice } | { ok: false; status: number; reasons: Reason[] };

/**
 * Create an invoice. `head` is the current block, read by the caller. A reference that is already
 * taken on this chain is refused with status 409, so one reference always means one invoice.
 */
export async function createInvoice(
  kv: KV,
  chain: MezoChain,
  input: { to: string; amount: string; memo?: string | null; signed?: boolean },
  head: number,
  now: Date = new Date(),
  random?: (n: number) => Uint8Array,
): Promise<CreateInvoiceResult> {
  const memo = input.memo?.trim() || newReference(random);
  const r = createPaymentLink({ chainId: chain.id, recipient: input.to, amount: input.amount, memo });
  if (!r.ok) return { ok: false, status: 422, reasons: r.reasons };
  if (await kv.get(invKey(chain.id, memo))) {
    return { ok: false, status: 409, reasons: [{ code: "reference_taken", message: `The reference ${memo} is already used by another invoice on ${chain.name}. Leave it empty to get a fresh one.` }] };
  }
  const invoice: StoredInvoice = {
    chainId: chain.id,
    to: r.payment.recipient,
    amount: r.payment.amountText,
    units: r.payment.amount.toString(),
    memo,
    fromBlock: head,
    createdAt: now.toISOString(),
    link: r.link,
    ...(input.signed ? { signed: true } : {}),
  };
  await kv.put(invKey(chain.id, memo), JSON.stringify(invoice), { expirationTtl: INVOICE_TTL_SECONDS });
  const idx = JSON.parse((await kv.get(idxKey(chain.id, invoice.to))) ?? "[]") as string[];
  await kv.put(idxKey(chain.id, invoice.to), JSON.stringify([memo, ...idx.filter((m) => m !== memo)].slice(0, MAX_LISTED)), { expirationTtl: INVOICE_TTL_SECONDS });
  return { ok: true, invoice };
}

export async function listInvoices(kv: KV, chainId: number, to: string): Promise<StoredInvoice[]> {
  const idx = JSON.parse((await kv.get(idxKey(chainId, to))) ?? "[]") as string[];
  const all = await Promise.all(idx.slice(0, MAX_LISTED).map((m) => getInvoice(kv, chainId, m)));
  return all.filter((x): x is StoredInvoice => x !== null);
}

export interface PaymentRef {
  txHash: string;
  block: number;
  from: string;
  amount: string;
}

export type InvoiceCheck =
  | { status: "paid"; invoice: StoredInvoice }
  /** A matching payment exists but is not deep enough yet. Nothing is recorded. The payer must not pay again. */
  | { status: "confirming"; invoice: StoredInvoice; payment: PaymentRef; confirmations: number; required: number; inbox?: Extract<FindResult, { status: "ok" }> }
  | { status: "open"; invoice: StoredInvoice; inbox: Extract<FindResult, { status: "ok" }> }
  | { status: "unavailable"; invoice: StoredInvoice; message: string };

/** Write the payment into the invoice and claim the transaction for it, so it cannot pay a second invoice. */
async function recordPaid(kv: KV, chainId: number, invoice: StoredInvoice, p: PaymentRef, now: Date): Promise<StoredInvoice> {
  const paid: StoredInvoice = { ...invoice, paid: { txHash: p.txHash, block: p.block, from: p.from, amount: p.amount, at: now.toISOString() } };
  await kv.put(txKey(chainId, p.txHash), invoice.memo, { expirationTtl: INVOICE_TTL_SECONDS });
  await kv.put(invKey(chainId, invoice.memo), JSON.stringify(paid), { expirationTtl: INVOICE_TTL_SECONDS });
  return paid;
}

/**
 * Look for the payment of an open invoice on chain and record it once found and at least
 * CONFIRMATIONS_REQUIRED blocks deep. A transaction that is already recorded for another invoice is
 * skipped, so it cannot pay two invoices. A matching payment that is not deep enough yet gives
 * "confirming", so a pay page can lock the Pay button before the invoice is recorded.
 */
export async function checkInvoice(kv: KV, chain: MezoChain, invoice: StoredInvoice, fetchImpl?: Fetch, now: Date = new Date()): Promise<InvoiceCheck> {
  if (invoice.paid) return { status: "paid", invoice };
  const inbox = await findPayments(chain, { recipient: invoice.to, fromBlock: invoice.fromBlock, memo: invoice.memo, amount: BigInt(invoice.units) }, fetchImpl);
  if (inbox.status !== "ok") return { status: "unavailable", invoice, message: inbox.message };
  const candidates = [...inbox.payments].reverse().filter((p) => p.matches === true); // oldest first
  for (const p of candidates) {
    const owner = await kv.get(txKey(chain.id, p.txHash));
    if (owner && owner !== invoice.memo) continue;
    const ref: PaymentRef = { txHash: p.txHash, block: p.block, from: p.from, amount: p.amount };
    const confirmations = inbox.head - p.block + 1;
    if (confirmations < CONFIRMATIONS_REQUIRED) return { status: "confirming", invoice, payment: ref, confirmations, required: CONFIRMATIONS_REQUIRED, inbox };
    return { status: "paid", invoice: await recordPaid(kv, chain.id, invoice, ref, now) };
  }
  return { status: "open", invoice, inbox };
}

export type ConfirmResult =
  | { status: "paid"; invoice: StoredInvoice }
  /** The invoice was paid by another transaction. A second payment is not hidden behind a "paid". */
  | { status: "already_paid"; invoice: StoredInvoice; message: string }
  | { status: "confirming"; invoice: StoredInvoice; payment: PaymentRef; confirmations: number; required: number }
  | { status: "tx_used" | "pending" | "not_found" | "failed" | "mismatch" | "unavailable"; invoice: StoredInvoice; message: string };

/**
 * Confirm an invoice by transaction hash, for payments the automatic search cannot see (an invoice older
 * than the search window, or a busy address). The transaction is checked against the stored invoice
 * (recipient, amount, reference, invoice block), never against values from the caller, so anyone may call it.
 */
export async function confirmInvoice(kv: KV, chain: MezoChain, invoice: StoredInvoice, txHash: string, fetchImpl?: Fetch, now: Date = new Date()): Promise<ConfirmResult> {
  if (invoice.paid?.txHash.toLowerCase() === txHash.toLowerCase()) return { status: "paid", invoice };
  const v = await verifyPayment(chain, { txHash, recipient: invoice.to, amount: BigInt(invoice.units), memo: invoice.memo, fromBlock: invoice.fromBlock }, fetchImpl);
  if (v.status !== "paid") return { status: v.status, invoice, message: v.message };
  // Only a transaction that really pays this invoice is called a second payment.
  if (invoice.paid) return { status: "already_paid", invoice, message: `Invoice ${invoice.memo} was already paid by ${invoice.paid.txHash}. This transaction is a second payment and does not count for it.` };
  const ref: PaymentRef = { txHash: txHash.toLowerCase(), block: v.block, from: v.from ?? "", amount: v.paid };
  if (v.confirmations < CONFIRMATIONS_REQUIRED) return { status: "confirming", invoice, payment: ref, confirmations: v.confirmations, required: CONFIRMATIONS_REQUIRED };
  const owner = await kv.get(txKey(chain.id, txHash));
  if (owner && owner !== invoice.memo) return { status: "tx_used", invoice, message: `This transaction already paid invoice ${owner}. One transaction pays one invoice.` };
  return { status: "paid", invoice: await recordPaid(kv, chain.id, invoice, ref, now) };
}
