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
// The throwaway testnet address of this project (key outside the repo). It opened a trove and paid invoice
// INV-65ZVUMXW on 2026-10-26. The merchant test address received the 5 MUSD.
const THROWAWAY = "0x980E2213E6396043e2d104Ad65cBF162985Ce313";
const OWN_BORROW_TX = "0x1de64d3a9fe0588d2707718ed3c247d793f5d5f818efd502ae80ee8dc70a26f2";
const OWN_PAY_TX = "0x7abfedb120383f817134e5e63823aef69948930fa9760c6b96fb03a87909cc0b";
const OWN_MERCHANT = "0x94958151D1789C8279a67f5cE4631e9DDdE43cB6";
const OWN_MEMO = "INV-65ZVUMXW";
const OWN_INVOICE_BLOCK = 16370824;
// An address with no trove, used as the "from" of the openTrove simulation.
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

  // openTrove for the smallest trove, simulated with eth_call and a state override that gives an
  // address with no trove 1 test BTC. Nothing is signed or sent.
  const tterms = await readBorrowTerms(MEZO_TESTNET);
  const q = quoteBorrow(tterms, tterms.minNetDebt);
  const ZERO = "0x0000000000000000000000000000000000000000";
  const data = encodeFunctionData({ abi: parseAbi(["function openTrove(uint256,address,address) payable"]), functionName: "openTrove", args: [q.borrow, ZERO, ZERO] });
  const tx = { from: MERCHANT, to: MEZO_TESTNET.system.borrowerOperations, data, value: "0x" + q.collateral.toString(16) };
  let sim: string;
  try {
    sim = `ok ${await rpc<string>(MEZO_TESTNET, "eth_call", [tx, "latest", { [MERCHANT]: { balance: "0x" + (10n ** 18n).toString(16) } }])}`;
  } catch (e) {
    sim = `reverted ${(e as Error).message}`;
  }
  out.openTroveSimulation = { borrow: q.borrow.toString(), collateral: q.collateral.toString(), to: tx.to, result: sim };

  const inbox = await findPayments(MEZO_TESTNET, { recipient: ACTIVE_RECIPIENT });
  out.inbox = inbox.status === "ok"
    ? { status: inbox.status, fromBlock: inbox.fromBlock, head: inbox.head, payments: inbox.payments.length, withReference: inbox.payments.filter((p) => p.memo).length, newest: inbox.payments[0]?.txHash ?? null }
    : inbox;

  // The project's own testnet payment, end to end. Borrow receipt, trove state, invoice payment and inbox.
  const tmAbi = parseAbi(["function getTroveStatus(address) view returns (uint256)", "function getTroveColl(address) view returns (uint256)", "function getTroveDebt(address) view returns (uint256)"]);
  const troveRead = async (fn: "getTroveStatus" | "getTroveColl" | "getTroveDebt") =>
    BigInt(await rpc<string>(MEZO_TESTNET, "eth_call", [{ to: MEZO_TESTNET.system.troveManager, data: encodeFunctionData({ abi: tmAbi, functionName: fn, args: [THROWAWAY] }) }, "latest"])).toString();
  const borrowReceipt = await rpc<{ status: string; blockNumber: string }>(MEZO_TESTNET, "eth_getTransactionReceipt", [OWN_BORROW_TX]);
  const ownInbox = await findPayments(MEZO_TESTNET, { recipient: OWN_MERCHANT, fromBlock: OWN_INVOICE_BLOCK, memo: OWN_MEMO, amount: 5n * 10n ** 18n });
  out.ownPayment = {
    borrowTx: OWN_BORROW_TX,
    borrowStatus: borrowReceipt.status,
    borrowBlock: Number(borrowReceipt.blockNumber),
    trove: { owner: THROWAWAY, status: await troveRead("getTroveStatus"), collateral: await troveRead("getTroveColl"), debt: await troveRead("getTroveDebt") },
    payTx: OWN_PAY_TX,
    verify: await verifyPayment(MEZO_TESTNET, { txHash: OWN_PAY_TX, recipient: OWN_MERCHANT, amount: 5n * 10n ** 18n, memo: OWN_MEMO, fromBlock: OWN_INVOICE_BLOCK }),
    verifyWrongReference: await verifyPayment(MEZO_TESTNET, { txHash: OWN_PAY_TX, recipient: OWN_MERCHANT, amount: 5n * 10n ** 18n, memo: "INV-0001" }),
    inbox: ownInbox.status === "ok" ? { status: ownInbox.status, paid: ownInbox.paid?.txHash ?? null, payments: ownInbox.payments.length } : ownInbox,
  };

  const json = JSON.stringify(out, null, 2);
  writeFileSync(new URL("../docs/evidence.json", import.meta.url), json + "\n");
  console.log(json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
