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

export interface MezoChain {
  readonly id: number;
  readonly name: string;
  readonly musd: `0x${string}`;
  readonly rpc: string;
  readonly explorer: string;
  readonly testnet: boolean;
}

export const MEZO_TESTNET: MezoChain = {
  id: 31611,
  name: "Mezo Testnet",
  musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
  rpc: "https://rpc.test.mezo.org",
  explorer: "https://explorer.test.mezo.org",
  testnet: true,
};

export const MEZO_MAINNET: MezoChain = {
  id: 31612,
  name: "Mezo Mainnet",
  musd: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186",
  rpc: "https://mezo.drpc.org",
  explorer: "https://explorer.mezo.org",
  testnet: false,
};

export const MEZO_CHAINS: readonly MezoChain[] = [MEZO_TESTNET, MEZO_MAINNET];

export function chainById(id: number): MezoChain | undefined {
  return MEZO_CHAINS.find((c) => c.id === id);
}
