// Testnet-only preparation for one direct BorrowerOperations.openTrove call.
// This module reads and simulates. It never requests a wallet signature or sends a transaction.
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, parseAbi } from "viem";

import { quoteBorrow, readBorrowTerms, type BorrowQuote, type BorrowSnapshot, type BorrowTerms } from "./borrow.ts";
import { MEZO_TESTNET, type MezoChain } from "./chains.ts";
import { ethCall, rpc, type Fetch } from "./rpc.ts";

export const OPEN_TROVE_MAX_AGE_MS = 60_000;
export const BORROW_BLOCK_MAX_AGE_MS = 120_000;
export const OPEN_TROVE_EXECUTION_NOTICE = "This is a testnet transaction. The protocol has no maximum-fee argument. Price, fees and contract state can change before the transaction is mined, even after a successful simulation.";
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const SORTED_TROVES = "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA" as const;
const HINT_HELPERS = "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6" as const;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// Official matsnet deployment files at mezo-org/musd commit da7888a10949c8a5d3f884454cec8978cfa87e48.
// Address pins identify the reviewed deployment. They are not a compiler/bytecode security audit.
const PROXIES = [
  { proxy: MEZO_TESTNET.system.borrowerOperations, implementation: "0xc05Bf344BD5b58825784326dD3112fB6cC160dcC" },
  { proxy: MEZO_TESTNET.system.troveManager, implementation: "0x9aAB567966983e95536FC460C12266FB0Cc10B07" },
  { proxy: MEZO_TESTNET.system.priceFeed, implementation: "0xec42B37C12b8D73d320f4075A1BCd58B306629c1" },
  { proxy: MEZO_TESTNET.system.interestRateManager, implementation: "0xAA13B1d9CFFA3F44ab3A8BE0dC8774FB7841459C" },
  { proxy: SORTED_TROVES, implementation: "0x9177DF58A9614b84C8c2F68dF27506AB9a5d0323" },
  { proxy: HINT_HELPERS, implementation: "0x8adF3f35dBE4026112bCFc078872bcb967732Ea8" },
] as const;
const MAX_UINT256 = (1n << 256n) - 1n;
const ABI = parseAbi([
  "function openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable",
  "function musd() view returns (address)",
  "function troveManager() view returns (address)",
  "function borrowerOperations() view returns (address)",
  "function priceFeed() view returns (address)",
  "function interestRateManager() view returns (address)",
  "function sortedTroves() view returns (address)",
  "function governableVariables() view returns (address)",
  "function getTroveStatus(address) view returns (uint256)",
  "function getApproxHint(uint256,uint256,uint256) view returns (address,uint256,uint256)",
  "function findInsertPosition(uint256,address,address) view returns (address,address)",
]);
type Fn = (typeof ABI)[number]["name"];

export interface OpenTroveInput {
  account: `0x${string}`;
  need: bigint;
  /** Native test BTC in wei. The user chooses this value before reviewing the transaction. */
  collateral: bigint;
  ratio?: bigint;
}

export interface OpenTroveTransaction {
  from: `0x${string}`;
  to: `0x${string}`;
  chainId: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
  nonce: `0x${string}`;
  gas: `0x${string}`;
  gasPrice: `0x${string}`;
}

export interface PreparedOpenTrove {
  version: 1;
  chainId: 31611;
  account: `0x${string}`;
  need: bigint;
  collateral: bigint;
  ratio: bigint;
  quote: BorrowQuote;
  /** Projection from the chosen collateral at the quoted price, not an observed onchain trove. */
  position: {
    actualCollateral: bigint;
    actualRatio: bigint;
    liquidationPrice: bigint;
    totalDebt: bigint;
  };
  terms: BorrowTerms;
  snapshot: BorrowSnapshot;
  transaction: OpenTroveTransaction;
  nativeBalance: bigint;
  estimatedGas: bigint;
  maxGasCost: bigint;
  /** Nonempty code hashes and exact implementation addresses observed at the snapshot block. */
  deployment: {
    contracts: { address: string; codeHash: `0x${string}` }[];
    implementations: { proxy: string; implementation: string; codeHash: `0x${string}` }[];
  };
  preparedAt: number;
  expiresAt: number;
  simulation: { success: true; block: number; result: "0x" };
}

const hex = (n: bigint): `0x${string}` => `0x${n.toString(16)}`;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function uint(raw: unknown, label: string): bigint {
  if (typeof raw !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(raw)) throw new Error(`Invalid ${label} from RPC`);
  const n = BigInt(raw);
  if (n > MAX_UINT256) throw new Error(`Invalid ${label} from RPC`);
  return n;
}

function checkedChain(chain: MezoChain): void {
  if (chain.id !== MEZO_TESTNET.id || !chain.testnet || !sameAddress(chain.musd, MEZO_TESTNET.musd)
    || Object.entries(MEZO_TESTNET.system).some(([key, value]) => !sameAddress(chain.system[key as keyof typeof chain.system], value))) {
    throw new Error("Borrowing actions are enabled only for the pinned Mezo Testnet deployment");
  }
}

function assertFreshBlock(snapshot: BorrowSnapshot): void {
  const age = Date.now() - snapshot.timestamp * 1000;
  if (age > BORROW_BLOCK_MAX_AGE_MS || age < -30_000) throw new Error("The borrow snapshot is stale or has an invalid timestamp. Refresh the quote.");
}

async function read(chain: MezoChain, to: string, fn: Fn, args: readonly unknown[], block: string, fetchImpl?: Fetch): Promise<unknown> {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args } as never);
  return decodeFunctionResult({ abi: ABI, functionName: fn, data: await ethCall(chain, to, data, fetchImpl, undefined, block) } as never);
}

/** Prepare a direct testnet transaction after real balance, code, deployment and simulation checks. */
export async function prepareOpenTrove(chain: MezoChain, input: OpenTroveInput, fetchImpl?: Fetch): Promise<PreparedOpenTrove> {
  checkedChain(chain);
  const account = getAddress(input.account);
  if (sameAddress(account, ZERO)) throw new Error("A nonzero borrower account is required");
  if (input.need <= 0n || input.need > MAX_UINT256 || input.collateral <= 0n || input.collateral > MAX_UINT256) throw new RangeError("Borrow amount and collateral must be positive uint256 values");
  const terms = await readBorrowTerms(chain, fetchImpl, { account });
  const snapshot = terms.snapshot!;
  assertFreshBlock(snapshot);
  const block = hex(BigInt(snapshot.block));
  const s = chain.system;
  const linked = await Promise.all([
    read(chain, s.borrowerOperations, "musd", [], block, fetchImpl),
    read(chain, s.borrowerOperations, "troveManager", [], block, fetchImpl),
    read(chain, s.borrowerOperations, "priceFeed", [], block, fetchImpl),
    read(chain, s.borrowerOperations, "interestRateManager", [], block, fetchImpl),
    read(chain, s.borrowerOperations, "sortedTroves", [], block, fetchImpl),
    read(chain, HINT_HELPERS, "borrowerOperations", [], block, fetchImpl),
    read(chain, HINT_HELPERS, "troveManager", [], block, fetchImpl),
    read(chain, HINT_HELPERS, "sortedTroves", [], block, fetchImpl),
  ]) as string[];
  const expected = [chain.musd, s.troveManager, s.priceFeed, s.interestRateManager, SORTED_TROVES, s.borrowerOperations, s.troveManager, SORTED_TROVES];
  if (linked.some((address, i) => !sameAddress(address, expected[i]!))) throw new Error("The live borrowing deployment differs from the pinned Mezo contracts");
  const addresses = [...new Set([s.borrowerOperations, s.troveManager, s.priceFeed, s.interestRateManager, chain.musd, SORTED_TROVES, HINT_HELPERS])];
  const [status, balanceRaw, nonceRaw, gasPriceRaw, ...codes] = await Promise.all([
    read(chain, s.troveManager, "getTroveStatus", [account], block, fetchImpl),
    rpc<string>(chain, "eth_getBalance", [account, "pending"], fetchImpl),
    rpc<string>(chain, "eth_getTransactionCount", [account, "pending"], fetchImpl),
    rpc<string>(chain, "eth_gasPrice", [], fetchImpl),
    ...addresses.map((address) => rpc<string>(chain, "eth_getCode", [address, block], fetchImpl)),
  ]);
  if (status === 1n) throw new Error("This account already has an active trove. Opening another is not permitted.");
  if (typeof status !== "bigint" || status < 0n || status > 4n) throw new Error("Unexpected trove status");
  if (codes.some((code) => typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || /^0x0+$/i.test(code))) throw new Error("A required Mezo contract has no valid deployed code");
  const implementations = await Promise.all(PROXIES.map(async ({ proxy, implementation }) => {
    const slot = await rpc<string>(chain, "eth_getStorageAt", [proxy, IMPLEMENTATION_SLOT, block], fetchImpl);
    if (!/^0x0{24}[0-9a-f]{40}$/i.test(slot) || !sameAddress(`0x${slot.slice(-40)}`, implementation)) throw new Error("A Mezo proxy implementation changed from the pinned deployment. Borrowing is disabled pending review.");
    const code = await rpc<`0x${string}`>(chain, "eth_getCode", [implementation, block], fetchImpl);
    if (!/^0x(?:[0-9a-f]{2})+$/i.test(code) || /^0x0+$/i.test(code)) throw new Error("A pinned Mezo implementation has no valid deployed code");
    return { proxy, implementation, codeHash: keccak256(code) };
  }));
  const deployment = { contracts: addresses.map((address, i) => ({ address, codeHash: keccak256(codes[i] as `0x${string}`) })), implementations };
  const nativeBalance = uint(balanceRaw, "native balance");
  const nonce = uint(nonceRaw, "pending account nonce");
  const gasPrice = uint(gasPriceRaw, "gas price");
  if (gasPrice === 0n) throw new Error("The network returned a zero gas price");
  const quote = quoteBorrow(terms, input.need, input.ratio);
  if (quote.totalDebt > MAX_UINT256 || input.collateral < quote.collateral) throw new Error("The chosen collateral does not meet the reviewed collateral ratio");
  if (nativeBalance <= input.collateral) throw new Error("The borrower needs enough test BTC for both collateral and transaction gas");
  const nicr = (input.collateral * 10n ** 20n) / quote.totalDebt;
  let approximate: `0x${string}` = ZERO;
  if (terms.troves > 0) {
    const result = await read(chain, HINT_HELPERS, "getApproxHint", [nicr, 15n, 42n], block, fetchImpl) as readonly [`0x${string}`, bigint, bigint];
    approximate = result[0];
  }
  const hints = await read(chain, SORTED_TROVES, "findInsertPosition", [nicr, approximate, approximate], block, fetchImpl) as readonly [`0x${string}`, `0x${string}`];
  const data = encodeFunctionData({ abi: ABI, functionName: "openTrove", args: [quote.borrow, hints[0], hints[1]] });
  const core = { from: account, to: s.borrowerOperations, data, value: hex(input.collateral) };
  // No state overrides: the simulation uses the account's actual balance and the deployed contracts.
  const simulation = await rpc<string>(chain, "eth_call", [core, block], fetchImpl);
  if (simulation !== "0x") throw new Error("Unexpected openTrove simulation result");
  const estimatedGas = uint(await rpc<string>(chain, "eth_estimateGas", [core, block], fetchImpl), "gas estimate");
  if (estimatedGas === 0n) throw new Error("The network returned a zero gas estimate");
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  const maxGasCost = gasLimit * gasPrice;
  if (nativeBalance < input.collateral + maxGasCost) throw new Error("The borrower needs more test BTC for collateral and the gas limit");
  const after = await rpc<{ hash: string } | null>(chain, "eth_getBlockByNumber", [block, false], fetchImpl);
  if (!after || after.hash !== snapshot.hash) throw new Error("The borrow snapshot changed during simulation. Refresh the quote.");
  if (uint(await rpc<string>(chain, "eth_chainId", [], fetchImpl), "chain id") !== 31611n) throw new Error("Borrow RPC changed chain during preparation");
  assertFreshBlock(snapshot);
  const preparedAt = Date.now();
  return {
    version: 1, chainId: 31611, account, need: input.need, collateral: input.collateral, ratio: quote.ratio,
    quote,
    position: {
      actualCollateral: input.collateral,
      actualRatio: input.collateral * terms.price / quote.totalDebt,
      liquidationPrice: quote.totalDebt * terms.mcr / input.collateral,
      totalDebt: quote.totalDebt,
    },
    terms, snapshot, nativeBalance, estimatedGas, maxGasCost, deployment, preparedAt,
    expiresAt: Math.min(preparedAt + OPEN_TROVE_MAX_AGE_MS, snapshot.timestamp * 1000 + BORROW_BLOCK_MAX_AGE_MS),
    transaction: { ...core, chainId: "0x7b7b", nonce: hex(nonce), gas: hex(gasLimit), gasPrice: hex(gasPrice) },
    simulation: { success: true, block: snapshot.block, result: "0x" },
  };
}

/** Recheck immediately before asking the wallet. Changed terms require a new visible review. */
export async function revalidateOpenTrove(
  prepared: PreparedOpenTrove,
  wallet: { account: string; chainId: number },
  fetchImpl?: Fetch,
): Promise<PreparedOpenTrove> {
  if (prepared.version !== 1 || prepared.chainId !== 31611 || wallet.chainId !== 31611 || !sameAddress(wallet.account, prepared.account)) throw new Error("The borrower account or wallet chain changed. Review a new quote.");
  if (!Number.isFinite(prepared.preparedAt) || !Number.isFinite(prepared.expiresAt) || prepared.preparedAt > Date.now() || prepared.expiresAt <= Date.now() || prepared.expiresAt - prepared.preparedAt > OPEN_TROVE_MAX_AGE_MS) throw new Error("The borrow quote expired. Review a new quote.");
  const fresh = await prepareOpenTrove(MEZO_TESTNET, { account: prepared.account, need: prepared.need, collateral: prepared.collateral, ratio: prepared.ratio }, fetchImpl);
  const amounts = ["borrow", "fee", "gasCompensation", "totalDebt", "ratio"] as const;
  const rules = ["price", "mcr", "ccr", "minNetDebt", "gasCompensation", "borrowingRate", "interestRateBps", "recoveryMode", "feeExempt"] as const;
  const txFields = ["from", "to", "chainId", "data", "value", "nonce", "gas", "gasPrice"] as const;
  const positionFields = ["actualCollateral", "actualRatio", "liquidationPrice", "totalDebt"] as const;
  if (amounts.some((key) => fresh.quote[key] !== prepared.quote[key])
    || positionFields.some((key) => fresh.position[key] !== prepared.position[key])
    || rules.some((key) => fresh.terms[key] !== prepared.terms[key])
    || JSON.stringify(fresh.deployment) !== JSON.stringify(prepared.deployment)
    || txFields.some((key) => fresh.transaction[key].toLowerCase() !== prepared.transaction[key].toLowerCase())) {
    throw new Error("Borrowing terms, hints or transaction details changed. Review a new quote.");
  }
  return fresh;
}
