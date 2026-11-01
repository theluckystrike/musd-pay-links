import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import { prepareOpenTrove, revalidateOpenTrove } from "../src/borrow-action.ts";
import { MEZO_MAINNET, MEZO_TESTNET } from "../src/chains.ts";
import { ACCOUNT, OTHER, ZERO, SORTED, HINTS, HASH, ABI, E, IMPLEMENTATIONS, protocol, type Seen } from "./helpers/borrow-protocol.ts";

const input = { account: ACCOUNT, need: 25n * E, collateral: E / 10n };

describe("prepareOpenTrove", () => {
  it("simulates one exact account-bound payable call without signing, sending or a balance override", async () => {
    const seen: Seen[] = [];
    const prepared = await prepareOpenTrove(MEZO_TESTNET, input, protocol({}, seen));
    expect(prepared.chainId).toBe(31611);
    expect(prepared.account).toBe(ACCOUNT);
    expect(prepared.transaction).toMatchObject({ from: ACCOUNT, to: MEZO_TESTNET.system.borrowerOperations, value: "0x16345785d8a0000", nonce: "0x0", chainId: "0x7b7b" });
    const decoded = decodeFunctionData({ abi: ABI, data: prepared.transaction.data });
    expect(decoded.functionName).toBe("openTrove");
    expect(decoded.args).toEqual([prepared.quote.borrow, OTHER, ZERO]);
    expect(prepared.simulation).toEqual({ success: true, block: 1000, result: "0x" });
    expect(seen.some((r) => /send|sign|personal|wallet/i.test(r.method))).toBe(false);
    const simulation = seen.find((r) => r.fn === "openTrove")!;
    expect(simulation.params).toHaveLength(2);
    expect(simulation.params[1]).toBe("0x3e8");
    expect(seen.filter((r) => r.method === "eth_call").every((r) => r.params[1] === "0x3e8")).toBe(true);
    expect(seen.find((r) => r.fn === "getApproxHint")?.params[0]).toMatchObject({ to: HINTS });
    expect(prepared.maxGasCost).toBe(600_000n * 1_000_000_000n);
    expect(prepared.deployment.implementations).toHaveLength(6);
  });

  it("projects the chosen collateral separately from the quote's minimum target collateral", async () => {
    const prepared = await prepareOpenTrove(MEZO_TESTNET, input, protocol());
    expect(prepared.quote.ratio).toBe(2n * E);
    expect(prepared.quote.collateral).toBe(E / 20n);
    expect(prepared.position).toEqual({ actualCollateral: E / 10n, actualRatio: 4n * E, liquidationPrice: 22_000n * E, totalDebt: 2000n * E });
    expect(prepared.position.liquidationPrice).not.toBe(prepared.quote.liquidationPrice);
  });

  it("refuses mainnet, substituted deployments and wrong RPC chain before creating a transaction", async () => {
    await expect(prepareOpenTrove(MEZO_MAINNET, input, protocol())).rejects.toThrow("only for the pinned Mezo Testnet");
    await expect(prepareOpenTrove({ ...MEZO_TESTNET, musd: OTHER }, input, protocol())).rejects.toThrow("pinned Mezo Testnet");
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ chainId: "0x7b7c" }))).rejects.toThrow("wrong chain");
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ wrongLink: true }))).rejects.toThrow("live borrowing deployment differs");
  });

  it("refuses missing contract code and a borrower with an existing active trove", async () => {
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ missingCode: MEZO_TESTNET.musd }))).rejects.toThrow("no valid deployed code");
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ status: 1n }))).rejects.toThrow("already has an active trove");
  });

  it("refuses proxy upgrades and missing implementation code even when proxy code exists", async () => {
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ upgradedProxy: true }))).rejects.toThrow("proxy implementation changed");
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ missingCode: IMPLEMENTATIONS[MEZO_TESTNET.system.borrowerOperations.toLowerCase()] }))).rejects.toThrow("implementation has no valid deployed code");
  });

  it("refuses stale or replaced block snapshots", async () => {
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ stale: true }))).rejects.toThrow("snapshot is stale");
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ reorg: true }))).rejects.toThrow("snapshot changed");
  });

  it("refuses inadequate collateral, gas reserves and a reverted simulation", async () => {
    await expect(prepareOpenTrove(MEZO_TESTNET, { ...input, collateral: E / 100n }, protocol())).rejects.toThrow("collateral ratio");
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ balance: input.collateral }))).rejects.toThrow("both collateral and transaction gas");
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ balance: input.collateral + 1n }))).rejects.toThrow("gas limit");
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ revert: true }))).rejects.toThrow("execution reverted");
  });

  it("quotes zero fees for recovery mode and the exact fee-exempt account", async () => {
    for (const options of [{ recovery: true }, { feeExempt: true }]) {
      const prepared = await prepareOpenTrove(MEZO_TESTNET, input, protocol(options));
      expect(prepared.terms.borrower).toBe(ACCOUNT);
      expect(prepared.quote.fee).toBe(0n);
      expect(prepared.quote.borrow).toBe(1800n * E);
    }
  });

  it("rejects malformed RPC quantities rather than computing an invalid gas allowance", async () => {
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ gas: "0x" }))).rejects.toThrow("Invalid gas estimate");
    await expect(prepareOpenTrove(MEZO_TESTNET, input, protocol({ gasPrice: "0x0" }))).rejects.toThrow("zero gas price");
  });
});

describe("revalidateOpenTrove", () => {
  it("allows the same reviewed request only after a fresh complete simulation", async () => {
    const prepared = await prepareOpenTrove(MEZO_TESTNET, input, protocol());
    const seen: Seen[] = [];
    const checked = await revalidateOpenTrove(prepared, { account: ACCOUNT, chainId: 31611 }, protocol({}, seen));
    expect(checked.transaction).toEqual(prepared.transaction);
    expect(seen.some((r) => r.fn === "openTrove")).toBe(true);
  });

  it("refuses account or chain changes and expired reviews without network requests", async () => {
    const prepared = await prepareOpenTrove(MEZO_TESTNET, input, protocol());
    const seen: Seen[] = [];
    await expect(revalidateOpenTrove(prepared, { account: OTHER, chainId: 31611 }, protocol({}, seen))).rejects.toThrow("account or wallet chain changed");
    await expect(revalidateOpenTrove(prepared, { account: ACCOUNT, chainId: 31612 }, protocol({}, seen))).rejects.toThrow("account or wallet chain changed");
    await expect(revalidateOpenTrove({ ...prepared, expiresAt: Date.now() - 1 }, { account: ACCOUNT, chainId: 31611 }, protocol({}, seen))).rejects.toThrow("quote expired");
    expect(seen).toHaveLength(0);
  });

  it("requires a new visible review after price, fee, nonce or wallet balance changes", async () => {
    const prepared = await prepareOpenTrove(MEZO_TESTNET, input, protocol());
    for (const options of [{ price: 79_000n * E }, { feeRate: E / 100n }, { nonce: "0x1" }, { implementationCode: "0x60026000" }]) {
      await expect(revalidateOpenTrove(prepared, { account: ACCOUNT, chainId: 31611 }, protocol(options))).rejects.toThrow("changed");
    }
    await expect(revalidateOpenTrove(prepared, { account: ACCOUNT, chainId: 31611 }, protocol({ balance: 0n }))).rejects.toThrow("test BTC");
  });

  it("does not authorize a transaction whose reviewed amount was modified", async () => {
    const prepared = await prepareOpenTrove(MEZO_TESTNET, input, protocol());
    const changed = { ...prepared, transaction: { ...prepared.transaction, value: "0x1" as const } };
    await expect(revalidateOpenTrove(changed, { account: ACCOUNT, chainId: 31611 }, protocol())).rejects.toThrow("transaction details changed");
  });
});
