import { describe, expect, it } from "vitest";

import { MEZO_TESTNET } from "../src/chains.ts";
import { buildTransferData, checkPaymentLink } from "../src/guard.ts";
import { connectPaymentWallet, type Eip1193 } from "../src/wallet.ts";

// Provider behavior tests. This is not a browser wallet, chain transaction or adoption evidence.
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const HASH = "0x" + "ab".repeat(32);
const CHAIN = "0x7b7b";

class Provider implements Eip1193 {
  chain = "0x1";
  accounts = [ACCOUNT];
  unknown = false;
  switchChangesChain = true;
  sendResult: unknown = HASH;
  sendError: unknown;
  calls: { method: string; params?: unknown[] }[] = [];
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  beforeRead?: (method: string) => void;

  on(event: string, listener: (...args: unknown[]) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener); this.listeners.set(event, set);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, value?: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(value); }

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push(args);
    this.beforeRead?.(args.method);
    switch (args.method) {
      case "eth_requestAccounts":
      case "eth_accounts": return this.accounts;
      case "eth_chainId": return this.chain;
      case "wallet_switchEthereumChain":
        if (this.unknown) throw { code: 4902, message: "unknown chain" };
        if (this.switchChangesChain) this.chain = (args.params![0] as { chainId: string }).chainId;
        return null;
      case "wallet_addEthereumChain": this.unknown = false; return null; // Deliberately does not select it.
      case "eth_sendTransaction":
        if (this.sendError) throw this.sendError;
        return this.sendResult;
      default: throw new Error("Unexpected provider method " + args.method);
    }
  }
}

function transfer() {
  const result = checkPaymentLink(`ethereum:${MEZO_TESTNET.musd}@31611/transfer?address=${OTHER}&uint256=5&memo=INV-WALLET`, { maxAmount: "1" });
  if (!result.ok) throw new Error("Expected valid test transfer");
  return result.tx;
}

describe("payment wallet network and account binding", () => {
  it("binds one send to the read-back account and chain", async () => {
    const provider = new Provider();
    const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    expect(await session.send(transfer())).toEqual({ status: "sent", hash: HASH });
    const sends = provider.calls.filter((c) => c.method === "eth_sendTransaction");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.params).toEqual([{ from: ACCOUNT, chainId: CHAIN, to: MEZO_TESTNET.musd, value: "0x0", data: transfer().data }]);
    expect(provider.calls.slice(-3).map((c) => c.method)).toEqual(["eth_chainId", "eth_accounts", "eth_sendTransaction"]);
    session.close();
  });

  it("switches again after adding a network that does not select itself", async () => {
    const provider = new Provider(); provider.unknown = true;
    const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    expect(provider.calls.slice(0, 4).map((c) => c.method)).toEqual(["eth_requestAccounts", "wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain"]);
    expect(provider.chain).toBe(CHAIN);
    expect(await session.send(transfer())).toMatchObject({ status: "sent" });
    session.close();
  });

  it("refuses a wallet that claims a switch without selecting the required network", async () => {
    const provider = new Provider(); provider.switchChangesChain = false;
    await expect(connectPaymentWallet(provider, MEZO_TESTNET)).rejects.toThrow("not connected to Mezo Testnet");
    expect(provider.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    expect([...provider.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  it("refuses a changed account even if the provider emits no event", async () => {
    const provider = new Provider(); const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    provider.accounts = [OTHER];
    await expect(session.send(transfer())).rejects.toThrow("account changed");
    expect(provider.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    session.close();
  });

  it("refuses a changed chain before opening a payment prompt", async () => {
    const provider = new Provider(); const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    provider.chain = "0x1";
    let marked = false;
    await expect(session.send(transfer(), () => { marked = true; })).rejects.toThrow("not connected to Mezo Testnet");
    expect(marked).toBe(false);
    expect(provider.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    session.close();
  });

  it("keeps an account-change event visible even if the wallet changes back", async () => {
    const provider = new Provider(); const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    provider.emit("accountsChanged", [OTHER]); provider.emit("accountsChanged", [ACCOUNT]);
    await expect(session.send(transfer())).rejects.toThrow("account or network changed");
    expect(provider.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    session.close();
  });

  it("catches a provider change while the last read is in progress", async () => {
    const provider = new Provider(); const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    provider.beforeRead = (method) => { if (method === "eth_accounts") provider.emit("disconnect"); };
    await expect(session.send(transfer())).rejects.toThrow("not connected to Mezo Testnet");
    expect(provider.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    session.close();
  });

  it("refuses a prepared request for another chain, token or native value", async () => {
    const provider = new Provider(); const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    for (const tx of [{ ...transfer(), chainId: 1 }, { ...transfer(), to: OTHER as `0x${string}` }, { ...transfer(), value: 1n }]) {
      await expect(session.send(tx)).rejects.toThrow("does not match");
    }
    expect(provider.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    session.close();
  });

  it("does not send if the attempt cannot be saved before the request", async () => {
    const provider = new Provider(); const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    await expect(session.send(transfer(), () => { throw new Error("storage blocked"); })).rejects.toThrow("storage blocked");
    expect(provider.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    session.close();
  });

  const invalidData: [string, unknown][] = [
    ["approve", "0x095ea7b3" + transfer().data.slice(10)],
    ["another method", "0x12345678" + transfer().data.slice(10)],
    ["missing data", undefined],
    ["short ABI data", transfer().data.slice(0, 136)],
    ["non-hex data", transfer().data + "zz"],
    ["an incomplete byte", transfer().data + "f"],
    ["noncanonical recipient padding", "0xa9059cbb1" + transfer().data.slice(11)],
    ["the zero recipient", buildTransferData("0x0000000000000000000000000000000000000000", 5n, null)],
    ["the token as recipient", buildTransferData(MEZO_TESTNET.musd, 5n, null)],
    ["zero amount", buildTransferData(OTHER, 0n, null)],
    ["an invalid memo byte", buildTransferData(OTHER, 5n, null) + "00"],
    ["a long memo", buildTransferData(OTHER, 5n, null) + "41".repeat(33)],
  ];
  it.each(invalidData)("refuses %s at the JavaScript wallet boundary", async (_name, data) => {
    const provider = new Provider(); const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    // This cast deliberately models a JavaScript caller that bypasses TypeScript's request type.
    await expect(session.send({ ...transfer(), data: data as `0x${string}` })).rejects.toThrow("not a valid MUSD transfer");
    expect(provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
    session.close();
  });

  it.each([null, "INV-1", "A".repeat(32)])("accepts a canonical transfer with reference %j", async (memo) => {
    const provider = new Provider(); const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    expect(await session.send({ ...transfer(), data: buildTransferData(OTHER, 5n, memo) })).toMatchObject({ status: "sent" });
    expect(provider.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);
    session.close();
  });
});

describe("one wallet submission and uncertain outcomes", () => {
  it("allows only one request when two callers start concurrently", async () => {
    const provider = new Provider(); const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    const results = await Promise.allSettled([session.send(transfer()), session.send(transfer())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(provider.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);
    session.close();
  });

  it("saves the attempt before one request and does not retry a lost reply", async () => {
    const provider = new Provider(); provider.sendError = new Error("connection lost after broadcast");
    const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    let marked = 0;
    expect(await session.send(transfer(), () => { marked++; expect(provider.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false); })).toMatchObject({ status: "unknown" });
    expect(marked).toBe(1);
    await expect(session.send(transfer())).rejects.toThrow("already requested");
    expect(provider.calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(1);
    session.close();
  });

  it("distinguishes an explicit rejected request from a transport failure", async () => {
    const provider = new Provider(); provider.sendError = { code: 4001, message: "user rejected" };
    const session = await connectPaymentWallet(provider, MEZO_TESTNET);
    expect(await session.send(transfer())).toMatchObject({ status: "rejected" });
    expect(provider.calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(1);
    session.close();
  });

  for (const result of [null, "", "0x1234", { hash: HASH }]) {
    it(`does not call malformed reply ${JSON.stringify(result)} a sent payment`, async () => {
      const provider = new Provider(); provider.sendResult = result;
      const session = await connectPaymentWallet(provider, MEZO_TESTNET);
      expect(await session.send(transfer())).toMatchObject({ status: "unknown" });
      expect(provider.calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(1);
      session.close();
    });
  }
});
