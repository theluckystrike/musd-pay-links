import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MEZO_MAINNET, MEZO_TESTNET } from "../src/chains.ts";
import { MERCHANT_ELEMENT_IDS, payerStatus, payerSummary } from "../src/payerview.ts";

const SHOP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

const invoice = {
  chainId: MEZO_TESTNET.id,
  to: SHOP,
  amount: "5",
  memo: "INV-65ZVUMXW",
  link: `ethereum:${MEZO_TESTNET.musd}@31611/transfer?address=${SHOP}&uint256=5000000000000000000&memo=INV-65ZVUMXW`,
};

describe("payer summary", () => {
  it("shows amount, recipient, token, network, reference and a QR label for the invoice", () => {
    expect(payerSummary(invoice)).toEqual({
      amount: "5 MUSD",
      recipient: SHOP,
      token: MEZO_TESTNET.musd,
      network: "Mezo Testnet (31611)",
      reference: "INV-65ZVUMXW",
      qrLabel: "QR code for invoice INV-65ZVUMXW",
    });
  });

  it("uses the MUSD contract of the invoice chain", () => {
    const s = payerSummary({ ...invoice, chainId: MEZO_MAINNET.id });
    expect(s.token).toBe(MEZO_MAINNET.musd);
    expect(s.network).toBe("Mezo Mainnet (31612)");
  });

  it("keeps the unknown chain visible instead of hiding it", () => {
    expect(payerSummary({ ...invoice, chainId: 1 })).toMatchObject({ token: "", network: "1" });
  });
});

describe("payer status", () => {
  it("says confirming with the depth until the payment is final", () => {
    const s = payerStatus({ lock: "confirming", confirmations: 3, required: 5 });
    expect(s).toContain("Confirming");
    expect(s).toContain("3 of 5");
    expect(s).not.toContain("Paid.");
  });

  it("says paid only when the payment is final", () => {
    expect(payerStatus({ lock: "paid", confirmations: 5, required: 5 })).toBe("Paid. Do not pay it again.");
  });

  it("shows the block the search reached when the invoice is open", () => {
    expect(payerStatus({ lock: null, head: 2_000_000 })).toBe("Open. The chain shows no payment for this invoice up to block 2,000,000.");
  });

  it("explains a lock with a plain reason", () => {
    expect(payerStatus({ lock: "not_found" })).toContain("not found");
    expect(payerStatus({ lock: "cannot_prove" })).toContain("cannot prove");
    expect(payerStatus({ lock: "partial", count: 2 })).toContain("2 payment(s)");
    expect(payerStatus({ lock: "possible", count: 1 })).toContain("without the reference");
    expect(payerStatus({ lock: "unavailable" })).toContain("Pay is locked");
  });
});

describe("payer-only page", () => {
  const html = readFileSync(new URL("../web/public/index.html", import.meta.url), "utf8");

  it("hides every merchant panel on an invoice page and shows the payer section", () => {
    expect(html).toMatch(/<section class="panel wide" id="payer-view"[^>]*hidden/);
    for (const id of MERCHANT_ELEMENT_IDS) {
      expect(html).toContain(`id="${id}"`);
      expect(id).not.toBe("payer-view");
    }
    expect(MERCHANT_ELEMENT_IDS).toContain("m-panel");
    expect(MERCHANT_ELEMENT_IDS).toContain("p-panel");
    expect(MERCHANT_ELEMENT_IDS).toContain("v-panel");
    expect(MERCHANT_ELEMENT_IDS).toContain("b-panel");
    expect(MERCHANT_ELEMENT_IDS).toContain("live");
    expect(MERCHANT_ELEMENT_IDS).toContain("steps");
  });

  it("labels the new controls for the keyboard and a screen reader", () => {
    expect(html).toContain('id="pv-status" role="status" aria-live="polite"');
    expect(html).toContain('id="pv-pay" type="button" aria-describedby="pv-status"');
    expect(html).toMatch(/id="pv-qr" role="img" aria-label="QR code/);
    expect(html).toContain('id="pv-check" type="button"');
    expect(html).toContain('id="pv-unlock" type="button"');
  });
});
