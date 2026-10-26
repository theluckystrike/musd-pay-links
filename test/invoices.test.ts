import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIRMATIONS_REQUIRED, MEZO_TESTNET } from "../src/chains.ts";
import { buildTransferData } from "../src/guard.ts";
import { checkInvoice, confirmInvoice, createInvoice, getInvoice, listInvoices, MAX_LISTED, newReference, type KV } from "../src/invoices.ts";
import { payPageLock } from "../src/paystate.ts";
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

/** A fake Mezo RPC with MUSD transfers to SHOP. Answers single and batch requests, receipts included. */
function chainWith(pays: { tx: string; block: number; units: bigint; memo: string | null }[], head = HEAD): Fetch {
  const one = (method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return "0x" + head.toString(16);
    if (method === "eth_getTransactionReceipt") {
      const p = pays.find((x) => x.tx === params[0]);
      return p
        ? { status: "0x1", from: PAYER, blockNumber: "0x" + p.block.toString(16), to: MEZO_TESTNET.musd, logs: [{ address: MEZO_TESTNET.musd, topics: [TRANSFER_TOPIC, pad(PAYER), pad(SHOP)], data: "0x" + p.units.toString(16) }] }
        : null;
    }
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

describe("confirmation depth", () => {
  it("does not record a payment with fewer than CONFIRMATIONS_REQUIRED blocks, and reports it as confirming", async () => {
    expect(CONFIRMATIONS_REQUIRED).toBe(5);
    const kv = memKV();
    const r = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-D" }, HEAD - 100);
    if (!r.ok) throw new Error("expected ok");
    const pay = [{ tx: h(7), block: HEAD - 3, units: 5n * E, memo: "INV-D" }]; // 4 confirmations
    const c = await checkInvoice(kv, MEZO_TESTNET, r.invoice, chainWith(pay));
    expect(c).toMatchObject({ status: "confirming", confirmations: 4, required: 5, payment: { txHash: h(7), block: HEAD - 3, from: PAYER, amount: "5" } });
    expect((await getInvoice(kv, MEZO_TESTNET.id, "INV-D"))!.paid).toBeUndefined();
    expect(kv.data.has(`tx:31611:${h(7)}`)).toBe(false);
    // One block later the payment has 5 confirmations and is recorded.
    const later = await checkInvoice(kv, MEZO_TESTNET, r.invoice, chainWith(pay, HEAD + 1));
    expect(later.status).toBe("paid");
    expect((await getInvoice(kv, MEZO_TESTNET.id, "INV-D"))!.paid?.txHash).toBe(h(7));
  });
});

describe("confirm by transaction hash", () => {
  const setup = async (memo = "INV-C", fromBlock = HEAD - 30_000) => {
    const kv = memKV();
    const r = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo }, fromBlock);
    if (!r.ok) throw new Error("expected ok");
    return { kv, inv: r.invoice };
  };

  it("records a deep payment that the automatic search cannot see (older than the search window)", async () => {
    const { kv, inv } = await setup();
    const f = chainWith([{ tx: h(11), block: HEAD - 25_000, units: 5n * E, memo: "INV-C" }]);
    // The inbox search starts 20,000 blocks back, so it does not see the payment.
    const auto = await checkInvoice(kv, MEZO_TESTNET, inv, f);
    expect(auto).toMatchObject({ status: "open" });
    if (auto.status === "open") expect(auto.inbox.clamped).toBe(true);
    const c = await confirmInvoice(kv, MEZO_TESTNET, inv, h(11), f);
    expect(c).toMatchObject({ status: "paid", invoice: { paid: { txHash: h(11), block: HEAD - 25_000, from: PAYER, amount: "5" } } });
    // Confirming the same transaction again is still paid.
    expect((await confirmInvoice(kv, MEZO_TESTNET, (await getInvoice(kv, MEZO_TESTNET.id, "INV-C"))!, h(11), f)).status).toBe("paid");
    expect(kv.data.get(`tx:31611:${h(11)}`)).toBe("INV-C");
    expect((await getInvoice(kv, MEZO_TESTNET.id, "INV-C"))!.paid?.txHash).toBe(h(11));
  });

  it("reports a shallow payment as confirming and records nothing", async () => {
    const { kv, inv } = await setup();
    const c = await confirmInvoice(kv, MEZO_TESTNET, inv, h(12), chainWith([{ tx: h(12), block: HEAD - 1, units: 5n * E, memo: "INV-C" }]));
    expect(c).toMatchObject({ status: "confirming", confirmations: 2, required: 5 });
    expect((await getInvoice(kv, MEZO_TESTNET.id, "INV-C"))!.paid).toBeUndefined();
  });

  it("checks the stored invoice, not the caller: wrong reference, too little, before the invoice block, unknown hash", async () => {
    const { kv, inv } = await setup("INV-C", HEAD - 1000);
    const f = chainWith([
      { tx: h(13), block: HEAD - 100, units: 5n * E, memo: "INV-OTHER" },
      { tx: h(14), block: HEAD - 100, units: 4n * E, memo: "INV-C" },
      { tx: h(15), block: HEAD - 2000, units: 5n * E, memo: "INV-C" },
    ]);
    expect((await confirmInvoice(kv, MEZO_TESTNET, inv, h(13), f)).status).toBe("mismatch");
    expect((await confirmInvoice(kv, MEZO_TESTNET, inv, h(14), f)).status).toBe("mismatch");
    expect((await confirmInvoice(kv, MEZO_TESTNET, inv, h(15), f)).status).toBe("mismatch");
    expect((await confirmInvoice(kv, MEZO_TESTNET, inv, h(16), f)).status).toBe("not_found");
    expect((await getInvoice(kv, MEZO_TESTNET.id, "INV-C"))!.paid).toBeUndefined();
  });

  it("refuses a transaction that already paid another invoice", async () => {
    const { kv, inv } = await setup();
    await kv.put(`tx:31611:${h(17)}`, "INV-FIRST");
    const c = await confirmInvoice(kv, MEZO_TESTNET, inv, h(17), chainWith([{ tx: h(17), block: HEAD - 100, units: 5n * E, memo: "INV-C" }]));
    expect(c).toMatchObject({ status: "tx_used" });
    expect(statusCode(c.status)).toBe(409);
  });
});

describe("double payment", () => {
  it("a second payment with the same reference does not replace the first, and the pay page stays locked", async () => {
    const kv = memKV();
    const r = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-2X" }, HEAD - 1000);
    if (!r.ok) throw new Error("expected ok");
    const first = { tx: h(21), block: HEAD - 500, units: 5n * E, memo: "INV-2X" };
    const second = { tx: h(22), block: HEAD - 10, units: 5n * E, memo: "INV-2X" };
    const f = chainWith([first, second]);
    // Nobody opened the invoice after the first payment. The pay page check finds it and records it.
    const c = await checkInvoice(kv, MEZO_TESTNET, r.invoice, f);
    expect(c.status).toBe("paid");
    expect(c.invoice.paid?.txHash).toBe(h(21));
    expect(payPageLock({ status: c.status, invoice: c.invoice, checked: true })).toBe("paid");
    // Confirming the second transaction keeps the first one and reports a second payment with 409.
    const again = await confirmInvoice(kv, MEZO_TESTNET, (await getInvoice(kv, MEZO_TESTNET.id, "INV-2X"))!, h(22), f);
    expect(again).toMatchObject({ status: "already_paid", invoice: { paid: { txHash: h(21) } } });
    expect(statusCode(again.status)).toBe(409);
  });

  it("locks Pay while the first payment is still shallow", async () => {
    const kv = memKV();
    const r = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-2Y" }, HEAD - 1000);
    if (!r.ok) throw new Error("expected ok");
    const c = await checkInvoice(kv, MEZO_TESTNET, r.invoice, chainWith([{ tx: h(23), block: HEAD, units: 5n * E, memo: "INV-2Y" }]));
    expect(c.status).toBe("confirming");
    expect(payPageLock({ status: c.status, invoice: c.invoice, checked: true })).toBe("confirming");
  });
});

describe("pay page lock", () => {
  const inv = { memo: "INV-1" };
  it("unlocks Pay only for a chain-checked open invoice with a full search", () => {
    expect(payPageLock({ status: "open", invoice: inv, checked: true })).toBeNull();
    expect(payPageLock({ status: "open", invoice: inv, checked: false })).toBe("unavailable");
    expect(payPageLock({ status: "open", invoice: inv })).toBe("unavailable");
    expect(payPageLock({ status: "open", invoice: inv, checked: true, clamped: true })).toBe("cannot_prove");
    expect(payPageLock({ status: "open", invoice: inv, checked: true, truncated: true })).toBe("cannot_prove");
    expect(payPageLock({ status: "unavailable", invoice: inv, checked: true })).toBe("unavailable");
    expect(payPageLock({ status: "something_new", invoice: inv, checked: true })).toBe("unavailable");
    expect(payPageLock({ status: "open", invoice: inv, checked: true, possible: [{ txHash: "0x1" }] })).toBe("possible");
    expect(payPageLock({ status: "open", invoice: inv, checked: true, possible: [] })).toBeNull();
    expect(payPageLock({ status: "open", invoice: inv, checked: true, partial: [{ txHash: "0x2" }], possible: [{ txHash: "0x1" }] })).toBe("partial");
  });
  it("tells a missing invoice from a refused request", () => {
    expect(payPageLock({ http: 404 })).toBe("not_found");
    expect(payPageLock({ http: 429 })).toBe("unavailable");
    expect(payPageLock({ http: 503 })).toBe("unavailable");
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
    expect((await call(e, "/api/invoices/%E0%A4%A?chain=31611")).status).toBe(400);
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
    expect([statusCode("paid"), statusCode("pending"), statusCode("open"), statusCode("confirming"), statusCode("not_found"), statusCode("mismatch"), statusCode("failed"), statusCode("unavailable"), statusCode("tx_used")]).toEqual([200, 200, 200, 200, 404, 422, 422, 503, 409]);
  });

  describe("with a fake chain behind the Worker", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("GET checks the chain, answers confirming for a shallow payment, then paid", async () => {
      const e = env();
      await createInvoice(e.INVOICES, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-W" }, HEAD - 100);
      const pay = [{ tx: h(31), block: HEAD - 1, units: 5n * E, memo: "INV-W" }];
      vi.stubGlobal("fetch", chainWith(pay));
      const res = await call(e, "/api/invoices/INV-W?chain=31611");
      const body = (await res.json()) as { status: string; checked: boolean; confirmations: number; required: number; payment: { txHash: string; explorer: string } };
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "confirming", checked: true, confirmations: 2, required: 5, payment: { txHash: h(31) } });
      expect(body.payment.explorer).toBe(`${MEZO_TESTNET.explorer}/tx/${h(31)}`);
      vi.stubGlobal("fetch", chainWith(pay, HEAD + 3));
      expect(((await (await call(e, "/api/invoices/INV-W?chain=31611")).json()) as { status: string }).status).toBe("paid");
      // The store-only answer says it was not checked on chain.
      expect(((await (await call(e, "/api/invoices/INV-W?chain=31611&check=0")).json()) as { checked: boolean }).checked).toBe(false);
    });

    it("POST /api/invoices/:memo/confirm records the payment and validates its input", async () => {
      const e = env();
      await createInvoice(e.INVOICES, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-K" }, HEAD - 100);
      vi.stubGlobal("fetch", chainWith([{ tx: h(41), block: HEAD - 50, units: 5n * E, memo: "INV-K" }]));
      const post = (path: string, body: string) => call(e, path, { method: "POST", body, headers: { "content-type": "application/json" } });
      expect((await post("/api/invoices/INV-K/confirm?chain=31611", JSON.stringify({ tx: "0x12" }))).status).toBe(400);
      expect((await post("/api/invoices/INV-K/confirm?chain=31611", "{nope")).status).toBe(400);
      expect((await post("/api/invoices/INV-NONE/confirm?chain=31611", JSON.stringify({ tx: h(41) }))).status).toBe(404);
      expect((await call(e, "/api/invoices/INV-K/confirm?chain=31611")).status).toBe(405);
      expect((await post("/api/invoices/INV-K?chain=31611", JSON.stringify({ tx: h(41) }))).status).toBe(405);
      const wrong = await post("/api/invoices/INV-K/confirm?chain=31611", JSON.stringify({ tx: h(42) }));
      expect(wrong.status).toBe(404);
      const res = await post("/api/invoices/INV-K/confirm?chain=31611", JSON.stringify({ tx: h(41) }));
      const body = (await res.json()) as { status: string; invoice: { paid: { txHash: string }; explorer: string } };
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "paid", invoice: { paid: { txHash: h(41) } } });
      expect(body.invoice.explorer).toBe(`${MEZO_TESTNET.explorer}/tx/${h(41)}`);
      expect((await getInvoice(e.INVOICES, MEZO_TESTNET.id, "INV-K"))!.paid?.txHash).toBe(h(41));
    });

    it("lists a smaller payment with the reference as partial, so the pay page does not invite a full second payment", async () => {
      const e = env();
      await createInvoice(e.INVOICES, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-PART" }, HEAD - 100);
      vi.stubGlobal("fetch", chainWith([{ tx: h(61), block: HEAD - 50, units: 2n * E, memo: "INV-PART" }]));
      const body = (await (await call(e, "/api/invoices/INV-PART?chain=31611")).json()) as { status: string; checked: boolean; partial: { txHash: string; amount: string }[]; possible: unknown[] };
      expect(body).toMatchObject({ status: "open", checked: true, partial: [{ txHash: h(61), amount: "2" }], possible: [] });
      expect(payPageLock(body)).toBe("partial");
    });

    it("gives confirm calls their own budget, so they do not use up invoice creation", async () => {
      const e = env();
      const ip = { "cf-connecting-ip": "198.19.5.5" };
      for (let i = 0; i < 10; i++) await call(e, "/api/invoices/INV-NONE/confirm?chain=31611", { method: "POST", body: "{}", headers: ip });
      const over = await call(e, "/api/invoices/INV-NONE/confirm?chain=31611", { method: "POST", body: "{}", headers: ip });
      expect(over.status).toBe(429);
      expect(((await over.json()) as { error: string }).error).toBe("Too many requests. The limit is 10 a minute per client for this kind of call.");
      // Creation from the same client is still allowed (400 for the empty body, not 429).
      expect((await call(e, "/api/invoices", { method: "POST", body: "{nope", headers: ip })).status).toBe(400);
    });

    it("reads an invoice whose reference is the word confirm", async () => {
      const e = env();
      await createInvoice(e.INVOICES, MEZO_TESTNET, { to: SHOP, amount: "1", memo: "confirm" }, 10);
      expect((await call(e, "/api/invoices/confirm?chain=31611&check=0")).status).toBe(200);
    });

    it("/api/verify says how deep a payment is and whether it is final", async () => {
      const e = env();
      vi.stubGlobal("fetch", chainWith([{ tx: h(51), block: HEAD - 1, units: 5n * E, memo: "INV-V" }, { tx: h(52), block: HEAD - 9, units: 5n * E, memo: "INV-V" }]));
      const q = (tx: string) => call(e, `/api/verify?chain=31611&tx=${tx}&to=${SHOP}&amount=5&memo=INV-V`);
      expect(await (await q(h(51))).json()).toMatchObject({ status: "paid", confirmations: 2, required: 5, final: false });
      expect(await (await q(h(52))).json()).toMatchObject({ status: "paid", confirmations: 10, required: 5, final: true });
    });
  });
});
