// Cloudflare Worker: serves the demo page (static assets) and a small JSON API.
// It holds no keys and signs nothing. Invoices are kept in KV. Creating one needs a signature by the
// recipient wallet (src/auth.ts). Every chain read goes to a public Mezo RPC.

import { checkAddress } from "./address.ts";
import { checkAcceptSignature, checkInvoiceSignature } from "./auth.ts";
import { parseAmount } from "./amount.ts";
import { chainById, CONFIRMATIONS_REQUIRED, MEZO_CHAINS, type MezoChain } from "./chains.ts";
import { checkPaymentLink } from "./guard.ts";
import { createPaymentLink } from "./merchant.ts";
import { qrSvg } from "./qr.ts";
import { quoteBorrow, readBorrowTerms, type BorrowTerms } from "./borrow.ts";
import { acceptPossibleInvoice, checkInvoice, confirmInvoice, createInvoice, getInvoice, listInvoices, type KV, type StoredInvoice } from "./invoices.ts";
import { claimsFor, type DONamespace } from "./claims.ts";
export { InvoiceStoreDO } from "./claims.ts";
import { MEMO_PATTERN } from "./eip681.ts";
import { findPayments, headBlock, readBalance, readTokenInfo, rpc, verifyPayment, type TokenInfo } from "./rpc.ts";

interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/**
 * One Durable Object per client key counts calls in a fixed window. A Durable Object is a single instance,
 * so the count is exact across all Worker isolates. The Cloudflare rate limiting binding did not refuse
 * 40 calls in 10 seconds in a live test on 25 October 2026, so this is the limit that is enforced.
 */
export class ClientLimiter {
  private start = 0;
  private count = 0;
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const limit = Number(u.searchParams.get("limit") ?? RATE_LIMIT.limit);
    const period = Number(u.searchParams.get("period") ?? RATE_LIMIT.periodSeconds) * 1000;
    const now = Date.now();
    if (now - this.start >= period) {
      this.start = now;
      this.count = 0;
    }
    this.count++;
    return new Response(this.count <= limit ? "ok" : "over", { status: this.count <= limit ? 200 : 429 });
  }
}

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  /** Cloudflare Workers rate limiting binding, see wrangler.toml. Optional so tests and dev run without it. */
  LIMITER?: RateLimiter;
  /** Invoice store, see src/invoices.ts. Optional so the read-only routes work without it. */
  INVOICES?: KV;
  /** Exact per-client limiter, see ClientLimiter. Optional so tests and dev run without it. */
  CLIENT_LIMITER?: DONamespace;
  /** Atomic invoice claims, see InvoiceStoreDO. Optional so tests and dev run without it. */
  INVOICE_STORE?: DONamespace;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/**
 * Routes that only compute (no RPC call) may be called from any web page. Routes that read the chain
 * are same-origin only for browsers and are rate limited per client IP, so the Worker is not an open
 * RPC proxy. Server-side agents can call every route.
 */
export const PURE_ROUTES = new Set(["/api/link", "/api/check"]);
/** Creating invoices writes to KV, so it has its own, lower limit per client. */
export const CREATE_LIMIT = { limit: 10, periodSeconds: 60 };
export const RATE_LIMIT = { limit: 30, periodSeconds: 60 };
/** The only text a caller sees when a route throws. The exception detail is logged, not returned. */
export const PUBLIC_ERROR_MESSAGE = "The network did not answer. Try again in a moment.";

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return new Response(text + "\n", { status, headers: { ...JSON_HEADERS, ...extra } });
}

/** In-memory fallback limiter, per Worker isolate, used only when the LIMITER binding is missing. */
const windows = new Map<string, { start: number; count: number }>();
export function localLimit(key: string, now = Date.now(), rule: { limit: number; periodSeconds: number } = RATE_LIMIT): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= rule.periodSeconds * 1000) {
    if (windows.size > 5_000) windows.clear();
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  w.count++;
  return w.count <= rule.limit;
}

/** HTTP status for a verify or invoice answer, so an agent can branch on the code alone. */
export function statusCode(status: string): number {
  switch (status) {
    case "paid":
    case "paid_no_memo":
    case "pending":
    case "open":
    case "confirming":
    case "ok":
      return 200;
    case "not_found":
      return 404;
    case "tx_used":
    case "already_paid":
      return 409;
    case "unavailable":
      return 503;
    default:
      return 422; // mismatch, failed
  }
}

function publicInvoice(inv: StoredInvoice, origin: string) {
  const c = chainById(inv.chainId)!;
  return {
    ...inv,
    /** false for invoices made before signed creation (26 October 2026). They stay readable. */
    signed: inv.signed === true,
    payUrl: `${origin}/?invoice=${encodeURIComponent(inv.memo)}&chain=${inv.chainId}`,
    explorer: inv.paid ? `${c.explorer}/tx/${inv.paid.txHash}` : null,
  };
}

function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function chainParam(url: URL): MezoChain | null {
  const raw = url.searchParams.get("chain") ?? "31611";
  return /^\d{1,10}$/.test(raw) ? (chainById(Number(raw)) ?? null) : null;
}

const tokenCache = new Map<number, { at: number; info: TokenInfo }>();
const termsCache = new Map<number, { at: number; terms: BorrowTerms }>();

async function terms(chain: MezoChain): Promise<BorrowTerms> {
  const hit = termsCache.get(chain.id);
  if (hit && Date.now() - hit.at < 30_000) return hit.terms;
  const t = await readBorrowTerms(chain);
  termsCache.set(chain.id, { at: Date.now(), terms: t });
  return t;
}

function blockParam(raw: string | null): number | null | undefined {
  if (raw === null || raw === "") return null;
  return /^\d{1,12}$/.test(raw) ? Number(raw) : undefined;
}

async function token(chain: MezoChain): Promise<TokenInfo> {
  const hit = tokenCache.get(chain.id);
  if (hit && Date.now() - hit.at < 30_000) return hit.info;
  const info = await readTokenInfo(chain);
  tokenCache.set(chain.id, { at: Date.now(), info });
  return info;
}

async function invoices(req: Request, url: URL, env: Env): Promise<Response> {
  const kv = env.INVOICES;
  if (!kv) return bad("The invoice store is not configured.", 503);
  const p = url.searchParams;
  const rest = url.pathname.slice("/api/invoices".length);
  if (req.method === "POST" && rest === "") {
    let body: { chain?: unknown; to?: unknown; amount?: unknown; memo?: unknown; timestamp?: unknown; signature?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return bad("Send a JSON body, for example {\"chain\":31611,\"to\":\"0x...\",\"amount\":\"12.5\",\"memo\":\"INV-1\",\"timestamp\":1793000000,\"signature\":\"0x...\"}");
    }
    if (body === null || typeof body !== "object") return bad("Send a JSON object.");
    const chain = chainById(Number(body.chain ?? 31611));
    if (!chain) return bad("chain must be 31611 or 31612");
    const claims = claimsFor(env.INVOICE_STORE, chain.id);
    const memo = typeof body.memo === "string" ? body.memo.trim() : "";
    const pre = createPaymentLink({ chainId: chain.id, recipient: String(body.to ?? ""), amount: String(body.amount ?? ""), memo: memo || undefined });
    if (!pre.ok) return json({ ok: false, reasons: pre.reasons }, 422);
    if (!memo) return json({ ok: false, reasons: [{ code: "memo_required", message: "A signed invoice needs its reference in the request, because the signature covers it." }] }, 400);
    const auth = await checkInvoiceSignature({ chainId: chain.id, to: pre.payment.recipient, amount: pre.payment.amountText, memo, timestamp: body.timestamp }, body.signature);
    if (!auth.ok) return json({ ok: false, reasons: [{ code: auth.code, message: auth.message }] }, 401);
    const head = await headBlock(chain);
    const r = await createInvoice(kv, chain, { to: pre.payment.recipient, amount: pre.payment.amountText, memo, signed: true }, head, new Date(), undefined, claims);
    if (!r.ok) return json({ ok: false, reasons: r.reasons }, r.status);
    return json({ ok: true, invoice: publicInvoice(r.invoice, url.origin), qrSvg: qrSvg(r.invoice.link) }, 201);
  }
  if (req.method !== "GET" && req.method !== "POST") return bad("GET or POST only", 405);
  const chain = chainParam(url);
  if (!chain) return bad("chain must be 31611 or 31612");
  const claims = claimsFor(env.INVOICE_STORE, chain.id);
  if (rest === "") {
    if (req.method !== "GET") return bad("GET or POST only", 405);
    const to = checkAddress(p.get("to") ?? "", false);
    if (!to.ok) return bad(to.message);
    const list = await listInvoices(kv, chain.id, to.address, claims);
    return json({ chainId: chain.id, to: to.address, invoices: list.map((i) => publicInvoice(i, url.origin)) });
  }
  const suffix = rest.endsWith("/accept") && rest.length > "/accept".length ? "/accept" : rest.endsWith("/confirm") && rest.length > "/confirm".length ? "/confirm" : null;
  const action = suffix === "/accept" ? "accept" : suffix === "/confirm" ? "confirm" : null;
  let memo: string;
  try {
    memo = decodeURIComponent(rest.slice(1, suffix ? -suffix.length : undefined));
  } catch {
    return bad("Not an invoice reference.");
  }
  if (!MEMO_PATTERN.test(memo)) return bad("Not an invoice reference.");
  if (action && req.method !== "POST") return bad(action === "confirm" ? "POST a JSON body {\"tx\":\"0x...\"} to confirm an invoice." : "POST a signed JSON body to accept a possible payment.", 405);
  if (!action && req.method !== "GET") return bad("GET only", 405);
  const inv = await getInvoice(kv, chain.id, memo, claims);
  if (!inv) return bad(`No invoice ${memo} on ${chain.name}.`, 404);
  if (action === "confirm") {
    let tx: unknown;
    try {
      tx = ((await req.json()) as { tx?: unknown }).tx;
    } catch {
      return bad("Send a JSON body, for example {\"tx\":\"0x...\"}");
    }
    if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return bad("tx must be a transaction hash (0x and 64 hex characters).");
    const c = await confirmInvoice(kv, chain, inv, tx, undefined, new Date(), claims);
    return json(confirmAnswer(c, url.origin), statusCode(c.status));
  }
  if (action === "accept") {
    let body: { tx?: unknown; timestamp?: unknown; signature?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return bad("Send a JSON body with tx, timestamp and signature. The invoice recipient signs the accept message.");
    }
    const tx = typeof body.tx === "string" ? body.tx : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return bad("tx must be a transaction hash (0x and 64 hex characters).");
    const auth = await checkAcceptSignature({ chainId: chain.id, to: inv.to, memo, txHash: tx, timestamp: body.timestamp }, body.signature);
    if (!auth.ok) return json({ ok: false, reasons: [{ code: auth.code, message: auth.message }] }, 401);
    const c = await acceptPossibleInvoice(kv, chain, inv, tx, undefined, new Date(), claims);
    return json(acceptAnswer(c, url.origin), statusCode(c.status));
  }
  if (p.get("check") === "0") return json({ status: inv.paid ? "paid" : "open", invoice: publicInvoice(inv, url.origin), checked: false });
  const c = await checkInvoice(kv, chain, inv, undefined, new Date(), claims);
  const extra =
    c.status === "paid" ? {
      // A later transfer with the same reference is a duplicate. The money arrived twice, so a refund is due.
      duplicates: (c.duplicates ?? []).map((d) => ({ ...d, explorer: `${chain.explorer}/tx/${d.txHash}` })),
      duplicatesChecked: c.duplicatesChecked === true,
    }
    : c.status === "open" ? {
      clamped: c.inbox.clamped,
      truncated: c.inbox.truncated,
      possible: c.inbox.payments.filter((x) => x.possible === true).map(({ amountUnits: _u, ...x }) => x),
      // Payments with the reference but less than the amount. A payer must not pay the full amount again.
      partial: c.inbox.payments.filter((x) => x.memo === inv.memo && x.matches === false).map(({ amountUnits: _u, ...x }) => x),
      head: c.inbox.head,
    }
    : c.status === "confirming" ? { payment: { ...c.payment, explorer: `${chain.explorer}/tx/${c.payment.txHash}` }, confirmations: c.confirmations, required: c.required, head: c.inbox?.head }
    : c.status === "unavailable" ? { message: c.message }
    : {};
  return json({ status: c.status, invoice: publicInvoice(c.invoice, url.origin), checked: true, required: CONFIRMATIONS_REQUIRED, ...extra }, statusCode(c.status));
}

function acceptAnswer(c: Awaited<ReturnType<typeof acceptPossibleInvoice>>, origin: string) {
  const chain = chainById(c.invoice.chainId)!;
  const base = { status: c.status, invoice: publicInvoice(c.invoice, origin), required: CONFIRMATIONS_REQUIRED };
  if (c.status === "paid") return { ...base, message: "Payment accepted. The wallet dropped the reference, and the invoice recipient confirmed the match." };
  if (c.status === "confirming") return { ...base, payment: { ...c.payment, explorer: `${chain.explorer}/tx/${c.payment.txHash}` }, confirmations: c.confirmations, message: `The payment matches without the reference. It has ${c.confirmations} of ${c.required} confirmations. Accept again in a few seconds.` };
  return { ...base, message: c.message };
}

function confirmAnswer(c: Awaited<ReturnType<typeof confirmInvoice>>, origin: string) {
  const chain = chainById(c.invoice.chainId)!;
  const base = { status: c.status, invoice: publicInvoice(c.invoice, origin), required: CONFIRMATIONS_REQUIRED };
  if (c.status === "paid") return base;
  if (c.status === "confirming") return { ...base, payment: { ...c.payment, explorer: `${chain.explorer}/tx/${c.payment.txHash}` }, confirmations: c.confirmations, message: `The payment matches. It has ${c.confirmations} of ${c.required} confirmations. Confirm again in a few seconds.` };
  return { ...base, message: c.message };
}

async function api(url: URL): Promise<Response> {
  const p = url.searchParams;
  switch (url.pathname) {
    case "/api/health": {
      // Probes each chain once with a short read, so the answer says whether the RPC works right now.
      const chains = await Promise.all(
        MEZO_CHAINS.map(async (c) => {
          try {
            return { id: c.id, name: c.name, musd: c.musd, rpc: true, block: Number(await rpc<string>(c, "eth_blockNumber", [], fetch, 2)) };
          } catch {
            return { id: c.id, name: c.name, musd: c.musd, rpc: false, block: null };
          }
        }),
      );
      return json({ ok: chains.every((c) => c.rpc), chains }, chains.every((c) => c.rpc) ? 200 : 503);
    }

    case "/api/token": {
      if (p.get("chain") === "all") {
        return json({ tokens: await Promise.all(MEZO_CHAINS.map((c) => token(c))), source: "eth_call on the MUSD contract" });
      }
      const chain = chainParam(url);
      if (!chain) return bad("chain must be 31611 or 31612");
      return json({ token: await token(chain), source: "eth_call on the MUSD contract" });
    }

    case "/api/balance": {
      const chain = chainParam(url);
      if (!chain) return bad("chain must be 31611 or 31612");
      const a = checkAddress(p.get("address") ?? "", false);
      if (!a.ok) return bad(a.message);
      const units = await readBalance(chain, a.address);
      return json({ chainId: chain.id, address: a.address, balance: units.toString(), decimals: 18 });
    }

    case "/api/link": {
      const r = createPaymentLink({
        chainId: Number(p.get("chain") ?? "31611"),
        recipient: p.get("to") ?? "",
        amount: p.get("amount") ?? "",
        memo: p.get("memo") ?? undefined,
      });
      if (!r.ok) return json(r, 422);
      if (p.get("format") === "svg") {
        return new Response(qrSvg(r.link), { headers: { "content-type": "image/svg+xml" } });
      }
      return json({ ...r, qrSvg: qrSvg(r.link) });
    }

    case "/api/check": {
      const allow = (p.get("allow") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const max = p.get("max");
      if (!max) return bad("max is required. Enter the most MUSD you are willing to pay, for example max=50");
      const r = checkPaymentLink(p.get("link") ?? "", {
        maxAmount: max,
        allowlist: allow.length ? allow : undefined,
        // Default: a recipient with no checksum is accepted with a warning. checksum=1 refuses it.
        requireChecksum: p.get("checksum") === "1",
      });
      return json(r, r.ok ? 200 : 422);
    }

    case "/api/verify": {
      const chain = chainParam(url);
      if (!chain) return bad("chain must be 31611 or 31612");
      const to = checkAddress(p.get("to") ?? "", false);
      if (!to.ok) return bad(to.message);
      const amount = parseAmount(p.get("amount") ?? "");
      if (amount === null) return bad("amount must be a decimal MUSD amount, for example 12.5");
      const fromBlock = blockParam(p.get("from_block"));
      if (fromBlock === undefined) return bad("from_block must be a block number");
      const r = await verifyPayment(chain, { txHash: p.get("tx") ?? "", recipient: to.address, amount, memo: p.get("memo"), fromBlock });
      const tx = p.get("tx") ?? "";
      const explorer = /^0x[0-9a-fA-F]{64}$/.test(tx) ? `${chain.explorer}/tx/${tx}` : null;
      // final is always present. It is true only when the payment is at the required depth.
      const final = r.status === "paid" && r.confirmations >= CONFIRMATIONS_REQUIRED;
      return json({ chainId: chain.id, ...r, required: CONFIRMATIONS_REQUIRED, final, explorer }, statusCode(r.status));
    }

    case "/api/payments": {
      const chain = chainParam(url);
      if (!chain) return bad("chain must be 31611 or 31612");
      const to = checkAddress(p.get("to") ?? "", false);
      if (!to.ok) return bad(to.message);
      const fromBlock = blockParam(p.get("from_block"));
      if (fromBlock === undefined) return bad("from_block must be a block number");
      const rawAmount = p.get("amount");
      const amount = rawAmount ? parseAmount(rawAmount) : null;
      if (rawAmount && amount === null) return bad("amount must be a decimal MUSD amount, for example 12.5");
      const r = await findPayments(chain, { recipient: to.address, fromBlock, memo: p.get("memo") || null, amount });
      if (r.status !== "ok") {
        console.error("payments unavailable", r.detail);
        return json({ chainId: chain.id, status: r.status, message: r.message }, 503);
      }
      const payments = r.payments.map(({ amountUnits: _u, ...rest }) => ({ ...rest, explorer: `${chain.explorer}/tx/${rest.txHash}` }));
      return json({ chainId: chain.id, ...r, payments, paid: payments.find((x) => x.txHash === r.paid?.txHash) ?? null });
    }

    case "/api/head": {
      const chain = chainParam(url);
      if (!chain) return bad("chain must be 31611 or 31612");
      return json({ chainId: chain.id, block: await headBlock(chain) });
    }

    case "/api/borrow": {
      const chain = chainParam(url);
      if (!chain) return bad("chain must be 31611 or 31612");
      const need = parseAmount(p.get("need") ?? "");
      if (need === null || need === 0n) return bad("need must be a MUSD amount greater than zero, for example need=25");
      const rawRatio = p.get("ratio");
      const ratioPct = rawRatio ? parseAmount(rawRatio) : null;
      if (rawRatio && (ratioPct === null || ratioPct === 0n)) return bad("ratio must be a percentage, for example ratio=200");
      const t = await terms(chain);
      const q = quoteBorrow(t, need, ratioPct === null ? undefined : ratioPct / 100n);
      return json({ chainId: chain.id, terms: t, quote: q, borrowAt: chain.testnet ? "https://testnet.mezo.org/borrow" : "https://mezo.org/borrow", source: "eth_call on BorrowerOperations, TroveManager, PriceFeed and InterestRateManager" });
    }

    default:
      return bad("not found", 404);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const pure = PURE_ROUTES.has(url.pathname);
      const cors: Record<string, string> = pure ? { "access-control-allow-origin": "*" } : {};
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...JSON_HEADERS, ...cors, "access-control-allow-methods": "GET" } });
      const isInvoices = url.pathname === "/api/invoices" || url.pathname.startsWith("/api/invoices/");
      if (req.method !== "GET" && !(isInvoices && req.method === "POST")) return bad("GET only", 405);
      if (!pure) {
        const key = req.headers.get("cf-connecting-ip") ?? "local";
        // The in-isolate counter catches bursts at once. The Cloudflare binding counts across isolates in
        // a location, with some delay. A request must pass both.
        // Three budgets per client. Creating invoices, confirming by hash and reading the chain do not eat into each other.
        const kind = req.method !== "POST" ? "read" : url.pathname.endsWith("/confirm") || url.pathname.endsWith("/accept") ? "confirm" : "create";
        const rule = kind === "read" ? RATE_LIMIT : CREATE_LIMIT;
        const local = kind === "read" ? localLimit(key) : localLimit(kind + ":" + key, Date.now(), rule);
        let exact: boolean | null = null;
        if (local && env.CLIENT_LIMITER) {
          try {
            const name = kind + ":" + key;
            const stub = env.CLIENT_LIMITER.get(env.CLIENT_LIMITER.idFromName(name));
            exact = (await stub.fetch(new Request(`https://limiter/?limit=${rule.limit}&period=${rule.periodSeconds}`))).status === 200;
          } catch {
            exact = null; // the limiter itself failed, do not block the call
          }
        }
        // The kind prefix keeps the read, create and confirm budgets apart, as the comment and README say.
        const bound = local && exact !== false && env.LIMITER ? (await env.LIMITER.limit({ key: kind + ":" + key })).success : null;
        const allowed = local && exact !== false && bound !== false;
        if (!allowed) return json({ error: `Too many requests. The limit is ${rule.limit} a minute per client for this kind of call.` }, 429, { "retry-after": String(rule.periodSeconds) });
      }
      try {
        const res = isInvoices ? await invoices(req, url, env) : await api(url);
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
        return res;
      } catch (e) {
        // The detail goes to the Worker log only. Callers get a fixed text, so no internal error leaks.
        console.error("api error", url.pathname, String((e as Error)?.message ?? e).slice(0, 300));
        return bad(PUBLIC_ERROR_MESSAGE, 502);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
