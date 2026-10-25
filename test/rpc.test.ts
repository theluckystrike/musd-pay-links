import { encodeAbiParameters } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import { MEZO_MAINNET, MEZO_TESTNET } from "../src/chains.ts";
import { buildTransferData } from "../src/guard.ts";
import {
  findPayments,
  LOG_CHUNK,
  MAX_LOOKBACK,
  memoFromInput,
  NETWORK_UNAVAILABLE_MESSAGE,
  readBalance,
  readTokenInfo,
  retry,
  TRANSFER_TOPIC,
  verifyPayment,
  type Fetch,
} from "../src/rpc.ts";

beforeAll(() => {
  retry.delayMs = 1;
});

const SHOP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const HASH = "0x" + "ab".repeat(32);
const pad = (a: string) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");

function mockRpc(handlers: Record<string, (params: unknown[]) => unknown>): Fetch {
  return async (_url, init) => {
    const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] };
    const h = handlers[method];
    if (!h) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "no " + method } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: h(params) }));
  };
}

function receipt(logs: { address: string; to: string; value: bigint }[], status = "0x1") {
  return {
    status,
    blockNumber: "0x64",
    to: MEZO_TESTNET.musd,
    logs: logs.map((l) => ({ address: l.address, topics: [TRANSFER_TOPIC, pad(SHOP), pad(l.to)], data: "0x" + l.value.toString(16).padStart(64, "0") })),
  };
}

const base = {
  eth_blockNumber: () => "0x6d",
  eth_getTransactionByHash: () => ({ input: "0xa9059cbb" + "00".repeat(64) + "494e562d31", to: MEZO_TESTNET.musd }),
};

describe("verifyPayment", () => {
  it("reports paid with confirmations and a matched memo", async () => {
    const f = mockRpc({ ...base, eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]) });
    const r = await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, memo: "INV-1" }, f);
    expect(r).toEqual({ status: "paid", paid: "0.000000000000000005", confirmations: 10, memoMatched: true, block: 100 });
  });

  it("refuses a payment whose input does not carry the invoice reference", async () => {
    const f = mockRpc({ ...base, eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]) });
    const r = await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, memo: "INV-2" }, f);
    expect(r).toMatchObject({ status: "mismatch" });
  });

  it("ignores Transfer events from a fake token contract", async () => {
    const fake = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac504";
    const f = mockRpc({ ...base, eth_getTransactionReceipt: () => receipt([{ address: fake, to: SHOP, value: 10n ** 30n }]) });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 1n }, f)).toMatchObject({ status: "mismatch" });
  });

  it("ignores mainnet MUSD events when checking testnet", async () => {
    const f = mockRpc({ ...base, eth_getTransactionReceipt: () => receipt([{ address: MEZO_MAINNET.musd, to: SHOP, value: 9n }]) });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 1n }, f)).toMatchObject({ status: "mismatch" });
  });

  it("sums several transfers to the recipient in one transaction", async () => {
    const f = mockRpc({
      ...base,
      eth_getTransactionReceipt: () =>
        receipt([
          { address: MEZO_TESTNET.musd, to: SHOP, value: 3n },
          { address: MEZO_TESTNET.musd, to: SHOP, value: 4n },
        ]),
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 7n }, f)).toMatchObject({ status: "paid", paid: "0.000000000000000007" });
  });

  it("reports underpayment, a reverted transaction, a pending one and an unknown one", async () => {
    const under = mockRpc({ ...base, eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 4n }]) });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, under)).toMatchObject({ status: "mismatch" });
    const failed = mockRpc({ ...base, eth_getTransactionReceipt: () => receipt([], "0x0") });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, failed)).toMatchObject({ status: "failed" });
    const pending = mockRpc({ ...base, eth_getTransactionReceipt: () => null });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, pending)).toMatchObject({ status: "pending" });
    const none = mockRpc({ ...base, eth_getTransactionByHash: () => null, eth_getTransactionReceipt: () => null });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, none)).toMatchObject({ status: "not_found" });
  });

  it("retries when a lagging RPC node answers null for a mined transaction", async () => {
    let calls = 0;
    const f = mockRpc({
      ...base,
      eth_getTransactionReceipt: () => (++calls < 3 ? null : receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }])),
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f)).toMatchObject({ status: "paid" });
    expect(calls).toBe(3);
  });

  it("retries a transport error twice and then answers", async () => {
    let calls = 0;
    const f = mockRpc({
      ...base,
      eth_getTransactionReceipt: () => {
        calls++;
        if (calls <= 2) throw new Error("network down");
        return receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]);
      },
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f)).toMatchObject({ status: "paid" });
    expect(calls).toBe(3);
  });

  it("falls back to the second documented mainnet endpoint when the first does not answer", async () => {
    const urls: string[] = [];
    const f: Fetch = async (url, init) => {
      urls.push(url);
      if (url === MEZO_MAINNET.rpc) throw new Error("primary down");
      const { method } = JSON.parse(String(init!.body)) as { method: string };
      const result =
        method === "eth_getTransactionReceipt"
          ? receipt([{ address: MEZO_MAINNET.musd, to: SHOP, value: 5n }])
          : method === "eth_getTransactionByHash"
            ? { input: "0x", to: MEZO_MAINNET.musd }
            : "0x6d";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    };
    expect(await verifyPayment(MEZO_MAINNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f)).toMatchObject({ status: "paid" });
    expect(urls).toContain(MEZO_MAINNET.rpcFallback);
  });

  it("reports an unavailable network, not an invalid payment, when every RPC try fails", async () => {
    const f: Fetch = async () => {
      throw new Error("network down");
    };
    const r = await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f);
    expect(r).toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
  });

  it("falls back to the second testnet endpoint when the first answers null for a mined receipt", async () => {
    const f: Fetch = async (url, init) => {
      const { method } = JSON.parse(String(init!.body)) as { method: string };
      const lagging = url === MEZO_TESTNET.rpc && method !== "eth_blockNumber";
      const result = lagging
        ? null
        : method === "eth_getTransactionReceipt"
          ? receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }])
          : method === "eth_getTransactionByHash"
            ? { input: "0x", to: MEZO_TESTNET.musd }
            : "0x6d";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    };
    expect(MEZO_TESTNET.rpcFallback).toBe("https://mezo-testnet.drpc.org");
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f)).toMatchObject({ status: "paid" });
  });

  it("refuses a payment mined before the invoice block, so an old transfer cannot be replayed", async () => {
    const f = mockRpc({ ...base, eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]) });
    const old = await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, fromBlock: 101 }, f);
    expect(old).toMatchObject({ status: "mismatch" });
    expect((old as { message: string }).message).toContain("before the invoice was created in block 101");
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, fromBlock: 100 }, f)).toMatchObject({ status: "paid" });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, fromBlock: null }, f)).toMatchObject({ status: "paid" });
  });

  it("refuses a malformed hash without any network call", async () => {
    const f: Fetch = async () => {
      throw new Error("network used");
    };
    expect(await verifyPayment(MEZO_TESTNET, { txHash: "0x12", recipient: SHOP, amount: 1n }, f)).toMatchObject({ status: "not_found" });
  });
});

describe("memoFromInput", () => {
  it("reads back the reference the guard appended", () => {
    expect(memoFromInput(buildTransferData(SHOP, 5n, "INV-1042"))).toBe("INV-1042");
    expect(memoFromInput(buildTransferData(SHOP, 5n, "a.b_c:d/e-F9"))).toBe("a.b_c:d/e-F9");
  });

  it("returns null for a plain transfer, another function or bytes that are not a valid memo", () => {
    expect(memoFromInput(buildTransferData(SHOP, 5n, null))).toBeNull();
    expect(memoFromInput("0x095ea7b3" + "00".repeat(64) + "41")).toBeNull();
    expect(memoFromInput(buildTransferData(SHOP, 5n, null) + "00ff")).toBeNull();
    expect(memoFromInput(buildTransferData(SHOP, 5n, null) + "23")).toBeNull(); // "#"
    expect(memoFromInput(buildTransferData(SHOP, 5n, null) + "4")).toBeNull(); // odd length
    expect(memoFromInput(buildTransferData(SHOP, 5n, null) + "41".repeat(33))).toBeNull(); // 33 characters
  });
});

describe("findPayments", () => {
  const PAYER = "0x1111111111111111111111111111111111111111";
  const HEAD = 1_000_000;
  type L = { tx: string; block: number; value: bigint; token?: string };
  function inbox(logs: L[], inputs: Record<string, { input: string; to: string }>, calls: { method: string; params: unknown[] }[] = []): Fetch {
    return async (_url, init) => {
      const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] };
      calls.push({ method, params });
      let result: unknown = null;
      if (method === "eth_blockNumber") result = "0x" + HEAD.toString(16);
      if (method === "eth_getTransactionByHash") result = inputs[params[0] as string] ?? null;
      if (method === "eth_getLogs") {
        const q = params[0] as { fromBlock: string; toBlock: string; topics: string[] };
        const [from, to] = [Number(q.fromBlock), Number(q.toBlock)];
        result = logs
          .filter((l) => l.block >= from && l.block <= to)
          .sort((a, b) => a.block - b.block)
          .map((l) => ({ transactionHash: l.tx, blockNumber: "0x" + l.block.toString(16), topics: [TRANSFER_TOPIC, pad(PAYER), q.topics[2]], data: "0x" + l.value.toString(16) }));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    };
  }
  const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
  const direct = (memo: string | null, amount = 5n * 10n ** 18n) => ({ input: buildTransferData(SHOP, amount, memo), to: MEZO_TESTNET.musd });

  it("finds the payment that carries the invoice reference, newest first, with no hash from the payer", async () => {
    const f = inbox(
      [
        { tx: h(1), block: HEAD - 50, value: 5n * 10n ** 18n },
        { tx: h(2), block: HEAD - 10, value: 5n * 10n ** 18n },
        { tx: h(3), block: HEAD - 5, value: 1n },
      ],
      { [h(1)]: direct("INV-7"), [h(2)]: direct("INV-8"), [h(3)]: direct(null, 1n) },
    );
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, fromBlock: HEAD - 100, memo: "INV-7", amount: 5n * 10n ** 18n }, f);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.payments.map((p) => p.txHash)).toEqual([h(3), h(2), h(1)]);
    expect(r.payments.map((p) => p.memo)).toEqual([null, "INV-8", "INV-7"]);
    expect(r.paid?.txHash).toBe(h(1));
    expect(r.paid?.from).toBe(PAYER);
  });

  it("does not count a payment with the right reference but too little MUSD", async () => {
    const f = inbox([{ tx: h(1), block: HEAD - 1, value: 4n }], { [h(1)]: direct("INV-7", 4n) });
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f);
    expect(r.status === "ok" && r.paid).toBeNull();
  });

  it("ignores payments before the invoice block", async () => {
    const f = inbox([{ tx: h(1), block: HEAD - 200, value: 5n }], { [h(1)]: direct("INV-7", 5n) });
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, fromBlock: HEAD - 100, memo: "INV-7", amount: 5n }, f);
    expect(r.status === "ok" && r.payments).toEqual([]);
  });

  it("does not read a memo from a transaction sent to another contract", async () => {
    const f = inbox([{ tx: h(1), block: HEAD - 1, value: 5n }], { [h(1)]: { input: buildTransferData(SHOP, 5n, "INV-7"), to: "0x2222222222222222222222222222222222222222" } });
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f);
    expect(r.status === "ok" && r.payments[0]!.memo).toBeNull();
  });

  it("sums several transfers to the merchant inside one transaction", async () => {
    const f = inbox(
      [
        { tx: h(1), block: HEAD - 1, value: 2n },
        { tx: h(1), block: HEAD - 1, value: 3n },
      ],
      { [h(1)]: direct("INV-7", 2n) },
    );
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f);
    expect(r.status === "ok" && r.payments.length).toBe(1);
    expect(r.status === "ok" && r.paid?.amount).toBe("0.000000000000000005");
  });

  it("asks for at most LOG_CHUNK blocks per call and never looks back more than MAX_LOOKBACK", async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    await findPayments(MEZO_TESTNET, { recipient: SHOP, fromBlock: 0 }, inbox([], {}, calls));
    const ranges = calls.filter((c) => c.method === "eth_getLogs").map((c) => c.params[0] as { fromBlock: string; toBlock: string });
    expect(ranges.length).toBe(Math.ceil((MAX_LOOKBACK + 1) / LOG_CHUNK));
    for (const q of ranges) expect(Number(q.toBlock) - Number(q.fromBlock) + 1).toBeLessThanOrEqual(LOG_CHUNK);
    expect(Math.min(...ranges.map((q) => Number(q.fromBlock)))).toBe(HEAD - MAX_LOOKBACK);
    expect(Math.max(...ranges.map((q) => Number(q.toBlock)))).toBe(HEAD);
  });

  it("filters logs by the MUSD contract and the merchant address", async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    await findPayments(MEZO_TESTNET, { recipient: SHOP, fromBlock: HEAD - 10 }, inbox([], {}, calls));
    const q = calls.find((c) => c.method === "eth_getLogs")!.params[0] as { address: string; topics: (string | null)[] };
    expect(q.address).toBe(MEZO_TESTNET.musd);
    expect(q.topics).toEqual([TRANSFER_TOPIC, null, pad(SHOP)]);
  });

  it("reports an unavailable network when the RPC is down", async () => {
    const f: Fetch = async () => {
      throw new Error("down");
    };
    expect(await findPayments(MEZO_TESTNET, { recipient: SHOP }, f)).toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
  });
});

describe("readTokenInfo and readBalance", () => {
  const str = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);
  const num = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
  const tokenRpc = (chainId: string) =>
    mockRpc({
      eth_chainId: () => chainId,
      eth_blockNumber: () => "0x10",
      eth_call: (p) => {
        const sel = (p[0] as { data: string }).data.slice(0, 10);
        return { "0x06fdde03": str("Mezo USD"), "0x95d89b41": str("MUSD"), "0x313ce567": num(18n), "0x18160ddd": num(10n ** 24n), "0x70a08231": num(42n) }[sel];
      },
    });

  it("decodes the token metadata", async () => {
    expect(await readTokenInfo(MEZO_TESTNET, tokenRpc("0x7b7b"))).toMatchObject({ name: "Mezo USD", symbol: "MUSD", decimals: 18, totalSupply: "1000000", block: 16 });
  });

  it("refuses an RPC that serves a different chain", async () => {
    await expect(readTokenInfo(MEZO_TESTNET, tokenRpc("0x1"))).rejects.toThrow("expected 31611");
  });

  it("reads a balance", async () => {
    expect(await readBalance(MEZO_TESTNET, SHOP, tokenRpc("0x7b7b"))).toBe(42n);
  });
});

describe.runIf(process.env.LIVE === "1")("live Mezo RPC (LIVE=1)", () => {
  it("testnet MUSD reports Mezo USD, MUSD, 18 decimals", async () => {
    expect(await readTokenInfo(MEZO_TESTNET)).toMatchObject({ name: "Mezo USD", symbol: "MUSD", decimals: 18 });
  }, 30000);
  it("mainnet MUSD reports Mezo USD, MUSD, 18 decimals", async () => {
    expect(await readTokenInfo(MEZO_MAINNET)).toMatchObject({ name: "Mezo USD", symbol: "MUSD", decimals: 18 });
  }, 30000);
  it("both testnet endpoints and both mainnet endpoints serve the right chain", async () => {
    for (const c of [MEZO_TESTNET, MEZO_MAINNET]) {
      for (const url of [c.rpc, c.rpcFallback!]) {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
        expect(Number(((await res.json()) as { result: string }).result)).toBe(c.id);
      }
    }
  }, 30000);
  it("finds recent MUSD transfers to an active testnet address", async () => {
    const r = await findPayments(MEZO_TESTNET, { recipient: "0x64237b334f24b5d54B2A83ae0f8A9B74E29Cd564" });
    expect(r.status).toBe("ok");
  }, 60000);
});
