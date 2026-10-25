// Cloudflare Worker: serves the demo page (static assets) and a small read-only JSON API.
// No keys, no signing, no stored state. Every chain read goes to a public Mezo RPC.

import { checkAddress } from "./address.ts";
import { parseAmount } from "./amount.ts";
import { chainById, MEZO_CHAINS, type MezoChain } from "./chains.ts";
import { checkPaymentLink } from "./guard.ts";
import { createPaymentLink } from "./merchant.ts";
import { qrSvg } from "./qr.ts";
import { quoteBorrow, readBorrowTerms, type BorrowTerms } from "./borrow.ts";
import { findPayments, headBlock, readBalance, readTokenInfo, verifyPayment, type TokenInfo } from "./rpc.ts";

interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  /** Cloudflare Workers rate limiting binding, see wrangler.toml. Optional so tests and dev run without it. */
  LIMITER?: RateLimiter;
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
export const PURE_ROUTES = new Set(["/api/health", "/api/link", "/api/check"]);
export const RATE_LIMIT = { limit: 30, periodSeconds: 60 };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return new Response(text + "\n", { status, headers: { ...JSON_HEADERS, ...extra } });
}

/** In-memory fallback limiter, per Worker isolate, used only when the LIMITER binding is missing. */
const windows = new Map<string, { start: number; count: number }>();
export function localLimit(key: string, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= RATE_LIMIT.periodSeconds * 1000) {
    if (windows.size > 5_000) windows.clear();
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  w.count++;
  return w.count <= RATE_LIMIT.limit;
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

async function api(url: URL): Promise<Response> {
  const p = url.searchParams;
  switch (url.pathname) {
    case "/api/health":
      return json({ ok: true, chains: MEZO_CHAINS.map((c) => ({ id: c.id, name: c.name, musd: c.musd })) });

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
        requireChecksum: p.get("checksum") !== "0",
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
      return json({ chainId: chain.id, ...r, explorer: `${chain.explorer}/tx/${p.get("tx")}` });
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
      if (r.status !== "ok") return json({ chainId: chain.id, ...r }, 502);
      const payments = r.payments.map(({ amountUnits: _u, ...rest }) => ({ ...rest, explorer: `${chain.explorer}/tx/${rest.txHash}` }));
      return json({ chainId: chain.id, ...r, payments, paid: payments.find((x) => x.matches) ?? null });
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
      return json({ chainId: chain.id, terms: t, quote: q, borrowAt: chain.testnet ? "https://testnet.mezo.org" : "https://mezo.org", source: "eth_call on BorrowerOperations, TroveManager, PriceFeed and InterestRateManager" });
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
      if (req.method !== "GET") return bad("GET only", 405);
      if (!pure) {
        const key = req.headers.get("cf-connecting-ip") ?? "local";
        const allowed = env.LIMITER ? (await env.LIMITER.limit({ key })).success : localLimit(key);
        if (!allowed) return json({ error: `Too many chain reads. The limit is ${RATE_LIMIT.limit} a minute per client.` }, 429, { "retry-after": String(RATE_LIMIT.periodSeconds) });
      }
      try {
        const res = await api(url);
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
        return res;
      } catch (e) {
        return bad(`The network did not answer. Try again in a moment. (${(e as Error).message})`, 502);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
