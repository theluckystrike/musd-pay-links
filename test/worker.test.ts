import { describe, expect, it } from "vitest";

import { MEZO_TESTNET } from "../src/chains.ts";
import worker from "../src/worker.ts";

const SHOP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const env = { ASSETS: { fetch: async () => new Response("asset") } };
const get = (path: string, method = "GET") => worker.fetch(new Request("https://x.test" + path, { method }), env);

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
});
