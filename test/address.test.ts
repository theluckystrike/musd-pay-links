import { describe, expect, it } from "vitest";

import { checkAddress, looksLike } from "../src/address.ts";

// EIP-55 test vectors from the EIP itself.
const VECTORS = [
  "0x52908400098527886E0F7030069857D2E4169EE7",
  "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
  "0xde709f2102306220921060314715629080e2fb77",
  "0x27b1fdb04752bbc536007a920d24acb045561c26",
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

describe("checkAddress", () => {
  it.each(VECTORS)("accepts EIP-55 vector %s with checksum required", (a) => {
    const r = checkAddress(a, true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toBe(a);
  });

  it("refuses a flipped-case checksum", () => {
    const r = checkAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", true);
    expect(r).toMatchObject({ ok: false, code: "bad_checksum" });
  });

  it("refuses all-lowercase when a checksum is required, accepts it otherwise", () => {
    const lower = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
    expect(checkAddress(lower, true)).toMatchObject({ ok: false, code: "no_checksum" });
    expect(checkAddress(lower, false)).toMatchObject({ ok: true, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" });
  });

  it.each([
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed0",
    "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0X5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeg",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAе", // Cyrillic e
    "",
  ])("refuses malformed %j", (a) => {
    expect(checkAddress(a, false)).toMatchObject({ ok: false, code: "bad_address" });
  });

  it("accepts an address with no letters (nothing to checksum)", () => {
    expect(checkAddress("0x0000000000000000000000000000000000000001", true).ok).toBe(true);
  });
});

describe("looksLike", () => {
  it("flags same prefix and suffix", () => {
    expect(looksLike("0x1189" + "a".repeat(32) + "c503", "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503")).toBe(true);
  });
  it("does not flag the same address in another case", () => {
    expect(looksLike("0x118917a40faf1cd7a13db0ef56c86de7973ac503", "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503")).toBe(false);
  });
});
