// Merchant invoices kept in Cloudflare KV, so an invoice survives a reload and works across devices.
//
// The Worker, not the browser, stamps each invoice with the current block and gives it a reference that is
// unique on its chain. A payment is matched to an invoice by that reference, after that block, for at least
// the amount. A transaction that paid one invoice is recorded and cannot pay a second one.
// The store holds only what is public on chain anyway (address, amount, reference, transaction hash).

import { type MezoChain } from "./chains.ts";
import { type Reason } from "./eip681.ts";
import { createPaymentLink } from "./merchant.ts";
import { findPayments, type Fetch, type FindResult } from "./rpc.ts";

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
  input: { to: string; amount: string; memo?: string | null },
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

export type InvoiceCheck =
  | { status: "paid"; invoice: StoredInvoice }
  | { status: "open"; invoice: StoredInvoice; inbox: Extract<FindResult, { status: "ok" }> }
  | { status: "unavailable"; invoice: StoredInvoice; message: string };

/**
 * Look for the payment of an open invoice on chain and record it once found. A transaction that is already
 * recorded for another invoice is skipped, so it cannot pay two invoices.
 */
export async function checkInvoice(kv: KV, chain: MezoChain, invoice: StoredInvoice, fetchImpl?: Fetch, now: Date = new Date()): Promise<InvoiceCheck> {
  if (invoice.paid) return { status: "paid", invoice };
  const inbox = await findPayments(chain, { recipient: invoice.to, fromBlock: invoice.fromBlock, memo: invoice.memo, amount: BigInt(invoice.units) }, fetchImpl);
  if (inbox.status !== "ok") return { status: "unavailable", invoice, message: inbox.message };
  const candidates = [...inbox.payments].reverse().filter((p) => p.matches); // oldest first
  for (const p of candidates) {
    const owner = await kv.get(txKey(chain.id, p.txHash));
    if (owner && owner !== invoice.memo) continue;
    const paid: StoredInvoice = { ...invoice, paid: { txHash: p.txHash, block: p.block, from: p.from, amount: p.amount, at: now.toISOString() } };
    await kv.put(txKey(chain.id, p.txHash), invoice.memo, { expirationTtl: INVOICE_TTL_SECONDS });
    await kv.put(invKey(chain.id, invoice.memo), JSON.stringify(paid), { expirationTtl: INVOICE_TTL_SECONDS });
    return { status: "paid", invoice: paid };
  }
  return { status: "open", invoice, inbox };
}
