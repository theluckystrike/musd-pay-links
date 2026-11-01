// Read-only verification. This command cannot request a wallet or send a transaction.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { verifyOpenTrove } from "../src/borrow-receipt.ts";
import { MEZO_TESTNET } from "../src/chains.ts";

const [hash, account] = process.argv.slice(2);
if (!hash || !account) throw new Error("Usage: pnpm verify-borrow <testnet transaction hash> <borrower address>");
const result = await verifyOpenTrove(MEZO_TESTNET, { hash, account });
const source = await readFile(new URL("../src/borrow-receipt.ts", import.meta.url));
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  chain: MEZO_TESTNET.id,
  readOnly: true,
  scope: "Verification of an existing transaction. This command creates no loan and does not prove a new in-product borrowing action.",
  receiptModuleSha256: createHash("sha256").update(source).digest("hex"),
  result,
}, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
if (result.status !== "confirmed") process.exitCode = 2;
