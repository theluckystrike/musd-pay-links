# MUSD Pay Links, AKINDO submission

Answers for the Mezo Buildathon submission form, Wave 1 (build period 16 to 26 October 2026).

## Project name

MUSD Pay Links

## Project category

Payment links for MUSD

## TL;DR

Merchants ask for MUSD with a standard EIP-681 link or QR code, and wallets and agents check the token, the recipient and the amount before they pay.

## Short summary

MUSD Pay Links lets anyone request MUSD on Mezo with a link or a QR code that existing wallets already understand. A payer-side TypeScript guard refuses a link unless the token is the real MUSD contract for that chain, the recipient address is valid and checksummed, and the amount is within the payer's limit. A verifier then lets the merchant confirm the payment on chain.

## How it works

The problem. Paying someone in MUSD today means copying an address and an amount by hand, or trusting whatever a link or QR code says. A payment link is plain text. One changed character can point it at a fake token with the same symbol, at another chain, at an attacker's address, or at a much larger amount. AI agents that pay on behalf of users make this worse, because they act on text they did not write.

The merchant side creates a standard EIP-681 link for a MUSD transfer on Mezo Testnet (31611) or Mezo Mainnet (31612), plus a QR code. It takes an amount, the recipient and an optional reference such as an invoice number. Each link is passed through the payer guard before it is shown, so a merchant cannot hand out a link the guard would refuse.

The payer side parses the link strictly and runs three checks before it builds anything. The token must be the MUSD contract for the link's chain id. The recipient must be a valid address with a correct EIP-55 checksum, and on the payer's allowlist when one is set. The amount must be within the payer's limit, with exact integer math at 18 decimals. It also refuses unicode tricks, percent-encoding, duplicated or unknown parameters, execution parameters such as `value` or `gas`, and functions such as `approve`. Every refusal has a code and a plain reason. When all checks pass it returns an unsigned `transfer` call for the wallet to sign. It never holds a key.

The verifier reads the transaction receipt and counts only Transfer events from the real MUSD contract to the merchant's address, so a fake token cannot fake a payment. If the link had a reference, it also checks that the reference bytes are in the transaction input.

How MUSD is used and positioned. MUSD is the only asset the product handles. The two MUSD contract addresses come from the official Mezo docs and are verified on the Mezo explorers. The demo reads `name()`, `symbol()`, `decimals()` and `totalSupply()` from both contracts live, dry-runs the guard's transfer calldata against the testnet contract with `eth_call`, and verifies a real public testnet MUSD transfer. The goal is to make MUSD the easiest Bitcoin-backed stablecoin to ask for and the safest one to pay, through a link format every EVM wallet already supports.

## Target group

Small online sellers, freelancers and creators who want to be paid in a Bitcoin-backed stablecoin without a payment processor, and the wallets, bots and AI agents that pay them. The library and the JSON API are for developers who build those wallets and bots. The demo page works on desktop and on a phone. This fits Track 2, Access and Distribution, because it lowers the friction of asking for and paying MUSD where people already are, with a link in a chat, an invoice or a QR code at a counter.

## Tech stack

TypeScript, viem (address checksums and ABI encoding), qrcode-generator, Vitest, Cloudflare Workers with static assets, the public Mezo JSON-RPC endpoints and the Mezo Blockscout explorers.

## Track

Track 2, Access and Distribution for MUSD and MEZO.

## Chain deployed on

Mezo. The app works with MUSD on Mezo Testnet (chain 31611) and Mezo Mainnet (chain 31612). It does not deploy its own contracts. It calls the existing MUSD contracts.

## Project status

Entirely new, built during the hackathon. It reuses the design ideas of PayLink Guard (https://github.com/theluckystrike/paylink-guard), an earlier payment-link checker by the same author for Base and Solana, but the code for Mezo and MUSD is new.

## Project readiness

Live web app and JSON API on Cloudflare Workers, reading the real MUSD contracts on Mezo Testnet and Mainnet. No real testnet transfer has been made yet. Testnet MUSD has to be borrowed against testnet BTC, and the testnet BTC faucet is behind a CAPTCHA. The demo page can already send a real payment from any browser wallet that holds testnet MUSD, and it confirms the receipt on chain.

## Links

| What | Where |
|---|---|
| Live demo | https://musd-pay-links.lipmichal.workers.dev |
| Repository | https://github.com/theluckystrike/musd-pay-links |
| Threat model and test output | https://github.com/theluckystrike/musd-pay-links#threat-model |
| Testnet MUSD contract | https://explorer.test.mezo.org/token/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 |
| Mainnet MUSD contract | https://explorer.mezo.org/token/0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186 |

## Evidence

197 tests pass, including 2 that read both MUSD contracts over RPC. The adversarial cases cover wrong chains, lookalike tokens, uint256 overflow, bad checksums, unicode tricks and extra parameters. The read-only evidence (contract reads, `eth_call` dry runs returning `true`, and `verifyPayment` returning `paid` on a public testnet transfer and `mismatch` when the amount or recipient is wrong) is in `docs/evidence.json` in the repository.

## What is next

1. By the Wave 2 deadline (15 November 2026), make a real MUSD payment on Mezo Testnet end to end through the demo and record it in the repository, publish the guard as an npm package, and add a Telegram bot that creates MUSD links and confirms payments.
2. By the end of December 2026, add Mezo Passport so Bitcoin wallets can pay links, and accept the same checks for links that request MEZO.
3. By the end of January 2027, add a merchant view with payment notifications, so a small shop can take MUSD with links and see each payment confirmed without running a node.

## Team info

Michael Lip, solo builder (design, code and deployment), Warsaw, Poland. GitHub https://github.com/theluckystrike
