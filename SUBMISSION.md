# MUSD Pay Links, AKINDO submission

Answers for the Mezo Buildathon submission form. Updated on 26 October 2026, inside the Wave 1 build period (16 to 26 October 2026).

## Project name

MUSD Pay Links

## Project category

Payment links for MUSD

## TL;DR

Merchants ask for MUSD with a signed invoice, a link, a QR code or a pay page in a chat. Payers check the link before they pay, the page will not let them pay twice, and a payer who is short of MUSD sees how much BTC would mint it.

## Short summary

MUSD Pay Links lets anyone request MUSD on Mezo with a standard EIP-681 link. A payer-side TypeScript guard refuses a link unless the token is the real MUSD contract for that chain, the recipient is a valid address, and the amount is within the payer's limit. A payer without enough MUSD gets a borrow quote read from the live MUSD protocol. The merchant finds the payment on chain by its invoice reference. The pay page locks itself once a payment for the invoice is on chain.

## How it works

The problem. Paying someone in MUSD today means copying an address and an amount by hand, or trusting whatever a link or QR code says. A payment link is plain text. One changed character can point it at a fake token, at another chain, at an attacker's address, or at a much larger amount. AI agents that pay for users make this worse, because they act on text they did not write. A second problem is access. A Bitcoin holder who wants to pay in MUSD often holds no MUSD yet.

The merchant creates an invoice for MUSD on Mezo Testnet (31611) or Mezo Mainnet (31612). The wallet that receives the payment signs the invoice (EIP-191, a free message). The signature covers the chain, the recipient, the amount, the reference and the time. So nobody can create invoices for an address they do not control. The Worker saves the invoice, gives it a reference that is unique on that chain, and stamps it with the current block. The merchant gets an EIP-681 link, a QR code and a pay page URL to send in Telegram or any chat. Each link passes through the payer guard before it is shown.

The payer side parses the link strictly. The token must be the MUSD contract for the link's chain id. The recipient must be a valid address, and must be on the payer's allowlist when one is set. A mixed-case address with a wrong EIP-55 checksum is refused. An address in one case is accepted with a warning, because most link generators write lowercase. The amount must be within the payer's limit, with exact integer math at 18 decimals. Unicode tricks, percent-encoding, duplicated or unknown parameters, execution parameters and functions such as `approve` are refused. Every refusal has a code and a plain reason. When all checks pass, the guard returns an unsigned `transfer` call. It never holds a key.

When the payer is short of MUSD, the page reads the MUSD protocol on Mezo. It reads the BTC price from PriceFeed, MCR, CCR, the minimum debt, the gas compensation and the fee from BorrowerOperations, the interest rate from InterestRateManager, and the system ratio and recovery mode from TroveManager. It then shows the BTC to lock, the debt, the liquidation price and a link to the borrow page of the Mezo app. The payer keeps the Bitcoin and pays in MUSD.

Checking an invoice reads MUSD Transfer logs to the merchant address since the invoice block. It decodes the reference from each payment and marks the invoice paid with the oldest payment that carries the exact reference and covers the amount. The payer does not need to send a hash. A transaction that paid one invoice cannot pay another. A payment from before the invoice block does not count. A payment of the exact amount without a reference shows as a possible match, because some wallets drop the reference. An invoice is recorded as paid only at 5 confirmations. Before that it shows as confirming, with the depth. The pay page is payer-only. It shows the amount, recipient, token, network, reference, status with confirmation depth, the QR code and the Pay action, and it hides the merchant panels. The pay page checks the chain when it opens and again right before it sends, and locks Pay when a payment for the invoice exists. A merchant can also record a payment by its hash, for example for an invoice older than the search window of about 23 hours. Invoices work on any device and expire after 30 days.

How MUSD is used and positioned. MUSD is the only asset the product moves. It uses the MUSD token on both Mezo chains and four contracts of the MUSD protocol. The addresses come from the Mezo docs and the official deployment files in github.com/mezo-org/musd. The goal is to make MUSD easy to ask for, safe to pay, and easy to get for a Bitcoin holder who has none yet. Which wallets open these links has not been tested yet.

## Business model

Today the project is free and open source (MIT). It has no customers and no revenue. The plan has two parts. The guard library and the plain links stay free, so wallets and agents can use them. A hosted invoice service for shops gets a flat monthly plan with payment notifications, higher limits and a custom pay page. Payments always go straight from the payer to the merchant. The service never holds funds. The Wave 2 goal is 10 pilot merchants from the Mezo community and the author's network. None is signed today. A shop picks this over a wallet address in a chat for three reasons. The payer's guard stops a changed link. The payment is found by its reference with no hash from the payer. A payer with BTC and no MUSD sees how to mint it on the same page.

## Target group

Small online sellers, freelancers and creators who want to be paid in a Bitcoin-backed stablecoin without a payment processor. Bitcoin holders who want to spend without selling. The wallets, bots and AI agents that pay for them, through the library and the JSON API. Desktop and mobile web. This fits Track 2, Access and Distribution, because it lowers the friction of asking for, getting and paying MUSD in chats, invoices and QR codes.

## Tech stack

TypeScript, viem, qrcode-generator, Vitest, Cloudflare Workers with static assets, KV and a Durable Object, public Mezo JSON-RPC endpoints, Mezo Blockscout explorers.

## Track

Track 2, Access and Distribution for MUSD and MEZO.

## Chain deployed on

Mezo. The app works with MUSD on Mezo Testnet (chain 31611) and Mezo Mainnet (chain 31612). It deploys no contracts of its own. It reads and calls the existing MUSD token and MUSD protocol contracts.

## Project status

Entirely new, built during the hackathon. It reuses design ideas from PayLink Guard (https://github.com/theluckystrike/paylink-guard), an earlier payment-link checker by the same author for Base and Solana. The Mezo and MUSD code is new.

## Project readiness

Testnet deployment with a real payment. A live web app and JSON API on Cloudflare Workers read the MUSD token and the MUSD protocol on Mezo Testnet and Mainnet.

On 26 October 2026 the project made its own payment on Mezo Testnet, end to end. Testnet only, no real money.

1. Borrow. The project's test address opened a trove. It locked 0.049 test BTC and minted 1,800 MUSD. The debt is 2,001.80 MUSD and the ratio is 196 percent. Transaction https://explorer.test.mezo.org/tx/0x1de64d3a9fe0588d2707718ed3c247d793f5d5f818efd502ae80ee8dc70a26f2
2. Invoice. The live Worker created invoice INV-65ZVUMXW for 5 MUSD to a merchant test address.
3. Pay. The script checked the link with the guard and sent 5 MUSD with the reference. Transaction https://explorer.test.mezo.org/tx/0x7abfedb120383f817134e5e63823aef69948930fa9760c6b96fb03a87909cc0b
4. Confirm. The invoice check found the payment by its reference, with no hash from the payer. The merchant inbox and the verify route also return paid. The verify route always returns final. It is false until 5 confirmations.
5. Signed invoice. The merchant key signed invoice INV-P92MNPCN for 1 MUSD. A 1 MUSD payment followed (https://explorer.test.mezo.org/tx/0x9b8285c19033cc957932406347234a8b339e85fc2c1848fb672f522dd10a825c). Confirm by hash answered confirming at 3 of 5 confirmations, then paid. An unsigned create gets 401. A replay of the signed request gets 409.

The payments were sent from scripts. A browser wallet has not paid a link yet.

## Links

| What | Where |
|---|---|
| Live demo | https://musd-pay-links.lipmichal.workers.dev |
| Repository | https://github.com/theluckystrike/musd-pay-links |
| Pitch deck | https://github.com/theluckystrike/musd-pay-links/blob/main/docs/pitch-deck.pdf |
| Pitch video | https://youtu.be/T4JLpYwOAoY |
| How it protects the money | https://github.com/theluckystrike/musd-pay-links#how-it-protects-the-money |
| Own borrow transaction (testnet) | https://explorer.test.mezo.org/tx/0x1de64d3a9fe0588d2707718ed3c247d793f5d5f818efd502ae80ee8dc70a26f2 |
| Own invoice payment (testnet) | https://explorer.test.mezo.org/tx/0x7abfedb120383f817134e5e63823aef69948930fa9760c6b96fb03a87909cc0b |
| Testnet MUSD contract | https://explorer.test.mezo.org/token/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 |
| Mainnet MUSD contract | https://explorer.mezo.org/token/0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186 |

## Evidence

304 tests pass, 297 offline and 7 that read Mezo over RPC. One of them verifies the project's own payment on chain. They cover the guard's attack cases, the borrow quote rules, invoices, signed creation (good signature, wrong signer, expired time, replay), the confirmation depth, confirm by hash, a double payment, batched log search, replay by block, the RPC fallback, CORS, the rate limit and the HTTP codes. Contract reads, `eth_call` dry runs and the project's own borrow and payment are in `docs/evidence.json` in the repository.

## What is next

1. By 15 November 2026 (Wave 2), pay a link from a browser wallet on Mezo Testnet and record it, publish the guard as an npm package, and add a Telegram bot that creates links and reports payments.
2. By the end of December 2026, add Mezo Passport so Bitcoin wallets can pay links, and open the trove from the pay page when the payer is short.
3. By the end of January 2027, add merchant notifications, so a small shop can take MUSD with links and see each payment confirmed without running a node.

## Team info

Michael Lip, solo builder (design, code and deployment), Warsaw, Poland. GitHub https://github.com/theluckystrike
