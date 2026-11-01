// Borrow quote: how much BTC a payer must lock in the MUSD protocol to mint the MUSD a link asks for.
//
// MUSD is minted by opening a trove in BorrowerOperations with BTC as collateral. The rules used here are
// read live from the protocol contracts listed in chains.ts, never assumed:
//   - minNetDebt and MUSD_GAS_COMPENSATION (BorrowerOperations). The gas compensation is added to the debt
//     and minted to GasPool. It is burned from that pool when the trove closes, not refunded to the payer.
//   - borrowingRate (BorrowerOperations), a one-time fee on the borrowed amount.
//   - MCR and CCR (BorrowerOperations). Below MCR a trove can be liquidated. Below CCR for the whole system
//     the protocol is in recovery mode, and new troves must open at CCR or above.
//   - fetchPrice() (PriceFeed), the BTC price the protocol uses, in USD with 18 decimals.
//   - interestRate() (InterestRateManager), the fixed yearly rate for new troves, in basis points.
// All math is exact bigint math at 18 decimals. The library never signs and never sends.

import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi } from "viem";

import { formatAmount } from "./amount.ts";
import { type MezoChain } from "./chains.ts";
import { ethCall, rpc, type Fetch } from "./rpc.ts";

const ONE = 10n ** 18n;

const ABI = parseAbi([
  "function fetchPrice() view returns (uint256)",
  "function MCR() view returns (uint256)",
  "function CCR() view returns (uint256)",
  "function minNetDebt() view returns (uint256)",
  "function MUSD_GAS_COMPENSATION() view returns (uint256)",
  "function borrowingRate() view returns (uint256)",
  "function interestRate() view returns (uint16)",
  "function getTCR(uint256) view returns (uint256)",
  "function checkRecoveryMode(uint256) view returns (bool)",
  "function getTroveOwnersCount() view returns (uint256)",
  "function governableVariables() view returns (address)",
  "function isAccountFeeExempt(address) view returns (bool)",
]);

type Fn = (typeof ABI)[number]["name"];

export interface BorrowTerms {
  chainId: number;
  /** BTC price in USD, 18 decimals, as the protocol's PriceFeed reports it. */
  price: bigint;
  mcr: bigint;
  ccr: bigint;
  minNetDebt: bigint;
  gasCompensation: bigint;
  /** One-time borrowing fee, 18 decimals (0.001e18 is 0.1 percent). */
  borrowingRate: bigint;
  /** Fixed yearly interest for new troves, in basis points (100 is 1 percent). */
  interestRateBps: number;
  /** Total collateral ratio of the whole system, 18 decimals. */
  tcr: bigint;
  recoveryMode: boolean;
  troves: number;
  /** Every contract read used this block. Historical terms are not a transaction authorization. */
  snapshot?: BorrowSnapshot;
  /** Present only when the terms were read for this specific borrower. */
  borrower?: `0x${string}`;
  feeExempt?: boolean;
}

export interface BorrowSnapshot {
  block: number;
  hash: `0x${string}`;
  timestamp: number;
}

export interface BorrowReadOptions {
  account?: `0x${string}`;
  blockTag?: `0x${string}`;
}

async function read(chain: MezoChain, to: string, fn: Fn, args: readonly unknown[], block: string, fetchImpl?: Fetch): Promise<unknown> {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args } as never);
  return decodeFunctionResult({ abi: ABI, functionName: fn, data: await ethCall(chain, to, data, fetchImpl, undefined, block) } as never);
}

function quantity(raw: unknown, label: string): number {
  if (typeof raw !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(raw)) throw new Error(`Invalid ${label} from RPC`);
  const n = Number(BigInt(raw));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${label} from RPC`);
  return n;
}

/** Read borrowing rules at one block, and reject a changed block hash or wrong RPC chain. */
export async function readBorrowTerms(chain: MezoChain, fetchImpl?: Fetch, options: BorrowReadOptions = {}): Promise<BorrowTerms> {
  if (quantity(await rpc<string>(chain, "eth_chainId", [], fetchImpl), "chain id") !== chain.id) throw new Error("Borrow RPC reports the wrong chain");
  const blockTag = options.blockTag ?? await rpc<`0x${string}`>(chain, "eth_blockNumber", [], fetchImpl);
  const block = quantity(blockTag, "block number");
  const header = await rpc<{ number: string; hash: `0x${string}`; timestamp: string } | null>(chain, "eth_getBlockByNumber", [blockTag, false], fetchImpl);
  if (!header || quantity(header.number, "block number") !== block || !/^0x[0-9a-f]{64}$/i.test(header.hash)) throw new Error("Borrow snapshot block is missing or invalid");
  const timestamp = quantity(header.timestamp, "block timestamp");
  const s = chain.system;
  const bo = (fn: Fn) => read(chain, s.borrowerOperations, fn, [], blockTag, fetchImpl) as Promise<bigint>;
  const price = (await read(chain, s.priceFeed, "fetchPrice", [], blockTag, fetchImpl)) as bigint;
  const [mcr, ccr, minNetDebt, gasCompensation, borrowingRate, rate, tcr, recoveryMode, troves] = await Promise.all([
    bo("MCR"),
    bo("CCR"),
    bo("minNetDebt"),
    bo("MUSD_GAS_COMPENSATION"),
    bo("borrowingRate"),
    read(chain, s.interestRateManager, "interestRate", [], blockTag, fetchImpl) as Promise<number>,
    read(chain, s.troveManager, "getTCR", [price], blockTag, fetchImpl) as Promise<bigint>,
    read(chain, s.troveManager, "checkRecoveryMode", [price], blockTag, fetchImpl) as Promise<boolean>,
    read(chain, s.troveManager, "getTroveOwnersCount", [], blockTag, fetchImpl) as Promise<bigint>,
  ]);
  if (price <= 0n) throw new Error("PriceFeed returned a zero price");
  if (mcr < ONE || ccr < mcr) throw new Error("Unexpected collateral ratios from BorrowerOperations");
  if (recoveryMode !== (tcr < ccr)) throw new Error("Inconsistent recovery mode in the borrow snapshot");
  if (minNetDebt <= 0n || gasCompensation < 0n || borrowingRate < 0n || borrowingRate > ONE || !Number.isSafeInteger(Number(troves))) throw new Error("Unexpected borrowing rules from BorrowerOperations");
  let accountTerms: Pick<BorrowTerms, "borrower" | "feeExempt"> = {};
  if (options.account) {
    const borrower = getAddress(options.account);
    const governance = await read(chain, s.borrowerOperations, "governableVariables", [], blockTag, fetchImpl) as `0x${string}`;
    const feeExempt = await read(chain, governance, "isAccountFeeExempt", [borrower], blockTag, fetchImpl) as boolean;
    accountTerms = { borrower, feeExempt };
  }
  const after = await rpc<{ hash: string } | null>(chain, "eth_getBlockByNumber", [blockTag, false], fetchImpl);
  if (!after || after.hash !== header.hash) throw new Error("Borrow snapshot changed during the read. Refresh the quote.");
  return { chainId: chain.id, price, mcr, ccr, minNetDebt, gasCompensation, borrowingRate, interestRateBps: Number(rate), tcr, recoveryMode, troves: Number(troves), snapshot: { block, hash: header.hash, timestamp }, ...accountTerms };
}

export interface BorrowQuote {
  /** MUSD the payer asked for. */
  need: bigint;
  /** MUSD minted to the payer. The amount plus the actual fee must meet minNetDebt. */
  borrow: bigint;
  fee: bigint;
  gasCompensation: bigint;
  /** Debt recorded on the trove: borrow + fee + gas compensation. */
  totalDebt: bigint;
  /** Collateral ratio the quote uses, 18 decimals. Never below MCR, and never below CCR in recovery mode. */
  ratio: bigint;
  /** BTC to deposit, in wei (18 decimals), rounded up. */
  collateral: bigint;
  /** BTC at exactly MCR, the hard floor, rounded up. */
  minCollateral: bigint;
  /** BTC price at which this trove would reach MCR and could be liquidated, 18 decimals. */
  liquidationPrice: bigint;
  /** About one year of interest at the current rate, on borrow + fee. */
  yearlyInterest: bigint;
  notes: string[];
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Pure quote. `need` is in MUSD base units. `ratio` is the collateral ratio to aim for (18 decimals).
 * Throws on a zero or negative need.
 */
export function quoteBorrow(terms: BorrowTerms, need: bigint, ratio: bigint = (terms.ccr * 4n) / 3n): BorrowQuote {
  if (need <= 0n) throw new RangeError("need must be greater than zero");
  if (terms.price <= 0n || terms.minNetDebt <= 0n || terms.gasCompensation < 0n || terms.borrowingRate < 0n || terms.borrowingRate > ONE || terms.mcr < ONE || terms.ccr < terms.mcr) throw new RangeError("Invalid borrowing terms");
  const notes: string[] = [];
  const floor = terms.recoveryMode ? terms.ccr : terms.mcr;
  if (ratio < floor) {
    notes.push(`The ratio was raised to ${pct(floor)}, the lowest a new trove can open at right now.`);
    ratio = floor;
  }
  // BorrowerOperations applies no borrowing fee in recovery mode or to an exempt borrower.
  // Its minimum check includes the fee: borrow + floor(borrow * rate / ONE) >= minNetDebt.
  const feeRate = terms.recoveryMode || terms.feeExempt === true ? 0n : terms.borrowingRate;
  const minimumBorrow = ceilDiv(terms.minNetDebt * ONE, ONE + feeRate);
  const borrow = need < minimumBorrow ? minimumBorrow : need;
  if (borrow > need) {
    notes.push(`The minimum net debt is ${formatAmount(terms.minNetDebt)} MUSD including the borrowing fee. This quote mints ${formatAmount(borrow - need)} MUSD more than the link asks for. You keep the rest.`);
  }
  const fee = (borrow * feeRate) / ONE;
  const totalDebt = borrow + fee + terms.gasCompensation;
  const collateral = ceilDiv(totalDebt * ratio, terms.price);
  const minCollateral = ceilDiv(totalDebt * terms.mcr, terms.price);
  const liquidationPrice = (totalDebt * terms.mcr) / collateral;
  const yearlyInterest = ((borrow + fee) * BigInt(terms.interestRateBps)) / 10_000n;
  notes.push(`The ${formatAmount(terms.gasCompensation)} MUSD gas reserve is part of the debt. It is minted to the protocol's GasPool, not your wallet, and burned there when you close the trove. It is not a refund to you.`);
  if (terms.feeExempt) notes.push("The protocol lists this borrower as exempt from the borrowing fee.");
  if (terms.recoveryMode) notes.push("The protocol is in recovery mode. New troves must open at the critical ratio or higher.");
  return { need, borrow, fee, gasCompensation: terms.gasCompensation, totalDebt, ratio, collateral, minCollateral, liquidationPrice, yearlyInterest, notes };
}

/** "150%" style text for an 18-decimal ratio, with up to one decimal. */
export function pct(ratio: bigint): string {
  const tenths = (ratio * 1000n) / ONE;
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return frac === 0n ? `${whole}%` : `${whole}.${frac}%`;
}
