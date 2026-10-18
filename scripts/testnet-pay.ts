// Pay a MUSD link on Mezo Testnet from a throwaway key, then verify it the way a merchant would.
// The key is read from a file outside the repo and is never printed.
//
// Usage:
//   MEZO_KEY_FILE=/path/to/key pnpm testnet-pay "<ethereum:... link>" <max MUSD>
//
// The sending address needs testnet MUSD and a little testnet BTC for gas.

import { readFileSync } from "node:fs";

import { createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { checkPaymentLink, formatAmount, MEZO_TESTNET, readBalance, rpc, verifyPayment } from "../src/index.ts";

const keyFile = process.env.MEZO_KEY_FILE;
const [link, max] = process.argv.slice(2);
if (!keyFile || !link || !max) {
  console.error('usage: MEZO_KEY_FILE=<file> pnpm testnet-pay "<link>" <max MUSD>');
  process.exit(2);
}

const checked = checkPaymentLink(link, { maxAmount: max, allowedChains: [MEZO_TESTNET.id] });
if (!checked.ok) {
  console.error("Refused by the guard:");
  for (const r of checked.reasons) console.error(`  ${r.code}  ${r.message}`);
  process.exit(1);
}

const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as `0x${string}`);
const chain = defineChain({
  id: MEZO_TESTNET.id,
  name: MEZO_TESTNET.name,
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [MEZO_TESTNET.rpc] } },
});

const musd = await readBalance(MEZO_TESTNET, account.address);
const btc = BigInt(await rpc<string>(MEZO_TESTNET, "eth_getBalance", [account.address, "latest"]));
console.log(`from ${account.address}  MUSD ${formatAmount(musd)}  BTC ${formatAmount(btc)}`);
if (musd < checked.payment.amount) {
  console.error(`Not enough MUSD: need ${checked.payment.amountText}. Nothing was sent.`);
  process.exit(1);
}
if (btc === 0n) {
  console.error("No testnet BTC for gas. Nothing was sent.");
  process.exit(1);
}

const wallet = createWalletClient({ account, chain, transport: http(MEZO_TESTNET.rpc) });
const hash = await wallet.sendTransaction({ to: checked.tx.to, data: checked.tx.data, value: 0n });
console.log(`sent ${hash}`);
console.log(`${MEZO_TESTNET.explorer}/tx/${hash}`);

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const v = await verifyPayment(MEZO_TESTNET, {
    txHash: hash,
    recipient: checked.payment.recipient,
    amount: checked.payment.amount,
    memo: checked.payment.memo,
  });
  if (v.status === "paid" || v.status === "failed" || v.status === "mismatch") {
    console.log(JSON.stringify(v, null, 2));
    process.exit(v.status === "paid" ? 0 : 1);
  }
}
console.error("No receipt after 120 seconds.");
process.exit(1);
