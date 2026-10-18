import { describe, expect, it } from "vitest";

import { formatAmount } from "../src/amount.ts";
import { MEZO_MAINNET, MEZO_TESTNET } from "../src/chains.ts";
import { checkPaymentLink } from "../src/guard.ts";
import { createPaymentLink } from "../src/merchant.ts";

const SHOP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

describe("createPaymentLink", () => {
  it("makes a standard EIP-681 MUSD link on Mezo Testnet", () => {
    const r = createPaymentLink({ chainId: 31611, recipient: SHOP, amount: "12.50", memo: "INV-1042" });
    expect(r).toMatchObject({
      ok: true,
      link: `ethereum:${MEZO_TESTNET.musd}@31611/transfer?address=${SHOP}&uint256=12500000000000000000&memo=INV-1042`,
    });
  });

  it("checksums a lowercase recipient", () => {
    const r = createPaymentLink({ chainId: 31612, recipient: SHOP.toLowerCase(), amount: "1" });
    expect(r.ok && r.link).toBe(`ethereum:${MEZO_MAINNET.musd}@31612/transfer?address=${SHOP}&uint256=1000000000000000000`);
  });

  it("trims whitespace around inputs and drops an empty memo", () => {
    const r = createPaymentLink({ chainId: 31611, recipient: ` ${SHOP} `, amount: " 3 ", memo: "  " });
    expect(r.ok && r.link.endsWith("uint256=3000000000000000000")).toBe(true);
  });

  it.each([
    [{ chainId: 1, recipient: SHOP, amount: "1" }, "wrong_chain"],
    [{ chainId: 31611, recipient: "0x123", amount: "1" }, "recipient_bad_address"],
    [{ chainId: 31611, recipient: SHOP.replace("aAeb", "AAeb"), amount: "1" }, "recipient_bad_checksum"],
    [{ chainId: 31611, recipient: SHOP, amount: "0" }, "zero_amount"],
    [{ chainId: 31611, recipient: SHOP, amount: "1.0000000000000000001" }, "bad_amount"],
    [{ chainId: 31611, recipient: SHOP, amount: "-5" }, "bad_amount"],
    [{ chainId: 31611, recipient: SHOP, amount: "1", memo: "has space" }, "bad_memo"],
    [{ chainId: 31611, recipient: MEZO_TESTNET.musd, amount: "1" }, "recipient_is_token"],
    [{ chainId: 31611, recipient: "0x0000000000000000000000000000000000000000", amount: "1" }, "recipient_zero"],
  ])("refuses %j with %s", (input, code) => {
    const r = createPaymentLink(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.map((x) => x.code)).toContain(code);
  });

  it("every created link passes the payer guard with the same amount (300 cases)", () => {
    let x = 12345n;
    for (let i = 0; i < 300; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) % (1n << 90n);
      const units = x + 1n;
      const r = createPaymentLink({ chainId: i % 2 ? 31611 : 31612, recipient: SHOP, amount: formatAmount(units) });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const back = checkPaymentLink(r.link, { maxAmount: units });
      expect(back.ok && back.payment.amount).toBe(units);
    }
  });
});
