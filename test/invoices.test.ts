import { describe, expect, it } from "vitest";

import { MEZO_TESTNET } from "../src/chains.ts";
import { buildTransferData } from "../src/guard.ts";
import { checkInvoice, createInvoice, getInvoice, listInvoices, MAX_LISTED, newReference, type KV } from "../src/invoices.ts";
import { MEMO_PATTERN } from "../src/eip681.ts";
import { retry, TRANSFER_TOPIC, type Fetch } from "../src/rpc.ts";
import worker, { statusCode } from "../src/worker.ts";

retry.delayMs = 1;
const SHOP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const PAYER = "0x1111111111111111111111111111111111111111";
const E = 10n ** 18n;
const HEAD = 2_000_000;
const pad = (a: string) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function memKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v) };
}

/** A fake Mezo RPC with MUSD transfers to SHOP. Answers single and batch requests. */
function chainWith(pays: { tx: string; block: number; units: bigint; memo: string | null }[]): Fetch {
  const one = (method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return "0x" + HEAD.toString(16);
    if (method === "eth_getLogs") {
      const q = params[0] as { fromBlock: string; toBlock: string };
      return pays
        .filter((p) => p.block >= Number(q.fromBlock) && p.block <= Number(q.toBlock))
        .map((p) => ({ transactionHash: p.tx, blockNumber: "0x" + p.block.toString(16), topics: [TRANSFER_TOPIC, pad(PAYER), pad(SHOP)], data: "0x" + p.units.toString(16) }));
    }
    if (method === "eth_getTransactionByHash") {
      const p = pays.find((x) => x.tx === params[0]);
      return p ? { input: buildTransferData(SHOP, p.units, p.memo), to: MEZO_TESTNET.musd } : null;
    }
    return null;
  };
  return async (_u, init) => {
    const b = JSON.parse(String(init!.body));
    const out = Array.isArray(b) ? b.map((x: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: x.id, result: one(x.method, x.params) })) : { jsonrpc: "2.0", id: b.id, result: one(b.method, b.params) };
    return new Response(JSON.stringify(out));
  };
}

describe("invoices", () => {
  it("makes references that pass the memo rule and differ", () => {
    const a = newReference();
    expect(MEMO_PATTERN.test(a)).toBe(true);
    expect(a).toMatch(/^INV-[A-Z2-9]{8}$/);
    expect(new Set(Array.from({ length: 200 }, () => newReference())).size).toBe(200);
  });

  it("stamps the invoice with the block the Worker read and stores a link the guard accepts", async () => {
    const kv = memKV();
    const r = await createInvoice(kv, MEZO_TESTNET, { to: SHOP.toLowerCase(), amount: "12.50" }, HEAD - 100);
    if (!r.ok) throw new Error("expected ok");
    expect(r.invoice.fromBlock).toBe(HEAD - 100);
    expect(r.invoice.to).toBe(SHOP);
    expect(r.invoice.amount).toBe("12.5");
    expect(r.invoice.units).toBe((125n * E / 10n).toString());
    expect(r.invoice.link).toContain(`&memo=${r.invoice.memo}`);
    expect(await getInvoice(kv, MEZO_TESTNET.id, r.invoice.memo)).toEqual(r.invoice);
  });

  it("refuses a reference that is already taken, so one reference is one invoice", async () => {
    const kv = memKV();
    expect((await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "1", memo: "INV-A" }, 1)).ok).toBe(true);
    const again = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "2", memo: "INV-A" }, 2);
    expect(again).toMatchObject({ ok: false, status: 409, reasons: [{ code: "reference_taken" }] });
  });

  it("refuses bad input with the guard's reasons", async () => {
    const r = await createInvoice(memKV(), MEZO_TESTNET, { to: "0x12", amount: "abc", memo: "bad#memo" }, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.map((x) => x.code).sort()).toEqual(["bad_amount", "bad_memo", "recipient_bad_address"].sort());
  });

  it("lists a merchant's invoices newest first, capped", async () => {
    const kv = memKV();
    for (let i = 0; i < MAX_LISTED + 3; i++) await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "1", memo: `INV-${i}` }, i);
    const list = await listInvoices(kv, MEZO_TESTNET.id, SHOP.toLowerCase());
    expect(list.length).toBe(MAX_LISTED);
    expect(list[0]!.memo).toBe(`INV-${MAX_LISTED + 2}`);
  });

  it("marks the invoice paid by the oldest matching payment after its block, and records it", async () => {
    const kv = memKV();
    const r = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-P" }, HEAD - 1000);
    if (!r.ok) throw new Error("expected ok");
    const f = chainWith([
      { tx: h(1), block: HEAD - 2000, units: 5n * E, memo: "INV-P" }, // before the invoice
      { tx: h(2), block: HEAD - 500, units: 4n * E, memo: "INV-P" }, // too little
      { tx: h(3), block: HEAD - 400, units: 5n * E, memo: "INV-P" }, // the payment
      { tx: h(4), block: HEAD - 10, units: 5n * E, memo: "INV-P" }, // a later one
    ]);
    const c = await checkInvoice(kv, MEZO_TESTNET, r.invoice, f);
    expect(c.status).toBe("paid");
    expect(c.invoice.paid?.txHash).toBe(h(3));
    expect((await getInvoice(kv, MEZO_TESTNET.id, "INV-P"))!.paid?.txHash).toBe(h(3));
    expect(kv.data.get(`tx:31611:${h(3)}`)).toBe("INV-P");
    // Once paid, no chain read is needed.
    const offline: Fetch = async () => {
      throw new Error("no network");
    };
    expect((await checkInvoice(kv, MEZO_TESTNET, (await getInvoice(kv, MEZO_TESTNET.id, "INV-P"))!, offline)).status).toBe("paid");
  });

  it("never lets one transaction pay two invoices", async () => {
    const kv = memKV();
    await kv.put(`tx:31611:${h(3)}`, "INV-OTHER");
    const r = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-P" }, HEAD - 1000);
    if (!r.ok) throw new Error("expected ok");
    const c = await checkInvoice(kv, MEZO_TESTNET, r.invoice, chainWith([{ tx: h(3), block: HEAD - 400, units: 5n * E, memo: "INV-P" }]));
    expect(c.status).toBe("open");
  });

  it("stays open, with possible matches, when a wallet dropped the reference", async () => {
    const kv = memKV();
    const r = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-Q" }, HEAD - 1000);
    if (!r.ok) throw new Error("expected ok");
    const c = await checkInvoice(kv, MEZO_TESTNET, r.invoice, chainWith([{ tx: h(9), block: HEAD - 5, units: 5n * E, memo: null }]));
    expect(c.status).toBe("open");
    if (c.status === "open") expect(c.inbox.payments[0]!.possible).toBe(true);
  });
});

describe("invoice routes", () => {
  const env = () => ({ ASSETS: { fetch: async () => new Response("asset") }, INVOICES: memKV() });
  const call = (e: ReturnType<typeof env>, path: string, init: RequestInit = {}) =>
    worker.fetch(new Request("https://pay.test" + path, { ...init, headers: { "cf-connecting-ip": "198.18.0." + Math.floor(Math.random() * 250), ...(init.headers ?? {}) } }), e);

  it("answers 503 without a store, 405 for other methods, 400 for bad JSON", async () => {
    const bare = { ASSETS: env().ASSETS };
    expect((await worker.fetch(new Request("https://pay.test/api/invoices?chain=31611&to=" + SHOP, { headers: { "cf-connecting-ip": "198.18.1.1" } }), bare)).status).toBe(503);
    const e = env();
    expect((await call(e, "/api/invoices", { method: "PUT" })).status).toBe(405);
    expect((await call(e, "/api/invoices", { method: "POST", body: "{nope" })).status).toBe(400);
    expect((await call(e, "/api/check?link=x&max=1", { method: "POST" })).status).toBe(405);
  });

  it("finds a stored invoice without a chain read when check=0, and 404 for an unknown one", async () => {
    const e = env();
    const r = await createInvoice(e.INVOICES, MEZO_TESTNET, { to: SHOP, amount: "3", memo: "INV-R" }, 10);
    expect(r.ok).toBe(true);
    const res = await call(e, "/api/invoices/INV-R?chain=31611&check=0");
    const body = (await res.json()) as { status: string; invoice: { payUrl: string; amount: string } };
    expect(res.status).toBe(200);
    expect(body.status).toBe("open");
    expect(body.invoice.payUrl).toBe("https://pay.test/?invoice=INV-R&chain=31611");
    expect((await call(e, "/api/invoices/INV-NONE?chain=31611&check=0")).status).toBe(404);
    expect((await call(e, "/api/invoices/bad%23ref?chain=31611")).status).toBe(400);
  });

  it("lists invoices by merchant address", async () => {
    const e = env();
    await createInvoice(e.INVOICES, MEZO_TESTNET, { to: SHOP, amount: "3", memo: "INV-L1" }, 10);
    const res = await call(e, `/api/invoices?chain=31611&to=${SHOP}`);
    expect(((await res.json()) as { invoices: { memo: string }[] }).invoices.map((i) => i.memo)).toEqual(["INV-L1"]);
  });

  it("limits invoice creation per client", async () => {
    const e = env();
    const ip = { "cf-connecting-ip": "198.19.0.1" };
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call(e, "/api/invoices", { method: "POST", body: "{nope", headers: ip })).status;
    expect(last).toBe(429);
  });

  it("maps answer states to HTTP codes", () => {
    expect([statusCode("paid"), statusCode("pending"), statusCode("open"), statusCode("not_found"), statusCode("mismatch"), statusCode("failed"), statusCode("unavailable")]).toEqual([200, 200, 200, 404, 422, 422, 503]);
  });
});
