import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkInvoiceSignature, invoiceMessage, SIGNATURE_MAX_AGE_SECONDS, type InvoiceClaim } from "../src/auth.ts";
import { MEZO_TESTNET } from "../src/chains.ts";
import { createInvoice, getInvoice, type KV } from "../src/invoices.ts";
import worker from "../src/worker.ts";

// Throwaway keys made for each run. No real key is used or stored.
const merchant = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const now = () => Math.floor(Date.now() / 1000);

function memKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v) };
}

const env = () => ({ ASSETS: { fetch: async () => new Response("asset") }, INVOICES: memKV() });
let ip = 0;
const post = (e: ReturnType<typeof env>, body: unknown) =>
  worker.fetch(new Request("https://pay.test/api/invoices", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "cf-connecting-ip": `198.18.9.${ip++ % 250}` } }), e);

async function signed(over: Partial<InvoiceClaim> = {}, signer = merchant, send: Record<string, unknown> = {}) {
  const claim: InvoiceClaim = { chainId: 31611, to: merchant.address, amount: "12.5", memo: "INV-S" + Math.floor(Math.random() * 1e9), timestamp: now(), ...over };
  const signature = await signer.signMessage({ message: invoiceMessage(claim) });
  return { chain: claim.chainId, to: claim.to, amount: claim.amount, memo: claim.memo, timestamp: claim.timestamp, signature, ...send };
}

beforeEach(() => {
  // headBlock() is the only chain read of a create request.
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1e8480" })));
});
afterEach(() => vi.unstubAllGlobals());

describe("invoiceMessage", () => {
  it("is one fixed text with chain, recipient, amount, reference and time", () => {
    expect(invoiceMessage({ chainId: 31611, to: "0x94958151D1789C8279a67f5cE4631e9DDdE43cB6", amount: "5", memo: "INV-1", timestamp: 1793000000 })).toBe(
      "MUSD Pay Links, create invoice\nchain 31611\nto 0x94958151D1789C8279a67f5cE4631e9DDdE43cB6\namount 5 MUSD\nreference INV-1\ntime 1793000000",
    );
  });
});

describe("checkInvoiceSignature", () => {
  it("accepts the recipient's signature and refuses every other signer", async () => {
    const claim = { chainId: 31611, to: merchant.address, amount: "5", memo: "INV-1", timestamp: now() };
    expect(await checkInvoiceSignature(claim, await merchant.signMessage({ message: invoiceMessage(claim) }))).toEqual({ ok: true });
    expect(await checkInvoiceSignature(claim, await stranger.signMessage({ message: invoiceMessage(claim) }))).toMatchObject({ ok: false, code: "bad_signature" });
  });

  it("refuses a time more than 10 minutes in the past or the future", async () => {
    expect(SIGNATURE_MAX_AGE_SECONDS).toBe(600);
    for (const t of [now() - 605, now() + 605]) {
      const claim = { chainId: 31611, to: merchant.address, amount: "5", memo: "INV-1", timestamp: t };
      const r = await checkInvoiceSignature(claim, await merchant.signMessage({ message: invoiceMessage(claim) }));
      expect(r).toMatchObject({ ok: false, code: "signature_expired" });
    }
    const edge = { chainId: 31611, to: merchant.address, amount: "5", memo: "INV-1", timestamp: now() - 590 };
    expect((await checkInvoiceSignature(edge, await merchant.signMessage({ message: invoiceMessage(edge) }))).ok).toBe(true);
  });

  it("refuses a missing, malformed or non-numeric signature or time", async () => {
    const claim = { chainId: 31611, to: merchant.address, amount: "5", memo: "INV-1", timestamp: now() };
    expect(await checkInvoiceSignature(claim, undefined)).toMatchObject({ code: "signature_required" });
    expect(await checkInvoiceSignature(claim, "0x1234")).toMatchObject({ code: "bad_signature" });
    expect(await checkInvoiceSignature(claim, "0x" + "00".repeat(65))).toMatchObject({ code: "bad_signature" });
    expect(await checkInvoiceSignature({ ...claim, timestamp: String(now()) }, "0x" + "11".repeat(65))).toMatchObject({ code: "bad_timestamp" });
    expect(await checkInvoiceSignature({ ...claim, timestamp: now() * 1000 }, "0x" + "11".repeat(65))).toMatchObject({ code: "signature_expired" });
  });
});

describe("POST /api/invoices with a signature", () => {
  it("creates the invoice for a good signature and marks it signed", async () => {
    const e = env();
    const body = await signed();
    const res = await post(e, body);
    expect(res.status).toBe(201);
    const out = (await res.json()) as { invoice: { memo: string; to: string; amount: string; signed: boolean; fromBlock: number } };
    expect(out.invoice).toMatchObject({ memo: body.memo, to: merchant.address, amount: "12.5", signed: true, fromBlock: 2_000_000 });
    expect((await getInvoice(e.INVOICES, 31611, body.memo))!.signed).toBe(true);
  });

  it("refuses a request without a signature with 401, and stores nothing", async () => {
    const e = env();
    const res = await post(e, { chain: 31611, to: merchant.address, amount: "5", memo: "INV-UNSIGNED" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reasons: { code: string }[] }).reasons[0]!.code).toBe("signature_required");
    expect(await getInvoice(e.INVOICES, 31611, "INV-UNSIGNED")).toBeNull();
  });

  it("refuses a signature by a wallet that is not the recipient", async () => {
    const e = env();
    const res = await post(e, await signed({}, stranger));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reasons: { code: string }[] }).reasons[0]!.code).toBe("bad_signature");
    expect(e.INVOICES.data.size).toBe(0);
  });

  it("refuses an expired signature", async () => {
    const res = await post(env(), await signed({ timestamp: now() - SIGNATURE_MAX_AGE_SECONDS - 5 }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reasons: { code: string }[] }).reasons[0]!.code).toBe("signature_expired");
  });

  it("refuses a replay of the same signed request", async () => {
    const e = env();
    const body = await signed();
    expect((await post(e, body)).status).toBe(201);
    const again = await post(e, body);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { reasons: { code: string }[] }).reasons[0]!.code).toBe("reference_taken");
  });

  it("refuses a signed request with a changed amount, recipient, chain or reference", async () => {
    const e = env();
    const body = await signed({ amount: "5" });
    for (const change of [{ amount: "50" }, { to: stranger.address }, { chain: 31612 }, { memo: body.memo + "X" }]) {
      const res = await post(e, { ...body, ...change });
      expect(res.status).toBe(401);
    }
    expect(e.INVOICES.data.size).toBe(0);
  });

  it("accepts the same amount written another way, because both sides sign the normalised value", async () => {
    const res = await post(env(), await signed({ amount: "12.5", to: merchant.address }, merchant, { amount: "12.50", to: merchant.address.toLowerCase() }));
    expect(res.status).toBe(201);
  });

  it("needs a reference in a signed request, and checks the input before the signature", async () => {
    const e = env();
    const body = await signed();
    expect((await post(e, { ...body, memo: "" })).status).toBe(400);
    expect((await post(e, { ...body, amount: "abc" })).status).toBe(422);
    expect((await post(e, null)).status).toBe(400);
  });

  it("keeps invoices made before signing readable", async () => {
    const e = env();
    await createInvoice(e.INVOICES, MEZO_TESTNET, { to: merchant.address, amount: "3", memo: "INV-OLD" }, 10);
    const res = await worker.fetch(new Request("https://pay.test/api/invoices/INV-OLD?chain=31611&check=0", { headers: { "cf-connecting-ip": "198.18.8.1" } }), e);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { invoice: { signed: boolean } }).invoice.signed).toBe(false);
  });
});
