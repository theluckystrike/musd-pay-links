import { decodeFunctionData, encodeAbiParameters, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { pct, quoteBorrow, readBorrowTerms, type BorrowTerms } from "../src/borrow.ts";
import { MEZO_MAINNET, MEZO_TESTNET } from "../src/chains.ts";
import { retry, type Fetch } from "../src/rpc.ts";

retry.delayMs = 1;
const E = 10n ** 18n;

// Values read from Mezo Testnet on 2026-10-25 (see README, "Borrow quote").
const TERMS: BorrowTerms = {
  chainId: 31611,
  price: 80_329_158_970_000_000_000_000n,
  mcr: (11n * E) / 10n,
  ccr: (15n * E) / 10n,
  minNetDebt: 1800n * E,
  gasCompensation: 200n * E,
  borrowingRate: E / 1000n,
  interestRateBps: 100,
  tcr: 2_885_554_865_509_283_290n,
  recoveryMode: false,
  troves: 330,
};

describe("quoteBorrow", () => {
  it("mints the smallest amount whose actual fee-inclusive debt meets the protocol minimum", () => {
    const q = quoteBorrow(TERMS, 25n * E);
    expect(q.borrow).toBe(1_798_201_798_201_798_201_799n);
    expect(q.borrow + q.fee).toBe(1800n * E);
    const previous = q.borrow - 1n;
    expect(previous + previous * TERMS.borrowingRate / E).toBeLessThan(1800n * E);
    expect(q.totalDebt).toBe(2000n * E);
    expect(q.notes.join(" ")).toContain("including the borrowing fee");
    expect(q.notes.join(" ")).toContain("not your wallet");
    expect(q.notes.join(" ")).not.toContain("comes back");
  });

  it("keeps a need above the minimum as it is", () => {
    const q = quoteBorrow(TERMS, 5000n * E);
    expect(q.borrow).toBe(5000n * E);
    expect(q.notes.join(" ")).not.toContain("more than the link asks for");
  });

  it("defaults to a 200 percent ratio and rounds the BTC up", () => {
    const q = quoteBorrow(TERMS, 25n * E);
    expect(q.ratio).toBe(2n * E);
    expect(q.collateral * TERMS.price).toBeGreaterThanOrEqual(q.totalDebt * q.ratio);
    expect((q.collateral - 1n) * TERMS.price).toBeLessThan(q.totalDebt * q.ratio);
    expect(q.minCollateral * TERMS.price).toBeGreaterThanOrEqual(q.totalDebt * TERMS.mcr);
    expect(q.minCollateral).toBeLessThan(q.collateral);
  });

  it("gives a liquidation price where the trove reaches MCR", () => {
    const q = quoteBorrow(TERMS, 25n * E, 2n * E);
    // At 200 percent and MCR 110 percent the trove is liquidated at 55 percent of today's price.
    const expected = (TERMS.price * 55n) / 100n;
    const diff = q.liquidationPrice > expected ? q.liquidationPrice - expected : expected - q.liquidationPrice;
    expect(diff).toBeLessThan(10n ** 6n);
    expect(q.collateral * q.liquidationPrice).toBeLessThanOrEqual(q.totalDebt * TERMS.mcr);
  });

  it("never quotes below MCR, and never below CCR in recovery mode", () => {
    expect(quoteBorrow(TERMS, 25n * E, E).ratio).toBe(TERMS.mcr);
    const rec = quoteBorrow({ ...TERMS, recoveryMode: true }, 25n * E, (12n * E) / 10n);
    expect(rec.ratio).toBe(TERMS.ccr);
    expect(rec.notes.join(" ")).toContain("recovery mode");
  });

  it("computes about one year of interest on the borrowed amount and fee", () => {
    expect(quoteBorrow(TERMS, 25n * E).yearlyInterest).toBe(18n * E);
  });

  it("applies no fee in recovery mode or for the queried exempt borrower", () => {
    for (const rules of [{ ...TERMS, recoveryMode: true }, { ...TERMS, feeExempt: true }]) {
      const q = quoteBorrow(rules, 25n * E);
      expect(q.borrow).toBe(1800n * E);
      expect(q.fee).toBe(0n);
      expect(q.totalDebt).toBe(2000n * E);
    }
  });

  it("does not borrow extra when requested amount plus fee already meets the minimum", () => {
    const q = quoteBorrow(TERMS, 1799n * E);
    expect(q.borrow).toBe(1799n * E);
    expect(q.fee).toBe(1_799_000_000_000_000_000n);
    expect(q.borrow + q.fee).toBeGreaterThanOrEqual(TERMS.minNetDebt);
  });

  it("rejects malformed pure quote inputs before collateral division", () => {
    expect(() => quoteBorrow({ ...TERMS, price: 0n }, E)).toThrow("Invalid borrowing terms");
    expect(() => quoteBorrow({ ...TERMS, minNetDebt: 0n }, E)).toThrow("Invalid borrowing terms");
    expect(() => quoteBorrow({ ...TERMS, borrowingRate: E + 1n }, E)).toThrow("Invalid borrowing terms");
  });

  it("refuses a zero need", () => {
    expect(() => quoteBorrow(TERMS, 0n)).toThrow(RangeError);
  });

  it("formats ratios", () => {
    expect(pct((11n * E) / 10n)).toBe("110%");
    expect(pct((2885n * E) / 1000n)).toBe("288.5%");
  });
});

describe("readBorrowTerms", () => {
  const abi = parseAbi([
    "function fetchPrice() view returns (uint256)",
    "function MCR() view returns (uint256)",
    "function CCR() view returns (uint256)",
    "function minNetDebt() view returns (uint256)",
    "function MUSD_GAS_COMPENSATION() view returns (uint256)",
    "function borrowingRate() view returns (uint256)",
    "function interestRate() view returns (uint16)",
    "function getTCR(uint256) view returns (uint256)",
    "function checkRecoveryMode(uint256) view returns (bool)",
    "function getTroveOwnersCount() view returns (uint256)",
    "function governableVariables() view returns (address)",
    "function isAccountFeeExempt(address) view returns (bool)",
  ]);
  const u = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
  const BLOCK_HASH = `0x${"12".repeat(32)}`;
  function protocol(overrides: Partial<Record<string, string>> = {}, seen: { to: string; fn: string; block: string }[] = []): Fetch {
    return async (_url, init) => {
      const { method, params } = JSON.parse(String(init!.body));
      const response = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      if (method === "eth_chainId") return response(overrides.chainId ?? "0x7b7b");
      if (method === "eth_blockNumber") return response("0x3e8");
      if (method === "eth_getBlockByNumber") return response({ number: "0x3e8", hash: overrides.blockHash ?? BLOCK_HASH, timestamp: "0x6b000000" });
      const { to, data } = params[0] as { to: string; data: `0x${string}` };
      const fn = decodeFunctionData({ abi, data }).functionName;
      seen.push({ to, fn, block: params[1] });
      const answers: Record<string, string> = {
        fetchPrice: u(TERMS.price),
        MCR: u(TERMS.mcr),
        CCR: u(TERMS.ccr),
        minNetDebt: u(TERMS.minNetDebt),
        MUSD_GAS_COMPENSATION: u(TERMS.gasCompensation),
        borrowingRate: u(TERMS.borrowingRate),
        interestRate: encodeAbiParameters([{ type: "uint16" }], [100]),
        getTCR: u(TERMS.tcr),
        checkRecoveryMode: encodeAbiParameters([{ type: "bool" }], [false]),
        getTroveOwnersCount: u(330n),
        governableVariables: encodeAbiParameters([{ type: "address" }], ["0x6552059b6efc6aa4ae3ea45f28ed4d92ace020cd"]),
        isAccountFeeExempt: encodeAbiParameters([{ type: "bool" }], [true]),
        ...overrides,
      };
      return response(answers[fn]);
    };
  }

  it("reads every rule from the right protocol contract", async () => {
    const seen: { to: string; fn: string; block: string }[] = [];
    expect(await readBorrowTerms(MEZO_TESTNET, protocol({}, seen))).toMatchObject({ ...TERMS, snapshot: { block: 1000, hash: BLOCK_HASH } });
    const s = MEZO_TESTNET.system;
    const where = Object.fromEntries(seen.map((x) => [x.fn, x.to]));
    expect(where.fetchPrice).toBe(s.priceFeed);
    expect(where.minNetDebt).toBe(s.borrowerOperations);
    expect(where.interestRate).toBe(s.interestRateManager);
    expect(where.getTCR).toBe(s.troveManager);
    expect(seen.every((call) => call.block === "0x3e8")).toBe(true);
  });

  it("refuses a zero price and impossible ratios", async () => {
    await expect(readBorrowTerms(MEZO_TESTNET, protocol({ fetchPrice: u(0n) }))).rejects.toThrow("zero price");
    await expect(readBorrowTerms(MEZO_TESTNET, protocol({ CCR: u(E) }))).rejects.toThrow("ratios");
  });

  it("uses distinct protocol contracts on testnet and mainnet", () => {
    expect(MEZO_TESTNET.system.borrowerOperations).not.toBe(MEZO_MAINNET.system.borrowerOperations);
    expect(MEZO_TESTNET.system.priceFeed).not.toBe(MEZO_MAINNET.system.priceFeed);
  });

  it("queries fee exemption for the exact borrower", async () => {
    const account = "0x1111111111111111111111111111111111111111";
    const t = await readBorrowTerms(MEZO_TESTNET, protocol(), { account });
    expect(t.borrower).toBe(account);
    expect(t.feeExempt).toBe(true);
    expect(quoteBorrow(t, E).fee).toBe(0n);
  });

  it("refuses a wrong RPC chain or contradictory recovery rules", async () => {
    await expect(readBorrowTerms(MEZO_TESTNET, protocol({ chainId: "0x7b7c" }))).rejects.toThrow("wrong chain");
    await expect(readBorrowTerms(MEZO_TESTNET, protocol({ checkRecoveryMode: encodeAbiParameters([{ type: "bool" }], [true]) }))).rejects.toThrow("Inconsistent recovery mode");
  });

  it("rejects a block that changes while contract values are read", async () => {
    const base = protocol();
    let headers = 0;
    const changed: Fetch = async (url, init) => {
      const request = JSON.parse(String(init!.body));
      if (request.method === "eth_getBlockByNumber" && ++headers > 1) return new Response(JSON.stringify({ result: { hash: `0x${"34".repeat(32)}` } }));
      return base(url, init);
    };
    await expect(readBorrowTerms(MEZO_TESTNET, changed)).rejects.toThrow("snapshot changed");
  });
});

describe.runIf(process.env.LIVE === "1")("live MUSD protocol (LIVE=1)", () => {
  for (const chain of [MEZO_TESTNET, MEZO_MAINNET]) {
    it(`${chain.name} returns sane borrowing rules`, async () => {
      const t = await readBorrowTerms(chain);
      expect(t.mcr).toBeGreaterThanOrEqual(E);
      expect(t.ccr).toBeGreaterThanOrEqual(t.mcr);
      expect(t.price).toBeGreaterThan(1000n * E);
      expect(t.minNetDebt).toBeGreaterThan(0n);
    }, 60000);
  }
});
