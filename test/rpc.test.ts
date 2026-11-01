import { encodeAbiParameters } from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalBlock, canonicalBlockHash, minedReceipt, minedTransaction } from "./chain-fixtures.ts";

import { MEZO_MAINNET, MEZO_TESTNET } from "../src/chains.ts";
import { buildTransferData } from "../src/guard.ts";
import {
  findDuplicatePayments,
  findPayments,
  rpc,
  rpcBatch,
  LOG_CHUNK,
  MAX_LOOKBACK,
  PAYMENT_SCAN_REQUEST_LIMIT,
  RPC_HTTP_TIMEOUT_MS,
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
const TEST_CHAIN_WITH_FALLBACK = { ...MEZO_TESTNET, rpcFallback: "https://fallback.invalid" };
const pad = (a: string) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");

function mockRpc(handlers: Record<string, (params: unknown[]) => unknown>): Fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    const answer = ({ method, params, id }: { method: string; params: unknown[]; id: number }) => {
      const h = handlers[method];
      if (!h) return { jsonrpc: "2.0", id, error: { message: "no " + method } };
      const result = h(params);
      // Ordinary fixtures represent mined transactions. Explicit overrides can still model bad data.
      const value = method === "eth_getTransactionByHash" && result && typeof result === "object"
        ? { ...minedTransaction(HASH, 100), ...result } : result;
      return { jsonrpc: "2.0", id, result: value };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
  };
}

function changeRpcResult(source: Fetch, change: (method: string, params: unknown[], result: unknown) => unknown): Fetch {
  return async (url, init) => {
    const request = JSON.parse(String(init!.body));
    const response = await source(url, init);
    const body = await response.json() as { id: number; result?: unknown } | { id: number; result?: unknown }[];
    const edit = (reply: { id: number; result?: unknown }) => {
      const query = Array.isArray(request) ? request.find((entry: { id: number }) => entry.id === reply.id) : request;
      return { ...reply, result: change(query.method, query.params, reply.result) };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(edit) : edit(body)), { status: response.status });
  };
}

function receipt(logs: { address: string; to: string; value: bigint }[], status = "0x1") {
  return {
    ...minedReceipt(HASH, 100),
    status,
    blockNumber: "0x64",
    to: MEZO_TESTNET.musd,
    logs: logs.map((l) => ({ address: l.address, topics: [TRANSFER_TOPIC, pad(SHOP), pad(l.to)], data: "0x" + l.value.toString(16).padStart(64, "0") })),
  };
}

const base = {
  eth_blockNumber: () => "0x6d",
  eth_getBlockByNumber: (params: unknown[]) => canonicalBlock(Number(params[0])),
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

  it("reports a direct transfer without the reference as paid_no_memo, not a failure", async () => {
    const f = mockRpc({
      ...base,
      eth_getTransactionByHash: () => ({ input: buildTransferData(SHOP, 5n, null), to: MEZO_TESTNET.musd }),
      eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]),
    });
    const r = await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, memo: "INV-1", includeMemo: true }, f);
    expect(r).toMatchObject({ status: "paid_no_memo", paid: "0.000000000000000005", memoMatched: false, memo: null, confirmations: 10, block: 100, txMemo: null });
  });

  it("matches the reference exactly, so a longer reference that ends the same does not count", async () => {
    const f = mockRpc({
      ...base,
      eth_getTransactionByHash: () => ({ input: buildTransferData(SHOP, 5n, "XINV-1"), to: MEZO_TESTNET.musd }),
      eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]),
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, memo: "INV-1" }, f)).toMatchObject({ status: "mismatch" });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, memo: "XINV-1" }, f)).toMatchObject({ status: "paid", memoMatched: true });
  });

  it("does not read a reference from a transaction sent to another contract", async () => {
    const f = mockRpc({
      ...base,
      eth_getTransactionByHash: () => ({ input: buildTransferData(SHOP, 5n, "INV-1"), to: "0x2222222222222222222222222222222222222222" }),
      eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]),
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, memo: "INV-1" }, f)).toMatchObject({ status: "mismatch" });
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
    const working = mockRpc({ ...base,
      eth_getTransactionReceipt: () => receipt([{ address: MEZO_MAINNET.musd, to: SHOP, value: 5n }]),
      eth_getTransactionByHash: () => ({ input: "0x", to: MEZO_MAINNET.musd }),
    });
    const f: Fetch = async (url, init) => {
      urls.push(url);
      if (url === MEZO_MAINNET.rpc) throw new Error("primary down");
      return working(url, init);
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

  it("uses a configured fallback when the primary answers null for a mined receipt", async () => {
    const working = mockRpc({ ...base,
      eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]),
      eth_getTransactionByHash: () => ({ input: "0x", to: MEZO_TESTNET.musd }),
    });
    const f: Fetch = async (url, init) => {
      const body = JSON.parse(String(init!.body));
      if (!Array.isArray(body) && url === MEZO_TESTNET.rpc && ["eth_getTransactionReceipt", "eth_getTransactionByHash"].includes(body.method)) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }));
      }
      return working(url, init);
    };
    expect(await verifyPayment(TEST_CHAIN_WITH_FALLBACK, { txHash: HASH, recipient: SHOP, amount: 5n }, f)).toMatchObject({ status: "paid" });
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

  it.each([null, "not-a-block", "0x", "0x00", "0x20000000000000"])("does not claim payment depth from an invalid head %s", async (head) => {
    const f = mockRpc({
      ...base,
      eth_blockNumber: () => head,
      eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]),
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f))
      .toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
  });

  it("does not invent a confirmation when the receipt is ahead of the observed head", async () => {
    const f = mockRpc({
      ...base,
      eth_blockNumber: () => "0x63",
      eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]),
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f))
      .toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
  });

  it("does not accept a receipt with a malformed block height", async () => {
    const f = mockRpc({
      ...base,
      eth_getTransactionReceipt: () => ({ ...receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]), blockNumber: "NaN" }),
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f))
      .toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
  });

  it.each([undefined, null, "0x2", "success", "0x00"])("does not mistake receipt status %s for a verified revert", async (status) => {
    const f = mockRpc({
      ...base,
      eth_getTransactionReceipt: () => ({ ...receipt([]), status }),
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f))
      .toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
  });

  it("keeps a shallow reverted transaction pending before the payer can retry", async () => {
    const f = mockRpc({ ...base, eth_blockNumber: () => "0x64", eth_getTransactionReceipt: () => receipt([], "0x0") });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f))
      .toEqual({ status: "pending", message: "The transaction reverted but has only 1 of 5 confirmations. Wait before any retry." });
  });

  it("does not accept a reverted receipt whose mined block is invalid", async () => {
    const f = mockRpc({ ...base, eth_getTransactionReceipt: () => ({ ...receipt([], "0x0"), blockNumber: null }) });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f))
      .toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
  });

  it.each(["0x1", "0x0"])("does not finalize status%s from a receipt in an orphaned block", async (status) => {
    const f = mockRpc({ ...base,
      eth_getTransactionReceipt: () => ({ ...receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }], status), blockHash: "0x" + "ef".repeat(32) }),
      eth_getTransactionByHash: () => ({ ...base.eth_getTransactionByHash(), blockHash: "0x" + "ef".repeat(32) }),
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f))
      .toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
  });

  it("requires receipt, transaction and canonical header to agree on the mined block", async () => {
    const source = mockRpc({ ...base, eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]) });
    for (const change of [{ blockHash: undefined }, { blockHash: "0x" + "ef".repeat(32) }, { blockNumber: "0x65" }, { hash: "0x" + "cd".repeat(32) }]) {
      const f = changeRpcResult(source, (method, _params, result) => method === "eth_getTransactionByHash" ? { ...(result as object), ...change } : result);
      expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f)).toMatchObject({ status: "unavailable" });
    }
  });

  it("keeps the result unavailable when the pinned head is reorganized during receipt checks", async () => {
    let heads = 0;
    const f = mockRpc({ ...base,
      eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]),
      eth_getBlockByNumber: (params) => {
        const height = Number(params[0]);
        return height === 109 && ++heads > 1 ? { ...canonicalBlock(height), hash: "0x" + "ef".repeat(32) } : canonicalBlock(height);
      },
    });
    expect(await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n }, f)).toMatchObject({ status: "unavailable" });
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
  type L = { tx: string; block: number; value: bigint; token?: string; blockHash?: string; removed?: boolean };
  function inbox(logs: L[], inputs: Record<string, { input: string; to: string }>, calls: { method: string; params: unknown[] }[] = [], requests: { n: number } = { n: 0 }): Fetch {
    const answer = (method: string, params: unknown[]) => {
      calls.push({ method, params });
      if (method === "eth_blockNumber") return "0x" + HEAD.toString(16);
      if (method === "eth_getBlockByNumber") return canonicalBlock(Number(params[0]));
      if (method === "eth_getTransactionByHash") {
        const hash = params[0] as string;
        const log = logs.find((entry) => entry.tx === hash);
        const input = inputs[hash];
        return input && log ? { ...minedTransaction(hash, log.block), blockHash: log.blockHash ?? canonicalBlockHash(log.block), ...input } : null;
      }
      if (method === "eth_getLogs") {
        const q = params[0] as { fromBlock: string; toBlock: string; topics: string[] };
        const [from, to] = [Number(q.fromBlock), Number(q.toBlock)];
        return logs
          .filter((l) => l.block >= from && l.block <= to)
          .sort((a, b) => a.block - b.block)
          .map((l) => ({ transactionHash: l.tx, blockNumber: "0x" + l.block.toString(16), blockHash: l.blockHash ?? canonicalBlockHash(l.block), removed: l.removed ?? false, topics: [TRANSFER_TOPIC, pad(PAYER), q.topics[2]], data: "0x" + l.value.toString(16) }));
      }
      return null;
    };
    return async (_url, init) => {
      requests.n++;
      const body = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
      if (Array.isArray(body)) return new Response(JSON.stringify(body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: answer(b.method, b.params) }))));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params) }));
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

  it("reports an unavailable network with the reason when the RPC is down", async () => {
    const f: Fetch = async () => {
      throw new Error("down");
    };
    expect(await findPayments(MEZO_TESTNET, { recipient: SHOP }, f)).toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE, detail: "down" });
  });

  it("stays far below the 50 subrequest limit of a Worker, even with 60 payments", async () => {
    const logs: L[] = [];
    const inputs: Record<string, { input: string; to: string }> = {};
    for (let i = 1; i <= 60; i++) {
      logs.push({ tx: h(i), block: HEAD - i * 300, value: 1n });
      inputs[h(i)] = direct(null, 1n);
    }
    const requests = { n: 0 };
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, fromBlock: 0 }, inbox(logs, inputs, [], requests));
    expect(requests.n).toBeLessThanOrEqual(6);
    expect(r.status === "ok" && r.payments.length).toBe(50);
    expect(r.status === "ok" && r.truncated).toBe(true);
    expect(r.status === "ok" && r.clamped).toBe(true);
  });

  it("marks the oldest payment with the reference as the one that paid, so a later one cannot take its place", async () => {
    const f = inbox(
      [
        { tx: h(1), block: HEAD - 30, value: 5n },
        { tx: h(2), block: HEAD - 3, value: 5n },
      ],
      { [h(1)]: direct("INV-7", 5n), [h(2)]: direct("INV-7", 5n) },
    );
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, fromBlock: HEAD - 100, memo: "INV-7", amount: 5n }, f);
    expect(r.status === "ok" && r.paid?.txHash).toBe(h(1));
  });

  it("flags a payment without a reference but with the exact amount as a possible match only", async () => {
    const f = inbox(
      [
        { tx: h(1), block: HEAD - 3, value: 5n },
        { tx: h(2), block: HEAD - 2, value: 6n },
      ],
      { [h(1)]: direct(null, 5n), [h(2)]: direct(null, 6n) },
    );
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.paid).toBeNull();
    expect(r.payments.find((p) => p.txHash === h(1))!.possible).toBe(true);
    expect(r.payments.find((p) => p.txHash === h(2))!.possible).toBe(false);
  });

  it("returns null for matches and possible when the search had no reference or no amount", async () => {
    const f = inbox([{ tx: h(1), block: HEAD - 3, value: 5n }], { [h(1)]: direct("INV-7", 5n) });
    const bare = await findPayments(MEZO_TESTNET, { recipient: SHOP }, f);
    if (bare.status !== "ok") throw new Error("expected ok");
    expect(bare.payments[0]).toMatchObject({ memo: "INV-7", matches: null, possible: null });
    expect(bare.paid).toBeNull();
    const amountOnly = await findPayments(MEZO_TESTNET, { recipient: SHOP, amount: 5n }, f);
    if (amountOnly.status !== "ok") throw new Error("expected ok");
    expect(amountOnly.payments[0]).toMatchObject({ matches: null, possible: false });
    const memoOnly = await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7" }, f);
    if (memoOnly.status !== "ok") throw new Error("expected ok");
    expect(memoOnly.payments[0]).toMatchObject({ matches: true, possible: null });
  });

  it("asks again for transactions that a lagging node answered as null", async () => {
    let first = true;
    const base = inbox([{ tx: h(1), block: HEAD - 1, value: 5n }], { [h(1)]: direct("INV-7", 5n) });
    const f: Fetch = async (url, init) => {
      const body = JSON.parse(String(init!.body));
      if (Array.isArray(body) && body[0].method === "eth_getTransactionByHash" && first) {
        first = false;
        return new Response(JSON.stringify(body.map((b: { id: number }) => ({ jsonrpc: "2.0", id: b.id, result: null }))));
      }
      return base(url, init);
    };
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f);
    expect(r.status === "ok" && r.paid?.txHash).toBe(h(1));
  });

  it("does not classify a known overpayment as unrelated when its transaction stays unavailable", async () => {
    // The unread transaction may carry INV-7. Its larger amount does not qualify for the exact-
    // amount possible-match warning, so treating the missing input as an absent memo would unlock Pay.
    const calls: { method: string; params: unknown[] }[] = [];
    const f = inbox([{ tx: h(1), block: HEAD - 1, value: 6n }], {}, calls);
    const r = await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f);
    expect(r).toMatchObject({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
    expect(calls.filter((c) => c.method === "eth_getTransactionByHash")).toHaveLength(3);
  });

  it("does not call a duplicate scan complete while a transfer input is unreadable", async () => {
    const f = inbox([{ tx: h(2), block: HEAD - 1, value: 6n }], {});
    expect(await findDuplicatePayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", paidBlock: HEAD - 10, paidTxHash: h(1) }, f))
      .toEqual({ checked: false, duplicates: [], fromBlock: null });
  });

  it("refuses logs from removed or orphaned blocks instead of marking an invoice paid", async () => {
    for (const change of [{ blockHash: "0x" + "ef".repeat(32) }, { removed: true }]) {
      const f = inbox([{ tx: h(1), block: HEAD - 1, value: 5n, ...change }], { [h(1)]: direct("INV-7", 5n) });
      expect(await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f)).toMatchObject({ status: "unavailable" });
    }
  });

  it("requires transaction metadata to match the log and its canonical block", async () => {
    const source = inbox([{ tx: h(1), block: HEAD - 1, value: 5n }], { [h(1)]: direct("INV-7", 5n) });
    for (const change of [{ blockHash: null }, { blockHash: "0x" + "ef".repeat(32) }, { blockNumber: "0x1" }, { hash: h(2) }]) {
      const f = changeRpcResult(source, (method, _params, result) => method === "eth_getTransactionByHash" ? { ...(result as object), ...change } : result);
      expect(await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f)).toMatchObject({ status: "unavailable" });
    }
  });

  it("refuses a scan when the pinned head changes after log classification", async () => {
    let heads = 0;
    const source = inbox([{ tx: h(1), block: HEAD - 1, value: 5n }], { [h(1)]: direct("INV-7", 5n) });
    const f = changeRpcResult(source, (method, params, result) => method === "eth_getBlockByNumber" && Number(params[0]) === HEAD && ++heads > 1
      ? { ...(result as object), hash: "0x" + "ef".repeat(32) } : result);
    expect(await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f)).toMatchObject({ status: "unavailable" });
  });

  it("caps actual HTTP requests when retries and lagging transaction reads exhaust the scan budget", async () => {
    let requests = 0;
    let transactionRounds = 0;
    const source = inbox([{ tx: h(1), block: HEAD - 1, value: 5n }], { [h(1)]: direct("INV-7", 5n) });
    const f: Fetch = async (url, init) => {
      requests++;
      if (requests % 3 !== 0) throw new Error("transient network failure");
      const body = JSON.parse(String(init!.body));
      if (Array.isArray(body) && body[0].method === "eth_getTransactionByHash" && ++transactionRounds < 3) {
        return new Response(JSON.stringify(body.map((query: { id: number }) => ({ jsonrpc: "2.0", id: query.id, result: null }))));
      }
      return source(url, init);
    };
    expect(await findPayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", amount: 5n }, f)).toMatchObject({ status: "unavailable" });
    expect(requests).toBe(PAYMENT_SCAN_REQUEST_LIMIT);
  });

  it("lists further payments with the same reference as duplicates, newest first, without the recorded one", async () => {
    const f = inbox(
      [
        { tx: h(1), block: HEAD - 30, value: 5n },
        { tx: h(2), block: HEAD - 20, value: 5n },
        { tx: h(3), block: HEAD - 2, value: 5n },
        { tx: h(4), block: HEAD - 1, value: 5n },
      ],
      { [h(1)]: direct("INV-7", 5n), [h(2)]: direct("INV-7", 5n), [h(3)]: direct("INV-8", 5n), [h(4)]: direct("INV-7", 5n) },
    );
    const r = await findDuplicatePayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", paidBlock: HEAD - 30, paidTxHash: h(1) }, f);
    expect(r.checked).toBe(true);
    expect(r.duplicates.map((d) => d.txHash)).toEqual([h(4), h(2)]);
    expect(r.duplicates[0]).toMatchObject({ block: HEAD - 1, from: PAYER, amount: "0.000000000000000005" });
  });

  it("does not call an empty duplicate list proof when the search was clamped", async () => {
    const f = inbox([{ tx: h(1), block: HEAD - 30_000, value: 5n }], { [h(1)]: direct("INV-7", 5n) });
    const r = await findDuplicatePayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", paidBlock: HEAD - 30_000, paidTxHash: h(1) }, f);
    expect(r.checked).toBe(false);
    expect(r.duplicates).toEqual([]);
  });

  it("reports an unreadable duplicate scan without hiding the paid invoice", async () => {
    const f: Fetch = async () => {
      throw new Error("down");
    };
    expect(await findDuplicatePayments(MEZO_TESTNET, { recipient: SHOP, memo: "INV-7", paidBlock: 1, paidTxHash: h(1) }, f)).toEqual({ checked: false, duplicates: [], fromBlock: null });
  });
});

describe("rpcBatch", () => {
  it("retries the batch on the other endpoint when one item has an error", async () => {
    const urls: string[] = [];
    const f: Fetch = async (url, init) => {
      urls.push(url);
      const body = JSON.parse(String(init!.body)) as { id: number }[];
      const broken = url === MEZO_TESTNET.rpc;
      return new Response(JSON.stringify(body.map((b) => (broken && b.id === 1 ? { jsonrpc: "2.0", id: b.id, error: { message: "method does not exist" } } : { jsonrpc: "2.0", id: b.id, result: b.id }))));
    };
    const calls = [0, 1, 2].map(() => ({ method: "eth_blockNumber", params: [] }));
    expect(await rpcBatch(TEST_CHAIN_WITH_FALLBACK, calls, f)).toEqual([0, 1, 2]);
    expect(urls).toEqual([MEZO_TESTNET.rpc, TEST_CHAIN_WITH_FALLBACK.rpcFallback]);
  });

  it("matches answers by id even when the node returns them out of order", async () => {
    const f: Fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { id: number }[];
      return new Response(JSON.stringify([...body].reverse().map((b) => ({ jsonrpc: "2.0", id: b.id, result: `r${b.id}` }))));
    };
    expect(await rpcBatch(MEZO_TESTNET, [{ method: "a", params: [] }, { method: "b", params: [] }], f)).toEqual(["r0", "r1"]);
  });

  it("treats null as an error when nulls are not allowed, and throws after every try", async () => {
    const f: Fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { id: number }[];
      return new Response(JSON.stringify(body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: null }))));
    };
    await expect(rpcBatch(MEZO_TESTNET, [{ method: "eth_getLogs", params: [] }], f, { allowNull: false })).rejects.toThrow("null");
    expect(await rpcBatch(MEZO_TESTNET, [{ method: "x", params: [] }], f)).toEqual([null]);
  });
});

describe.each([
  { kind: "single", read: (fetch: Fetch) => rpc<string>(TEST_CHAIN_WITH_FALLBACK, "eth_chainId", [], fetch), expected: "0x7b7b" },
  { kind: "batch", read: (fetch: Fetch) => rpcBatch<string>(TEST_CHAIN_WITH_FALLBACK, [{ method: "eth_chainId", params: [] }], fetch), expected: ["0x7b7b"] },
])("$kind RPC HTTP deadline", ({ read, expected }) => {
  it.each(["responsive", "stalled"])("cancels an unread HTTP error body with %s cancellation and preserves its status", async (cancellation) => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = []; let cancellations = 0;
      const fetch: Fetch = async (_url, init) => {
        signals.push(init!.signal!);
        return new Response(new ReadableStream({ cancel() {
          cancellations++;
          if (cancellation === "stalled") return new Promise<void>(() => {});
        } }), { status: 503 });
      };
      const outcome = read(fetch).then(() => null, (error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({ message: expect.stringMatching(/RPC (?:eth_chainId|batch) HTTP 503/) });
      expect(cancellations).toBe(3);
      expect(signals).toHaveLength(3);
      expect(signals.every((signal) => signal.aborted)).toBe(cancellation === "stalled");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["fetch", "body"])("aborts a stalled %s and proceeds to the fallback with no deadline timers left", async (stage) => {
    vi.useFakeTimers();
    try {
      const urls: string[] = []; const signals: AbortSignal[] = []; let bodyAborted = false;
      const fetch: Fetch = async (url, init) => {
        urls.push(url); const signal = init!.signal!; signals.push(signal);
        if (urls.length === 1) {
          if (stage === "fetch") return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Transport aborted", "AbortError")), { once: true });
          });
          // Spend half the deadline receiving headers, then hang while consuming the body. The
          // deadline must cover both stages together, rather than restart when fetch resolves.
          await new Promise<void>((resolve) => setTimeout(resolve, RPC_HTTP_TIMEOUT_MS / 2));
          return new Response(new ReadableStream({ start(controller) {
            signal.addEventListener("abort", () => { bodyAborted = true; controller.error(new DOMException("Body aborted", "AbortError")); }, { once: true });
          } }));
        }
        const request = JSON.parse(String(init!.body));
        const answer = (entry: { id: number }) => ({ jsonrpc: "2.0", id: entry.id, result: "0x7b7b" });
        return new Response(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
      };
      const pending = read(fetch);
      await vi.advanceTimersByTimeAsync(RPC_HTTP_TIMEOUT_MS - 1);
      expect(urls).toEqual([TEST_CHAIN_WITH_FALLBACK.rpc]);
      expect(signals[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]!.aborted).toBe(true);
      if (stage === "body") expect(bodyAborted).toBe(true);
      await vi.advanceTimersByTimeAsync(retry.delayMs);
      expect(await pending).toEqual(expected);
      expect(urls).toEqual([TEST_CHAIN_WITH_FALLBACK.rpc, TEST_CHAIN_WITH_FALLBACK.rpcFallback]);
      expect(signals[1]!.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(RPC_HTTP_TIMEOUT_MS);
      expect(signals[1]!.aborted).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each(["fetch", "body"])("bounds all attempts even if a custom stalled %s ignores abort", async (stage) => {
    vi.useFakeTimers();
    try {
      const urls: string[] = []; const signals: AbortSignal[] = [];
      const fetch: Fetch = async (url, init) => {
        urls.push(url); signals.push(init!.signal!);
        if (stage === "fetch") return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ start() { /* Never produces or closes a body. */ } }));
      };
      // Attach rejection handling before advancing the deadline clock.
      const outcome = read(fetch).then(() => null, (error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({ message: "RPC request timed out" });
      expect(urls).toEqual([TEST_CHAIN_WITH_FALLBACK.rpc, TEST_CHAIN_WITH_FALLBACK.rpcFallback, TEST_CHAIN_WITH_FALLBACK.rpc]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("payment verification HTTP deadline", () => {
  it("keeps a timed-out receipt check unavailable with the public retry message", async () => {
    vi.useFakeTimers();
    try {
      const fetch: Fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("private transport details")), { once: true });
      });
      const pending = verifyPayment(TEST_CHAIN_WITH_FALLBACK, { txHash: HASH, recipient: SHOP, amount: 5n }, fetch);
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
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
  it("every configured endpoint serves the right chain and can read blocks and balances", async () => {
    for (const c of [MEZO_TESTNET, MEZO_MAINNET]) {
      for (const url of [c.rpc, ...(c.rpcFallback ? [c.rpcFallback] : [])]) {
        // Retry transport/RPC errors on this exact endpoint. A wrong chain still fails immediately;
        // a healthy fallback must not hide a broken endpoint in this availability check.
        const endpoint = { ...c, rpc: url, rpcFallback: undefined };
        const result = await rpc<string>(endpoint, "eth_chainId", []);
        expect(Number(result), url).toBe(c.id);
        const header = await rpc<{ number: string; hash: string }>(endpoint, "eth_getBlockByNumber", ["latest", false]);
        expect(header?.hash, url).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(header?.number, url).toMatch(/^0x[0-9a-f]+$/i);
        const balance = await rpc<string>(endpoint, "eth_getBalance", [SHOP, "latest"]);
        expect(balance, url).toMatch(/^0x[0-9a-f]+$/i);
      }
    }
  }, 30000);
  it("verifies the project's own 5 MUSD payment of invoice INV-65ZVUMXW (26 Oct 2026)", async () => {
    const own = { txHash: "0x7abfedb120383f817134e5e63823aef69948930fa9760c6b96fb03a87909cc0b", recipient: "0x94958151D1789C8279a67f5cE4631e9DDdE43cB6", amount: 5n * 10n ** 18n };
    expect(await verifyPayment(MEZO_TESTNET, { ...own, memo: "INV-65ZVUMXW", fromBlock: 16370824 })).toMatchObject({ status: "paid", paid: "5", memoMatched: true, block: 16370829 });
    expect((await verifyPayment(MEZO_TESTNET, { ...own, memo: "INV-0001" })).status).toBe("mismatch");
    expect((await verifyPayment(MEZO_TESTNET, { ...own, memo: "INV-65ZVUMXW", fromBlock: 16370830 })).status).toBe("mismatch");
  }, 60000);
  it("finds recent MUSD transfers to an active testnet address", async () => {
    const r = await findPayments(MEZO_TESTNET, { recipient: "0x64237b334f24b5d54B2A83ae0f8A9B74E29Cd564" });
    expect(r.status).toBe("ok");
  }, 60000);
});
