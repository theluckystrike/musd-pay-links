import { describe, expect, it } from "vitest";

import { MEZO_TESTNET } from "../src/chains.ts";
import { claimsFor, InvoiceStoreDO, type InvoiceClaims } from "../src/claims.ts";
import { buildTransferData } from "../src/guard.ts";
import { confirmInvoice, createInvoice, getInvoice, type KV, type StoredInvoice } from "../src/invoices.ts";
import { retry, TRANSFER_TOPIC, type Fetch } from "../src/rpc.ts";

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

/**
 * A Durable Object storage double. `transaction` runs one closure at a time, as one Durable Object does,
 * so a compare-and-set in the test has the same protection as the deployed object.
 */
class FakeStorage {
  private readonly data = new Map<string, unknown>();
  private queue: Promise<unknown> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async transaction<T>(closure: (txn: { get: <V>(k: string) => Promise<V | undefined>; put: <V>(k: string, v: V) => Promise<void> }) => Promise<T>): Promise<T> {
    const run = this.queue.then(() =>
      closure({
        get: async <V>(k: string) => this.data.get(k) as V | undefined,
        put: async <V>(k: string, v: V) => void this.data.set(k, v),
      }),
    );
    this.queue = run.catch(() => undefined);
    return run as Promise<T>;
  }

  get raw(): Map<string, unknown> {
    return this.data;
  }
}

function fakeStore(): { claims: InvoiceClaims; storage: FakeStorage } {
  const storage = new FakeStorage();
  const objects = new Map<string, InvoiceStoreDO>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const key = String(id);
      if (!objects.has(key)) {
        objects.set(key, new InvoiceStoreDO({ storage } as unknown as DurableObjectState));
      }
      return { fetch: (req: Request) => objects.get(key)!.fetch(req) };
    },
  };
  return { claims: claimsFor(namespace, MEZO_TESTNET.id)!, storage };
}

/** A fake Mezo RPC that answers one transfer to SHOP. */
function chainWith(pay: { tx: string; block: number; units: bigint; memo: string | null }, head = HEAD): Fetch {
  const one = (method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return "0x" + head.toString(16);
    if (method === "eth_getTransactionReceipt") {
      return params[0] === pay.tx
        ? { status: "0x1", from: PAYER, blockNumber: "0x" + pay.block.toString(16), to: MEZO_TESTNET.musd, logs: [{ address: MEZO_TESTNET.musd, topics: [TRANSFER_TOPIC, pad(PAYER), pad(SHOP)], data: "0x" + pay.units.toString(16) }] }
        : null;
    }
    if (method === "eth_getLogs") {
      const q = params[0] as { fromBlock: string; toBlock: string };
      return pay.block >= Number(q.fromBlock) && pay.block <= Number(q.toBlock)
        ? [{ transactionHash: pay.tx, blockNumber: "0x" + pay.block.toString(16), topics: [TRANSFER_TOPIC, pad(PAYER), pad(SHOP)], data: "0x" + pay.units.toString(16) }]
        : [];
    }
    if (method === "eth_getTransactionByHash") {
      return params[0] === pay.tx ? { input: buildTransferData(SHOP, pay.units, pay.memo), to: MEZO_TESTNET.musd } : null;
    }
    return null;
  };
  return async (_u, init) => {
    const b = JSON.parse(String(init!.body));
    const out = Array.isArray(b) ? b.map((x: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: x.id, result: one(x.method, x.params) })) : { jsonrpc: "2.0", id: b.id, result: one(b.method, b.params) };
    return new Response(JSON.stringify(out));
  };
}

describe("atomic claims", () => {
  it("lets only one of two concurrent creates take the same reference", async () => {
    const kv = memKV();
    const { claims, storage } = fakeStore();
    const [a, b] = await Promise.all([
      createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "1", memo: "INV-RACE" }, HEAD - 10, undefined, undefined, claims),
      createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "2", memo: "INV-RACE" }, HEAD - 10, undefined, undefined, claims),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0]!.ok) expect(losers[0]!.status).toBe(409);
    const stored = await claims.get(MEZO_TESTNET.id, "INV-RACE");
    expect(stored).toEqual(winners[0]!.ok ? winners[0]!.invoice : null);
    expect([...storage.raw.keys()].filter((k) => k === "inv:INV-RACE")).toHaveLength(1);
  });

  it("refuses a transaction hash that already paid a second invoice", async () => {
    const kv = memKV();
    const { claims } = fakeStore();
    const a = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-A" }, HEAD - 100, undefined, undefined, claims);
    const b = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-B" }, HEAD - 100, undefined, undefined, claims);
    if (!a.ok || !b.ok) throw new Error("expected both invoices");
    const paid = { txHash: h(90), block: HEAD - 50, from: PAYER, amount: "5", at: new Date().toISOString() };
    expect((await claims.pay(MEZO_TESTNET.id, a.invoice, paid)).status).toBe("paid");
    const second = await claims.pay(MEZO_TESTNET.id, b.invoice, paid);
    expect(second).toEqual({ status: "tx_used", owner: "INV-A" });
    expect((await claims.get(MEZO_TESTNET.id, "INV-B"))!.paid).toBeUndefined();
  });

  it("checks the transaction owner before the confirmation depth, so a shallow reused hash is tx_used", async () => {
    const kv = memKV();
    const { claims } = fakeStore();
    const a = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-OWN" }, HEAD - 100, undefined, undefined, claims);
    if (!a.ok) throw new Error("expected invoice");
    const other: StoredInvoice = { ...a.invoice, memo: "INV-OTHER" };
    await claims.import(MEZO_TESTNET.id, other);
    await claims.pay(MEZO_TESTNET.id, other, { txHash: h(71), block: HEAD - 20, from: PAYER, amount: "5", at: new Date().toISOString() });
    // The transaction pays INV-OWN and is shallow (2 confirmations). The old order answered "confirming".
    const f = chainWith({ tx: h(71), block: HEAD - 1, units: 5n * E, memo: "INV-OWN" });
    const c = await confirmInvoice(kv, MEZO_TESTNET, a.invoice, h(71), f, new Date(), claims);
    expect(c.status).toBe("tx_used");
  });

  it("honours a transaction claim that exists only in KV until the old invoice migrates", async () => {
    const kv = memKV();
    const { claims } = fakeStore();
    await kv.put(`tx:${MEZO_TESTNET.id}:${h(80)}`, "INV-LEGACY");
    const a = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "5", memo: "INV-NEW" }, HEAD - 100, undefined, undefined, claims);
    if (!a.ok) throw new Error("expected invoice");
    const f = chainWith({ tx: h(80), block: HEAD - 50, units: 5n * E, memo: "INV-NEW" });
    const c = await confirmInvoice(kv, MEZO_TESTNET, a.invoice, h(80), f, new Date(), claims);
    expect(c).toMatchObject({ status: "tx_used" });
    expect((await claims.get(MEZO_TESTNET.id, "INV-NEW"))!.paid).toBeUndefined();
  });

  it("migrates a KV-only invoice into the store on first read and keeps its paid transaction claimed", async () => {
    const kv = memKV();
    const { claims } = fakeStore();
    const legacy: StoredInvoice = {
      chainId: MEZO_TESTNET.id,
      to: SHOP,
      amount: "5",
      units: (5n * E).toString(),
      memo: "INV-65ZVUMXW",
      fromBlock: HEAD - 1000,
      createdAt: "2026-10-20T00:00:00.000Z",
      link: "ethereum:x",
      paid: { txHash: h(65), block: HEAD - 500, from: PAYER, amount: "5", at: "2026-10-20T01:00:00.000Z" },
    };
    await kv.put(`inv:${MEZO_TESTNET.id}:INV-65ZVUMXW`, JSON.stringify(legacy));
    expect(await claims.get(MEZO_TESTNET.id, "INV-65ZVUMXW")).toBeNull();
    const read = await getInvoice(kv, MEZO_TESTNET.id, "INV-65ZVUMXW", claims);
    expect(read).toEqual(legacy);
    expect(await claims.get(MEZO_TESTNET.id, "INV-65ZVUMXW")).toEqual(legacy);
    expect(await claims.owner(MEZO_TESTNET.id, h(65))).toBe("INV-65ZVUMXW");
  });

  it("does not let a create take a reference that exists only in KV", async () => {
    const kv = memKV();
    const { claims } = fakeStore();
    const legacy: StoredInvoice = {
      chainId: MEZO_TESTNET.id,
      to: SHOP,
      amount: "5",
      units: (5n * E).toString(),
      memo: "INV-OLD",
      fromBlock: HEAD - 1000,
      createdAt: "2026-10-20T00:00:00.000Z",
      link: "ethereum:x",
    };
    await kv.put(`inv:${MEZO_TESTNET.id}:INV-OLD`, JSON.stringify(legacy));
    const r = await createInvoice(kv, MEZO_TESTNET, { to: SHOP, amount: "9", memo: "INV-OLD" }, HEAD, undefined, undefined, claims);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(await claims.get(MEZO_TESTNET.id, "INV-OLD")).toEqual(legacy);
  });
});
