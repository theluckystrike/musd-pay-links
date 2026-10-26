# MUSD Pay Links

Payment links and QR codes for MUSD on Mezo, with a payer-side guard that checks the link before any transfer is built. Built by [Michael Lip](https://github.com/theluckystrike) (Warsaw, Poland) for the Mezo Buildathon on AKINDO, Access and Distribution track.

Live demo at https://musd-pay-links.lipmichal.workers.dev

Pitch deck, 10 slides, in [docs/pitch-deck.pdf](docs/pitch-deck.pdf). The slides are also in [docs/deck](docs/deck) as PNG files.

<img src="docs/demo-desktop.png" alt="MUSD Pay Links demo page" width="100%">

At phone width (390 px) the page has no horizontal scroll, see [docs/demo-mobile.png](docs/demo-mobile.png).

## First own payment on Mezo Testnet, 26 October 2026

The project made its own borrow and its own invoice payment on Mezo Testnet. Testnet only, no real money.

| Step | Transaction | Result |
|---|---|---|
| Borrow. `pnpm testnet-borrow` opens a trove | [`0x1de64d3a...26f2`](https://explorer.test.mezo.org/tx/0x1de64d3a9fe0588d2707718ed3c247d793f5d5f818efd502ae80ee8dc70a26f2) | 0.049 test BTC locked, 1,800 MUSD minted, block 16370809 |
| Invoice. The live Worker creates `INV-65ZVUMXW` for 5 MUSD | no transaction | invoice block 16370824 |
| Pay. `pnpm testnet-pay` checks the link with the guard and sends it | [`0x7abfedb1...cc0b`](https://explorer.test.mezo.org/tx/0x7abfedb120383f817134e5e63823aef69948930fa9760c6b96fb03a87909cc0b) | 5 MUSD to the merchant, reference in the transfer data, block 16370829 |
| Confirm. Live invoice check, merchant inbox and `/api/verify` | no transaction | all three return `paid`, 5 MUSD, reference matched |

Details are in [Testnet payment](#testnet-payment).

## What changed on 25 October 2026

- Borrow quote from the live MUSD protocol. A payer who is short of MUSD sees the BTC to lock, the fee, the protocol minimum and the liquidation price, read from four MUSD protocol contracts, with a link to the borrow page of the Mezo app.
- Invoices on the Worker (Cloudflare KV). Unique references, a block stamp set by the Worker, a pay page per invoice, a list per merchant address, and one transaction pays one invoice.
- The invoice check finds the payment on chain by its reference. The payer does not need to send a hash. Payments without a reference show as possible matches.
- Replay protection by invoice block and an exact reference match.
- Pay page and Telegram share.
- Reliability. Batched RPC reads, a second testnet endpoint, mainnet moved off an endpoint that refused `eth_call`, and reads retry up to 6 times. `/api/health` now probes both chains.
- Chain routes send no CORS header and have an exact per-client limit in a Durable Object. HTTP codes follow the answer.
- The payer picks the networks they accept. The demo defaults to Mezo Testnet only.
- A scripted path from test BTC to a paid invoice (`testnet-borrow` and `testnet-pay`).
- Tests went from 204 to 261. On 26 October one live test was added for the project's own payment (262).

## What it does

A merchant who wants MUSD needs a way to ask for it that wallets and agents can read. EIP-681 already defines a link format for an ERC-20 transfer, and a QR code of the link works at a counter or on an invoice. The weak point is the payer side. A link is just text, and one changed character can send the money to another address, ask for a fake token, or move the payment to another chain.

MUSD Pay Links has five parts.

1. The merchant side creates a standard EIP-681 link and a QR code for MUSD on Mezo, with the amount, the recipient and an optional reference such as an invoice number.
2. The payer side is a TypeScript library (and the same code in the demo page) that parses the link and refuses it unless three checks pass. The token must be the real MUSD contract for that chain id. The recipient must be a valid address with a correct EIP-55 checksum, and on the payer's allowlist when one is set. The amount must be within the payer's limit, compared with exact integer math at 18 decimals. Every refusal comes with a code and a plain reason.
3. The merchant can then confirm the payment on chain. The verifier reads the receipt and counts only Transfer events emitted by the real MUSD contract to the merchant's address. When the link carried a reference, the verifier also requires the payment input to end with the same reference. A payment that does not carry it is refused. The reference must match exactly, so `XINV-1` does not pay `INV-1`. The Worker gives every invoice a fresh random reference (about 40 bits) unless the merchant types one, refuses a reference that is already taken on that chain with HTTP 409, and records each transaction that paid an invoice, so one payment pays one invoice.

4. A payer who is short of MUSD sees how much BTC would mint it. The borrow quote links to the borrow page of the Mezo testnet dApp (https://testnet.mezo.org/borrow, the testnet dApp named on the buildathon page) or of https://mezo.org/borrow. The quote reads the live rules of the MUSD protocol on Mezo (the BTC price from PriceFeed, MCR, CCR, the minimum debt, the gas compensation and the fee from BorrowerOperations, the interest rate from InterestRateManager, the system ratio and recovery mode from TroveManager). It gives the BTC to lock, the debt, the liquidation price and a hand-off to the Mezo app. The payer keeps the Bitcoin and spends MUSD.
5. The merchant keeps invoices on the Worker. `POST /api/invoices` saves an invoice in Cloudflare KV with a unique reference and the current block, read by the Worker, not by the browser. The invoice works on any device and has its own pay page (`/?invoice=INV-...&chain=31611`). Checking an invoice reads MUSD Transfer logs to the merchant address since that block, decodes the reference of each payment, and marks the invoice paid with the oldest payment that carries the reference and covers the amount. The payer does not need to send a hash. A payment of exactly the amount without a reference shows as a possible match for a person to confirm, because some wallets drop the reference. The search looks back at most 20,000 blocks (about 23 hours on testnet) and says so when an invoice is older, and it reads at most the newest 50 payments. Log queries and transaction reads go out as JSON-RPC batches, so one check uses a handful of requests. Invoices expire after 30 days, but the on-chain search covers only the last 23 hours, so an older open invoice must be confirmed by hash. Invoices have no merchant login yet. Anyone who knows a merchant address can create or list invoices for it, which shows the open amounts and references.

The library never holds a key and never signs. It returns an unsigned transaction (`to` is the MUSD contract, `value` is 0, `data` is `transfer(recipient, amount)`) for the wallet or agent to sign.

## MUSD contracts

Both addresses come from the official Mezo docs, page "MUSD Payments With x402" (https://mezo.org/docs/developers/getting-started/musd-payments-x402/). Both are verified source on the Mezo Blockscout explorers as contract `MUSD`, token name "Mezo USD", symbol MUSD, 18 decimals. The demo reads `name()`, `symbol()`, `decimals()` and `totalSupply()` from them live.

| Network | Chain id | MUSD contract | RPC used |
|---|---|---|---|
| Mezo Testnet | 31611 | [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/token/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) | `https://rpc.test.mezo.org` |
| Mezo Mainnet | 31612 | [`0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186`](https://explorer.mezo.org/token/0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186) | `https://mezo-mainnet.boar.network` |

Chain ids and RPC endpoints are from https://mezo.org/docs/developers/getting-started/configure-environment/ and were confirmed with `eth_chainId`. Each chain has a second endpoint. On mainnet it is https://mainnet.mezo.public.validationcloud.io from the same docs table. On testnet the docs list one endpoint, so the second one is the public dRPC node https://mezo-testnet.drpc.org, which answers chain id 31611. It is a partial fallback. On 25 October 2026 some of its backends answered receipts and others answered "method does not exist", and its free plan limits log ranges. A read retries up to 6 times, waits 300 ms times the attempt number, and alternates between the two endpoints. A null answer from a lagging node and an error from the fallback both count as a failed try, so the next try goes back to the other endpoint. Measured with sequential curl GETs against the live Worker on 25 October 2026, 29 of 30 verify calls answered paid and 22 of 22 inbox calls answered (raw output in the lane notes, not in this repo). The demo page retries a failed verify call, so a click recovers. On 25 October 2026 the dRPC mainnet node refused `eth_call`, so mainnet now starts at Boar, the endpoint the Mezo docs use in their own examples.

### MUSD protocol contracts

The borrow quote reads these contracts. The addresses come from the official deployment files in https://github.com/mezo-org/musd (`solidity/artifacts/deployments/matsnet` for testnet and `.../mainnet`). On both chains `BorrowerOperations.priceFeed()`, `.troveManager()` and `.interestRateManager()` return the same addresses.

| Contract | Mezo Testnet | Mezo Mainnet |
|---|---|---|
| BorrowerOperations | `0xCdF7028ceAB81fA0C6971208e83fa7872994beE5` | `0x44b1bac67dDA612a41a58AAf779143B181dEe031` |
| TroveManager | `0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0` | `0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193` |
| PriceFeed | `0x86bCF0841622a5dAC14A313a15f96A95421b9366` | `0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88` |
| InterestRateManager | `0xD4D6c36A592A2c5e86035A6bca1d57747a567f37` | `0x4a453700d157717Fe02fB62E7700ED7845048285` |

Live testnet values on 25 October 2026. BTC price about 80,300 USD, MCR 110 percent, CCR 150 percent, minimum net debt 1,800 MUSD, gas compensation 200 MUSD, borrowing fee 0.1 percent, interest 1 percent a year, 330 troves, system ratio about 288 percent, recovery mode off. So the smallest trove carries 2,001.8 MUSD of debt, which matches the `openTrove` transactions on the testnet explorer (1,800 MUSD to the borrower, 200 to the gas pool and 1.8 as the fee).

## Link format

The merchant link is plain EIP-681 for an ERC-20 transfer, with one optional extra parameter for the reference.

`ethereum:0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503@31611/transfer?address=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed&uint256=12500000000000000000&memo=INV-1042`

The `uint256` value is in base units (12.5 MUSD here). The `memo` is up to 32 characters. Letters, digits and the characters dot, underscore, colon, slash and hyphen are allowed. The `#` character is not allowed, because `#` starts an EIP-681 fragment and would truncate the link. When a memo is present, the guard appends its bytes after the ABI arguments of the `transfer` call. The MUSD contract ignores the extra bytes (an `eth_call` dry run on testnet returns `true` with and without them), and the merchant's verifier can match the reference in the transaction input.

Wallet support is not proven here. EIP-681 token links are a standard, but wallet support for them varies, and `memo` is not part of EIP-681, so it is likely that a wallet that does not know the parameter will build the transfer without the reference. Mezo Testnet and Mezo Mainnet also have to be added to most wallets before a link is useful. No wallet has been tested with this project's links yet, and the tested-wallet table will be added when that testing is done.

## Use the library

```ts
import { checkPaymentLink, createPaymentLink, findPayments, headBlock, quoteBorrow, readBorrowTerms, verifyPayment, MEZO_TESTNET } from "./src/index.ts";

// Merchant
const chainId = 31611, recipient = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", amount = "12.50", memo = "INV-1042";
const created = createPaymentLink({ chainId, recipient, amount, memo });

// Payer, with a spending limit and an optional allowlist
const maxAmount = "50", allowlist = [recipient];
const result = checkPaymentLink(created.link, { maxAmount, allowlist });
if (!result.ok) console.log(result.reasons); // list of { code, message }
else wallet.sendTransaction(result.tx);     // { chainId, to, value, data }, value is always 0n

// Payer is short of MUSD: how much BTC mints it (live protocol reads, nothing is signed)
const terms = await readBorrowTerms(MEZO_TESTNET);
const quote = quoteBorrow(terms, 25n * 10n ** 18n); // { borrow, fee, totalDebt, collateral, liquidationPrice, ... }

// Merchant, after payment. Stamp the invoice with the block it was created in.
const fromBlock = await headBlock(MEZO_TESTNET);
const inbox = await findPayments(MEZO_TESTNET, { recipient, memo, amount: 12_500_000_000_000_000_000n, fromBlock });
if (inbox.status === "ok" && inbox.paid) console.log("paid in", inbox.paid.txHash);
// or, with a hash from the payer
if (result.ok) await verifyPayment(MEZO_TESTNET, { txHash, recipient, amount: result.payment.amount, memo, fromBlock });
```

The same functions are exposed as a read-only JSON API by the Worker, so an agent can call them over HTTP.

| Endpoint | Purpose |
|---|---|
| `/api/link?chain=31611&to=0x...&amount=12.5&memo=INV-1` | Create a link and its QR code (`&format=svg` returns only the SVG) |
| `/api/check?link=...&max=50&allow=0x...,0x...` | Run the payer guard. Returns 200 with the transaction or 422 with reasons |
| `/api/verify?chain=31611&tx=0x...&to=0x...&amount=12.5&memo=INV-1&from_block=16360000` | Confirm a payment on chain. A payment mined before `from_block` is refused |
| `/api/payments?chain=31611&to=0x...&memo=INV-1&amount=12.5&from_block=16360000` | Merchant inbox. Lists MUSD payments to the address with their references, and `paid` when one matches |
| `/api/borrow?chain=31611&need=25&ratio=200` | Borrow quote from the live MUSD protocol |
| `/api/head?chain=31611` | Current block |
| `POST /api/invoices` with `{"chain":31611,"to":"0x...","amount":"12.5"}` | Save an invoice. Returns the reference, the block, the link, the QR code and the pay page URL. 409 when a given reference is taken |
| `/api/invoices/INV-...?chain=31611` | Check one invoice on chain and record the payment. `&check=0` reads the stored invoice only |
| `/api/invoices?chain=31611&to=0x...` | The 20 newest invoices of a merchant address |
| `/api/health` | Reads the block number on both chains and answers 503 when one RPC does not answer |
| `/api/token?chain=all` | Read the MUSD contracts live |
| `/api/balance?chain=31611&address=0x...` | Read a MUSD balance |

HTTP codes follow the answer, so an agent can branch on the code alone. 200 for `paid`, `pending` and `open`, 404 for `not_found`, 422 for `mismatch` and `failed`, 503 for `unavailable`.

The routes that only compute (`/api/link`, `/api/check`) can be called from any web page. The routes that read the chain send no CORS header, so other web pages cannot use the Worker as an RPC proxy. They are limited to 30 calls a minute per client IP, and invoice creation to 10 a minute. The count is kept in a Durable Object per client, so it is exact across Worker isolates. In a live test with 36 sequential curl GETs on 25 October 2026, call 31 was the first to get 429. The Cloudflare rate limiting binding alone had let 40 calls through, so it is only a second line. A server-side agent can call every route.

## Threat model

The attacker controls the link text. They may also control the page or message that carries it, and they may know the payer's habits. They do not control the payer's wallet or the Mezo chain. The guard has to stop a link from paying more, paying someone else, paying in a fake token, or paying on another chain than the payer expects.

| Attack | What the guard does | Code |
|---|---|---|
| Fake token with the same symbol | Token address must equal the MUSD contract for the link's chain id. The comparison ignores case, so an all-lowercase MUSD address from a normal EIP-681 generator is accepted, and a mixed-case address with a wrong checksum is refused | `not_musd`, `token_bad_checksum` |
| Lookalike token address that keeps the first and last characters | Refused with a message that names the lookalike | `lookalike_token` |
| Real MUSD address with the other Mezo chain id | Refused, so funds do not land on the wrong network | `token_chain_mismatch` |
| Missing chain id, so the wallet guesses the network | Refused | `missing_chain_id` |
| Any non-Mezo chain id, leading zeros or hex chain ids | Refused | `wrong_chain`, `bad_chain_id` |
| Altered recipient | EIP-55 checksum must match. Unchecksummed addresses are refused by default | `recipient_bad_checksum`, `recipient_no_checksum` |
| Address poisoning (a recipient that looks like a saved one) | Refused when it is not on the allowlist, with the saved address named | `recipient_lookalike` |
| Recipient is the zero address or the MUSD contract | Refused, funds would be lost | `recipient_zero`, `recipient_is_token` |
| Amount above the payer's limit | Refused with both numbers | `over_limit` |
| Amount above uint256, which some parsers wrap to a small number | Refused | `amount_overflow` |
| Fractional base units, signs, hex, commas | Refused | `amount_overflow`, `bad_amount` |
| Zero-width spaces, bidi overrides, Cyrillic or full-width lookalikes, control characters | Any character outside printable ASCII is refused, and the code point is named | `unicode_trick` |
| Percent-encoding that hides the same characters | Refused, a MUSD link never needs it | `percent_encoding` |
| Extra execution parameters such as `value`, `gas`, `gasPrice`, `nonce`, `data` | Refused | `forbidden_param` |
| Unknown parameters, wrong-case keys that some wallets read | Refused | `unknown_param`, `param_case` |
| Two `address` or two `uint256` values (wallets disagree on which wins) | Refused | `duplicate_param` |
| `approve`, `transferFrom`, `increaseAllowance`, `permit` | Refused, only `transfer` is allowed | `dangerous_function` |
| Very long links, fragments, malformed queries, ENS names | Refused | `too_long`, `fragment`, `malformed_query`, `ens_or_bad_target` |
| Replay of an older payment under a new invoice reference | The verifier requires the payment input to carry the link's reference, otherwise `mismatch` | `mismatch` |
| Replay of an older payment with no reference | The Worker stamps the invoice with its creation block. A payment mined earlier is refused, and the invoice check does not search before it | `mismatch` |
| One payment used for two invoices | References are unique per chain (409 on reuse), the match is exact, and a transaction that paid one invoice is recorded and skipped for every other | `reference_taken` |
| A payer's page accepts a link for the other Mezo network | The payer picks the networks they accept. The demo defaults to Mezo Testnet only | `wrong_chain` |

Out of scope. The guard does not judge whether the merchant is honest, and it does not replace the wallet's own confirmation screen. It does not check sanctions lists. A payer who sets a high limit and no allowlist can still pay a real but unwanted address. The verifier trusts the RPC node it reads from (the Worker uses the public Mezo RPC endpoints listed above).

## Testnet payment

On 26 October 2026 the project made its own payment on Mezo Testnet, end to end. Testnet only, no real money. The key of the payer stays outside the repo and was never printed.

1. Faucet. At 00:42 UTC the throwaway payer address [`0x980E...e313`](https://explorer.test.mezo.org/address/0x980E2213E6396043e2d104Ad65cBF162985Ce313) got 0.05 test BTC from https://faucet.test.mezo.org. The faucet needs a human check, so a person did this step.
2. Borrow. `pnpm testnet-borrow` read the live terms. The BTC price from PriceFeed was 80,068.61 USD. MCR was 110 percent and CCR was 150 percent. The minimum debt was 1,800 MUSD plus 200 MUSD gas compensation. The script simulated `openTrove`, then sent it with 0.049 test BTC and kept 0.001 test BTC for gas. Transaction [`0x1de64d3a9fe0588d2707718ed3c247d793f5d5f818efd502ae80ee8dc70a26f2`](https://explorer.test.mezo.org/tx/0x1de64d3a9fe0588d2707718ed3c247d793f5d5f818efd502ae80ee8dc70a26f2) in block 16370809. The trove is active. It holds 0.049 BTC against 2,001.80 MUSD of debt, a ratio of 196 percent. The liquidation price at MCR is about 44,940 USD.
3. Invoice. A `POST /api/invoices` on the live Worker created invoice `INV-65ZVUMXW` for 5 MUSD to the merchant test address [`0x9495...3cB6`](https://explorer.test.mezo.org/address/0x94958151D1789C8279a67f5cE4631e9DDdE43cB6). The Worker stamped it with block 16370824.
4. Pay. `pnpm testnet-pay "<link>" 5` checked the invoice link with the guard and sent the MUSD `transfer` with the reference bytes after the arguments. Transaction [`0x7abfedb120383f817134e5e63823aef69948930fa9760c6b96fb03a87909cc0b`](https://explorer.test.mezo.org/tx/0x7abfedb120383f817134e5e63823aef69948930fa9760c6b96fb03a87909cc0b) in block 16370829.
5. Confirm. Without a transaction hash, `GET /api/invoices/INV-65ZVUMXW` found the payment by its reference and returned `paid`. `GET /api/payments` (the merchant inbox) listed it as the matching payment. `GET /api/verify` returned `paid`, 5 MUSD, reference matched. The same payment checked against the reference `INV-0001` returns `mismatch`.

The verify panel on the demo page is prefilled with this payment. The raw output is in `ownPayment` in [docs/evidence.json](docs/evidence.json).

What this does not show. The payment was sent from a script, not from a browser wallet. The payer and the merchant are both test addresses of the project.

What is verified against the real contracts, with no key.

| Check | Result |
|---|---|
| `name()`, `symbol()`, `decimals()` on testnet and mainnet MUSD | "Mezo USD", "MUSD", 18 on both |
| `eth_call` dry run of the guard's transfer data from a public testnet MUSD holder, with and without memo | returns `true` |
| Borrow terms read from BorrowerOperations, TroveManager, PriceFeed and InterestRateManager on both chains | sane values, see above |
| `openTrove` simulation for the smallest trove | no revert |
| `verifyPayment` on the project's own payment, with reference and invoice block | `paid`, 5 MUSD |
| Trove of the payer address in TroveManager | status 1 (active), 0.049 BTC, 2,001.80 MUSD debt |
| `verifyPayment` on a public 6 MUSD transfer made by someone else ([`0xc19b443d...e239a`](https://explorer.test.mezo.org/tx/0xc19b443ddcb35fdbe4389382dfff3815a82a0f2e12f43b00537d73db89be239a)) | `paid`, 6 MUSD |
| `findPayments` on an active testnet address | lists its MUSD payments with references decoded |
| `verifyPayment` with an invoice block after the transfer | `mismatch` |

The raw output of every check above is in [docs/evidence.json](docs/evidence.json), regenerated on 26 October 2026. Run `pnpm evidence` to read it again.

The demo page has a browser wallet payment path that has not been used with a real wallet yet. A payer opens the page with a wallet that holds testnet MUSD, checks a link and presses "Pay with browser wallet". The page switches the wallet to Mezo Testnet, reads the MUSD balance, shows the borrow quote when the balance is short, asks the wallet to sign the checked transaction, and confirms the receipt with the verifier.

## Setup

Node 22 or later and pnpm.

```sh
pnpm install
pnpm test            # unit and adversarial tests, no network
LIVE=1 pnpm test     # also reads both MUSD contracts over RPC
pnpm typecheck
pnpm evidence        # read-only checks against the real contracts, writes docs/evidence.json
pnpm dev             # local Worker with the demo page
pnpm deploy          # Cloudflare Workers
```

To mint testnet MUSD and pay a link from a testnet key (the key file stays outside the repo and is never printed)

```sh
MEZO_KEY_FILE=/path/to/key pnpm testnet-borrow --dry-run   # simulate only
MEZO_KEY_FILE=/path/to/key pnpm testnet-borrow             # needs about 0.04 test BTC
MEZO_KEY_FILE=/path/to/key pnpm testnet-pay "ethereum..." 5
```

## Test output

Run on 26 October 2026 with `LIVE=1 pnpm test`.

```text
 ✓ test/address.test.ts   20 tests
 ✓ test/amount.test.ts    52 tests
 ✓ test/borrow.test.ts    13 tests (2 live)
 ✓ test/guard.test.ts     93 tests
 ✓ test/invoices.test.ts  13 tests
 ✓ test/merchant.test.ts  15 tests
 ✓ test/rpc.test.ts       40 tests (5 live)
 ✓ test/worker.test.ts    16 tests
 Test Files  8 passed (8)
      Tests  262 passed (262)
```

Without network, `pnpm test` gives 255 passed and 7 skipped. One live test verifies the project's own payment on chain.

The guard suite covers wrong chains, lookalike tokens, uint256 overflow and wraparound, bad checksums, eleven unicode tricks, percent-encoding, extra and duplicated parameters, dangerous functions, and 2,000 random inputs that must never throw. The merchant suite creates 300 links with pseudo-random amounts and checks that each one passes the guard with the same amount. The verifier suite uses fake RPCs that answer null, fail, or lag on the first endpoint, and checks that a payment without the reference or from before the invoice block is refused. The inbox suite checks chunked log queries (at most 5,000 blocks a range, at most 20,000 blocks back), batching (60 payments in at most 3 requests), the oldest-payment rule, possible matches, lagging nodes, reference decoding, sums inside one transaction and the amount rule. The borrow suite checks the minimum debt, the fee, rounding up of the BTC, the liquidation price, and the MCR and recovery mode floors. The invoice suite checks unique references, the block stamp, the oldest-payment rule, one transaction for one invoice and possible matches. The worker suite checks CORS, both limiters and the HTTP codes. `pnpm typecheck` passes and `pnpm audit --prod` reports no known vulnerabilities.

## Project layout

| Path | Contents |
|---|---|
| `src/chains.ts` | Mezo chain ids, MUSD and MUSD protocol addresses, RPC endpoints and explorer URLs, with sources |
| `src/eip681.ts` | Strict EIP-681 parser |
| `src/guard.ts` | Payer policy checks and transfer builder |
| `src/merchant.ts` | Link creation with a round trip through the guard |
| `src/rpc.ts` | Live contract reads with retries and a fallback endpoint, payment verification and the merchant inbox |
| `src/borrow.ts` | Live MUSD protocol terms and the borrow quote |
| `src/invoices.ts` | Invoices in Cloudflare KV, matched to payments on chain |
| `src/worker.ts` | Cloudflare Worker API |
| `web/` | Demo page |
| `scripts/` | Evidence, testnet borrow and testnet payment scripts |

## License

MIT. See [LICENSE](LICENSE).
