import { describe, expect, it } from "vitest";

import { formatAmount, MAX_UINT256, parseAmount, parseEip681Number } from "../src/amount.ts";

describe("parseAmount (merchant input, 18 decimals)", () => {
  it.each([
    ["1", 10n ** 18n],
    ["0.5", 5n * 10n ** 17n],
    ["12.50", 125n * 10n ** 17n],
    ["0.000000000000000001", 1n],
    ["1000000", 10n ** 24n],
    ["007", 7n * 10n ** 18n],
  ])("%s", (text, units) => {
    expect(parseAmount(text)).toBe(units);
  });

  it.each([
    "", ".5", "5.", "-1", "+1", "1e18", "1,000", "1 000", " 1", "1.0000000000000000001", "0x10", "١", "１", "1.2.3", "NaN", "Infinity",
  ])("refuses %j", (text) => {
    expect(parseAmount(text)).toBeNull();
  });

  it("refuses values above uint256", () => {
    expect(parseAmount("9".repeat(80))).toBeNull();
  });

  it("has no float rounding: 0.1 + 0.2 stays exact", () => {
    expect(parseAmount("0.1")! + parseAmount("0.2")!).toBe(parseAmount("0.3"));
  });
});

describe("formatAmount", () => {
  it.each([
    [0n, "0"],
    [1n, "0.000000000000000001"],
    [10n ** 18n, "1"],
    [125n * 10n ** 17n, "12.5"],
    [MAX_UINT256, "115792089237316195423570985008687907853269984665640564039457.584007913129639935"],
  ])("%s", (units, text) => {
    expect(formatAmount(units)).toBe(text);
  });

  it("round trips 500 pseudo-random amounts exactly", () => {
    let x = 0x9e3779b97f4a7c15n;
    for (let i = 0; i < 500; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) % (1n << 128n);
      expect(parseAmount(formatAmount(x))).toBe(x);
    }
  });

  it("refuses negatives", () => {
    expect(() => formatAmount(-1n)).toThrow(RangeError);
  });
});

describe("parseEip681Number", () => {
  it.each([
    ["1", 1n],
    ["2014000000000000000", 2014n * 10n ** 15n],
    ["2.014e18", 2014n * 10n ** 15n],
    ["2014e15", 2014n * 10n ** 15n],
    ["1E18", 10n ** 18n],
    ["1.50e1", 15n],
    ["1.500e1", 15n],
  ])("%s", (text, value) => {
    expect(parseEip681Number(text)).toBe(value);
  });

  it.each(["1.5", "1.5e0", "1.25e1", "-1", "+1", "1e", "e18", "0x1", "1_000", "1e-18", "", "1e999"])("refuses %j", (text) => {
    expect(parseEip681Number(text)).toBeNull();
  });

  it("accepts exactly uint256 max and refuses one more", () => {
    expect(parseEip681Number(MAX_UINT256.toString())).toBe(MAX_UINT256);
    expect(parseEip681Number((MAX_UINT256 + 1n).toString())).toBeNull();
  });

  it("refuses 1e78 (above uint256) and a 101 character number", () => {
    expect(parseEip681Number("1e78")).toBeNull();
    expect(parseEip681Number("1".repeat(101))).toBeNull();
  });
});
