// Merchant invoices kept in Cloudflare KV, so an invoice survives a reload and works across devices.
//
// The Worker, not the browser, stamps each invoice with the current block and gives it a reference that is
// unique on its chain. A payment is matched to an invoice by that reference, after that block, for at least
// the amount. A transaction that paid one invoice is recorded and cannot pay a second one.
// The store holds only what is public on chain anyway (address, amount, reference, transaction hash).

import { CONFIRMATIONS_REQUIRED, type MezoChain } from "./chains.ts";
import { type InvoiceClaims, type Paid } from "./claims.ts";
import { type Reason } from "./eip681.ts";
import { createPaymentLink } from "./merchant.ts";
import { findDuplicatePayments, findPayments, verifyPayment, type DuplicatePayment, type Fetch, type FindResult } from "./rpc.ts";

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
  paid?: { txHash: string; block: number; from: string; amount: string; at: string; referenceMissing?: true };
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

/**
 * Read an invoice. The Durable Object store is the source of truth. When it has no record (an invoice
 * made before the store existed), the KV copy is read and copied into the store, so old invoices stay
 * readable and are claimed atomically from then on.
 */
export async function getInvoice(kv: KV, chainId: number, memo: string, claims?: InvoiceClaims): Promise<StoredInvoice | null> {
  if (claims) {
    const stored = await claims.get(chainId, memo);
    if (stored) return stored;
  }
  const raw = await kv.get(invKey(chainId, memo));
  const invoice = raw ? (JSON.parse(raw) as StoredInvoice) : null;
  if (invoice && claims) return await claims.import(chainId, invoice);
  return invoice;
}

export type CreateInvoiceResult = { ok: true; invoice: StoredInvoice } | { ok: false; status: number; reasons: Reason[] };

const referenceTaken = (memo: string, chain: MezoChain): CreateInvoiceResult => ({
  ok: false,
  status: 409,
  reasons: [{ code: "reference_taken", message: `The reference ${memo} is already used by another invoice on ${chain.name}. Leave it empty to get a fresh one.` }],
});

/**
 * Create an invoice. `head` is the current block, read by the caller. A reference that is already
 * taken on this chain is refused with status 409, so one reference always means one invoice. When a
 * claims store is present, the check and the write are one atomic compare-and-set in a Durable Object.
 */
export async function createInvoice(
  kv: KV,
  chain: MezoChain,
  input: { to: string; amount: string; memo?: string | null; signed?: boolean },
  head: number,
  now: Date = new Date(),
  random?: (n: number) => Uint8Array,
  claims?: InvoiceClaims,
): Promise<CreateInvoiceResult> {
  const memo = input.memo?.trim() || newReference(random);
  const r = createPaymentLink({ chainId: chain.id, recipient: input.to, amount: input.amount, memo });
  if (!r.ok) return { ok: false, status: 422, reasons: r.reasons };
  // Also finds a KV-only invoice and copies it into the store before the claim, so an old reference is not taken twice.
  if (await getInvoice(kv, chain.id, memo, claims)) return referenceTaken(memo, chain);
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
  if (claims) {
    const claim = await claims.create(chain.id, invoice);
    if (claim.status === "taken") return referenceTaken(memo, chain);
  }
  await kv.put(invKey(chain.id, memo), JSON.stringify(invoice), { expirationTtl: INVOICE_TTL_SECONDS });
  const idx = JSON.parse((await kv.get(idxKey(chain.id, invoice.to))) ?? "[]") as string[];
  await kv.put(idxKey(chain.id, invoice.to), JSON.stringify([memo, ...idx.filter((m) => m !== memo)].slice(0, MAX_LISTED)), { expirationTtl: INVOICE_TTL_SECONDS });
  return { ok: true, invoice };
}

export async function listInvoices(kv: KV, chainId: number, to: string, claims?: InvoiceClaims): Promise<StoredInvoice[]> {
  const idx = JSON.parse((await kv.get(idxKey(chainId, to))) ?? "[]") as string[];
  const all = await Promise.all(idx.slice(0, MAX_LISTED).map((m) => getInvoice(kv, chainId, m, claims)));
  return all.filter((x): x is StoredInvoice => x !== null);
}

export interface PaymentRef {
  txHash: string;
  block: number;
  from: string;
  amount: string;
  /** True when the merchant accepted a payment whose wallet dropped the reference bytes. */
  referenceMissing?: true;
}

export type InvoiceCheck =
  | {
      status: "paid";
      invoice: StoredInvoice;
      /** Further transfers with the same reference, already on chain. Each one is a refund due. */
      duplicates?: DuplicatePayment[];
      /** True when the duplicate scan covered every block from the recorded payment. */
      duplicatesChecked?: boolean;
    }
  /** A matching payment exists but is not deep enough yet. Nothing is recorded. The payer must not pay again. */
  | { status: "confirming"; invoice: StoredInvoice; payment: PaymentRef; confirmations: number; required: number; inbox?: Extract<FindResult, { status: "ok" }> }
  | { status: "open"; invoice: StoredInvoice; inbox: Extract<FindResult, { status: "ok" }> }
  | { status: "unavailable"; invoice: StoredInvoice; message: string };

type RecordResult = { status: "paid"; invoice: StoredInvoice } | { status: "already_paid" | "tx_used"; invoice: StoredInvoice; owner?: string };

/**
 * Write the payment into the invoice and claim the transaction for it, so it cannot pay a second
 * invoice. With a claims store the two writes are one atomic transaction. KV is updated as a cache.
 */
async function recordPaid(kv: KV, chainId: number, invoice: StoredInvoice, p: PaymentRef, now: Date, claims?: InvoiceClaims): Promise<RecordResult> {
  const paid: Paid = { txHash: p.txHash, block: p.block, from: p.from, amount: p.amount, at: now.toISOString(), ...(p.referenceMissing ? { referenceMissing: true } : {}) };
  let result: RecordResult;
  if (claims) {
    // A paid invoice that is still only in KV keeps its transaction claimed during the migration.
    const legacyOwner = await kv.get(txKey(chainId, p.txHash));
    if (legacyOwner && legacyOwner !== invoice.memo) return { status: "tx_used", invoice, owner: legacyOwner };
    const claim = await claims.pay(chainId, invoice, paid);
    if (claim.status === "tx_used") return { status: "tx_used", invoice, owner: claim.owner };
    result = { status: claim.status, invoice: claim.invoice };
  } else {
    const next: StoredInvoice = { ...invoice, paid };
    result = { status: "paid", invoice: next };
  }
  const stored = result.invoice;
  if (stored.paid) {
    await kv.put(txKey(chainId, stored.paid.txHash), stored.memo, { expirationTtl: INVOICE_TTL_SECONDS });
    await kv.put(invKey(chainId, stored.memo), JSON.stringify(stored), { expirationTtl: INVOICE_TTL_SECONDS });
  }
  return result;
}

/** A paid invoice plus the later payments with the same reference, so a merchant sees a refund due. */
async function paidWithDuplicates(chain: MezoChain, invoice: StoredInvoice, fetchImpl?: Fetch): Promise<Extract<InvoiceCheck, { status: "paid" }>> {
  if (!invoice.paid) return { status: "paid", invoice };
  const scan = await findDuplicatePayments(
    chain,
    { recipient: invoice.to, memo: invoice.memo, paidBlock: invoice.paid.block, paidTxHash: invoice.paid.txHash },
    fetchImpl,
  );
  return { status: "paid", invoice, duplicates: scan.duplicates, duplicatesChecked: scan.checked };
}

/**
 * Look for the payment of an open invoice on chain and record it once found and at least
 * CONFIRMATIONS_REQUIRED blocks deep. A transaction that is already recorded for another invoice is
 * skipped, so it cannot pay two invoices. A matching payment that is not deep enough yet gives
 * "confirming", so a pay page can lock the Pay button before the invoice is recorded.
 */
export async function checkInvoice(kv: KV, chain: MezoChain, invoice: StoredInvoice, fetchImpl?: Fetch, now: Date = new Date(), claims?: InvoiceClaims): Promise<InvoiceCheck> {
  if (invoice.paid) return await paidWithDuplicates(chain, invoice, fetchImpl);
  const inbox = await findPayments(chain, { recipient: invoice.to, fromBlock: invoice.fromBlock, memo: invoice.memo, amount: BigInt(invoice.units) }, fetchImpl);
  if (inbox.status !== "ok") return { status: "unavailable", invoice, message: inbox.message };
  const candidates = [...inbox.payments].reverse().filter((p) => p.matches === true); // oldest first
  for (const p of candidates) {
    const owner = claims ? ((await claims.owner(chain.id, p.txHash)) ?? (await kv.get(txKey(chain.id, p.txHash)))) : await kv.get(txKey(chain.id, p.txHash));
    if (owner && owner !== invoice.memo) continue;
    const ref: PaymentRef = { txHash: p.txHash, block: p.block, from: p.from, amount: p.amount };
    const confirmations = inbox.head - p.block + 1;
    if (confirmations < CONFIRMATIONS_REQUIRED) return { status: "confirming", invoice, payment: ref, confirmations, required: CONFIRMATIONS_REQUIRED, inbox };
    const recorded = await recordPaid(kv, chain.id, invoice, ref, now, claims);
    if (recorded.status === "tx_used") continue; // another invoice claimed it between the read and the write
    return await paidWithDuplicates(chain, recorded.invoice, fetchImpl);
  }
  return { status: "open", invoice, inbox };
}

export type ConfirmResult =
  | { status: "paid"; invoice: StoredInvoice }
  /** The invoice was paid by another transaction. A second payment is not hidden behind a "paid". */
  | { status: "already_paid"; invoice: StoredInvoice; message: string }
  | { status: "confirming"; invoice: StoredInvoice; payment: PaymentRef; confirmations: number; required: number }
  | { status: "tx_used" | "pending" | "not_found" | "failed" | "mismatch" | "unavailable" | "not_possible"; invoice: StoredInvoice; message: string };

/**
 * Confirm an invoice by transaction hash, for payments the automatic search cannot see (an invoice older
 * than the search window, or a busy address). The transaction is checked against the stored invoice
 * (recipient, amount, reference, invoice block), never against values from the caller, so anyone may call it.
 */
export async function confirmInvoice(kv: KV, chain: MezoChain, invoice: StoredInvoice, txHash: string, fetchImpl?: Fetch, now: Date = new Date(), claims?: InvoiceClaims): Promise<ConfirmResult> {
  if (invoice.paid?.txHash.toLowerCase() === txHash.toLowerCase()) return { status: "paid", invoice };
  const v = await verifyPayment(chain, { txHash, recipient: invoice.to, amount: BigInt(invoice.units), memo: invoice.memo, fromBlock: invoice.fromBlock }, fetchImpl);
  if (v.status === "paid_no_memo") return { status: "not_possible", invoice, message: "This transaction has no reference. Use the accept action instead." };
  if (v.status !== "paid") return { status: v.status, invoice, message: v.message };
  // Only a transaction that really pays this invoice is called a second payment.
  if (invoice.paid) return { status: "already_paid", invoice, message: `Invoice ${invoice.memo} was already paid by ${invoice.paid.txHash}. This transaction is a second payment and does not count for it.` };
  const ref: PaymentRef = { txHash: txHash.toLowerCase(), block: v.block, from: v.from ?? "", amount: v.paid };
  // The owner check comes before the depth check, so a shallow transaction that already paid another
  // invoice is reported as tx_used on this invoice, not as confirming.
  const owner = claims ? ((await claims.owner(chain.id, txHash)) ?? (await kv.get(txKey(chain.id, txHash)))) : await kv.get(txKey(chain.id, txHash));
  if (owner && owner !== invoice.memo) return { status: "tx_used", invoice, message: `This transaction already paid invoice ${owner}. One transaction pays one invoice.` };
  if (v.confirmations < CONFIRMATIONS_REQUIRED) return { status: "confirming", invoice, payment: ref, confirmations: v.confirmations, required: CONFIRMATIONS_REQUIRED };
  const recorded = await recordPaid(kv, chain.id, invoice, ref, now, claims);
  if (recorded.status === "tx_used") return { status: "tx_used", invoice, message: `This transaction already paid invoice ${recorded.owner ?? "another invoice"}. One transaction pays one invoice.` };
  if (recorded.status === "already_paid") return { status: "already_paid", invoice: recorded.invoice, message: `Invoice ${invoice.memo} was already paid by another transaction. This transaction is a second payment and does not count for it.` };
  return { status: "paid", invoice: recorded.invoice };
}

export type AcceptResult =
  | { status: "paid"; invoice: StoredInvoice }
  | { status: "confirming"; invoice: StoredInvoice; payment: PaymentRef; confirmations: number; required: number }
  | { status: "already_paid"; invoice: StoredInvoice; message: string }
  | { status: "tx_used" | "pending" | "not_found" | "failed" | "mismatch" | "unavailable" | "not_possible"; invoice: StoredInvoice; message: string };

/**
 * Accept a payment that arrived without the reference. The merchant signs the request with the wallet of
 * the invoice recipient (src/auth.ts), so only the recipient can accept a possible match. The transaction
 * must pay the invoice recipient, from the invoice block or later, with the exact invoice amount. The
 * payment is then recorded with referenceMissing: true and claims its hash like any other payment.
 */
export async function acceptPossibleInvoice(
  kv: KV,
  chain: MezoChain,
  invoice: StoredInvoice,
  txHash: string,
  fetchImpl?: Fetch,
  now: Date = new Date(),
  claims?: InvoiceClaims,
): Promise<AcceptResult> {
  if (invoice.paid?.txHash.toLowerCase() === txHash.toLowerCase()) return { status: "paid", invoice };
  const v = await verifyPayment(chain, { txHash, recipient: invoice.to, amount: BigInt(invoice.units), memo: invoice.memo, fromBlock: invoice.fromBlock }, fetchImpl);
  if (v.status === "paid") return { status: "not_possible", invoice, message: "This transaction carries the reference. Use the confirm action instead." };
  if (v.status !== "paid_no_memo") return { status: v.status, invoice, message: v.message };
  if (v.paid !== invoice.amount) {
    return { status: "mismatch", invoice, message: `This transaction sent ${v.paid} MUSD, not the invoice amount ${invoice.amount} MUSD. A possible match must be the exact amount.` };
  }
  if (invoice.paid) return { status: "already_paid", invoice, message: `Invoice ${invoice.memo} was already paid by ${invoice.paid.txHash}. This transaction is a second payment and does not count for it.` };
  const ref: PaymentRef = { txHash: txHash.toLowerCase(), block: v.block, from: v.from ?? "", amount: v.paid, referenceMissing: true };
  const owner = claims ? ((await claims.owner(chain.id, txHash)) ?? (await kv.get(txKey(chain.id, txHash)))) : await kv.get(txKey(chain.id, txHash));
  if (owner && owner !== invoice.memo) return { status: "tx_used", invoice, message: `This transaction already paid invoice ${owner}. One transaction pays one invoice.` };
  if (v.confirmations < CONFIRMATIONS_REQUIRED) return { status: "confirming", invoice, payment: ref, confirmations: v.confirmations, required: CONFIRMATIONS_REQUIRED };
  const recorded = await recordPaid(kv, chain.id, invoice, ref, now, claims);
  if (recorded.status === "tx_used") return { status: "tx_used", invoice, message: `This transaction already paid invoice ${recorded.owner ?? "another invoice"}. One transaction pays one invoice.` };
  if (recorded.status === "already_paid") return { status: "already_paid", invoice: recorded.invoice, message: `Invoice ${invoice.memo} was already paid by another transaction. This transaction is a second payment and does not count for it.` };
  return { status: "paid", invoice: recorded.invoice };
}
