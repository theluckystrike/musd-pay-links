import { decodeFunctionData, encodeAbiParameters, parseAbi } from "viem";
import { MEZO_TESTNET } from "../../src/chains.ts";
import { retry, type Fetch } from "../../src/rpc.ts";

retry.delayMs = 1;
export const E = 10n ** 18n;
export const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
export const OTHER = "0x2222222222222222222222222222222222222222" as const;
export const ZERO = "0x0000000000000000000000000000000000000000" as const;
export const SORTED = "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA" as const;
export const HINTS = "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6" as const;
export const IMPLEMENTATIONS: Record<string, string> = {
  [MEZO_TESTNET.system.borrowerOperations.toLowerCase()]: "0xc05Bf344BD5b58825784326dD3112fB6cC160dcC",
  [MEZO_TESTNET.system.troveManager.toLowerCase()]: "0x9aAB567966983e95536FC460C12266FB0Cc10B07",
  [MEZO_TESTNET.system.priceFeed.toLowerCase()]: "0xec42B37C12b8D73d320f4075A1BCd58B306629c1",
  [MEZO_TESTNET.system.interestRateManager.toLowerCase()]: "0xAA13B1d9CFFA3F44ab3A8BE0dC8774FB7841459C",
  [SORTED.toLowerCase()]: "0x9177DF58A9614b84C8c2F68dF27506AB9a5d0323",
  [HINTS.toLowerCase()]: "0x8adF3f35dBE4026112bCFc078872bcb967732Ea8",
};
export const HASH = `0x${"ab".repeat(32)}`;
export const ABI = parseAbi([
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
  "function musd() view returns (address)",
  "function troveManager() view returns (address)",
  "function borrowerOperations() view returns (address)",
  "function priceFeed() view returns (address)",
  "function interestRateManager() view returns (address)",
  "function sortedTroves() view returns (address)",
  "function getTroveStatus(address) view returns (uint256)",
  "function getApproxHint(uint256,uint256,uint256) view returns (address,uint256,uint256)",
  "function findInsertPosition(uint256,address,address) view returns (address,address)",
  "function openTrove(uint256,address,address) payable",
]);

export interface Options {
  chainId?: string;
  status?: bigint;
  balance?: bigint;
  feeExempt?: boolean;
  recovery?: boolean;
  stale?: boolean;
  missingCode?: string;
  wrongLink?: boolean;
  revert?: boolean;
  gas?: string;
  gasPrice?: string;
  nonce?: string;
  feeRate?: bigint;
  price?: bigint;
  reorg?: boolean;
  upgradedProxy?: boolean;
  implementationCode?: string;
}
export interface Seen { method: string; params: unknown[]; fn?: string }
const word = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);
const address = (value: `0x${string}`) => encodeAbiParameters([{ type: "address" }], [value]);
const bool = (value: boolean) => encodeAbiParameters([{ type: "bool" }], [value]);

// Mock protocol responses only. These cases prove local guards, not an actual Mezo transaction.
export function protocol(options: Options = {}, seen: Seen[] = []): Fetch {
  const timestamp = Math.floor(Date.now() / 1000) - (options.stale ? 300 : 0);
  let headers = 0;
  return async (_url, init) => {
    const request = JSON.parse(String(init!.body));
    const { method, params } = request as { method: string; params: unknown[] };
    const record: Seen = { method, params };
    seen.push(record);
    const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "eth_chainId") return answer(options.chainId ?? "0x7b7b");
    if (method === "eth_blockNumber") return answer("0x3e8");
    if (method === "eth_getBlockByNumber") return answer({ number: "0x3e8", hash: options.reorg && ++headers > 1 ? `0x${"cd".repeat(32)}` : HASH, timestamp: `0x${timestamp.toString(16)}` });
    if (method === "eth_getCode") return answer(String(params[0]).toLowerCase() === options.missingCode?.toLowerCase() ? "0x" : options.implementationCode ?? "0x60016000");
    if (method === "eth_getStorageAt") return answer(`0x${(options.upgradedProxy ? OTHER : IMPLEMENTATIONS[String(params[0]).toLowerCase()]!).slice(2).toLowerCase().padStart(64, "0")}`);
    if (method === "eth_getBalance") return answer(`0x${(options.balance ?? E).toString(16)}`);
    if (method === "eth_getTransactionCount") return answer(options.nonce ?? "0x0");
    if (method === "eth_gasPrice") return answer(options.gasPrice ?? "0x3b9aca00");
    if (method === "eth_estimateGas") return answer(options.gas ?? "0x7a120");
    if (method !== "eth_call") throw new Error(`Unexpected mock RPC method ${method}`);
    const transaction = params[0] as { to: string; data: `0x${string}` };
    const decoded = decodeFunctionData({ abi: ABI, data: transaction.data });
    const fn = decoded.functionName;
    record.fn = fn;
    if (fn === "openTrove") {
      if (options.revert) return new Response(JSON.stringify({ error: { code: -32000, message: "execution reverted: test case" } }));
      return answer("0x");
    }
    const responses: Record<string, `0x${string}`> = {
      fetchPrice: word(options.price ?? 80_000n * E),
      MCR: word(11n * E / 10n),
      CCR: word(15n * E / 10n),
      minNetDebt: word(1800n * E),
      MUSD_GAS_COMPENSATION: word(200n * E),
      borrowingRate: word(options.feeRate ?? E / 1000n),
      interestRate: encodeAbiParameters([{ type: "uint16" }], [100]),
      getTCR: word((options.recovery ? 14n : 28n) * E / 10n),
      checkRecoveryMode: bool(options.recovery ?? false),
      getTroveOwnersCount: word(353n),
      governableVariables: address("0x6552059b6efc6aa4ae3ea45f28ed4d92ace020cd"),
      isAccountFeeExempt: bool(options.feeExempt ?? false),
      musd: address(options.wrongLink ? OTHER : MEZO_TESTNET.musd),
      troveManager: address(MEZO_TESTNET.system.troveManager),
      borrowerOperations: address(MEZO_TESTNET.system.borrowerOperations),
      priceFeed: address(MEZO_TESTNET.system.priceFeed),
      interestRateManager: address(MEZO_TESTNET.system.interestRateManager),
      sortedTroves: address(SORTED),
      getTroveStatus: word(options.status ?? 0n),
      getApproxHint: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [OTHER, 0n, 42n]),
      findInsertPosition: encodeAbiParameters([{ type: "address" }, { type: "address" }], [OTHER, ZERO]),
    };
    if (!(fn in responses)) throw new Error(`Unexpected mock contract method ${fn}`);
    return answer(responses[fn]);
  };
}
