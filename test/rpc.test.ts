import { encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";

import { MEZO_MAINNET, MEZO_TESTNET } from "../src/chains.ts";
import { readBalance, readTokenInfo, TRANSFER_TOPIC, verifyPayment, type Fetch } from "../src/rpc.ts";

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

  it("reports a memo that does not match", async () => {
    const f = mockRpc({ ...base, eth_getTransactionReceipt: () => receipt([{ address: MEZO_TESTNET.musd, to: SHOP, value: 5n }]) });
    const r = await verifyPayment(MEZO_TESTNET, { txHash: HASH, recipient: SHOP, amount: 5n, memo: "INV-2" }, f);
    expect(r).toMatchObject({ status: "paid", memoMatched: false });
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

  it("refuses a malformed hash without any network call", async () => {
    const f: Fetch = async () => {
      throw new Error("network used");
    };
    expect(await verifyPayment(MEZO_TESTNET, { txHash: "0x12", recipient: SHOP, amount: 1n }, f)).toMatchObject({ status: "not_found" });
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
});
