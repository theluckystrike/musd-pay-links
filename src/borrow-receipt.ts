// Read-only confirmation of a direct testnet openTrove transaction.
// A hash, simulation, quote, or shallow receipt is not a confirmed borrowing result.
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi } from "viem";

import { type OpenTroveTransaction } from "./borrow-action.ts";
import { CONFIRMATIONS_REQUIRED, MEZO_TESTNET, type MezoChain } from "./chains.ts";
import { ethCall, rpc, rpcNotNull, TRANSFER_TOPIC, type Fetch } from "./rpc.ts";

const ABI = parseAbi([
  "function openTrove(uint256,address,address) payable",
  "function getTroveStatus(address) view returns (uint256)",
  "function getTroveDebt(address) view returns (uint256)",
  "function getTroveColl(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
type Fn = (typeof ABI)[number]["name"];
type ObjectValue = Record<string, unknown>;

export interface VerifyOpenTroveInput {
  account: string;
  hash: string;
  expected?: OpenTroveTransaction;
}

export interface OpenTroveReceiptResult {
  status: "pending" | "confirming" | "confirmed" | "failed" | "unavailable";
  message: string;
  hash?: string;
  confirmations?: number;
  required: number;
  block?: number;
  blockHash?: string;
  /** Actual state at the end of the receipt block. Later transactions in that block can affect it. */
  position?: { collateral: bigint; debt: bigint; musdBalance: bigint; status: bigint };
  mintedMUSD?: bigint;
  transaction?: { account: string; contract: string; nonce: bigint; collateral: bigint; requestedMUSD: bigint };
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Missing or malformed ${label}`);
  return value as ObjectValue;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function address(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error(`Invalid ${label}`);
  const n = BigInt(value);
  if (n >= 1n << 256n) throw new Error(`Invalid ${label}`);
  return n;
}

function height(value: unknown, label: string): number {
  const n = Number(uint(value, label));
  if (!Number.isSafeInteger(n)) throw new Error(`Invalid ${label}`);
  return n;
}

function checkedChain(chain: MezoChain): void {
  if (chain.id !== 31611 || !chain.testnet || address(chain.musd, "MUSD address") !== MEZO_TESTNET.musd.toLowerCase()
    || Object.entries(MEZO_TESTNET.system).some(([key, expected]) => address(chain.system[key as keyof typeof chain.system], key) !== expected.toLowerCase())) {
    throw new Error("Borrowing receipt verification supports only the pinned Mezo Testnet deployment");
  }
}

function transaction(tx: ObjectValue, input: VerifyOpenTroveInput, account: string, bo: string): { nonce: bigint; collateral: bigint; requestedMUSD: bigint } {
  if (hash(tx.hash, "transaction hash") !== input.hash.toLowerCase()
    || address(tx.from, "transaction sender") !== account
    || address(tx.to, "transaction recipient") !== bo) throw new Error("The transaction does not match this borrower and BorrowerOperations contract");
  if (tx.chainId !== undefined && uint(tx.chainId, "transaction chain") !== 31611n) throw new Error("The transaction belongs to a different chain");
  const data = tx.input ?? tx.data;
  if (typeof data !== "string" || !/^0x[0-9a-f]{200}$/i.test(data)) throw new Error("Malformed openTrove calldata");
  const decoded = decodeFunctionData({ abi: ABI, data: data as `0x${string}` });
  if (decoded.functionName !== "openTrove" || !decoded.args || decoded.args[0] <= 0n) throw new Error("The transaction is not a direct positive-amount openTrove call");
  const collateral = uint(tx.value, "transaction collateral");
  const nonce = uint(tx.nonce, "transaction nonce");
  if (collateral === 0n) throw new Error("An openTrove transaction needs positive BTC collateral");
  const expected = input.expected;
  if (expected && (address(expected.from, "reviewed sender") !== account
    || address(expected.to, "reviewed contract") !== bo
    || uint(expected.chainId, "reviewed chain") !== 31611n
    || typeof expected.data !== "string" || expected.data.toLowerCase() !== data.toLowerCase()
    || uint(expected.value, "reviewed collateral") !== collateral
    || uint(expected.nonce, "reviewed nonce") !== nonce)) throw new Error("The mined transaction differs from the reviewed borrowing request");
  return { nonce, collateral, requestedMUSD: decoded.args[0] };
}

function receipt(value: unknown, wantedHash: string, account: string, bo: string): { raw: ObjectValue; block: number; blockHash: string; status: "0x0" | "0x1" } {
  const raw = object(value, "borrowing receipt");
  if (hash(raw.transactionHash, "receipt transaction hash") !== wantedHash
    || address(raw.from, "receipt sender") !== account
    || address(raw.to, "receipt recipient") !== bo) throw new Error("Receipt identity does not match the borrowing transaction");
  if (raw.status !== "0x0" && raw.status !== "0x1") throw new Error("Missing or malformed receipt status");
  return { raw, block: height(raw.blockNumber, "receipt block"), blockHash: hash(raw.blockHash, "receipt block hash"), status: raw.status };
}

function canonicalHeader(value: unknown, block: number, blockHash: string): void {
  const header = object(value, "canonical receipt block");
  if (height(header.number, "canonical block number") !== block || hash(header.hash, "canonical block hash") !== blockHash) throw new Error("The borrowing receipt is not in the canonical block. Check again after the network settles.");
}

function confirmations(head: number, block: number): number {
  const count = head - block + 1;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("The RPC head is behind the borrowing receipt");
  return count;
}

function mintedAmount(raw: ObjectValue, token: string, account: string): bigint {
  if (!Array.isArray(raw.logs)) throw new Error("Missing or malformed receipt logs");
  const recipient = `0x${account.slice(2).padStart(64, "0")}`;
  const zero = `0x${"0".repeat(64)}`;
  let minted = 0n;
  for (const value of raw.logs) {
    const log = object(value, "receipt log");
    if (address(log.address, "receipt log contract") !== token) continue;
    if (!Array.isArray(log.topics)) throw new Error("Malformed MUSD event topics");
    if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC || String(log.topics[1]).toLowerCase() !== zero || String(log.topics[2]).toLowerCase() !== recipient) continue;
    if ((log.removed !== undefined && log.removed !== false) || log.topics.length !== 3 || typeof log.data !== "string" || !/^0x[0-9a-f]{64}$/i.test(log.data)) throw new Error("Malformed or removed MUSD mint event");
    minted += BigInt(log.data);
  }
  return minted;
}

async function read(chain: MezoChain, to: string, fn: Fn, account: `0x${string}`, block: string, fetchImpl?: Fetch): Promise<bigint> {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args: [account] } as never);
  const raw = await ethCall(chain, to, data, fetchImpl, undefined, block);
  return decodeFunctionResult({ abi: ABI, functionName: fn, data: raw } as never) as bigint;
}

/** Confirm a real direct testnet opening. Reads only; never signs or sends. */
export async function verifyOpenTrove(chain: MezoChain, input: VerifyOpenTroveInput, fetchImpl?: Fetch): Promise<OpenTroveReceiptResult> {
  const required = Math.max(5, CONFIRMATIONS_REQUIRED);
  let wantedHash: string | undefined;
  try {
    checkedChain(chain);
    wantedHash = hash(input.hash, "borrowing transaction hash");
    const account = address(input.account, "borrower account");
    if (account === "0x0000000000000000000000000000000000000000") throw new Error("A nonzero borrower account is required");
    const bo = MEZO_TESTNET.system.borrowerOperations.toLowerCase();
    const [chainId, txRaw, receiptRaw, headRaw] = await Promise.all([
      rpc<string>(chain, "eth_chainId", [], fetchImpl),
      rpcNotNull<unknown>(chain, "eth_getTransactionByHash", [wantedHash], fetchImpl),
      rpcNotNull<unknown>(chain, "eth_getTransactionReceipt", [wantedHash], fetchImpl),
      rpc<string>(chain, "eth_blockNumber", [], fetchImpl),
    ]);
    if (uint(chainId, "RPC chain") !== 31611n) throw new Error("The RPC reports a different chain");
    const head = height(headRaw, "RPC head");
    if (txRaw === null && receiptRaw === null) return { status: "pending", message: "The network has not returned this borrowing transaction yet. Keep its hash and check again.", hash: wantedHash, confirmations: 0, required };
    const tx = object(txRaw, "borrowing transaction");
    const observed = transaction(tx, { ...input, hash: wantedHash }, account, bo);
    if (receiptRaw === null) return { status: "pending", message: "The RPC endpoints returned no borrowing receipt. Keep the hash and check again before any retry.", hash: wantedHash, confirmations: 0, required };
    const mined = receipt(receiptRaw, wantedHash, account, bo);
    if (height(tx.blockNumber, "transaction block") !== mined.block || hash(tx.blockHash, "transaction block hash") !== mined.blockHash) throw new Error("The transaction and receipt disagree about the mined block");
    const blockTag = `0x${mined.block.toString(16)}`;
    canonicalHeader(await rpc<unknown>(chain, "eth_getBlockByNumber", [blockTag, false], fetchImpl), mined.block, mined.blockHash);
    const depth = confirmations(head, mined.block);
    const common = { hash: wantedHash, confirmations: depth, required, block: mined.block, blockHash: mined.blockHash };
    if (mined.status === "0x0" && depth < required) return { status: "pending", message: "The shallow receipt reports a revert. Wait for the required confirmation depth before treating it as final.", ...common };
    let minted: bigint | undefined;
    if (mined.status === "0x1") {
      minted = mintedAmount(mined.raw, chain.musd.toLowerCase(), account);
      if (minted !== observed.requestedMUSD) throw new Error("The receipt does not prove the requested MUSD mint to this borrower");
      if (depth < required) return { status: "confirming", message: `The borrowing receipt has ${depth} of ${required} required confirmations.`, ...common };
    }
    let position: OpenTroveReceiptResult["position"];
    if (mined.status === "0x1") {
      const normalized = getAddress(account);
      const [status, debt, collateral, musdBalance] = await Promise.all([
        read(chain, chain.system.troveManager, "getTroveStatus", normalized, blockTag, fetchImpl),
        read(chain, chain.system.troveManager, "getTroveDebt", normalized, blockTag, fetchImpl),
        read(chain, chain.system.troveManager, "getTroveColl", normalized, blockTag, fetchImpl),
        read(chain, chain.musd, "balanceOf", normalized, blockTag, fetchImpl),
      ]);
      if (status < 1n || status > 4n || (status === 1n && (debt <= 0n || collateral <= 0n))) throw new Error("The post-transaction trove state is missing or inconsistent");
      position = { collateral, debt, musdBalance, status };
    }
    const [headerAfter, receiptAfter, headAfter, chainAfter] = await Promise.all([
      rpc<unknown>(chain, "eth_getBlockByNumber", [blockTag, false], fetchImpl),
      rpc<unknown>(chain, "eth_getTransactionReceipt", [wantedHash], fetchImpl),
      rpc<string>(chain, "eth_blockNumber", [], fetchImpl),
      rpc<string>(chain, "eth_chainId", [], fetchImpl),
    ]);
    canonicalHeader(headerAfter, mined.block, mined.blockHash);
    const finalReceipt = receipt(receiptAfter, wantedHash, account, bo);
    if (finalReceipt.block !== mined.block || finalReceipt.blockHash !== mined.blockHash || finalReceipt.status !== mined.status || uint(chainAfter, "RPC chain") !== 31611n) throw new Error("The borrowing receipt or chain changed during verification");
    const finalDepth = confirmations(height(headAfter, "RPC head"), mined.block);
    if (finalDepth < required) return { status: mined.status === "0x1" ? "confirming" : "pending", message: "The network no longer reports the required confirmation depth. Check again.", ...common, confirmations: finalDepth };
    if (mined.status === "0x0") return { status: "failed", message: "The canonical borrowing transaction reverted after the required confirmations. No new borrowing is confirmed.", ...common, confirmations: finalDepth };
    return {
      status: "confirmed", message: "The borrowing transaction and MUSD mint are confirmed. Position values were read at the end of its canonical block.",
      ...common, confirmations: finalDepth, position, mintedMUSD: minted,
      transaction: { account, contract: bo, nonce: observed.nonce, collateral: observed.collateral, requestedMUSD: observed.requestedMUSD },
    };
  } catch (error) {
    return { status: "unavailable", message: `The borrowing result could not be verified: ${String((error as Error)?.message ?? error).slice(0, 240)}`, ...(wantedHash ? { hash: wantedHash } : {}), required };
  }
}
