// Read-only evidence against the real MUSD contracts. Sends no transaction and needs no key.
// Usage: pnpm evidence   (writes docs/evidence.json)

import { writeFileSync } from "node:fs";

import {
  checkPaymentLink,
  createPaymentLink,
  MEZO_MAINNET,
  MEZO_TESTNET,
  readBalance,
  readTokenInfo,
  simulateTransfer,
  verifyPayment,
} from "../src/index.ts";

// A public testnet wallet (EOA) that holds MUSD, taken from the explorer holder list. Used only as the
// "from" of an eth_call dry run. Nothing is signed or sent.
const TESTNET_HOLDER = "0x401d68969c9afAdeEc0e9fE6B67221247CFa642F";
// A public MUSD transfer on Mezo Testnet made by someone else (2026-10-17), used to test verifyPayment.
const REAL_TX = "0xfc56e25bdddcba0e1d2b43e7c92958d3fa9021d6e814e2dae430a83f7418d805";
const REAL_TX_TO = "0x484b5593BbB90383f94FB299470F09427cf6cfE2";
const REAL_TX_AMOUNT = 245201907550000000000n;
const MERCHANT = "0x52908400098527886E0F7030069857D2E4169EE7";

async function main(): Promise<void> {
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  out.testnetToken = await readTokenInfo(MEZO_TESTNET);
  out.mainnetToken = await readTokenInfo(MEZO_MAINNET);
  out.holderBalance = (await readBalance(MEZO_TESTNET, TESTNET_HOLDER)).toString();

  const plain = createPaymentLink({ chainId: MEZO_TESTNET.id, recipient: MERCHANT, amount: "1.25" });
  const memo = createPaymentLink({ chainId: MEZO_TESTNET.id, recipient: MERCHANT, amount: "1.25", memo: "INV-1042" });
  if (!plain.ok || !memo.ok) throw new Error("link creation failed");
  const sims: Record<string, unknown> = {};
  for (const [name, link] of [["plain", plain.link], ["memo", memo.link]] as const) {
    const checked = checkPaymentLink(link, { maxAmount: "10" });
    if (!checked.ok) throw new Error(`guard refused ${name}`);
    sims[name] = { link, data: checked.tx.data, returns: await simulateTransfer(MEZO_TESTNET, TESTNET_HOLDER, checked.tx.data) };
  }
  out.simulations = sims;

  out.verifyReal = await verifyPayment(MEZO_TESTNET, { txHash: REAL_TX, recipient: REAL_TX_TO, amount: REAL_TX_AMOUNT });
  out.verifyTooHigh = await verifyPayment(MEZO_TESTNET, { txHash: REAL_TX, recipient: REAL_TX_TO, amount: REAL_TX_AMOUNT + 1n });
  out.verifyWrongRecipient = await verifyPayment(MEZO_TESTNET, { txHash: REAL_TX, recipient: MERCHANT, amount: 1n });

  const json = JSON.stringify(out, null, 2);
  writeFileSync(new URL("../docs/evidence.json", import.meta.url), json + "\n");
  console.log(json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
