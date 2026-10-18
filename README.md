# MUSD Pay Links

Payment links and QR codes for MUSD on Mezo, with a payer-side guard that checks the link before any transfer is built. Built by [Michael Lip](https://github.com/theluckystrike) (Warsaw, Poland) for the Mezo Buildathon on AKINDO, Access and Distribution track.

Live demo at https://musd-pay-links.lipmichal.workers.dev

Pitch deck, 10 slides, in [docs/pitch-deck.pdf](docs/pitch-deck.pdf). The slides are also in [docs/deck](docs/deck) as PNG files.

<img src="docs/demo-desktop.png" alt="MUSD Pay Links demo page" width="100%">

## What it does

A merchant who wants MUSD needs a way to ask for it that any wallet understands. EIP-681 already defines that link format, and a QR code of the link works at a counter or on an invoice. The weak point is the payer side. A link is just text, and one changed character can send the money to another address, ask for a fake token, or move the payment to another chain.

MUSD Pay Links has three parts.

1. The merchant side creates a standard EIP-681 link and a QR code for MUSD on Mezo, with the amount, the recipient and an optional reference such as an invoice number.
2. The payer side is a TypeScript library (and the same code in the demo page) that parses the link and refuses it unless three checks pass. The token must be the real MUSD contract for that chain id. The recipient must be a valid address with a correct EIP-55 checksum, and on the payer's allowlist when one is set. The amount must be within the payer's limit, compared with exact integer math at 18 decimals. Every refusal comes with a code and a plain reason.
3. The merchant can then confirm the payment on chain. The verifier reads the receipt and counts only Transfer events emitted by the real MUSD contract to the merchant's address.

The library never holds a key and never signs. It returns an unsigned transaction (`to` is the MUSD contract, `value` is 0, `data` is `transfer(recipient, amount)`) for the wallet or agent to sign.

## MUSD contracts

Both addresses come from the official Mezo docs, page "MUSD Payments With x402" (https://mezo.org/docs/developers/getting-started/musd-payments-x402/). Both are verified source on the Mezo Blockscout explorers as contract `MUSD`, token name "Mezo USD", symbol MUSD, 18 decimals. The demo reads `name()`, `symbol()`, `decimals()` and `totalSupply()` from them live.

| Network | Chain id | MUSD contract | RPC used |
|---|---|---|---|
| Mezo Testnet | 31611 | [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/token/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) | `https://rpc.test.mezo.org` |
| Mezo Mainnet | 31612 | [`0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186`](https://explorer.mezo.org/token/0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186) | `https://mezo.drpc.org` |

Chain ids and RPC endpoints are from https://mezo.org/docs/developers/getting-started/ and were confirmed with `eth_chainId`.

## Link format

The merchant link is plain EIP-681 for an ERC-20 transfer, with one optional extra parameter for the reference.

`ethereum:0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503@31611/transfer?address=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed&uint256=12500000000000000000&memo=INV-1042`

The `uint256` value is in base units (12.5 MUSD here). The `memo` is up to 32 characters from a small ASCII set. When it is present, the guard appends its bytes after the ABI arguments of the `transfer` call. The MUSD contract ignores the extra bytes (an `eth_call` dry run on testnet returns `true` with and without them), and the merchant's verifier can match the reference in the transaction input.

## Use the library

```ts
import { checkPaymentLink, createPaymentLink, verifyPayment, MEZO_TESTNET } from "./src/index.ts";

// Merchant
const chainId = 31611, recipient = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", amount = "12.50", memo = "INV-1042";
const created = createPaymentLink({ chainId, recipient, amount, memo });

// Payer, with a spending limit and an optional allowlist
const maxAmount = "50", allowlist = [recipient];
const result = checkPaymentLink(created.link, { maxAmount, allowlist });
if (!result.ok) console.log(result.reasons); // list of { code, message }
else wallet.sendTransaction(result.tx);     // { chainId, to, value, data }, value is always 0n

// Merchant, after payment, with the amount in base units
if (result.ok) {
  const { amount } = result.payment;
  await verifyPayment(MEZO_TESTNET, { txHash, recipient, amount, memo });
}
```

The same functions are exposed as a read-only JSON API by the Worker, so an agent can call them over HTTP.

| Endpoint | Purpose |
|---|---|
| `/api/link?chain=31611&to=0x...&amount=12.5&memo=INV-1` | Create a link and its QR code (`&format=svg` returns only the SVG) |
| `/api/check?link=...&max=50&allow=0x...,0x...` | Run the payer guard. Returns 200 with the transaction or 422 with reasons |
| `/api/verify?chain=31611&tx=0x...&to=0x...&amount=12.5&memo=INV-1` | Confirm a payment on chain |
| `/api/token?chain=all` | Read the MUSD contracts live |
| `/api/balance?chain=31611&address=0x...` | Read a MUSD balance |

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

Out of scope. The guard does not judge whether the merchant is honest, and it does not replace the wallet's own confirmation screen. It does not check sanctions lists. A payer who sets a high limit and no allowlist can still pay a real but unwanted address. The verifier trusts the RPC node it reads from (the Worker uses the public Mezo RPC endpoints listed above).

## Testnet transfer status

No real testnet transfer was made for this submission, and none is shown as if it were. Testnet MUSD is minted by opening a borrow position against testnet BTC (the Mezo docs give a minimum debt of 2,000 MUSD), and the testnet BTC faucet at https://faucet.test.mezo.org is protected by a Cloudflare Turnstile CAPTCHA. An agent cannot get past that on its own.

What is verified instead, against the real contracts and with no key.

| Check | Result |
|---|---|
| `name()`, `symbol()`, `decimals()` on testnet and mainnet MUSD | "Mezo USD", "MUSD", 18 on both |
| `eth_call` dry run of the guard's transfer data from a public testnet MUSD holder, without memo | returns `true` |
| The same dry run with the memo bytes appended | returns `true` |
| `verifyPayment` on a public testnet MUSD transfer made by someone else on 17 October 2026 ([`0xfc56e25b...d805`](https://explorer.test.mezo.org/tx/0xfc56e25bdddcba0e1d2b43e7c92958d3fa9021d6e814e2dae430a83f7418d805)) | `paid`, 245.20190755 MUSD |
| The same transaction checked against 1 base unit more | `mismatch` |
| The same transaction checked against another recipient | `mismatch` |

The raw output is in [docs/evidence.json](docs/evidence.json). Run `pnpm evidence` to read it again.

The demo page can make a real payment. Open it in a browser with a wallet that holds testnet MUSD, check a link, and press "Pay with browser wallet". The page switches the wallet to Mezo Testnet, reads the MUSD balance, asks the wallet to sign the checked transaction, and then confirms the receipt with the verifier. For a command line run there is `scripts/testnet-pay.ts`, which reads a key from a file outside the repo.

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

To pay a link from a funded testnet key (the key file stays outside the repo and is never printed)

```sh
MEZO_KEY_FILE=/path/to/key pnpm testnet-pay "ethereum..." 5
```

## Test output

Run on 18 October 2026 with `LIVE=1 pnpm test`.

```text
 ✓ test/amount.test.ts (52 tests) 10ms
 ✓ test/address.test.ts (20 tests) 16ms
 ✓ test/guard.test.ts (91 tests) 33ms
 ✓ test/merchant.test.ts (13 tests) 29ms
 ✓ test/worker.test.ts (8 tests) 37ms
 ✓ test/rpc.test.ts (13 tests) 1614ms
   ✓ live Mezo RPC (LIVE=1) (2)
     ✓ testnet MUSD reports Mezo USD, MUSD, 18 decimals 1049ms
     ✓ mainnet MUSD reports Mezo USD, MUSD, 18 decimals 542ms
 Test Files  6 passed (6)
      Tests  197 passed (197)
```

The guard suite covers wrong chains, lookalike tokens, uint256 overflow and wraparound, bad checksums, eleven unicode tricks, percent-encoding, extra and duplicated parameters, dangerous functions, and 2,000 random inputs that must never throw. The merchant suite creates 300 links with pseudo-random amounts and checks that each one passes the guard with the same amount. `pnpm typecheck` passes and `pnpm audit --prod` reports no known vulnerabilities.

## Project layout

| Path | Contents |
|---|---|
| `src/chains.ts` | Mezo chain ids, MUSD addresses, RPC and explorer URLs, with sources |
| `src/eip681.ts` | Strict EIP-681 parser |
| `src/guard.ts` | Payer policy checks and transfer builder |
| `src/merchant.ts` | Link creation with a round trip through the guard |
| `src/rpc.ts` | Live contract reads, dry runs and payment verification |
| `src/worker.ts` | Cloudflare Worker API |
| `web/` | Demo page |
| `scripts/` | Evidence and testnet payment scripts |

## License

MIT. See [LICENSE](LICENSE).
