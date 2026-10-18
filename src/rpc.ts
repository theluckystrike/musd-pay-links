// Read-only access to the real MUSD contracts over JSON-RPC, plus merchant-side payment verification.

import { decodeFunctionResult, encodeFunctionData, erc20Abi } from "viem";

import { formatAmount } from "./amount.ts";
import { type MezoChain } from "./chains.ts";
import { memoToHex } from "./guard.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function rpc<T>(chain: MezoChain, method: string, params: unknown[], fetchImpl: Fetch = fetch): Promise<T> {
  const res = await fetchImpl(chain.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method} error ${body.error.message}`);
  return body.result as T;
}

async function call(chain: MezoChain, data: `0x${string}`, fetchImpl?: Fetch, from?: string): Promise<`0x${string}`> {
  const tx: Record<string, string> = { to: chain.musd, data };
  if (from) tx.from = from;
  return rpc<`0x${string}`>(chain, "eth_call", [tx, "latest"], fetchImpl);
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
}

export type VerifyResult =
  | { status: "paid"; paid: string; confirmations: number; memoMatched: boolean | null; block: number }
  | { status: "pending" | "not_found" | "failed" | "mismatch"; message: string };

interface Receipt {
  status: string;
  blockNumber: string;
  to: string | null;
  logs: { address: string; topics: string[]; data: string }[];
}

/**
 * Some public RPC nodes behind a load balancer lag behind and answer null for a mined transaction.
 * Ask again a few times before treating null as the answer.
 */
async function rpcNotNull<T>(chain: MezoChain, method: string, params: unknown[], fetchImpl?: Fetch, tries = 4): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const r = await rpc<T | null>(chain, method, params, fetchImpl);
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

/** Merchant check: did this transaction move at least `amount` MUSD to `recipient`? */
export async function verifyPayment(chain: MezoChain, input: VerifyInput, fetchImpl?: Fetch): Promise<VerifyResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) return { status: "not_found", message: "Not a transaction hash." };
  const [receipt, tx, head] = await Promise.all([
    rpcNotNull<Receipt>(chain, "eth_getTransactionReceipt", [input.txHash], fetchImpl),
    rpcNotNull<{ input: string; to: string | null }>(chain, "eth_getTransactionByHash", [input.txHash], fetchImpl),
    rpc<string>(chain, "eth_blockNumber", [], fetchImpl),
  ]);
  if (!tx) return { status: "not_found", message: `No transaction ${input.txHash} on ${chain.name}.` };
  if (!receipt) return { status: "pending", message: "The transaction is not mined yet." };
  if (receipt.status !== "0x1") return { status: "failed", message: "The transaction reverted." };
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
  if (input.memo) memoMatched = tx.input.toLowerCase().endsWith(memoToHex(input.memo).slice(2).toLowerCase());
  const block = Number(receipt.blockNumber);
  return { status: "paid", paid: formatAmount(paid), confirmations: Number(head) - block + 1, memoMatched, block };
}
