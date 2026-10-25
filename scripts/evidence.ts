// Read-only evidence against the real MUSD contracts. Sends no transaction and needs no key.
// Usage: pnpm evidence   (writes docs/evidence.json)

import { writeFileSync } from "node:fs";

import { encodeFunctionData, parseAbi } from "viem";

import {
  checkPaymentLink,
  findPayments,
  quoteBorrow,
  readBorrowTerms,
  rpc,
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
// A public 6 MUSD wallet to wallet transfer() on Mezo Testnet made by someone else (2026-10-25, block 16360722),
// used to test verifyPayment. It carries no reference.
const REAL_TX = "0xc19b443ddcb35fdbe4389382dfff3815a82a0f2e12f43b00537d73db89be239a";
const REAL_TX_TO = "0x67A792C5025193C9cBDA498FE462Cbdf49C8a598";
const REAL_TX_AMOUNT = 6n * 10n ** 18n;
const REAL_TX_BLOCK = 16360722;
// An active testnet address that receives MUSD often, used to exercise the merchant inbox.
const ACTIVE_RECIPIENT = "0x64237b334f24b5d54B2A83ae0f8A9B74E29Cd564";
// The throwaway testnet address of this project (key outside the repo). Used only in a simulation.
const THROWAWAY = "0x980E2213E6396043e2d104Ad65cBF162985Ce313";
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
  out.verifyWrongReference = await verifyPayment(MEZO_TESTNET, { txHash: REAL_TX, recipient: REAL_TX_TO, amount: REAL_TX_AMOUNT, memo: "INV-0001" });
  out.verifyBeforeInvoiceBlock = await verifyPayment(MEZO_TESTNET, { txHash: REAL_TX, recipient: REAL_TX_TO, amount: REAL_TX_AMOUNT, fromBlock: REAL_TX_BLOCK + 1 });

  const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
  for (const chain of [MEZO_TESTNET, MEZO_MAINNET]) {
    const terms = await readBorrowTerms(chain);
    out[`borrow${chain.testnet ? "Testnet" : "Mainnet"}`] = JSON.parse(JSON.stringify({ terms, quoteFor25: quoteBorrow(terms, 25n * 10n ** 18n) }, big));
  }

  // openTrove for the smallest trove, simulated with eth_call and a state override that gives the
  // throwaway address 1 test BTC. Nothing is signed or sent.
  const tterms = await readBorrowTerms(MEZO_TESTNET);
  const q = quoteBorrow(tterms, tterms.minNetDebt);
  const ZERO = "0x0000000000000000000000000000000000000000";
  const data = encodeFunctionData({ abi: parseAbi(["function openTrove(uint256,address,address) payable"]), functionName: "openTrove", args: [q.borrow, ZERO, ZERO] });
  const tx = { from: THROWAWAY, to: MEZO_TESTNET.system.borrowerOperations, data, value: "0x" + q.collateral.toString(16) };
  let sim: string;
  try {
    sim = `ok ${await rpc<string>(MEZO_TESTNET, "eth_call", [tx, "latest", { [THROWAWAY]: { balance: "0x" + (10n ** 18n).toString(16) } }])}`;
  } catch (e) {
    sim = `reverted ${(e as Error).message}`;
  }
  out.openTroveSimulation = { borrow: q.borrow.toString(), collateral: q.collateral.toString(), to: tx.to, result: sim };

  const inbox = await findPayments(MEZO_TESTNET, { recipient: ACTIVE_RECIPIENT });
  out.inbox = inbox.status === "ok"
    ? { status: inbox.status, fromBlock: inbox.fromBlock, head: inbox.head, payments: inbox.payments.length, withReference: inbox.payments.filter((p) => p.memo).length, newest: inbox.payments[0]?.txHash ?? null }
    : inbox;

  const json = JSON.stringify(out, null, 2);
  writeFileSync(new URL("../docs/evidence.json", import.meta.url), json + "\n");
  console.log(json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
