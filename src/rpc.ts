// Read-only access to the real MUSD contracts over JSON-RPC, plus merchant-side payment verification.

import { decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress } from "viem";

import { formatAmount } from "./amount.ts";
import { CONFIRMATIONS_REQUIRED, type MezoChain } from "./chains.ts";
import { MEMO_PATTERN } from "./eip681.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Wait between two retries of a read, multiplied by the attempt number. */
export const RETRY_DELAY_MS = 300;
/** One HTTP attempt, including response body consumption, must finish within this deadline. */
export const RPC_HTTP_TIMEOUT_MS = 8_000;
/** Bound one invoice scan, including retries, so two scans plus store calls fit a Worker request. */
export const PAYMENT_SCAN_REQUEST_LIMIT = 18;
/** Retry timing. Tests lower `delayMs` so they run fast; production code never changes it. */
export const retry = { delayMs: RETRY_DELAY_MS };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function rpcBody<T>(url: string, payload: unknown, label: string, fetchImpl: Fetch): Promise<T> {
  const controller = new AbortController();
  let responseError: Error | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("RPC request timed out"));
    }, RPC_HTTP_TIMEOUT_MS);
  });
  try {
    // Keep the same deadline until JSON consumption finishes. A response's headers alone do not
    // establish that its body will arrive. The race also bounds custom fetches that ignore abort.
    return await Promise.race([
      (async () => {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) {
          responseError = new Error(`${label} HTTP ${res.status}`);
          // Release an unread error body before retrying. A stalled cancellation is covered by the
          // same deadline, and cannot replace the already observed HTTP status with a body error.
          try { await res.body?.cancel(); } catch { /* Preserve the HTTP error. */ }
          throw responseError;
        }
        return await res.json() as T;
      })(),
      deadline,
    ]);
  } catch (error) {
    if (responseError) throw responseError;
    if (controller.signal.aborted) throw new Error("RPC request timed out");
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}

async function rpcAt<T>(url: string, method: string, params: unknown[], fetchImpl: Fetch): Promise<T> {
  const body = await rpcBody<{ result?: T; error?: { message: string } }>(url, { jsonrpc: "2.0", id: 1, method, params }, `RPC ${method}`, fetchImpl);
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
export async function ethCall(chain: MezoChain, to: string, data: `0x${string}`, fetchImpl?: Fetch, from?: string, blockTag = "latest"): Promise<`0x${string}`> {
  const tx: Record<string, string> = { to, data };
  if (from) tx.from = from;
  return rpc<`0x${string}`>(chain, "eth_call", [tx, blockTag], fetchImpl);
}

/** A block height must be a complete RPC quantity, not NaN, a fraction or a rounded integer. */
function blockNumber(value: unknown): number {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error("RPC returned an invalid block height");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("RPC block height exceeds the supported range");
  return Number(parsed);
}

const blockTag = (height: number) => `0x${height.toString(16)}`;
const isHash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

interface BlockHeader { number: string; hash: string }
interface ChainTransaction {
  hash: string;
  input: string;
  to: string | null;
  blockNumber: string | null;
  blockHash: string | null;
}

function checkedHeader(value: BlockHeader | null, expected: number): BlockHeader {
  if (!value || blockNumber(value.number) !== expected || !isHash(value.hash)) throw new Error("RPC returned an invalid canonical block header");
  return value;
}

/** At most fifty distinct payment blocks, in one HTTP request rather than one request per transfer. */
async function canonicalHeaders(chain: MezoChain, heights: number[], fetchImpl?: Fetch): Promise<Map<number, string>> {
  const distinct = [...new Set(heights)];
  if (distinct.length > MAX_TX_READS) throw new Error("Too many distinct payment blocks");
  const headers = await rpcBatch<BlockHeader>(chain, distinct.map((height) => ({ method: "eth_getBlockByNumber", params: [blockTag(height), false] })), fetchImpl, { allowNull: false });
  return new Map(distinct.map((height, index) => [height, checkedHeader(headers[index] ?? null, height).hash.toLowerCase()]));
}

async function unchangedHead(chain: MezoChain, height: number, expectedHash: string, fetchImpl?: Fetch): Promise<void> {
  const header = checkedHeader(await rpc<BlockHeader | null>(chain, "eth_getBlockByNumber", [blockTag(height), false], fetchImpl), height);
  if (header.hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("The chain head changed during payment verification");
}

function boundedScanFetch(fetchImpl: Fetch = fetch): Fetch {
  let requests = 0;
  return (url, init) => {
    if (requests >= PAYMENT_SCAN_REQUEST_LIMIT) throw new Error("Payment scan request limit reached");
    requests++;
    return fetchImpl(url, init);
  };
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
    block: blockNumber(block),
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
  /** Add the reference found in the transaction input to the answer. Used by the possible-match check. */
  includeMemo?: boolean;
}

export type VerifyResult =
  | { status: "paid"; paid: string; confirmations: number; memoMatched: boolean | null; block: number; from?: string; txMemo?: string | null }
  /**
   * The transfer succeeded to the right recipient for at least the amount, but the wallet dropped the
   * trailing reference bytes. It is not a failure. The merchant can accept it as a possible payment.
   */
  | { status: "paid_no_memo"; paid: string; confirmations: number; memoMatched: false; block: number; memo: null; from?: string; txMemo?: string | null }
  | { status: "pending" | "not_found" | "failed" | "mismatch" | "unavailable"; message: string };

/** Shown when every RPC try failed, so the reader does not mistake it for an invalid payment. */
export const NETWORK_UNAVAILABLE_MESSAGE = "The network did not answer. Try again in a moment.";

interface Receipt {
  transactionHash: string;
  status: string;
  from?: string;
  blockNumber: string;
  blockHash: string;
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
export async function rpcNotNull<T>(chain: MezoChain, method: string, params: unknown[], fetchImpl: Fetch = fetch, tries = 6): Promise<T | null> {
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
  let tx: ChainTransaction | null;
  let headRaw: string | null;
  try {
    [receipt, tx, headRaw] = await Promise.all([
      rpcNotNull<Receipt>(chain, "eth_getTransactionReceipt", [input.txHash], fetchImpl),
      rpcNotNull<ChainTransaction>(chain, "eth_getTransactionByHash", [input.txHash], fetchImpl),
      rpcNotNull<string>(chain, "eth_blockNumber", [], fetchImpl),
    ]);
  } catch {
    return { status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE };
  }
  if (!tx) return { status: "not_found", message: `No transaction ${input.txHash} on ${chain.name}.` };
  if (!receipt) return { status: "pending", message: "The transaction is not mined yet." };
  let block: number;
  let head: number;
  try {
    block = blockNumber(receipt.blockNumber);
    head = blockNumber(headRaw);
    // Independent public nodes can disagree while one is catching up. They do not establish finality.
    if (block > head) throw new Error("Receipt is ahead of the reported chain head");
  } catch {
    return { status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE };
  }
  if (receipt.status !== "0x1" && receipt.status !== "0x0") {
    return { status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE };
  }
  try {
    if (!isHash(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== input.txHash.toLowerCase()
      || !isHash(tx.hash) || tx.hash.toLowerCase() !== input.txHash.toLowerCase()
      || !isHash(receipt.blockHash) || !isHash(tx.blockHash)
      || blockNumber(tx.blockNumber) !== block || tx.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      throw new Error("Payment receipt and transaction metadata disagree");
    }
    const headers = await canonicalHeaders(chain, [block, head], fetchImpl);
    if (headers.get(block) !== receipt.blockHash.toLowerCase()) throw new Error("Payment receipt belongs to an orphaned block");
    await unchangedHead(chain, head, headers.get(head)!, fetchImpl);
  } catch {
    return { status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE };
  }
  const confirmations = head - block + 1;
  if (receipt.status === "0x0") {
    // The payer may retry only after the same confirmation policy used for a successful payment.
    // A shallow revert can disappear in a reorg and the transaction can later execute successfully.
    if (confirmations < CONFIRMATIONS_REQUIRED) {
      return { status: "pending", message: `The transaction reverted but has only ${confirmations} of ${CONFIRMATIONS_REQUIRED} confirmations. Wait before any retry.` };
    }
    return { status: "failed", message: "The transaction reverted." };
  }
  if (input.fromBlock != null && block < input.fromBlock) {
    return {
      status: "mismatch",
      message: `This transaction was mined in block ${block}, before the invoice was created in block ${input.fromBlock}. An older payment cannot pay a new invoice.`,
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
  const from = receipt.from && /^0x[0-9a-fA-F]{40}$/.test(receipt.from) ? getAddress(receipt.from) : undefined;
  const direct = tx.to?.toLowerCase() === chain.musd.toLowerCase();
  const txMemo = direct ? memoFromInput(tx.input) : null;
  const seen = input.includeMemo ? { txMemo } : {};
  let memoMatched: boolean | null = null;
  if (input.memo) {
    // Exact match of the decoded reference, so "XINV-1" does not pay invoice "INV-1".
    memoMatched = direct && txMemo === input.memo;
    if (!memoMatched) {
      if (direct && txMemo === null) {
        // A direct MUSD transfer with no trailing bytes. Some wallets drop the reference. The money
        // arrived, so this must never look like a failed payment.
        return { status: "paid_no_memo", paid: formatAmount(paid), confirmations, memoMatched: false, memo: null, block, ...(from ? { from } : {}), ...seen };
      }
      return {
        status: "mismatch",
        message: `This payment does not carry the reference ${input.memo} in its input data, so it cannot mark this invoice paid.`,
      };
    }
  }
  return { status: "paid", paid: formatAmount(paid), confirmations, memoMatched, block, ...(from ? { from } : {}), ...seen };
}

/** Most blocks one eth_getLogs call asks for. The Mezo testnet RPC refuses ranges above 10,000. */
export const LOG_CHUNK = 5_000;
/** Most blocks a payment search looks back. About 23 hours on Mezo Testnet at about 4.2 s a block. */
export const MAX_LOOKBACK = 20_000;
/** Most transactions a payment search reads in full to find the reference, in one batch request. */
export const MAX_TX_READS = 50;

const TRANSFER_SELECTOR = "a9059cbb";

/**
 * One JSON-RPC batch request. Cloudflare Workers allow 50 subrequests per call on the free plan, so the
 * inbox sends its log queries and its transaction reads as batches instead of one fetch each.
 * Retries the whole batch, alternating endpoints, when the request fails or any item has an error.
 * With `allowNull`, null items are kept. Without it, null items are retried like errors.
 */
export async function rpcBatch<T>(
  chain: MezoChain,
  calls: { method: string; params: unknown[] }[],
  fetchImpl: Fetch = fetch,
  { tries = 3, allowNull = true }: { tries?: number; allowNull?: boolean } = {},
): Promise<(T | null)[]> {
  if (calls.length === 0) return [];
  const urls = rpcEndpoints(chain);
  let lastError: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      const body = await rpcBody<{ id: number; result?: T; error?: { message: string } }[]>(
        urls[i % urls.length]!, calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params })), "RPC batch", fetchImpl,
      );
      if (!Array.isArray(body) || body.length !== calls.length) throw new Error("RPC batch answer has the wrong length");
      const byId = new Map(body.map((b) => [b.id, b]));
      const out = calls.map((_c, id) => byId.get(id));
      const bad = out.find((b) => !b || b.error || (!allowNull && (b.result === null || b.result === undefined)));
      if (bad) throw new Error(bad.error ? `RPC batch item error ${bad.error.message}` : "RPC batch item missing or null");
      return out.map((b) => (b!.result ?? null) as T | null);
    } catch (e) {
      lastError = e;
    }
    if (i < tries - 1) await sleep(retry.delayMs * (i + 1));
  }
  throw lastError;
}

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
  /**
   * True when the payment carries the wanted reference and at least the wanted amount.
   * null when the search had no reference, so nothing was evaluated.
   */
  matches: boolean | null;
  /**
   * True when the payment carries no reference but has exactly the wanted amount. Needs a human check.
   * null when the search had no amount, so nothing was evaluated.
   */
  possible: boolean | null;
}

export interface FindInput {
  recipient: string;
  /** First block to search. Clamped to MAX_LOOKBACK blocks behind the head. */
  fromBlock?: number | null;
  memo?: string | null;
  amount?: bigint | null;
}

export type FindResult =
  | {
      status: "ok";
      head: number;
      fromBlock: number;
      /** True when the wanted start block was older than MAX_LOOKBACK and the search started later. */
      clamped: boolean;
      /** True when more payments were found than MAX_TX_READS, so the oldest ones were not read. */
      truncated: boolean;
      payments: FoundPayment[];
      /** The oldest payment that carries the reference and covers the amount. */
      paid: FoundPayment | null;
    }
  | { status: "unavailable"; message: string; detail: string };

interface Log { transactionHash: string; blockNumber: string; blockHash: string; removed?: boolean; topics: string[]; data: string }

/**
 * Merchant inbox: list MUSD transfers to `recipient` since `fromBlock`, newest first, and read the
 * reference of each. With a memo, `paid` is the oldest payment after the invoice block that carries it
 * and covers the amount, so a later payment with the same reference cannot take its place.
 * The payer does not need to send a transaction hash. Normal scans use six HTTP requests, with
 * at most PAYMENT_SCAN_REQUEST_LIMIT requests including retries. The head and every payment block
 * must remain canonical across log classification. Public RPC consistency is not consensus proof.
 */
export async function findPayments(chain: MezoChain, input: FindInput, fetchImpl?: Fetch): Promise<FindResult> {
  const topic = "0x" + input.recipient.toLowerCase().slice(2).padStart(64, "0");
  const scanFetch = boundedScanFetch(fetchImpl);
  try {
    const head = blockNumber(await rpc<string>(chain, "eth_blockNumber", [], scanFetch));
    const snapshot = checkedHeader(await rpc<BlockHeader | null>(chain, "eth_getBlockByNumber", [blockTag(head), false], scanFetch), head);
    const floor = Math.max(0, head - MAX_LOOKBACK);
    const wanted = input.fromBlock ?? floor;
    if (!Number.isSafeInteger(wanted) || wanted < 0) throw new Error("Payment search requires a valid start block");
    const start = Math.min(head, Math.max(floor, wanted));
    const ranges: [number, number][] = [];
    for (let to = head; to >= start; to -= LOG_CHUNK) ranges.push([Math.max(start, to - LOG_CHUNK + 1), to]);
    const chunks = await rpcBatch<Log[]>(
      chain,
      ranges.map(([from, to]) => ({
        method: "eth_getLogs",
        params: [{ address: chain.musd, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [TRANSFER_TOPIC, null, topic] }],
      })),
      scanFetch,
      { allowNull: false },
    );
    const logs = chunks.flatMap((c) => [...(c ?? [])].reverse()); // newest first
    // One entry per transaction, summing every MUSD transfer to the recipient inside it.
    const byTx = new Map<string, { block: number; blockHash: string; from: string; units: bigint }>();
    let truncated = false;
    for (const log of logs) {
      const block = blockNumber(log.blockNumber);
      if (block < start || block > head) throw new Error("RPC log falls outside the requested block range");
      if (log.removed === true || !isHash(log.blockHash) || !isHash(log.transactionHash)) throw new Error("Payment log has invalid or removed block metadata");
      const hit = byTx.get(log.transactionHash);
      if (hit) {
        if (hit.block !== block || hit.blockHash !== log.blockHash.toLowerCase()) throw new Error("Payment logs disagree about their transaction block");
        hit.units += BigInt(log.data);
      }
      else if (byTx.size < MAX_TX_READS) byTx.set(log.transactionHash, { block, blockHash: log.blockHash.toLowerCase(), from: getAddress("0x" + log.topics[1]!.slice(26)), units: BigInt(log.data) });
      else truncated = true;
    }
    const hashes = [...byTx.keys()];
    const txs = await readTransactions(chain, hashes, scanFetch);
    // A Transfer log proves money moved, but a missing transaction does not prove its reference was
    // absent. In particular an overpayment could already pay this invoice. Keep Pay locked until
    // every transaction in the bounded scan can be classified.
    if (txs.some((tx) => tx === null)) throw new Error("RPC did not return every payment transaction");
    const headers = await canonicalHeaders(chain, [...byTx.values()].map((payment) => payment.block), scanFetch);
    for (let i = 0; i < hashes.length; i++) {
      const hash = hashes[i]!;
      const payment = byTx.get(hash)!;
      const tx = txs[i]!;
      if (headers.get(payment.block) !== payment.blockHash || !isHash(tx.hash) || tx.hash.toLowerCase() !== hash.toLowerCase()
        || !isHash(tx.blockHash) || tx.blockHash.toLowerCase() !== payment.blockHash || blockNumber(tx.blockNumber) !== payment.block) {
        throw new Error("Payment logs or transactions belong to an orphaned or inconsistent block");
      }
    }
    await unchangedHead(chain, head, snapshot.hash, scanFetch);
    const payments: FoundPayment[] = hashes.map((txHash, i) => {
      const p = byTx.get(txHash)!;
      const tx = txs[i];
      const direct = !!tx && tx.to?.toLowerCase() === chain.musd.toLowerCase();
      const memo = direct ? memoFromInput(tx!.input) : null;
      const matches = input.memo ? memo === input.memo && p.units >= (input.amount ?? 0n) : null;
      const possible = input.amount != null ? memo === null && p.units === input.amount : null;
      return { txHash, block: p.block, from: p.from, amount: formatAmount(p.units), amountUnits: p.units, memo, matches, possible };
    });
    const paid = [...payments].reverse().find((p) => p.matches === true) ?? null;
    return { status: "ok", head, fromBlock: start, clamped: wanted < floor, truncated, payments, paid };
  } catch (e) {
    return { status: "unavailable", message: NETWORK_UNAVAILABLE_MESSAGE, detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

export interface DuplicatePayment {
  txHash: string;
  block: number;
  from: string;
  amount: string;
}

export interface DuplicateScan {
  /** False when the search could not cover every block from the paid transaction, so "no duplicates" is not proven. */
  checked: boolean;
  /** Payments after the recorded one that carry the same reference. Newest first. */
  duplicates: DuplicatePayment[];
  /** Block the scan started from, null when the chain did not answer. */
  fromBlock: number | null;
}

/**
 * Find further payments with the reference of an already paid invoice. It uses the same log search as
 * the merchant inbox, starting at the recorded payment block, and keeps only transactions with the
 * exact reference other than the recorded one. A clamped or truncated search says checked=false, so
 * the merchant does not read an empty list as proof that no duplicate exists.
 */
export async function findDuplicatePayments(
  chain: MezoChain,
  input: { recipient: string; memo: string; paidBlock: number; paidTxHash: string },
  fetchImpl?: Fetch,
): Promise<DuplicateScan> {
  const r = await findPayments(chain, { recipient: input.recipient, fromBlock: input.paidBlock, memo: input.memo, amount: 0n }, fetchImpl);
  if (r.status !== "ok") return { checked: false, duplicates: [], fromBlock: null };
  const paid = input.paidTxHash.toLowerCase();
  const duplicates = r.payments
    .filter((p) => p.memo === input.memo && p.txHash.toLowerCase() !== paid)
    .map((p) => ({ txHash: p.txHash, block: p.block, from: p.from, amount: p.amount }));
  return { checked: !r.clamped && !r.truncated, duplicates, fromBlock: r.fromBlock };
}

/** Read transactions in batches. A lagging node can answer null, so null items are asked again, up to 3 rounds. */
async function readTransactions(chain: MezoChain, hashes: string[], fetchImpl?: Fetch): Promise<(ChainTransaction | null)[]> {
  const out: (ChainTransaction | null)[] = hashes.map(() => null);
  for (let round = 0; round < 3; round++) {
    const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    if (missing.length === 0) break;
    const got = await rpcBatch<ChainTransaction>(
      chain,
      missing.map((i) => ({ method: "eth_getTransactionByHash", params: [hashes[i]] })),
      fetchImpl,
    );
    missing.forEach((i, k) => (out[i] = got[k] ?? null));
    if (round < 2 && out.some((v) => !v)) await sleep(retry.delayMs * (round + 1));
  }
  return out;
}

/** Current block number, so a merchant can stamp an invoice when it is created. */
export async function headBlock(chain: MezoChain, fetchImpl?: Fetch): Promise<number> {
  return blockNumber(await rpc<string>(chain, "eth_blockNumber", [], fetchImpl));
}
