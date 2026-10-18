// Cloudflare Worker: serves the demo page (static assets) and a small read-only JSON API.
// No keys, no signing, no state. Every chain read goes to the public Mezo RPC.

import { checkAddress } from "./address.ts";
import { parseAmount } from "./amount.ts";
import { chainById, MEZO_CHAINS, type MezoChain } from "./chains.ts";
import { checkPaymentLink } from "./guard.ts";
import { createPaymentLink } from "./merchant.ts";
import { qrSvg } from "./qr.ts";
import { readBalance, readTokenInfo, verifyPayment, type TokenInfo } from "./rpc.ts";

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return new Response(text + "\n", { status, headers: JSON_HEADERS });
}

function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function chainParam(url: URL): MezoChain | null {
  const raw = url.searchParams.get("chain") ?? "31611";
  return /^\d{1,10}$/.test(raw) ? (chainById(Number(raw)) ?? null) : null;
}

const tokenCache = new Map<number, { at: number; info: TokenInfo }>();

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
        return new Response(qrSvg(r.link), { headers: { "content-type": "image/svg+xml", "access-control-allow-origin": "*" } });
      }
      return json({ ...r, qrSvg: qrSvg(r.link) });
    }

    case "/api/check": {
      const allow = (p.get("allow") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const max = p.get("max");
      if (!max) return bad("max is required: the most MUSD you are willing to pay, for example max=50");
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
      const r = await verifyPayment(chain, { txHash: p.get("tx") ?? "", recipient: to.address, amount, memo: p.get("memo") });
      return json({ chainId: chain.id, ...r, explorer: `${chain.explorer}/tx/${p.get("tx")}` });
    }

    default:
      return bad("not found", 404);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") return new Response(null, { headers: { ...JSON_HEADERS, "access-control-allow-methods": "GET" } });
      if (req.method !== "GET") return bad("GET only", 405);
      try {
        return await api(url);
      } catch (e) {
        return bad(`upstream error: ${(e as Error).message}`, 502);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
