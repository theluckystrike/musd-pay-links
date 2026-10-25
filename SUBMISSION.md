# MUSD Pay Links, AKINDO submission

Answers for the Mezo Buildathon submission form. Updated on 25 October 2026, inside the Wave 1 build period (16 to 26 October 2026).

## Project name

MUSD Pay Links

## Project category

Payment links for MUSD

## TL;DR

Merchants ask for MUSD with a link, a QR code or a pay page in a chat. Payers check the link before they pay, and a payer who is short of MUSD sees how much BTC would mint it.

## Short summary

MUSD Pay Links lets anyone request MUSD on Mezo with a standard EIP-681 link. A payer-side TypeScript guard refuses a link unless the token is the real MUSD contract for that chain, the recipient is valid and checksummed, and the amount is within the payer's limit. A payer without enough MUSD gets a borrow quote read from the live MUSD protocol. The merchant finds the payment on chain by its invoice reference.

## How it works

The problem. Paying someone in MUSD today means copying an address and an amount by hand, or trusting whatever a link or QR code says. A payment link is plain text. One changed character can point it at a fake token, at another chain, at an attacker's address, or at a much larger amount. AI agents that pay for users make this worse, because they act on text they did not write. A second problem is access. A Bitcoin holder who wants to pay in MUSD often holds no MUSD yet.

The merchant creates an EIP-681 link for a MUSD transfer on Mezo Testnet (31611) or Mezo Mainnet (31612), a QR code and a pay page URL to send in Telegram or any chat. Every invoice gets a reference and is stamped with the current block. Each link passes through the payer guard before it is shown.

The payer side parses the link strictly. The token must be the MUSD contract for the link's chain id. The recipient must have a correct EIP-55 checksum, and must be on the payer's allowlist when one is set. The amount must be within the payer's limit, with exact integer math at 18 decimals. Unicode tricks, percent-encoding, duplicated or unknown parameters, execution parameters and functions such as `approve` are refused. Every refusal has a code and a plain reason. When all checks pass, the guard returns an unsigned `transfer` call. It never holds a key.

When the payer is short of MUSD, the page reads the MUSD protocol on Mezo. It reads the BTC price from PriceFeed, MCR, CCR, the minimum debt, the gas compensation and the fee from BorrowerOperations, the interest rate from InterestRateManager, and the system ratio and recovery mode from TroveManager. It then shows the BTC to lock, the debt, the liquidation price and a link to borrow in the Mezo app. The payer keeps the Bitcoin and pays in MUSD.

The merchant inbox reads MUSD Transfer logs to the merchant address since the invoice block. It decodes the reference from each payment and marks the invoice paid with the oldest payment that carries the reference and covers the amount. Each invoice gets a fresh random reference, so one payment pays one invoice. A payment of the exact amount without a reference shows as a possible match, because some wallets drop the reference. The payer does not need to send a hash. A payment from before the invoice block is refused, so an old transfer cannot pay a new invoice.

How MUSD is used and positioned. MUSD is the only asset the product moves. It uses the MUSD token on both Mezo chains and four contracts of the MUSD protocol. The addresses come from the Mezo docs and the official deployment files in github.com/mezo-org/musd. The goal is to make MUSD easy to ask for, safe to pay, and easy to get for a Bitcoin holder who has none yet. Which wallets open these links has not been tested yet.

## Target group

Small online sellers, freelancers and creators who want to be paid in a Bitcoin-backed stablecoin without a payment processor. Bitcoin holders who want to spend without selling. The wallets, bots and AI agents that pay for them, through the library and the JSON API. Desktop and mobile web. This fits Track 2, Access and Distribution, because it lowers the friction of asking for, getting and paying MUSD in chats, invoices and QR codes.

## Tech stack

TypeScript, viem, qrcode-generator, Vitest, Cloudflare Workers with static assets and the rate limiting binding, public Mezo JSON-RPC endpoints, Mezo Blockscout explorers.

## Track

Track 2, Access and Distribution for MUSD and MEZO.

## Chain deployed on

Mezo. The app works with MUSD on Mezo Testnet (chain 31611) and Mezo Mainnet (chain 31612). It deploys no contracts of its own. It reads and calls the existing MUSD token and MUSD protocol contracts.

## Project status

Entirely new, built during the hackathon. It reuses design ideas from PayLink Guard (https://github.com/theluckystrike/paylink-guard), an earlier payment-link checker by the same author for Base and Solana. The Mezo and MUSD code is new.

## Project readiness

Testnet deployment. A live web app and JSON API on Cloudflare Workers read the MUSD token and the MUSD protocol on Mezo Testnet and Mainnet. No payment of our own has been made yet. Testnet MUSD is minted against testnet BTC, and the testnet BTC faucet needs a human check. The scripts that open a trove and pay a link are ready. The `openTrove` call was checked with a simulation that did not revert.

## Links

| What | Where |
|---|---|
| Live demo | https://musd-pay-links.lipmichal.workers.dev |
| Repository | https://github.com/theluckystrike/musd-pay-links |
| Pitch deck | https://github.com/theluckystrike/musd-pay-links/blob/main/docs/pitch-deck.pdf |
| Pitch video | https://youtu.be/T4JLpYwOAoY |
| Threat model and test output | https://github.com/theluckystrike/musd-pay-links#threat-model |
| Testnet MUSD contract | https://explorer.test.mezo.org/token/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 |
| Mainnet MUSD contract | https://explorer.mezo.org/token/0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186 |

## Evidence

244 tests pass, 238 offline and 6 that read Mezo over RPC. They cover the guard's attack cases, the borrow quote rules, batched log search, replay by block, the RPC fallback, CORS and the rate limit. Contract reads and `eth_call` dry runs are in `docs/evidence.json` in the repository.

## What is next

1. By 15 November 2026 (Wave 2), make the first MUSD payment on Mezo Testnet end to end and record it, publish the guard as an npm package, and add a Telegram bot that creates links and reports payments.
2. By the end of December 2026, add Mezo Passport so Bitcoin wallets can pay links, and open the trove from the pay page when the payer is short.
3. By the end of January 2027, add merchant notifications, so a small shop can take MUSD with links and see each payment confirmed without running a node.

## Team info

Michael Lip, solo builder (design, code and deployment), Warsaw, Poland. GitHub https://github.com/theluckystrike
