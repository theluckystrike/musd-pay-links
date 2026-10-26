// Create a signed invoice on the live Worker from a merchant key file. The recipient is the key's address.
// The key is read from a file outside the repo and is never printed. It signs a message, not a transaction.
//
// Usage:
//   MEZO_KEY_FILE=/path/to/key pnpm create-invoice <amount MUSD> [reference] [--chain 31611] [--url https://...]

import { readFileSync } from "node:fs";

import { privateKeyToAccount } from "viem/accounts";

import { chainById, createPaymentLink, invoiceMessage, newReference } from "../src/index.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1] ?? fallback;
  args.splice(i, 2);
  return v;
};
const chainId = Number(flag("--chain", "31611"));
const base = flag("--url", "https://musd-pay-links.lipmichal.workers.dev");
const [amount, ref] = args;
const keyFile = process.env.MEZO_KEY_FILE;
if (!keyFile || !amount || !chainById(chainId)) {
  console.error("usage: MEZO_KEY_FILE=<file> pnpm create-invoice <amount MUSD> [reference] [--chain 31611] [--url <worker>]");
  process.exit(2);
}

const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as `0x${string}`);
const memo = ref ?? newReference();
// Normalise exactly as the Worker does, so the signed text matches.
const local = createPaymentLink({ chainId, recipient: account.address, amount, memo });
if (!local.ok) {
  for (const r of local.reasons) console.error(`  ${r.code}  ${r.message}`);
  process.exit(1);
}
const claim = { chainId, to: local.payment.recipient, amount: local.payment.amountText, memo, timestamp: Math.floor(Date.now() / 1000) };
const signature = await account.signMessage({ message: invoiceMessage(claim) });
const res = await fetch(`${base}/api/invoices`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chain: chainId, to: claim.to, amount: claim.amount, memo, timestamp: claim.timestamp, signature }),
});
const body = (await res.json()) as { invoice?: { qrSvg?: string } } & Record<string, unknown>;
delete (body as { qrSvg?: unknown }).qrSvg;
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(body, null, 2));
process.exit(res.status === 201 ? 0 : 1);
