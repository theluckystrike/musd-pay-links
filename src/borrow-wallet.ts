// One explicitly reviewed testnet loan request. Signing remains inside the connected browser wallet.
import { getAddress } from "viem";

import { revalidateOpenTrove, type OpenTroveTransaction, type PreparedOpenTrove } from "./borrow-action.ts";
import { MEZO_TESTNET } from "./chains.ts";
import type { Fetch } from "./rpc.ts";
import { isTransactionHash, type Eip1193 } from "./wallet.ts";

export type OpenTroveWalletResult =
  | { status: "sent"; hash: `0x${string}`; prepared: PreparedOpenTrove }
  | { status: "rejected"; message: string }
  | { status: "unknown"; message: string };

const attemptedReviews = new WeakSet<PreparedOpenTrove>();
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : undefined;

/**
 * Refresh the exact reviewed loan, recheck the wallet, and ask it once. A changed quote is never
 * silently substituted. The protocol can still change between approval and mining; it has no max-fee argument.
 */
export async function requestReviewedOpenTrove(
  provider: Eip1193,
  reviewed: PreparedOpenTrove,
  beforeRequest: (transaction: Readonly<OpenTroveTransaction>) => void,
  fetchImpl?: Fetch,
): Promise<OpenTroveWalletResult> {
  if (attemptedReviews.has(reviewed)) throw new Error("This loan review already requested the wallet. Check wallet activity and prepare a new review before any retry.");
  // Copy before the first await. Caller mutations cannot change the approved transaction or quote.
  const snapshot = structuredClone(reviewed);
  attemptedReviews.add(reviewed);
  let changed = false;
  let dispatched = false;
  const account = getAddress(snapshot.account);
  const onChange = () => { changed = true; };
  const listeners = ["accountsChanged", "chainChanged", "disconnect"];
  for (const event of listeners) provider.on?.(event, onChange);
  const assertWallet = async () => {
    if (changed) throw new Error("The borrower wallet changed. Prepare a new loan review.");
    const [chainId, accounts] = await Promise.all([
      provider.request({ method: "eth_chainId" }),
      provider.request({ method: "eth_accounts" }),
    ]);
    if (changed || typeof chainId !== "string" || !/^0x[0-9a-f]+$/i.test(chainId) || BigInt(chainId) !== 31611n) {
      throw new Error("The wallet must stay on Mezo Testnet for this loan. No transaction was requested.");
    }
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || getAddress(accounts[0]) !== account) {
      throw new Error("The borrower account changed. Prepare a new loan review.");
    }
  };
  try {
    await assertWallet();
    const fresh = await revalidateOpenTrove(snapshot, { account, chainId: MEZO_TESTNET.id }, fetchImpl);
    const transaction = Object.freeze({ ...fresh.transaction });
    if (transaction.chainId !== "0x7b7b" || transaction.from.toLowerCase() !== account.toLowerCase()
      || transaction.to.toLowerCase() !== MEZO_TESTNET.system.borrowerOperations.toLowerCase()) {
      throw new Error("The reviewed loan does not match the pinned testnet borrower contract.");
    }
    await assertWallet();
    // The caller writes its attempt while holding the browser's loan lock. No await follows this
    // callback before the single provider request, so another page task cannot swap the review.
    beforeRequest(transaction);
    dispatched = true;
    try {
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{ ...transaction }] });
      if (!isTransactionHash(hash)) return { status: "unknown", message: "The wallet returned no valid loan transaction hash. Check its activity before any retry." };
      return { status: "sent", hash, prepared: fresh };
    } catch (error) {
      if (errorCode(error) === 4001) return { status: "rejected", message: "You rejected the testnet loan in the wallet." };
      return { status: "unknown", message: "The wallet did not confirm whether the testnet loan was sent. Check its activity before any retry." };
    }
  } finally {
    for (const event of listeners) provider.removeListener?.(event, onChange);
    // No wallet send happened. A later explicit review can retry after correcting the failed preflight.
    if (!dispatched) attemptedReviews.delete(reviewed);
  }
}
