# MUSD Pay Links, AKINDO submission

Working submission draft updated on 1 November 2026. The original Wave 1 evidence is dated 26 October and is labelled below. This file does not prove that any updated answer was submitted to AKINDO or that the live demo serves this branch.

## Project name

MUSD Pay Links

## Project category

Payment links for MUSD

## TL;DR

Merchants ask for MUSD with a signed invoice, a link, a QR code or a pay page in a chat. Payers check the link before they pay. The page blocks a second payment from the same browser and checks the chain again before it sends. Two payers can still race, so a later payment with the same reference is shown as a duplicate and a refund is due. A payer who is short of MUSD sees a protocol quote and can separately review a direct testnet loan.

## Short summary

MUSD Pay Links lets anyone request MUSD on Mezo with a standard EIP-681 link. A payer-side TypeScript guard refuses a link unless the token is the real MUSD contract for that chain, the recipient is a valid address, and the amount is within the payer's limit. A payer without enough MUSD gets a quote read from the live MUSD protocol. The current source also offers a separate testnet loan review and wallet action; its execution evidence is reported separately. The merchant finds the payment on chain by its invoice reference. The pay page locks itself once a payment for the invoice is on chain.

## How it works

The problem. Paying someone in MUSD today means copying an address and an amount by hand, or trusting whatever a link or QR code says. A payment link is plain text. One changed character can point it at a fake token, at another chain, at an attacker's address, or at a much larger amount. AI agents that pay for users make this worse, because they act on text they did not write. A second problem is access. A Bitcoin holder who wants to pay in MUSD often holds no MUSD yet.

The merchant creates an invoice for MUSD on Mezo Testnet (31611) or Mezo Mainnet (31612). The wallet that receives the payment signs the invoice (EIP-191, a free message). The signature covers the chain, the recipient, the amount, the reference and the time. So nobody can create invoices for an address they do not control. The Worker saves the invoice, gives it a reference that is unique on that chain, and stamps it with the current block. The merchant gets an EIP-681 link, a QR code and a pay page URL to send in Telegram or any chat. Each link passes through the payer guard before it is shown.

The payer side parses the link strictly. The token must be the MUSD contract for the link's chain id. The recipient must be a valid address, and must be on the payer's allowlist when one is set. A mixed-case address with a wrong EIP-55 checksum is refused. An address in one case is accepted with a warning, because most link generators write lowercase. The amount must be within the payer's limit, with exact integer math at 18 decimals. Unicode tricks, percent-encoding, duplicated or unknown parameters, execution parameters and functions such as `approve` are refused. Every refusal has a code and a plain reason. When all checks pass, the guard returns an unsigned `transfer` call. It never holds a key.

When the payer is short of MUSD, the page reads the MUSD protocol on Mezo. It reads the BTC price from PriceFeed, MCR, CCR, the minimum debt, the gas compensation and the fee from BorrowerOperations, the interest rate from InterestRateManager, and the system ratio and recovery mode from TroveManager. The quote shows BTC collateral, full debt and liquidation price. On testnet, the user can review a direct `openTrove` request before a separate wallet action. Preparation checks the pinned deployment, actual balance, nonce, gas and a simulation without balance overrides. The page refreshes and checks the exact review before asking the wallet. This review expires after at most 60 seconds, but price, fee and state can still change before mining: `openTrove` has no maximum-fee argument. Mainnet borrowing remains in the external Mezo app. The borrower locks BTC as collateral; a loan does not automatically pay an invoice. The protocol minimum can make the debt much larger than the requested payment. The review includes minted MUSD, the borrowing fee and the GasPool reserve. That reserve is not spendable money or a refund to the borrower.

Checking an invoice reads MUSD Transfer logs to the merchant address since the invoice block. It decodes the reference from each payment and marks the invoice paid with the oldest payment that carries the exact reference and covers the amount. The payer does not need to send a hash. A transaction that paid one invoice cannot pay another. A payment from before the invoice block does not count. A payment of the exact amount without a reference shows as a possible match, because some wallets drop the reference. An invoice is recorded as paid only at 5 confirmations. Before that it shows as confirming, with the depth. The pay page is payer-only. It shows the amount, recipient, token, network, reference, status with confirmation depth, the QR code and the Pay action, and it hides the merchant panels. The pay page checks the chain when it opens and again right before it sends. It blocks a second payment from the same browser, and it locks Pay when a payment for the invoice exists. Two payers can still race. When an invoice is paid, later transfers with the same reference are listed as duplicates, with their transaction hashes and a refund due. A merchant can also record a payment by its hash, for example for an invoice older than the search window of about 23 hours. Invoices work on any device and expire after 30 days.

How MUSD is used and positioned. MUSD is the payment asset. The direct testnet loan also locks native test BTC. The app uses the MUSD token on both Mezo chains and reads the deployed MUSD protocol contracts. The addresses come from the Mezo docs and the official deployment files in github.com/mezo-org/musd. The goal is to make MUSD easy to ask for, safe to pay, and easy to get for a Bitcoin holder who has none yet. A desktop wallet check is separate from general wallet and mobile compatibility; current results are recorded in `docs/verification.md`.

After network selection, the payer may see another normal account-permission prompt. The app checks the original payer and selected chain again before payment. This flow needs wallet-specific execution evidence; a permission reply alone does not prove compatibility. An uncertain send remains locked, including an authorization error after the send request.

## Business model

Today the project is free and open source (MIT). It has no customers and no revenue. The plan has two parts. The guard library and the plain links stay free, so wallets and agents can use them. A hosted invoice service for shops would offer payment notifications, higher limits and a custom pay page for a flat monthly price. Pricing is unvalidated. Payments go straight from the payer to the merchant. The service never holds funds. The next validation target is one voluntary merchant or freelancer test. No participant or paid plan is agreed today. A shop may prefer this to an address in a chat because the guard checks the link and the merchant finds payment by its reference. A payer with BTC and no MUSD can separately inspect the full cost of borrowing.

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

The historical deployment has project-owned testnet payment evidence. Its web app and JSON API read the MUSD token and protocol on Mezo Testnet and Mainnet. The isolated [1 November Preview](https://sprint-20261101-musd-pay-links.lipmichal.workers.dev) serves application source `e50735e`, with separate invoice storage. It is not a production traffic rollout.

On 1 November, [hosted real MetaMask run 41302937067](https://github.com/theluckystrike/musd-pay-links/actions/runs/41302937067) at `5987b40` signed invoice `INV-6MG8SUDA`, rejected one transaction without a nonce change, then made one [1 MUSD payment](https://explorer.test.mezo.org/tx/0x11028978ae896a11ad946047bebd829882f729580d1d452cabf4c50b97df1fad). Exact transfer calldata, invoice reference, canonical block and at least five confirmations passed. The product showed Paid and retained its lock after reload. This wallet test used a local Worker and two project wallets, so it does not prove payment through the public HTTPS Preview or outside adoption. See the [dated evidence and limits](docs/sprint-2026-11-01/README.md). A newly opened in-product loan remains unproved because the new test wallet lacks enough native collateral.

On 26 October 2026 the project made its own payment on Mezo Testnet, end to end. Testnet only, no real money.

1. Borrow. The project's test address opened a trove. It locked 0.049 test BTC and minted 1,800 MUSD. The debt is 2,001.80 MUSD and the ratio is 196 percent. Transaction https://explorer.test.mezo.org/tx/0x1de64d3a9fe0588d2707718ed3c247d793f5d5f818efd502ae80ee8dc70a26f2
2. Invoice. The live Worker created invoice INV-65ZVUMXW for 5 MUSD to a merchant test address.
3. Pay. The script checked the link with the guard and sent 5 MUSD with the reference. Transaction https://explorer.test.mezo.org/tx/0x7abfedb120383f817134e5e63823aef69948930fa9760c6b96fb03a87909cc0b
4. Confirm. The invoice check found the payment by its reference, with no hash from the payer. The merchant inbox and the verify route also return paid. The verify route always returns final. It is false until 5 confirmations.
5. Signed invoice. The merchant key signed invoice INV-P92MNPCN for 1 MUSD. A 1 MUSD payment followed (https://explorer.test.mezo.org/tx/0x9b8285c19033cc957932406347234a8b339e85fc2c1848fb672f522dd10a825c). Confirm by hash answered confirming at 3 of 5 confirmations, then paid. An unsigned create gets 401. A replay of the signed request gets 409.

6. Duplicate payment. On 26 Oct a second 5 MUSD payment with the same reference went to the paid invoice INV-65ZVUMXW (https://explorer.test.mezo.org/tx/0x95ef25c8d2f3dec854e8203e3122ec6694f12153d2d21b7f5945669a7c902dc4). The invoice API lists it under duplicates with refund due. The invoice still counts the first payment only.

These 26 October payments were sent from scripts. They do not establish browser-wallet use or an outside merchant pilot. The separate 1 November browser result is recorded above and in `docs/verification.md`. No newly opened in-product loan or outside merchant pilot is claimed.

## Links

| What | Where |
|---|---|
| Live demo | https://musd-pay-links.lipmichal.workers.dev |
| Isolated 1 November Preview | https://sprint-20261101-musd-pay-links.lipmichal.workers.dev |
| 1 November browser evidence | https://github.com/theluckystrike/musd-pay-links/blob/sprint/20261101-wallet-evidence/docs/sprint-2026-11-01/README.md |
| Repository | https://github.com/theluckystrike/musd-pay-links |
| Pitch deck | https://github.com/theluckystrike/musd-pay-links/blob/main/docs/pitch-deck.pdf |
| Pitch video | https://youtu.be/T4JLpYwOAoY |
| How it protects the money | https://github.com/theluckystrike/musd-pay-links#how-it-protects-the-money |
| Own borrow transaction (testnet) | https://explorer.test.mezo.org/tx/0x1de64d3a9fe0588d2707718ed3c247d793f5d5f818efd502ae80ee8dc70a26f2 |
| Own invoice payment (testnet) | https://explorer.test.mezo.org/tx/0x7abfedb120383f817134e5e63823aef69948930fa9760c6b96fb03a87909cc0b |
| Testnet MUSD contract | https://explorer.test.mezo.org/token/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 |
| Mainnet MUSD contract | https://explorer.mezo.org/token/0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186 |

## Evidence

The 26 October baseline reported 337 passing tests: 330 offline and 7 live RPC cases. This is a dated baseline, not the current sprint count. One live case verifies the project's own earlier payment on chain. They cover the guard's attack cases, the borrow quote rules, invoices, signed creation (good signature, wrong signer, expired time, replay), the confirmation depth, confirm by hash, a double payment, batched log search, replay by block, the RPC fallback, CORS, the rate limit and the HTTP codes. Contract reads, `eth_call` dry runs and the project's own earlier borrow and payment are in `docs/evidence.json`. That file is chain evidence; it contains no Vitest runner report and cannot prove a test total. Fresh runner JSON, exact commands, commit identifiers and browser results are described in `docs/verification.md`. A successful build or runtime check alone proves no wallet transaction, loan, customer use or revenue.

## What is next

1. For Wave 2, seek one voluntary merchant or freelancer test through a permitted route. Record the problem, agreed task, actual outcome and feedback. Update the dated deck and video before a new submission. A public guard package and Telegram integration remain planned, not shipped.
2. Prove a newly opened loan through the testnet review flow, then test the return to invoice payment. Add Mezo Passport so Bitcoin wallets can pay links. Mainnet loan support requires separate work and evidence.
3. By the end of January 2027, add merchant notifications, so a small shop can take MUSD with links and see each payment confirmed without running a node.

## Team info

Michael Lip, solo builder (design, code and deployment), Warsaw, Poland. GitHub https://github.com/theluckystrike
