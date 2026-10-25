// Mint testnet MUSD for the payment demo: open a trove on Mezo Testnet with testnet BTC as collateral.
// The key is read from a file outside the repo and is never printed. Testnet only, the chain id is checked.
//
// Usage:
//   MEZO_KEY_FILE=/path/to/key pnpm testnet-borrow [--dry-run]
//
// --dry-run simulates openTrove with eth_call and a state override that gives the address 1 test BTC,
// so the call path can be checked before the address holds any BTC. Nothing is sent in a dry run.

import { readFileSync } from "node:fs";

import { createWalletClient, defineChain, encodeFunctionData, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { formatAmount, MEZO_TESTNET, pct, quoteBorrow, readBalance, readBorrowTerms, rpc } from "../src/index.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const GAS_RESERVE = 10n ** 15n; // 0.001 BTC kept for gas
const abi = parseAbi(["function openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable"]);

const keyFile = process.env.MEZO_KEY_FILE;
const dry = process.argv.includes("--dry-run");
if (!keyFile) {
  console.error("usage: MEZO_KEY_FILE=<file> pnpm testnet-borrow [--dry-run]");
  process.exit(2);
}
const chainId = Number(await rpc<string>(MEZO_TESTNET, "eth_chainId", []));
if (chainId !== MEZO_TESTNET.id) throw new Error(`RPC is chain ${chainId}, not Mezo Testnet`);

const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as `0x${string}`);
const terms = await readBorrowTerms(MEZO_TESTNET);
const quote = quoteBorrow(terms, terms.minNetDebt); // the smallest trove the protocol allows
const btc = dry ? 10n ** 18n : BigInt(await rpc<string>(MEZO_TESTNET, "eth_getBalance", [account.address, "latest"]));
const musd = await readBalance(MEZO_TESTNET, account.address);
console.log(`from ${account.address}  BTC ${formatAmount(btc)}  MUSD ${formatAmount(musd)}${dry ? "  (BTC from the dry-run override)" : ""}`);
console.log(`quote  borrow ${formatAmount(quote.borrow)} MUSD  debt ${formatAmount(quote.totalDebt)}  collateral ${formatAmount(quote.collateral)} BTC at ${pct(quote.ratio)}  floor ${formatAmount(quote.minCollateral)} BTC`);

// Use the 200 percent quote when the balance allows it, otherwise as much as the balance allows down to CCR.
const floor = (quote.totalDebt * terms.ccr + terms.price - 1n) / terms.price;
const usable = btc > GAS_RESERVE ? btc - GAS_RESERVE : 0n;
const collateral = usable >= quote.collateral ? quote.collateral : usable;
if (collateral < floor) {
  console.error(`Need at least ${formatAmount(floor + GAS_RESERVE)} test BTC (CCR ${pct(terms.ccr)} plus gas). Nothing was sent.`);
  process.exit(1);
}
const data = encodeFunctionData({ abi, functionName: "openTrove", args: [quote.borrow, ZERO, ZERO] });
const tx = { from: account.address, to: MEZO_TESTNET.system.borrowerOperations, data, value: "0x" + collateral.toString(16) };
const override = dry ? [{ [account.address]: { balance: "0x" + btc.toString(16) } }] : [];
const sim = await rpc<string>(MEZO_TESTNET, "eth_call", [tx, "latest", ...override]);
console.log(`simulation of openTrove(${formatAmount(quote.borrow)} MUSD) with ${formatAmount(collateral)} BTC: ok (${sim})`);
if (dry) process.exit(0);

const chain = defineChain({
  id: MEZO_TESTNET.id,
  name: MEZO_TESTNET.name,
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [MEZO_TESTNET.rpc] } },
});
const wallet = createWalletClient({ account, chain, transport: http(MEZO_TESTNET.rpc) });
const hash = await wallet.sendTransaction({ to: tx.to, data, value: collateral });
console.log(`sent ${hash}`);
console.log(`${MEZO_TESTNET.explorer}/tx/${hash}`);
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const now = await readBalance(MEZO_TESTNET, account.address);
  if (now > musd) {
    console.log(`MUSD balance ${formatAmount(now)}`);
    process.exit(0);
  }
}
console.error("No MUSD after 120 seconds. Check the transaction in the explorer.");
process.exit(1);
