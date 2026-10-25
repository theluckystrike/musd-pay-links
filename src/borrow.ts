// Borrow quote: how much BTC a payer must lock in the MUSD protocol to mint the MUSD a link asks for.
//
// MUSD is minted by opening a trove in BorrowerOperations with BTC as collateral. The rules used here are
// read live from the protocol contracts listed in chains.ts, never assumed:
//   - minNetDebt and MUSD_GAS_COMPENSATION (BorrowerOperations). The gas compensation is added to the debt
//     and paid back when the trove is closed.
//   - borrowingRate (BorrowerOperations), a one-time fee on the borrowed amount.
//   - MCR and CCR (BorrowerOperations). Below MCR a trove can be liquidated. Below CCR for the whole system
//     the protocol is in recovery mode, and new troves must open at CCR or above.
//   - fetchPrice() (PriceFeed), the BTC price the protocol uses, in USD with 18 decimals.
//   - interestRate() (InterestRateManager), the fixed yearly rate for new troves, in basis points.
// All math is exact bigint math at 18 decimals. The library never signs and never sends.

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

import { formatAmount } from "./amount.ts";
import { type MezoChain } from "./chains.ts";
import { ethCall, type Fetch } from "./rpc.ts";

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
}

async function read(chain: MezoChain, to: string, fn: Fn, args: readonly unknown[], fetchImpl?: Fetch): Promise<unknown> {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args } as never);
  return decodeFunctionResult({ abi: ABI, functionName: fn, data: await ethCall(chain, to, data, fetchImpl) } as never);
}

/** Read the live borrowing rules from the MUSD protocol contracts. */
export async function readBorrowTerms(chain: MezoChain, fetchImpl?: Fetch): Promise<BorrowTerms> {
  const s = chain.system;
  const bo = (fn: Fn) => read(chain, s.borrowerOperations, fn, [], fetchImpl) as Promise<bigint>;
  const price = (await read(chain, s.priceFeed, "fetchPrice", [], fetchImpl)) as bigint;
  const [mcr, ccr, minNetDebt, gasCompensation, borrowingRate, rate, tcr, recoveryMode, troves] = await Promise.all([
    bo("MCR"),
    bo("CCR"),
    bo("minNetDebt"),
    bo("MUSD_GAS_COMPENSATION"),
    bo("borrowingRate"),
    read(chain, s.interestRateManager, "interestRate", [], fetchImpl) as Promise<number>,
    read(chain, s.troveManager, "getTCR", [price], fetchImpl) as Promise<bigint>,
    read(chain, s.troveManager, "checkRecoveryMode", [price], fetchImpl) as Promise<boolean>,
    read(chain, s.troveManager, "getTroveOwnersCount", [], fetchImpl) as Promise<bigint>,
  ]);
  if (price <= 0n) throw new Error("PriceFeed returned a zero price");
  if (mcr < ONE || ccr < mcr) throw new Error("Unexpected collateral ratios from BorrowerOperations");
  return { chainId: chain.id, price, mcr, ccr, minNetDebt, gasCompensation, borrowingRate, interestRateBps: Number(rate), tcr, recoveryMode, troves: Number(troves) };
}

export interface BorrowQuote {
  /** MUSD the payer asked for. */
  need: bigint;
  /** MUSD that the trove mints to the payer. At least minNetDebt, so it can be more than `need`. */
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
  const notes: string[] = [];
  const floor = terms.recoveryMode ? terms.ccr : terms.mcr;
  if (ratio < floor) {
    notes.push(`The ratio was raised to ${pct(floor)}, the lowest a new trove can open at right now.`);
    ratio = floor;
  }
  const borrow = need < terms.minNetDebt ? terms.minNetDebt : need;
  if (borrow > need) {
    notes.push(`The protocol minimum is ${formatAmount(terms.minNetDebt)} MUSD, so the trove mints ${formatAmount(borrow - need)} MUSD more than the link asks for. You keep the rest.`);
  }
  const fee = (borrow * terms.borrowingRate) / ONE;
  const totalDebt = borrow + fee + terms.gasCompensation;
  const collateral = ceilDiv(totalDebt * ratio, terms.price);
  const minCollateral = ceilDiv(totalDebt * terms.mcr, terms.price);
  const liquidationPrice = (totalDebt * terms.mcr) / collateral;
  const yearlyInterest = ((borrow + fee) * BigInt(terms.interestRateBps)) / 10_000n;
  notes.push(`The ${formatAmount(terms.gasCompensation)} MUSD gas compensation is part of the debt and comes back when the trove is closed.`);
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
