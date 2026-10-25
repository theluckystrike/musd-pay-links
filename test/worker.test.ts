import { describe, expect, it } from "vitest";

import { MEZO_TESTNET } from "../src/chains.ts";
import worker, { localLimit, PURE_ROUTES, RATE_LIMIT } from "../src/worker.ts";

const SHOP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const env = { ASSETS: { fetch: async () => new Response("asset") } };
const get = (path: string, method = "GET", headers: Record<string, string> = {}) => worker.fetch(new Request("https://x.test" + path, { method, headers }), env);

describe("worker API (no network routes)", () => {
  it("serves assets for non-API paths", async () => {
    expect(await (await get("/")).text()).toBe("asset");
  });

  it("creates a link with a QR code", async () => {
    const res = await get(`/api/link?chain=31611&to=${SHOP}&amount=2.5&memo=A-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: string; qrSvg: string };
    expect(body.link).toBe(`ethereum:${MEZO_TESTNET.musd}@31611/transfer?address=${SHOP}&uint256=2500000000000000000&memo=A-1`);
    expect(body.qrSvg.startsWith("<svg")).toBe(true);
  });

  it("returns an SVG QR on request", async () => {
    const res = await get(`/api/link?chain=31611&to=${SHOP}&amount=1&format=svg`);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("refuses a bad link request with 422 and reasons", async () => {
    const res = await get(`/api/link?chain=1&to=${SHOP}&amount=1`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { reasons: { code: string }[] }).reasons[0]!.code).toBe("wrong_chain");
  });

  it("checks a link and serialises bigints as strings", async () => {
    const link = `ethereum:${MEZO_TESTNET.musd}@31611/transfer?address=${SHOP}&uint256=7`;
    const res = await get(`/api/check?max=1&link=${encodeURIComponent(link)}`);
    const body = (await res.json()) as { ok: boolean; payment: { amount: string }; tx: { value: string } };
    expect(body.ok).toBe(true);
    expect(body.payment.amount).toBe("7");
    expect(body.tx.value).toBe("0");
  });

  it("requires a payer limit on /api/check", async () => {
    expect((await get(`/api/check?link=x`)).status).toBe(400);
  });

  it("returns 422 for a refused link", async () => {
    const link = `ethereum:${MEZO_TESTNET.musd}@1/transfer?address=${SHOP}&uint256=7`;
    expect((await get(`/api/check?max=1&link=${encodeURIComponent(link)}`)).status).toBe(422);
  });

  it("rejects non-GET methods, unknown routes and bad chains", async () => {
    expect((await get("/api/check", "POST")).status).toBe(405);
    expect((await get("/api/nope")).status).toBe(404);
    expect((await get("/api/token?chain=1")).status).toBe(400);
    expect((await get(`/api/balance?chain=31611&address=0x12`)).status).toBe(400);
    expect((await get(`/api/verify?chain=31611&to=${SHOP}&amount=abc&tx=0x`)).status).toBe(400);
  });

  it("validates the new chain routes before any network call", async () => {
    const h = { "cf-connecting-ip": "203.0.113.9" };
    expect((await get(`/api/borrow?chain=31611&need=0`, "GET", h)).status).toBe(400);
    expect((await get(`/api/borrow?chain=31611&need=-1`, "GET", h)).status).toBe(400);
    expect((await get(`/api/borrow?chain=31611&need=5&ratio=abc`, "GET", h)).status).toBe(400);
    expect((await get(`/api/borrow?chain=1&need=5`, "GET", h)).status).toBe(400);
    expect((await get(`/api/payments?chain=31611&to=0x12`, "GET", h)).status).toBe(400);
    expect((await get(`/api/payments?chain=31611&to=${SHOP}&from_block=-5`, "GET", h)).status).toBe(400);
    expect((await get(`/api/payments?chain=31611&to=${SHOP}&amount=1e3`, "GET", h)).status).toBe(400);
    expect((await get(`/api/verify?chain=31611&to=${SHOP}&amount=1&tx=0x&from_block=abc`, "GET", h)).status).toBe(400);
    expect((await get(`/api/head?chain=7`, "GET", h)).status).toBe(400);
  });

  it("allows any origin only on routes that do not read the chain", async () => {
    expect([...PURE_ROUTES].sort()).toEqual(["/api/check", "/api/health", "/api/link"]);
    const link = await get(`/api/link?chain=31611&to=${SHOP}&amount=1`);
    expect(link.headers.get("access-control-allow-origin")).toBe("*");
    const chainRoute = await get(`/api/balance?chain=31611&address=0x12`, "GET", { "cf-connecting-ip": "203.0.113.10" });
    expect(chainRoute.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rate limits chain routes per client and answers 429 with retry-after", async () => {
    const h = { "cf-connecting-ip": "198.51.100.77" };
    for (let i = 0; i < RATE_LIMIT.limit; i++) expect((await get(`/api/head?chain=7`, "GET", h)).status).toBe(400);
    const res = await get(`/api/head?chain=7`, "GET", h);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(RATE_LIMIT.periodSeconds));
    // Another client is not affected, and pure routes are never limited.
    expect((await get(`/api/head?chain=7`, "GET", { "cf-connecting-ip": "198.51.100.78" })).status).toBe(400);
    expect((await get(`/api/link?chain=31611&to=${SHOP}&amount=1`, "GET", h)).status).toBe(200);
  });

  it("uses the Cloudflare rate limiting binding when it is bound", async () => {
    const keys: string[] = [];
    const bound = { ...env, LIMITER: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } };
    const res = await worker.fetch(new Request("https://x.test/api/head?chain=31611", { headers: { "cf-connecting-ip": "192.0.2.1" } }), bound);
    expect(res.status).toBe(429);
    expect(keys).toEqual(["192.0.2.1"]);
  });

  it("opens a fresh window after the period", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < RATE_LIMIT.limit; i++) expect(localLimit("k-window", t0)).toBe(true);
    expect(localLimit("k-window", t0 + 1)).toBe(false);
    expect(localLimit("k-window", t0 + RATE_LIMIT.periodSeconds * 1000)).toBe(true);
  });
});
