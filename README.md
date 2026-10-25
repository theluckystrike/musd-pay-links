# MUSD Pay Links

Payment links and QR codes for MUSD on Mezo, with a payer-side guard that checks the link before any transfer is built. Built by [Michael Lip](https://github.com/theluckystrike) (Warsaw, Poland) for the Mezo Buildathon on AKINDO, Access and Distribution track.

Live demo at https://musd-pay-links.lipmichal.workers.dev

Pitch deck, 10 slides, in [docs/pitch-deck.pdf](docs/pitch-deck.pdf). The slides are also in [docs/deck](docs/deck) as PNG files.

<img src="docs/demo-desktop.png" alt="MUSD Pay Links demo page" width="100%">

At phone width (390 px) the page has no horizontal scroll, see [docs/demo-mobile.png](docs/demo-mobile.png).

## What changed on 25 October 2026

- Borrow quote from the live MUSD protocol. A payer who is short of MUSD sees the BTC to lock, the fee, the protocol minimum and the liquidation price, read from four MUSD protocol contracts.
- Merchant inbox. The page watches the MUSD contract for a payment that carries the invoice reference. The payer does not need to send a hash.
- Replay protection. Every invoice is stamped with its creation block, and an older payment is refused.
- Pay page and Telegram share. A merchant sends one URL in a chat. It opens a payer view with the guard already run.
- Reliability. Testnet now has a second RPC endpoint, mainnet moved off an endpoint that refused `eth_call`, and reads retry up to 6 times.
- Chain routes send no CORS header and are rate limited per client.
- A scripted path from test BTC to a paid invoice (`testnet-borrow` and `testnet-pay`).
- Tests went from 204 to 236.

## What it does

A merchant who wants MUSD needs a way to ask for it that wallets and agents can read. EIP-681 already defines a link format for an ERC-20 transfer, and a QR code of the link works at a counter or on an invoice. The weak point is the payer side. A link is just text, and one changed character can send the money to another address, ask for a fake token, or move the payment to another chain.

MUSD Pay Links has five parts.

1. The merchant side creates a standard EIP-681 link and a QR code for MUSD on Mezo, with the amount, the recipient and an optional reference such as an invoice number.
2. The payer side is a TypeScript library (and the same code in the demo page) that parses the link and refuses it unless three checks pass. The token must be the real MUSD contract for that chain id. The recipient must be a valid address with a correct EIP-55 checksum, and on the payer's allowlist when one is set. The amount must be within the payer's limit, compared with exact integer math at 18 decimals. Every refusal comes with a code and a plain reason.
3. The merchant can then confirm the payment on chain. The verifier reads the receipt and counts only Transfer events emitted by the real MUSD contract to the merchant's address. When the link carried a reference, the verifier also requires the payment input to end with the same reference. A payment that does not carry it is refused, so one old payment cannot mark several invoices paid.

4. A payer who is short of MUSD sees how much BTC would mint it. The borrow quote reads the live rules of the MUSD protocol on Mezo (the BTC price from PriceFeed, MCR, CCR, the minimum debt, the gas compensation and the fee from BorrowerOperations, the interest rate from InterestRateManager, the system ratio and recovery mode from TroveManager). It gives the BTC to lock, the debt, the liquidation price and a hand-off to the Mezo app. The payer keeps the Bitcoin and spends MUSD.
5. The merchant can watch for the payment without a hash from the payer. The inbox reads MUSD Transfer logs to the merchant address since the block in which the invoice was created, decodes the reference from each payment, and marks the invoice paid when a payment carries its reference and covers the amount.

The library never holds a key and never signs. It returns an unsigned transaction (`to` is the MUSD contract, `value` is 0, `data` is `transfer(recipient, amount)`) for the wallet or agent to sign.

## MUSD contracts

Both addresses come from the official Mezo docs, page "MUSD Payments With x402" (https://mezo.org/docs/developers/getting-started/musd-payments-x402/). Both are verified source on the Mezo Blockscout explorers as contract `MUSD`, token name "Mezo USD", symbol MUSD, 18 decimals. The demo reads `name()`, `symbol()`, `decimals()` and `totalSupply()` from them live.

| Network | Chain id | MUSD contract | RPC used |
|---|---|---|---|
| Mezo Testnet | 31611 | [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/token/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) | `https://rpc.test.mezo.org` |
| Mezo Mainnet | 31612 | [`0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186`](https://explorer.mezo.org/token/0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186) | `https://mezo-mainnet.boar.network` |

Chain ids and RPC endpoints are from https://mezo.org/docs/developers/getting-started/configure-environment/ and were confirmed with `eth_chainId`. Each chain has a second endpoint. On mainnet it is https://mainnet.mezo.public.validationcloud.io from the same docs table. On testnet the docs list one endpoint, so the second one is the public dRPC node https://mezo-testnet.drpc.org, which answers chain id 31611. A read retries up to 6 times, waits 300 ms times the attempt number, and alternates between the two endpoints, so a node that lags and answers null for a mined transaction is skipped. On 25 October 2026 the dRPC mainnet node refused `eth_call`, so mainnet now starts at Boar, the endpoint the Mezo docs use in their own examples.

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
| `/api/head?chain=31611` | Current block, to stamp an invoice |
| `/api/token?chain=all` | Read the MUSD contracts live |
| `/api/balance?chain=31611&address=0x...` | Read a MUSD balance |

The routes that only compute (`/api/health`, `/api/link`, `/api/check`) can be called from any web page. The routes that read the chain send no CORS header, so other web pages cannot use the Worker as an RPC proxy, and they are limited to 30 calls a minute per client IP with the Cloudflare rate limiting binding. A server-side agent can call every route.

## Threat model

The attacker controls the link text. They may also control the page or message that carries it, and they may know the payer's habits. They do not control the payer's wallet or the Mezo chain. The guard has to stop a link from paying more, paying someone else, paying in a fake token, or paying on another chain than the payer expects.

| Attack | What the guard does | Code |
|---|---|---|
| Fake token with the same symbol | Token address must equal the MUSD contract for the link's chain id | `not_musd` |
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
| Replay of an older payment with no reference | The merchant stamps the invoice with its creation block. A payment mined earlier is refused, and the inbox does not search before it | `mismatch` |

Out of scope. The guard does not judge whether the merchant is honest, and it does not replace the wallet's own confirmation screen. It does not check sanctions lists. A payer who sets a high limit and no allowlist can still pay a real but unwanted address. The verifier trusts the RPC node it reads from (the Worker uses the public Mezo RPC endpoints listed above).

## Testnet payment status

No payment of our own has been made yet, and none is shown as if it were. Testnet MUSD is minted by opening a trove against testnet BTC, and the testnet BTC faucet at https://faucet.test.mezo.org shows a Cloudflare "Verify you are human" check. An agent does not pass that check, so one click by a person is needed.

Everything after that click is scripted. `scripts/testnet-borrow.ts` reads the live borrow terms, simulates `openTrove` with `eth_call` and then sends it, and `scripts/testnet-pay.ts` pays a link through the guard and verifies it. The `openTrove` call path was checked on 25 October 2026 with a dry run (`pnpm testnet-borrow --dry-run`), which simulates the call with a state override that gives the address 1 test BTC. The simulation of `openTrove(1800 MUSD)` with 0.0499 BTC returned without a revert. Nothing was sent.

The verify panel is prefilled with a public 6 MUSD wallet to wallet `transfer` on Mezo Testnet that someone else made on 25 October 2026 ([`0xc19b443d...e239a`](https://explorer.test.mezo.org/tx/0xc19b443ddcb35fdbe4389382dfff3815a82a0f2e12f43b00537d73db89be239a)). It carries no reference.

What is verified against the real contracts, with no key.

| Check | Result |
|---|---|
| `name()`, `symbol()`, `decimals()` on testnet and mainnet MUSD | "Mezo USD", "MUSD", 18 on both |
| `eth_call` dry run of the guard's transfer data from a public testnet MUSD holder, with and without memo | returns `true` |
| Borrow terms read from BorrowerOperations, TroveManager, PriceFeed and InterestRateManager on both chains | sane values, see above |
| `openTrove` simulation for the smallest trove | no revert |
| `verifyPayment` on the public transfer above | `paid`, 6 MUSD |
| `findPayments` on an active testnet address | lists its MUSD payments with references decoded |

The raw output of the first checks is in [docs/evidence.json](docs/evidence.json). Run `pnpm evidence` to read it again.

The demo page has a payment path that has not been used with a real wallet yet. A payer opens the page with a wallet that holds testnet MUSD, checks a link and presses "Pay with browser wallet". The page switches the wallet to Mezo Testnet, reads the MUSD balance, shows the borrow quote when the balance is short, asks the wallet to sign the checked transaction, and confirms the receipt with the verifier.

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

Run on 25 October 2026 with `LIVE=1 pnpm test`.

```text
 ✓ test/address.test.ts   20 tests
 ✓ test/amount.test.ts    52 tests
 ✓ test/borrow.test.ts    13 tests (2 live)
 ✓ test/guard.test.ts     93 tests
 ✓ test/merchant.test.ts  15 tests
 ✓ test/rpc.test.ts       30 tests (4 live)
 ✓ test/worker.test.ts    13 tests
 Test Files  7 passed (7)
      Tests  236 passed (236)
```

Without network, `pnpm test` gives 230 passed and 6 skipped.

The guard suite covers wrong chains, lookalike tokens, uint256 overflow and wraparound, bad checksums, eleven unicode tricks, percent-encoding, extra and duplicated parameters, dangerous functions, and 2,000 random inputs that must never throw. The merchant suite creates 300 links with pseudo-random amounts and checks that each one passes the guard with the same amount. The verifier suite uses fake RPCs that answer null, fail, or lag on the first endpoint, and checks that a payment without the reference or from before the invoice block is refused. The inbox suite checks chunked log queries (at most 5,000 blocks a call, at most 20,000 blocks back), reference decoding, sums inside one transaction and the amount rule. The borrow suite checks the minimum debt, the fee, rounding up of the BTC, the liquidation price, and the MCR and recovery mode floors. The worker suite checks CORS and the rate limit. `pnpm typecheck` passes and `pnpm audit --prod` reports no known vulnerabilities.

## Project layout

| Path | Contents |
|---|---|
| `src/chains.ts` | Mezo chain ids, MUSD and MUSD protocol addresses, RPC endpoints and explorer URLs, with sources |
| `src/eip681.ts` | Strict EIP-681 parser |
| `src/guard.ts` | Payer policy checks and transfer builder |
| `src/merchant.ts` | Link creation with a round trip through the guard |
| `src/rpc.ts` | Live contract reads with retries and a fallback endpoint, payment verification and the merchant inbox |
| `src/borrow.ts` | Live MUSD protocol terms and the borrow quote |
| `src/worker.ts` | Cloudflare Worker API |
| `web/` | Demo page |
| `scripts/` | Evidence, testnet borrow and testnet payment scripts |

## License

MIT. See [LICENSE](LICENSE).
