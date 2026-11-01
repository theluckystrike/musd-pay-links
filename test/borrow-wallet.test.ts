import { describe, expect, it } from "vitest";

import { prepareOpenTrove } from "../src/borrow-action.ts";
import { requestReviewedOpenTrove } from "../src/borrow-wallet.ts";
import { MEZO_TESTNET } from "../src/chains.ts";
import type { Eip1193 } from "../src/wallet.ts";
import { ACCOUNT, OTHER, E, protocol } from "./helpers/borrow-protocol.ts";

const HASH = `0x${"ab".repeat(32)}` as const;
class Wallet implements Eip1193 {
  chain = "0x7b7b";
  account = ACCOUNT as string;
  sent: unknown[] = [];
  error: unknown;
  hash: unknown = HASH;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    if (method === "eth_chainId") return this.chain;
    if (method === "eth_accounts") return [this.account];
    if (method !== "eth_sendTransaction") throw new Error(`Unexpected wallet request ${method}`);
    this.sent.push(params?.[0]);
    if (this.error) throw this.error;
    return this.hash;
  }
  on(event: string, fn: (...args: unknown[]) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); }
  removeListener(event: string, fn: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(fn); }
}
const prepare = () => prepareOpenTrove(MEZO_TESTNET, { account: ACCOUNT, need: 25n * E, collateral: E / 10n }, protocol());

describe("reviewed testnet loan wallet boundary", () => {
  it("requests the exact refreshed transaction once, after saving the attempt", async () => {
    const reviewed = await prepare(); const wallet = new Wallet(); let saved = false;
    const result = await requestReviewedOpenTrove(wallet, reviewed, (transaction) => {
      expect(wallet.sent).toHaveLength(0); expect(transaction.from).toBe(ACCOUNT); saved = true;
    }, protocol());
    expect(saved).toBe(true); expect(result.status).toBe("sent");
    expect(wallet.sent).toEqual([reviewed.transaction]);
    await expect(requestReviewedOpenTrove(wallet, reviewed, () => {}, protocol())).rejects.toThrow("already requested");
    expect(wallet.sent).toHaveLength(1);
  });
  it.each(["0x1", "0x7b7c", "invalid"])("refuses wrong wallet chain %s before any request", async (chain) => {
    const wallet = new Wallet(); wallet.chain = chain;
    await expect(requestReviewedOpenTrove(wallet, await prepare(), () => {}, protocol())).rejects.toThrow("Mezo Testnet");
    expect(wallet.sent).toEqual([]);
  });
  it("refuses a changed borrower", async () => {
    const wallet = new Wallet(); wallet.account = OTHER;
    await expect(requestReviewedOpenTrove(wallet, await prepare(), () => {}, protocol())).rejects.toThrow("account changed");
    expect(wallet.sent).toEqual([]);
  });
  it("refuses changed protocol terms instead of silently changing the reviewed transaction", async () => {
    const wallet = new Wallet(); let saved = false;
    await expect(requestReviewedOpenTrove(wallet, await prepare(), () => { saved = true; }, protocol({ price: 81_000n * E }))).rejects.toThrow("changed");
    expect(saved).toBe(false); expect(wallet.sent).toEqual([]);
  });
  it("does not allow a callback to replace the checked transaction", async () => {
    const wallet = new Wallet();
    await expect(requestReviewedOpenTrove(wallet, await prepare(), (transaction) => {
      (transaction as { to: string }).to = OTHER;
    }, protocol())).rejects.toThrow();
    expect(wallet.sent).toEqual([]);
  });
  it("sends the reviewed snapshot when the caller mutates its object during preflight", async () => {
    const wallet = new Wallet(); const reviewed = await prepare();
    const pending = requestReviewedOpenTrove(wallet, reviewed, () => {}, protocol());
    reviewed.transaction.to = OTHER;
    const result = await pending;
    expect(result.status).toBe("sent");
    expect((wallet.sent[0] as { to: string }).to).toBe(MEZO_TESTNET.system.borrowerOperations);
  });
  it("distinguishes explicit rejection from an uncertain broadcast and never repeats either request", async () => {
    for (const [error, expected] of [[{ code: 4001 }, "rejected"], [new Error("lost transport response"), "unknown"]] as const) {
      const wallet = new Wallet(); wallet.error = error; const reviewed = await prepare();
      expect((await requestReviewedOpenTrove(wallet, reviewed, () => {}, protocol())).status).toBe(expected);
      await expect(requestReviewedOpenTrove(wallet, reviewed, () => {}, protocol())).rejects.toThrow("already requested");
      expect(wallet.sent).toHaveLength(1);
    }
  });
  it("keeps an invalid wallet hash uncertain", async () => {
    const wallet = new Wallet(); wallet.hash = "0x1234";
    expect((await requestReviewedOpenTrove(wallet, await prepare(), () => {}, protocol())).status).toBe("unknown");
    expect(wallet.sent).toHaveLength(1);
  });
});
