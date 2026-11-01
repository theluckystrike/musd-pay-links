# 1 November testnet browser evidence

Real MetaMask 13.55.0 signed invoice `INV-6MG8SUDA`, rejected one payment, then approved one 1 MUSD payment. The actual page reached Paid and kept Pay disabled after reload. Both accounts belong to the project. These are testnet tokens, not revenue or outside adoption.

| Record | Result |
| --- | --- |
| Native wallet run | [41302937067](https://github.com/theluckystrike/musd-pay-links/actions/runs/41302937067), harness source `5987b40b82eb0451e9d573c0295e933cdd9d01e7` |
| Wallet actions | One invoice signature, one explicit transaction rejection, one transaction approval |
| Payment | [0x11028978…df1fad](https://explorer.test.mezo.org/tx/0x11028978ae896a11ad946047bebd829882f729580d1d452cabf4c50b97df1fad) |
| Network | Mezo Testnet, chain 31611 |
| Amount and reference | 1 MUSD, `INV-6MG8SUDA` |
| Receipt | Success, nonce 0, block 16,505,037, 51,877 gas, at least five confirmations at the harness check |
| Exact transaction | Official MUSD contract, project payer and merchant, zero native value, exact transfer calldata and reference bytes; canonical block and Transfer event checked |
| Browser guards | Rejection left the nonce unchanged. Missing-Web-Locks simulation produced no wallet action or nonce change. Paid status and reload lock passed. |
| Dated code verification | [41302244470](https://github.com/theluckystrike/musd-pay-links/actions/runs/41302244470), clean `e50735e`: 474 passed and seven skipped offline; 481 passed with LIVE enabled; typecheck, build and Worker runtime smoke passed |

The structured [browser summary](browser-payment.json) includes source identity, the original evidence hash and image hashes. The [dated runner summaries](dated-test-receipts.json) retain exact commands, counts and report hashes. They are dated records, not an assertion that every later revision has those results.

## Captures

- [Wallet-signed invoice in the merchant UI](signed-invoice.png)
- [Actual MetaMask confirmation](wallet-review.png)
- [Confirmed paid invoice](paid-invoice.png)

The retained wallet confirmation heading says **Unknown**. That image does not visually establish the token amount; the exact contract, calldata, reference and 1 MUSD Transfer were checked on chain. The native paid and reloaded-paid captures have identical pixels; the reload also has a real DOM assertion and stored-invoice check.

## Scope

The wallet run used a local Worker on a hosted Linux runner. The separate [public branch Preview](https://sprint-20261101-musd-pay-links.lipmichal.workers.dev) serves application code `e50735e` with isolated data. No wallet payment through that HTTPS Preview, other wallet product or mobile wallet is claimed by this record. No production traffic rollout was made.

No new in-product loan or independent merchant test is established. The older script loan remains historical. A proposed paid hosted service, pilot target or programme ceiling is not an agreement, award or payment. The 26 October deck, video and chain records keep their original date.
