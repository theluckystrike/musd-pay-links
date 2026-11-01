import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { type OpenTroveTransaction } from "../src/borrow-action.ts";
import { verifyOpenTrove } from "../src/borrow-receipt.ts";
import { MEZO_MAINNET, MEZO_TESTNET } from "../src/chains.ts";
import { retry, TRANSFER_TOPIC, type Fetch } from "../src/rpc.ts";

retry.delayMs = 1;
const E = 10n ** 18n;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const NEW_BLOCK_HASH = `0x${"ef".repeat(32)}`;
const ABI = parseAbi([
  "function openTrove(uint256,address,address) payable",
  "function getTroveStatus(address) view returns (uint256)",
  "function getTroveDebt(address) view returns (uint256)",
  "function getTroveColl(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const DATA = encodeFunctionData({ abi: ABI, functionName: "openTrove", args: [1800n * E, ZERO, ZERO] });
const expected: OpenTroveTransaction = {
  from: ACCOUNT, to: MEZO_TESTNET.system.borrowerOperations, chainId: "0x7b7b", data: DATA,
  value: "0x16345785d8a0000", nonce: "0x7", gas: "0xf4240", gasPrice: "0x3b9aca00",
};
const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;

interface Options {
  chainId?: unknown;
  tx?: Record<string, unknown> | null;
  receipt?: Record<string, unknown> | null;
  head?: unknown;
  headAfter?: unknown;
  header?: Record<string, unknown> | null;
  headerAfter?: Record<string, unknown> | null;
  receiptAfter?: Record<string, unknown> | null;
  state?: Partial<Record<"getTroveStatus" | "getTroveDebt" | "getTroveColl" | "balanceOf", bigint>>;
  stateError?: boolean;
  chainAfter?: unknown;
  stateRaw?: string;
}
interface Seen { method: string; params: unknown[]; fn?: string }

function fixture(options: Options = {}, seen: Seen[] = []): Fetch {
  let receipts = 0, headers = 0, heads = 0, chains = 0;
  return async (_url, init) => {
    const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] };
    const record: Seen = { method, params };
    seen.push(record);
    let result: unknown;
    if (method === "eth_chainId") result = ++chains > 1 && "chainAfter" in options ? options.chainAfter : options.chainId ?? "0x7b7b";
    else if (method === "eth_getTransactionByHash") result = "tx" in options ? options.tx : transaction();
    else if (method === "eth_getTransactionReceipt") result = ++receipts > 1 && "receiptAfter" in options ? options.receiptAfter : "receipt" in options ? options.receipt : receipt();
    else if (method === "eth_blockNumber") result = ++heads > 1 && "headAfter" in options ? options.headAfter : options.head ?? "0x3ec";
    else if (method === "eth_getBlockByNumber") result = ++headers > 1 && "headerAfter" in options ? options.headerAfter : "header" in options ? options.header : { number: "0x3e8", hash: BLOCK_HASH };
    else if (method === "eth_call") {
      const tx = params[0] as { data: `0x${string}` };
      const decoded = decodeFunctionData({ abi: ABI, data: tx.data });
      record.fn = decoded.functionName;
      if (options.stateError) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "state unavailable" } }));
      const state = { getTroveStatus: 1n, getTroveDebt: 2001n * E + 8n * E / 10n, getTroveColl: E / 10n, balanceOf: 25n * E, ...options.state };
      if (decoded.functionName === "openTrove") throw new Error("Receipt verification must never simulate or send openTrove");
      result = options.stateRaw ?? word(state[decoded.functionName]);
    } else throw new Error(`Unexpected fixture RPC ${method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { hash: HASH, from: ACCOUNT, to: MEZO_TESTNET.system.borrowerOperations, input: DATA, value: expected.value, nonce: expected.nonce, blockNumber: "0x3e8", blockHash: BLOCK_HASH, chainId: "0x7b7b", ...overrides };
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionHash: HASH, from: ACCOUNT, to: MEZO_TESTNET.system.borrowerOperations,
    blockNumber: "0x3e8", blockHash: BLOCK_HASH, status: "0x1",
    logs: [{ address: MEZO_TESTNET.musd, topics: [TRANSFER_TOPIC, topic(ZERO), topic(ACCOUNT)], data: word(1800n * E) }],
    ...overrides,
  };
}

const input = { account: ACCOUNT, hash: HASH, expected };

describe("verifyOpenTrove", () => {
  it("confirms exact transaction identity, mint and actual state at its canonical block after five confirmations", async () => {
    const seen: Seen[] = [];
    const result = await verifyOpenTrove(MEZO_TESTNET, input, fixture({}, seen));
    expect(result).toMatchObject({ status: "confirmed", hash: HASH, block: 1000, blockHash: BLOCK_HASH, confirmations: 5, required: 5, mintedMUSD: 1800n * E });
    expect(result.position).toEqual({ status: 1n, collateral: E / 10n, debt: 2001n * E + 8n * E / 10n, musdBalance: 25n * E });
    // The live observed wallet balance need not equal the mint; other transactions can run in that block.
    expect(result.position!.musdBalance).not.toBe(result.mintedMUSD);
    const reads = seen.filter((request) => request.method === "eth_call");
    expect(reads).toHaveLength(4);
    expect(reads.every((request) => request.params[1] === "0x3e8")).toBe(true);
    expect(seen.some((request) => /send|sign|personal|wallet/i.test(request.method))).toBe(false);
  });

  it("keeps absent transactions and missing receipts pending without reading position state", async () => {
    for (const options of [{ tx: null, receipt: null }, { tx: transaction({ blockNumber: null, blockHash: null }), receipt: null }]) {
      const seen: Seen[] = [];
      expect((await verifyOpenTrove(MEZO_TESTNET, input, fixture(options, seen))).status).toBe("pending");
      expect(seen.some((request) => request.method === "eth_call")).toBe(false);
    }
  });

  it("requires the confirmation floor before returning a successful position", async () => {
    const seen: Seen[] = [];
    const result = await verifyOpenTrove(MEZO_TESTNET, input, fixture({ head: "0x3eb" }, seen));
    expect(result).toMatchObject({ status: "confirming", confirmations: 4, required: 5 });
    expect(result.position).toBeUndefined();
    expect(seen.some((request) => request.method === "eth_call")).toBe(false);
  });

  it("checks the documented fallback when the primary RPC has no historical receipt", async () => {
    const base = fixture();
    const receiptURLs: string[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const request = JSON.parse(String(init!.body)) as { method: string };
      if (request.method === "eth_getTransactionReceipt") {
        receiptURLs.push(String(url));
        if (receiptURLs.length === 1) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
      }
      return base(url, init);
    };
    const result = await verifyOpenTrove(MEZO_TESTNET, input, fetchImpl);
    expect(result.status).toBe("confirmed");
    expect(receiptURLs.length).toBeGreaterThanOrEqual(2);
    expect(receiptURLs[1]).not.toBe(receiptURLs[0]);
  });

  it("does not label a shallow revert final, but reports a deep canonical revert as failed", async () => {
    const reverted = receipt({ status: "0x0", logs: [] });
    const shallow = await verifyOpenTrove(MEZO_TESTNET, input, fixture({ receipt: reverted, head: "0x3eb" }));
    expect(shallow).toMatchObject({ status: "pending", confirmations: 4 });
    const seen: Seen[] = [];
    const deep = await verifyOpenTrove(MEZO_TESTNET, input, fixture({ receipt: reverted }, seen));
    expect(deep).toMatchObject({ status: "failed", confirmations: 5 });
    expect(deep.position).toBeUndefined();
    expect(seen.some((request) => request.method === "eth_call")).toBe(false);
  });

  it("refuses mainnet and a substituted deployment without making RPC requests", async () => {
    const seen: Seen[] = [];
    expect((await verifyOpenTrove(MEZO_MAINNET, input, fixture({}, seen))).status).toBe("unavailable");
    expect((await verifyOpenTrove({ ...MEZO_TESTNET, musd: OTHER }, input, fixture({}, seen))).status).toBe("unavailable");
    expect(seen).toHaveLength(0);
  });

  it("fails closed on the wrong RPC chain or mismatched transaction identities", async () => {
    const cases: Options[] = [
      { chainId: "0x7b7c" }, { tx: transaction({ hash: NEW_BLOCK_HASH }) }, { tx: transaction({ from: OTHER }) },
      { tx: transaction({ to: OTHER }) }, { tx: transaction({ chainId: "0x7b7c" }) },
      { receipt: receipt({ transactionHash: NEW_BLOCK_HASH }) }, { receipt: receipt({ from: OTHER }) },
      { receipt: receipt({ to: OTHER }) }, { tx: null },
    ];
    for (const options of cases) expect((await verifyOpenTrove(MEZO_TESTNET, input, fixture(options))).status).toBe("unavailable");
  });

  it("binds calldata, value and nonce to the reviewed request but permits wallet gas adjustments", async () => {
    for (const overrides of [{ input: encodeFunctionData({ abi: ABI, functionName: "openTrove", args: [1801n * E, ZERO, ZERO] }) }, { value: "0x1" }, { nonce: "0x8" }]) {
      const result = await verifyOpenTrove(MEZO_TESTNET, input, fixture({ tx: transaction(overrides) }));
      expect(result.status).toBe("unavailable");
      expect(result.message).toContain("differs from the reviewed");
    }
    expect((await verifyOpenTrove(MEZO_TESTNET, input, fixture({ tx: transaction({ gas: "0x200000", gasPrice: "0x4a817c800" }) }))).status).toBe("confirmed");
  });

  it("rejects malformed quantities, calldata and receipt status rather than inventing confirmation depth", async () => {
    for (const options of [
      { head: "0x" }, { head: "0x3e7" }, { head: "0x20000000000000" }, { receipt: receipt({ blockNumber: "0x" }) },
      { receipt: receipt({ status: undefined }) }, { tx: transaction({ input: `${DATA}00` }) },
      { tx: transaction({ input: "0xa9059cbb" }) }, { tx: transaction({ nonce: "0x" }) },
    ]) expect((await verifyOpenTrove(MEZO_TESTNET, input, fixture(options))).status).toBe("unavailable");
  });

  it("requires an exact canonical block and refuses a reorg during the state read", async () => {
    for (const options of [
      { header: null }, { header: { number: "0x3e9", hash: BLOCK_HASH } },
      { header: { number: "0x3e8", hash: NEW_BLOCK_HASH } },
      { headerAfter: { number: "0x3e8", hash: NEW_BLOCK_HASH } },
      { receiptAfter: null }, { receiptAfter: receipt({ status: "0x0" }) }, { chainAfter: "0x7b7c" },
      { tx: transaction({ blockHash: NEW_BLOCK_HASH }) },
    ]) expect((await verifyOpenTrove(MEZO_TESTNET, input, fixture(options))).status).toBe("unavailable");
  });

  it("refuses a missing or wrong MUSD mint even when the transaction succeeded", async () => {
    for (const logs of [
      [], [{ address: MEZO_TESTNET.musd, topics: [TRANSFER_TOPIC, topic(ZERO), topic(OTHER)], data: word(1800n * E) }],
      [{ address: OTHER, topics: [TRANSFER_TOPIC, topic(ZERO), topic(ACCOUNT)], data: word(1800n * E) }],
      [{ address: MEZO_TESTNET.musd, topics: [TRANSFER_TOPIC, topic(ZERO), topic(ACCOUNT)], data: word(1799n * E) }],
      [{ address: MEZO_TESTNET.musd, topics: [TRANSFER_TOPIC, topic(ZERO), topic(ACCOUNT)], data: "0x" }],
      [{ address: MEZO_TESTNET.musd, topics: [TRANSFER_TOPIC, topic(ZERO), topic(ACCOUNT)], data: word(1800n * E), removed: "true" }],
      [{ address: MEZO_TESTNET.musd, topics: [TRANSFER_TOPIC, topic(ZERO), topic(ACCOUNT)], data: word(1800n * E), removed: true }],
    ]) expect((await verifyOpenTrove(MEZO_TESTNET, input, fixture({ receipt: receipt({ logs }) }))).status).toBe("unavailable");
  });

  it("fails closed if any actual position read is unavailable or contradicts an active position", async () => {
    for (const options of [
      { stateError: true }, { stateRaw: "0x" }, { state: { getTroveStatus: 0n } },
      { state: { getTroveDebt: 0n } }, { state: { getTroveColl: 0n } },
    ]) expect((await verifyOpenTrove(MEZO_TESTNET, input, fixture(options))).status).toBe("unavailable");
  });

  it("reports actual closed state if another transaction closes the trove in the same block", async () => {
    const result = await verifyOpenTrove(MEZO_TESTNET, input, fixture({ state: { getTroveStatus: 2n, getTroveDebt: 0n, getTroveColl: 0n, balanceOf: 4n * E } }));
    expect(result.status).toBe("confirmed");
    expect(result.position).toEqual({ status: 2n, debt: 0n, collateral: 0n, musdBalance: 4n * E });
  });

  it("withdraws confirmation if the reported head falls during verification", async () => {
    const result = await verifyOpenTrove(MEZO_TESTNET, input, fixture({ headAfter: "0x3eb" }));
    expect(result).toMatchObject({ status: "confirming", confirmations: 4 });
    expect(result.position).toBeUndefined();
  });

  it("can verify a discovered hash without a saved quote while keeping exact account and method guards", async () => {
    expect((await verifyOpenTrove(MEZO_TESTNET, { account: ACCOUNT, hash: HASH }, fixture())).status).toBe("confirmed");
    expect((await verifyOpenTrove(MEZO_TESTNET, { account: OTHER, hash: HASH }, fixture())).status).toBe("unavailable");
    expect((await verifyOpenTrove(MEZO_TESTNET, { account: ZERO, hash: HASH }, fixture())).status).toBe("unavailable");
  });
});
