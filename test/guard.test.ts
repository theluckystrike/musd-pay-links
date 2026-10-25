import { decodeFunctionData, erc20Abi, getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { MEZO_MAINNET, MEZO_TESTNET } from "../src/chains.ts";
import { checkPaymentLink, type PayerPolicy } from "../src/guard.ts";

const T = MEZO_TESTNET.musd;
const M = MEZO_MAINNET.musd;
const SHOP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const OTHER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const ONE = 10n ** 18n;
const policy: PayerPolicy = { maxAmount: "100" };

function link(over: { token?: string; chain?: string; fn?: string; query?: string } = {}): string {
  const chain = over.chain ?? "@31611";
  const fn = over.fn ?? "/transfer";
  const query = over.query ?? `?address=${SHOP}&uint256=${25n * ONE}`;
  return `ethereum:${over.token ?? T}${chain}${fn}${query}`;
}

function codes(l: unknown, p: PayerPolicy = policy): string[] {
  const r = checkPaymentLink(l, p);
  return r.ok ? [] : r.reasons.map((x) => x.code);
}

function swapChar(addr: string, index: number): string {
  const c = addr[index]!.toLowerCase();
  const next = c === "0" ? "1" : "0";
  return getAddress(addr.slice(0, index) + next + addr.slice(index + 1));
}

describe("valid links", () => {
  it("accepts a checksummed MUSD testnet link and builds the exact transfer", () => {
    const r = checkPaymentLink(link(), policy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payment).toMatchObject({ chainId: 31611, token: T, recipient: SHOP, amount: 25n * ONE, amountText: "25", memo: null });
    expect(r.tx.to).toBe(T);
    expect(r.tx.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: r.tx.data });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toEqual([SHOP, 25n * ONE]);
  });

  it("accepts mainnet MUSD on chain 31612", () => {
    expect(checkPaymentLink(link({ token: M, chain: "@31612" }), policy).ok).toBe(true);
  });

  it("accepts the pay- prefix and an upper-case scheme", () => {
    expect(checkPaymentLink(link().replace("ethereum:", "ethereum:pay-"), policy).ok).toBe(true);
    expect(checkPaymentLink(link().replace("ethereum:", "ETHEREUM:"), policy).ok).toBe(true);
  });

  it("accepts scientific notation amounts that are whole numbers", () => {
    const r = checkPaymentLink(link({ query: `?address=${SHOP}&uint256=2.5e19` }), policy);
    expect(r.ok && r.payment.amount).toBe(25n * ONE);
  });

  it("appends the memo bytes after the ABI arguments", () => {
    const r = checkPaymentLink(link({ query: `?address=${SHOP}&uint256=1&memo=INV-7` }), policy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tx.data.endsWith("494e562d37")).toBe(true);
  });

  it("accepts an amount exactly at the limit", () => {
    expect(checkPaymentLink(link({ query: `?address=${SHOP}&uint256=${100n * ONE}` }), policy).ok).toBe(true);
  });

  it("accepts parameters in any order", () => {
    expect(checkPaymentLink(link({ query: `?uint256=5&address=${SHOP}` }), policy).ok).toBe(true);
  });
});

describe("wrong chain", () => {
  it.each([
    ["@1", "wrong_chain"],
    ["@8453", "wrong_chain"],
    ["@31613", "wrong_chain"],
    ["", "missing_chain_id"],
    ["@031611", "bad_chain_id"],
    ["@0x7b7b", "bad_chain_id"],
    ["@", "bad_chain_id"],
    ["@-31611", "bad_chain_id"],
    ["@99999999999", "bad_chain_id"],
  ])("chain %j -> %s", (chain, code) => {
    expect(codes(link({ chain }))).toEqual([code]);
  });

  it("refuses testnet MUSD on the mainnet chain id and the reverse", () => {
    expect(codes(link({ token: T, chain: "@31612" }))).toContain("token_chain_mismatch");
    expect(codes(link({ token: M, chain: "@31611" }))).toContain("token_chain_mismatch");
  });

  it("refuses a Mezo chain the payer did not allow", () => {
    expect(codes(link({ token: M, chain: "@31612" }), { maxAmount: "100", allowedChains: [31611] })).toEqual(["chain_not_allowed"]);
  });
});

describe("lookalike and wrong tokens", () => {
  it("names a lookalike that keeps the first and last characters of MUSD", () => {
    const fake = swapChar(T, 20);
    expect(fake).not.toBe(T);
    expect(codes(link({ token: fake }))).toEqual(["lookalike_token"]);
  });

  it("refuses an unrelated token", () => {
    expect(codes(link({ token: OTHER }))).toEqual(["not_musd"]);
  });

  it("refuses MUSD with a broken checksum", () => {
    const broken = T.slice(0, 3) + (T[3] === T[3]!.toUpperCase() ? T[3]!.toLowerCase() : T[3]!.toUpperCase()) + T.slice(4);
    const bad = broken === T ? T.replace("FAF", "faf") : broken;
    expect(codes(link({ token: bad }))).toContain("token_bad_checksum");
  });

  it("accepts the MUSD address in all lowercase or all uppercase, since it is compared with a fixed address", () => {
    expect(codes(link({ token: T.toLowerCase() }))).toEqual([]);
    expect(codes(link({ token: "0x" + T.slice(2).toUpperCase() }))).toEqual([]);
    expect(codes(link({ token: T.toLowerCase() }), { maxAmount: "100", requireChecksum: false })).toEqual([]);
  });

  it("refuses an ENS name as the token", () => {
    expect(codes("ethereum:musd.eth@31611/transfer?address=" + SHOP + "&uint256=1")).toEqual(["ens_or_bad_target"]);
  });

  it("refuses a short hex token", () => {
    expect(codes(link({ token: T.slice(0, 41) }))).toEqual(["bad_token_address"]);
  });
});

describe("recipient checks", () => {
  it("refuses a bad checksum", () => {
    const bad = SHOP.replace("aAeb", "AAeb");
    expect(codes(link({ query: `?address=${bad}&uint256=1` }))).toEqual(["recipient_bad_checksum"]);
  });

  it("refuses a recipient without checksum by default", () => {
    expect(codes(link({ query: `?address=${SHOP.toLowerCase()}&uint256=1` }))).toEqual(["recipient_no_checksum"]);
  });

  it("refuses the zero address", () => {
    expect(codes(link({ query: `?address=0x0000000000000000000000000000000000000000&uint256=1` }))).toEqual(["recipient_zero"]);
  });

  it("refuses sending MUSD to the MUSD contract on either chain", () => {
    expect(codes(link({ query: `?address=${T}&uint256=1` }))).toEqual(["recipient_is_token"]);
    expect(codes(link({ query: `?address=${M}&uint256=1` }))).toEqual(["recipient_is_token"]);
  });

  it("refuses a missing recipient", () => {
    expect(codes(link({ query: `?uint256=1` }))).toEqual(["missing_recipient"]);
  });

  it("enforces the allowlist", () => {
    const p = { maxAmount: "100", allowlist: [OTHER] };
    expect(codes(link(), p)).toEqual(["not_in_allowlist"]);
    expect(codes(link({ query: `?address=${OTHER}&uint256=1` }), p)).toEqual([]);
  });

  it("matches the allowlist without regard to case", () => {
    expect(codes(link(), { maxAmount: "100", allowlist: [SHOP.toLowerCase()] })).toEqual([]);
  });

  it("names an address-poisoning twin of an allowlisted address", () => {
    const twin = swapChar(SHOP, 20);
    expect(codes(link({ query: `?address=${twin}&uint256=1` }), { maxAmount: "100", allowlist: [SHOP] })).toEqual([
      "recipient_lookalike",
    ]);
  });

  it("refuses an address with a non-hex character", () => {
    expect(codes(link({ query: `?address=${SHOP.slice(0, 41)}g&uint256=1` }))).toEqual(["recipient_bad_address"]);
  });
});

describe("amount checks", () => {
  it("refuses an amount above the payer limit and states both numbers", () => {
    const r = checkPaymentLink(link({ query: `?address=${SHOP}&uint256=${100n * ONE + 1n}` }), policy);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons[0]!.code).toBe("over_limit");
      expect(r.reasons[0]!.message).toContain("100.000000000000000001 MUSD");
      expect(r.reasons[0]!.message).toContain("Your limit is 100 MUSD");
    }
  });

  it("refuses uint256 overflow", () => {
    const over = ((1n << 256n) + 25n * ONE).toString();
    expect(codes(link({ query: `?address=${SHOP}&uint256=${over}` }))).toEqual(["amount_overflow"]);
  });

  it("refuses 1e78 and an amount that wraps to a small number mod 2^256", () => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=1e78` }))).toEqual(["amount_overflow"]);
    const wraps = ((1n << 256n) + 5n).toString();
    expect(codes(link({ query: `?address=${SHOP}&uint256=${wraps}` }))).toEqual(["amount_overflow"]);
  });

  it("refuses a fractional number of base units", () => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=1.5` }))).toEqual(["amount_overflow"]);
  });

  it.each(["-1", "0x10", "1,000", "abc", "1e-3", "+5", "Infinity"])("refuses amount %j", (amount) => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=${amount}` }))).toEqual(["bad_amount"]);
  });

  it("refuses zero and a missing amount", () => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=0` }))).toEqual(["zero_amount"]);
    expect(codes(link({ query: `?address=${SHOP}` }))).toEqual(["missing_amount"]);
  });

  it("refuses a policy that is not a valid amount", () => {
    expect(codes(link(), { maxAmount: "lots" })).toEqual(["bad_policy"]);
    expect(codes(link(), { maxAmount: -1n })).toEqual(["bad_policy"]);
  });

  it("takes a bigint limit in base units", () => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=11` }), { maxAmount: 10n })).toEqual(["over_limit"]);
  });
});

describe("unicode tricks", () => {
  const cases: [string, string][] = [
    ["zero-width space in the address", link().replace(SHOP, SHOP.slice(0, 10) + "​" + SHOP.slice(10))],
    ["right-to-left override", link().replace("uint256=", "uint256=‮")],
    ["Cyrillic a in the scheme", link().replace("ethereum", "ethereum".replace("e", "е"))],
    ["full-width digit in the amount", link({ query: `?address=${SHOP}&uint256=５` })],
    ["Arabic-Indic digit", link({ query: `?address=${SHOP}&uint256=٥` })],
    ["byte order mark at the start", "﻿" + link()],
    ["non-breaking space", link().replace("&", " &")],
    ["trailing newline", link() + "\n"],
    ["leading space", " " + link()],
    ["NUL byte", link().replace("&", "\u0000&")],
    ["emoji", link({ query: `?address=${SHOP}&uint256=1&memo=pay\u{1F600}` })],
  ];
  it.each(cases)("%s", (_name, l) => {
    expect(codes(l)).toEqual(["unicode_trick"]);
  });

  it("names the code point in the message", () => {
    const r = checkPaymentLink(cases[0]![1], policy);
    expect(!r.ok && r.reasons[0]!.message).toContain("U+200B");
  });

  it("refuses percent-encoding, which could smuggle the same characters", () => {
    expect(codes(link().replace("uint256=", "uint256=%E2%80%8B"))).toEqual(["percent_encoding"]);
    expect(codes(link().replace("address=", "addr%65ss="))).toEqual(["percent_encoding"]);
  });
});

describe("extra and malformed parameters", () => {
  it.each(["value", "gas", "gasLimit", "gasPrice", "maxFeePerGas", "nonce", "data"])("refuses execution parameter %s", (key) => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=1&${key}=1` }))).toEqual(["forbidden_param"]);
  });

  it("refuses unknown parameters", () => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=1&callback=https://x.example` }))).toEqual(["unknown_param"]);
    expect(codes(link({ query: `?address=${SHOP}&uint256=1&label=Shop` }))).toEqual(["unknown_param"]);
  });

  it("refuses a duplicated address or amount (parameter pollution)", () => {
    expect(codes(link({ query: `?address=${SHOP}&address=${OTHER}&uint256=1` }))).toEqual(["duplicate_param"]);
    expect(codes(link({ query: `?address=${SHOP}&uint256=1&uint256=999` }))).toEqual(["duplicate_param"]);
  });

  it("refuses wrong-case keys that some wallets would read", () => {
    expect(codes(link({ query: `?ADDRESS=${SHOP}&uint256=1` }))).toEqual(["param_case"]);
    expect(codes(link({ query: `?address=${SHOP}&UINT256=1` }))).toEqual(["param_case"]);
  });

  it.each([`?address=${SHOP}&&uint256=1`, `?address=${SHOP}&uint256=`, `?=1&address=${SHOP}`, `?address`, "?"])(
    "refuses malformed query %j",
    (query) => {
      expect(codes(link({ query }))).toEqual(["malformed_query"]);
    },
  );

  it("refuses a # fragment", () => {
    expect(codes(link() + "#uint256=1")).toEqual(["fragment"]);
  });

  it("refuses a bad memo", () => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=1&memo=${"x".repeat(33)}` }))).toEqual(["bad_memo"]);
    expect(codes(link({ query: `?address=${SHOP}&uint256=1&memo=a+b` }))).toEqual(["bad_memo"]);
  });

  it("refuses a memo with a #, so the memo rule and the parser agree", () => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=1&memo=INV#1` }))).toEqual(["fragment"]);
  });

  it("accepts the documented memo characters, including a colon", () => {
    const r = checkPaymentLink(link({ query: `?address=${SHOP}&uint256=1&memo=INV-2026:01/a_b.c` }), policy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payment.memo).toBe("INV-2026:01/a_b.c");
  });

  it("refuses a link over 512 characters", () => {
    expect(codes(link({ query: `?address=${SHOP}&uint256=1&memo=${"x".repeat(600)}` }))).toEqual(["too_long"]);
  });
});

describe("wrong function or scheme", () => {
  it.each(["/approve", "/increaseAllowance", "/transferFrom", "/permit"])("refuses %s as dangerous", (fn) => {
    expect(codes(link({ fn }))).toEqual(["dangerous_function"]);
  });

  it("refuses other functions and native payments", () => {
    expect(codes(link({ fn: "/mint" }))).toEqual(["wrong_function"]);
    expect(codes(link({ fn: "/Transfer" }))).toEqual(["wrong_function"]);
    expect(codes(link({ fn: "", query: "?value=1" }))).toEqual(["forbidden_param"]);
    expect(codes(link({ fn: "", query: "" }))).toEqual(["not_token_transfer"]);
  });

  it.each([
    ["bitcoin:bc1qxyz?amount=1", "bad_scheme"],
    ["https://evil.example/pay", "bad_scheme"],
    ["", "empty"],
    [42, "not_a_string"],
    [null, "not_a_string"],
    ["ethereum:", "ens_or_bad_target"],
  ])("refuses %j", (l, code) => {
    expect(codes(l)).toEqual([code]);
  });
});

describe("several problems at once", () => {
  it("reports every semantic problem, not only the first", () => {
    const l = link({ token: OTHER, query: `?address=0x0000000000000000000000000000000000000000&uint256=${1000n * ONE}` });
    expect(codes(l).sort()).toEqual(["not_musd", "over_limit", "recipient_zero"]);
  });

  it("never throws on random ASCII input", () => {
    let seed = 7;
    for (let i = 0; i < 2000; i++) {
      let s = "ethereum:";
      const len = (i * 13) % 120;
      for (let j = 0; j < len; j++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        s += String.fromCharCode(33 + (seed % 94));
      }
      const r = checkPaymentLink(s, policy);
      if (!r.ok) expect(r.reasons.length).toBeGreaterThan(0);
    }
  });
});
