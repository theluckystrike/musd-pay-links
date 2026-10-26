// Mezo networks and the MUSD token contract on each one.
//
// Every value below was checked against two independent sources on 2026-10-18:
//  1. Mezo docs, "MUSD Payments With x402", network table:
//     https://mezo.org/docs/developers/getting-started/musd-payments-x402/
//     (source: github.com/mezo-org/documentation, src/content/docs/docs/developers/getting-started/musd-payments-x402/index.mdx)
//  2. The Mezo Blockscout explorers, which list both contracts as verified source code,
//     contract name "MUSD", token name "Mezo USD", symbol "MUSD", 18 decimals:
//     https://explorer.test.mezo.org/token/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
//     https://explorer.mezo.org/token/0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186
// Chain ids and RPC endpoints come from https://mezo.org/docs/developers/getting-started/
// and were confirmed with eth_chainId (0x7b7b = 31611, 0x7b7c = 31612).

export const MUSD_DECIMALS = 18;

/**
 * Blocks a payment must have (its own block included) before an invoice is recorded as paid.
 * About 20 seconds on Mezo Testnet. A shallow reorg can drop a payment that only one block holds.
 */
export const CONFIRMATIONS_REQUIRED = 5;

export interface MezoChain {
  readonly id: number;
  readonly name: string;
  readonly musd: `0x${string}`;
  readonly rpc: string;
  /** A second RPC endpoint for the same chain, used when the first one does not answer or answers null. */
  readonly rpcFallback?: string;
  readonly explorer: string;
  readonly testnet: boolean;
  /** The MUSD borrowing system that mints MUSD against BTC on this chain. */
  readonly system: MusdSystem;
}

/**
 * Contracts of the MUSD protocol (a Liquity-style CDP system where BTC is the collateral).
 * Addresses come from the official deployment files in github.com/mezo-org/musd,
 * solidity/artifacts/deployments/matsnet (chain id 31611) and .../mainnet (chain id 31612),
 * read on 2026-10-25. On both chains BorrowerOperations.priceFeed(), .troveManager() and
 * .interestRateManager() return these same addresses, which was checked with eth_call.
 */
export interface MusdSystem {
  readonly borrowerOperations: `0x${string}`;
  readonly troveManager: `0x${string}`;
  readonly priceFeed: `0x${string}`;
  readonly interestRateManager: `0x${string}`;
}

export const MEZO_TESTNET: MezoChain = {
  id: 31611,
  name: "Mezo Testnet",
  musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
  // The Mezo docs list one testnet HTTP endpoint, https://rpc.test.mezo.org
  // (https://mezo.org/docs/developers/getting-started/configure-environment/).
  rpc: "https://rpc.test.mezo.org",
  // Public third-party provider (dRPC), not in the Mezo docs. It answers eth_chainId 0x7b7b and serves
  // receipts that a lagging node behind the first endpoint sometimes answers as null.
  rpcFallback: "https://mezo-testnet.drpc.org",
  explorer: "https://explorer.test.mezo.org",
  testnet: true,
  system: {
    borrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
    troveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
    priceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
    interestRateManager: "0xD4D6c36A592A2c5e86035A6bca1d57747a567f37",
  },
};

export const MEZO_MAINNET: MezoChain = {
  id: 31612,
  name: "Mezo Mainnet",
  musd: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186",
  // Both endpoints are in the Mezo docs mainnet table. Boar is the one the docs use in their Hardhat
  // and Foundry examples. dRPC was the first choice before, but on 2026-10-25 it refused eth_call
  // ("the method eth_call does not exist/is not available"), so it is no longer used.
  rpc: "https://mezo-mainnet.boar.network",
  rpcFallback: "https://mainnet.mezo.public.validationcloud.io",
  explorer: "https://explorer.mezo.org",
  testnet: false,
  system: {
    borrowerOperations: "0x44b1bac67dDA612a41a58AAf779143B181dEe031",
    troveManager: "0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193",
    priceFeed: "0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88",
    interestRateManager: "0x4a453700d157717Fe02fB62E7700ED7845048285",
  },
};

export const MEZO_CHAINS: readonly MezoChain[] = [MEZO_TESTNET, MEZO_MAINNET];

export function chainById(id: number): MezoChain | undefined {
  return MEZO_CHAINS.find((c) => c.id === id);
}
