// Read-only access to the real MUSD contracts over JSON-RPC, plus merchant-side payment verification.

import { decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress } from "viem";

import { formatAmount } from "./amount.ts";
import { type MezoChain } from "./chains.ts";
import { MEMO_PATTERN } from "./eip681.ts";
import { memoToHex } from "./guard.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Wait between two retries of a read, multiplied by the attempt number. */
export const RETRY_DELAY_MS = 300;
/** Retry timing. Tests lower `delayMs` so they run fast; production code never changes it. */
export const retry = { delayMs: RETRY_DELAY_MS };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function rpcAt<T>(url: string, method: string, params: unknown[], fetchImpl: Fetch): Promise<T> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method} error ${body.error.message}`);
  return body.result as T;
}

/**
 * One read of one method. Tries the chain's endpoints in turn, retries a transport or RPC error
 * with a growing backoff, and throws only when every try failed.
 */
export async function rpc<T>(chain: MezoChain, method: string, params: unknown[], fetchImpl: Fetch = fetch, tries = 3): Promise<T> {
  const urls = rpcEndpoints(chain);
  let lastError: unknown = null;
  for (let i = 0; i < tries; i++) {
    const url = urls[i % urls.length]!;
    try {
      return await rpcAt<T>(url, method, params, fetchImpl);
    } catch (e) {
      lastError = e;
    }
    if (i < tries - 1) await sleep(retry.delayMs * (i + 1));
  }
  throw lastError;
}

/** eth_call against any contract on the chain. Read only. */
export async function ethCall(chain: MezoChain, to: string, data: `0x${string}`, fetchImpl?: Fetch, from?: string): Promise<`0x${string}`> {
  const tx: Record<string, string> = { to, data };
  if (from) tx.from = from;
  return rpc<`0x${string}`>(chain, "eth_call", [tx, "latest"], fetchImpl);
}

function call(chain: MezoChain, data: `0x${string}`, fetchImpl?: Fetch, from?: string): Promise<`0x${string}`> {
  return ethCall(chain, chain.musd, data, fetchImpl, from);
}

export interface TokenInfo {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  block: number;
}

/** Read name, symbol, decimals and totalSupply from the MUSD contract and confirm the chain id. */
export async function readTokenInfo(chain: MezoChain, fetchImpl?: Fetch): Promise<TokenInfo> {
  const chainIdHex = await rpc<string>(chain, "eth_chainId", [], fetchImpl);
  if (Number(chainIdHex) !== chain.id) throw new Error(`RPC reports chain ${Number(chainIdHex)}, expected ${chain.id}`);
  const fn = ["name", "symbol", "decimals", "totalSupply"] as const;
  const [name, symbol, decimals, supply, block] = await Promise.all([
    ...fn.map((f) => call(chain, encodeFunctionData({ abi: erc20Abi, functionName: f }), fetchImpl)),
    rpc<string>(chain, "eth_blockNumber", [], fetchImpl),
  ]);
  return {
    chainId: chain.id,
    address: chain.musd,
    name: decodeFunctionResult({ abi: erc20Abi, functionName: "name", data: name! as `0x${string}` }),
    symbol: decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data: symbol! as `0x${string}` }),
    decimals: decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: decimals! as `0x${string}` }),
    totalSupply: formatAmount(decodeFunctionResult({ abi: erc20Abi, functionName: "totalSupply", data: supply! as `0x${string}` })),
    block: Number(block),
  };
}

export async function readBalance(chain: MezoChain, owner: `0x${string}`, fetchImpl?: Fetch): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: await call(chain, data, fetchImpl) });
}

/** Dry run of a transfer with eth_call from a given sender. Sends nothing. Returns the transfer() return value. */
export async function simulateTransfer(chain: MezoChain, from: string, data: `0x${string}`, fetchImpl?: Fetch): Promise<boolean> {
  const out = await call(chain, data, fetchImpl, from);
  return decodeFunctionResult({ abi: erc20Abi, functionName: "transfer", data: out });
}

export interface VerifyInput {
  txHash: string;
  recipient: string;
  amount: bigint;
  memo?: string | null;
  /**
   * Block at which the invoice was created. A payment mined before it is refused, so an old transfer
   * cannot be replayed for a new invoice. Optional.
   */
  fromBlock?: number | null;
}

export type VerifyResult =
  | { status: "paid"; paid: string; confirmations: number; memoMatched: boolean | null; block: number }
  | { status: "pending" | "not_found" | "failed" | "mismatch" | "unavailable"; message: string };

/** Shown when every RPC try failed, so the reader does not mistake it for an invalid payment. */
export const NETWORK_UNAVAILABLE_MESSAGE = "The network did not answer. Try again in a moment.";

interface Receipt {
  status: string;
  blockNumber: string;
  to: string | null;
  logs: { address: string; topics: string[]; data: string }[];
}

function rpcEndpoints(chain: MezoChain): string[] {
  return chain.rpcFallback ? [chain.rpc, chain.rpcFallback] : [chain.rpc];
}

/**
 * Some public RPC nodes behind a load balancer lag behind and answer null for a mined transaction.
 * Ask again a few times, waiting 300 ms times the attempt number, and switch to the chain's second
 * documented endpoint when there is one. Returns null only when every try answered null. Throws when
 * no endpoint answered at all.
 */
async function rpcNotNull<T>(chain: MezoChain, method: string, params: unknown[], fetchImpl: Fetch = fetch, tries = 6): Promise<T | null> {
  const urls = rpcEndpoints(chain);
  let lastError: unknown = null;
  for (let i = 0; i < tries; i++) {
    const url = urls[i % urls.length]!;
    try {
      const r = await rpcAt<T | null>(url, method, params, fetchImpl);
      if (r !== null && r !== undefined) return r;
    } catch (e) {
      lastError = e;
    }
    if (i < tries - 1) await sleep(retry.delayMs * (i + 1));
  }
  if (lastError) throw lastError;
  return null;
}

/** Merchant check: did this transaction move at least `amount` MUSD to `recipient`? */
export async function verifyPayment(chain: MezoChain, input: VerifyInput, fetchImpl?: Fetch): Promise<VerifyResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) return { status: "not_found", message: "Not a transaction hash." };
  let receipt: Receipt | null;
  let tx: { input: string; to: string | null } | null;
  let headRaw: string | null;
  try {
    [receipt, tx, headRaw] = await Promise.all([
      rpcNotNull<Receipt>(chain, "eth_getTransactionReceipt", [input.txHash], fetchImpl),
      rpcNotNull<{ input: string; to: string | null }>(chain, "eth_getTransactionByHash", [input.txHash], fetchImpl),
      rpcNotNull<string>(chain, "eth_blockNumber", [], fetchImpl),
    ]);
  } catch {
    return { status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE };
  }
  if (!tx) return { status: "not_found", message: `No transaction ${input.txHash} on ${chain.name}.` };
  if (!receipt) return { status: "pending", message: "The transaction is not mined yet." };
  if (receipt.status !== "0x1") return { status: "failed", message: "The transaction reverted." };
  if (input.fromBlock != null && Number(receipt.blockNumber) < input.fromBlock) {
    return {
      status: "mismatch",
      message: `This transaction was mined in block ${Number(receipt.blockNumber)}, before the invoice was created in block ${input.fromBlock}. An older payment cannot pay a new invoice.`,
    };
  }
  const want = "0x" + input.recipient.toLowerCase().slice(2).padStart(64, "0");
  let paid = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== chain.musd.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics[2]?.toLowerCase() !== want) continue;
    paid += BigInt(log.data);
  }
  if (paid < input.amount) {
    return {
      status: "mismatch",
      message: `MUSD received by the recipient in this transaction is ${formatAmount(paid)}, expected ${formatAmount(input.amount)}.`,
    };
  }
  let memoMatched: boolean | null = null;
  if (input.memo) {
    memoMatched = tx.input.toLowerCase().endsWith(memoToHex(input.memo).slice(2).toLowerCase());
    if (!memoMatched) {
      return {
        status: "mismatch",
        message: `This payment does not carry the reference ${input.memo} in its input data, so it cannot mark this invoice paid.`,
      };
    }
  }
  const block = Number(receipt.blockNumber);
  const head = headRaw ? Number(headRaw) : block;
  return { status: "paid", paid: formatAmount(paid), confirmations: head - block + 1, memoMatched, block };
}

/** Most blocks one eth_getLogs call asks for. Both testnet endpoints refuse ranges above 10,000. */
export const LOG_CHUNK = 5_000;
/** Most blocks a payment search looks back. About 23 hours on Mezo Testnet at about 4.2 s a block. */
export const MAX_LOOKBACK = 20_000;
/** Most transactions a payment search reads in full to find the reference. */
export const MAX_TX_READS = 20;

const TRANSFER_SELECTOR = "a9059cbb";

/**
 * The reference a MUSD payment carries: the ASCII bytes after transfer(address,uint256) in the input.
 * Returns null when the input is not a plain transfer or the trailing bytes are not a valid memo.
 */
export function memoFromInput(input: string): string | null {
  const hex = input.toLowerCase().replace(/^0x/, "");
  if (!hex.startsWith(TRANSFER_SELECTOR) || hex.length <= 8 + 128 || hex.length % 2 !== 0) return null;
  const tail = hex.slice(8 + 128);
  let out = "";
  for (let i = 0; i < tail.length; i += 2) out += String.fromCharCode(parseInt(tail.slice(i, i + 2), 16));
  return MEMO_PATTERN.test(out) ? out : null;
}

export interface FoundPayment {
  txHash: string;
  block: number;
  from: string;
  amount: string;
  amountUnits: bigint;
  memo: string | null;
  /** True when the payment carries the wanted reference and at least the wanted amount. */
  matches: boolean;
}

export interface FindInput {
  recipient: string;
  /** First block to search. Clamped to MAX_LOOKBACK blocks behind the head. */
  fromBlock?: number | null;
  memo?: string | null;
  amount?: bigint | null;
}

export type FindResult =
  | { status: "ok"; head: number; fromBlock: number; payments: FoundPayment[]; paid: FoundPayment | null }
  | { status: "unavailable"; message: string };

interface Log { transactionHash: string; blockNumber: string; topics: string[]; data: string }

/**
 * Merchant inbox: list MUSD transfers to `recipient` since `fromBlock`, newest first, and read the
 * reference of each. With a memo, `paid` is the newest payment that carries it and covers the amount.
 * The payer does not need to send a transaction hash.
 */
export async function findPayments(chain: MezoChain, input: FindInput, fetchImpl?: Fetch): Promise<FindResult> {
  const topic = "0x" + input.recipient.toLowerCase().slice(2).padStart(64, "0");
  try {
    const head = Number(await rpc<string>(chain, "eth_blockNumber", [], fetchImpl));
    const floor = Math.max(0, head - MAX_LOOKBACK);
    const start = Math.min(head, Math.max(floor, input.fromBlock ?? floor));
    const logs: Log[] = [];
    for (let to = head; to >= start && logs.length < MAX_TX_READS; to -= LOG_CHUNK) {
      const from = Math.max(start, to - LOG_CHUNK + 1);
      const filter = { address: chain.musd, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [TRANSFER_TOPIC, null, topic] };
      const chunk = await rpc<Log[]>(chain, "eth_getLogs", [filter], fetchImpl);
      logs.push(...[...chunk].reverse());
    }
    // One entry per transaction, summing every MUSD transfer to the recipient inside it.
    const byTx = new Map<string, { block: number; from: string; units: bigint }>();
    for (const log of logs) {
      const hit = byTx.get(log.transactionHash);
      if (hit) hit.units += BigInt(log.data);
      else if (byTx.size < MAX_TX_READS) byTx.set(log.transactionHash, { block: Number(log.blockNumber), from: getAddress("0x" + log.topics[1]!.slice(26)), units: BigInt(log.data) });
    }
    const payments: FoundPayment[] = [];
    for (const [txHash, p] of byTx) {
      const tx = await rpcNotNull<{ input: string; to: string | null }>(chain, "eth_getTransactionByHash", [txHash], fetchImpl, 3);
      const direct = !!tx && tx.to?.toLowerCase() === chain.musd.toLowerCase();
      const memo = direct ? memoFromInput(tx!.input) : null;
      const matches = !!input.memo && memo === input.memo && p.units >= (input.amount ?? 0n);
      payments.push({ txHash, block: p.block, from: p.from, amount: formatAmount(p.units), amountUnits: p.units, memo, matches });
    }
    return { status: "ok", head, fromBlock: start, payments, paid: payments.find((p) => p.matches) ?? null };
  } catch {
    return { status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE };
  }
}

/** Current block number, so a merchant can stamp an invoice when it is created. */
export async function headBlock(chain: MezoChain, fetchImpl?: Fetch): Promise<number> {
  return Number(await rpc<string>(chain, "eth_blockNumber", [], fetchImpl));
}
