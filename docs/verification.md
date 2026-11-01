# Verification and evidence

Use the source commit and native runner reports to assess a result. A count copied into a deck or submission is not an execution record. The live demo, the current branch, the historical deck and a hosted workflow may use different revisions.

## Current sprint status

The retained 1 November results identify separate source revisions:

- Clean code revision `e50735e5ea034a96a912545756005bc4af87205b` passed 474 offline tests with seven skipped, then all 481 with LIVE enabled. Typecheck, browser build and actual Worker runtime smoke passed in [run 41302244470](https://github.com/theluckystrike/musd-pay-links/actions/runs/41302244470). Earlier live availability failures, timeouts and HTTP 429 results remain part of the history; a later pass does not erase them.
- Actual MetaMask run [41302937067](https://github.com/theluckystrike/musd-pay-links/actions/runs/41302937067) at harness revision `5987b40b82eb0451e9d573c0295e933cdd9d01e7` passed all 84 harness assertions. It signed invoice `INV-6MG8SUDA`, rejected one payment without a nonce change, then approved one exact 1 MUSD transfer. The receipt at block 16,505,037 had five confirmations when checked. The product showed Paid, retained the lock after reload and stored that exact hash. The [public evidence packet](sprint-2026-11-01/README.md) includes the receipt and captures.
- The [isolated HTTPS Preview](https://sprint-20261101-musd-pay-links.lipmichal.workers.dev) serves application source `e50735e`, deployment `450ab5cb-6f94-4b2d-8aa1-7204b716ffa2`. Source HTML/client hashes and API reads passed after deployment. Invoice KV and Durable Object state are separate from production. No production traffic rollout was made. The successful wallet test used the local Worker, so it is not a claim of a wallet payment through this public Preview.

The transaction used project-owned test wallets on chain 31611. It establishes no outside user, customer, grant award or revenue. The existing-loan browser view verifies an older script loan at its receipt block. A newly opened loan through the current interface remains unproved because the new test wallet lacks enough native collateral. Other wallet products and mobile wallets remain untested.

## Run the checks

Use Node 22 or later and the pnpm version pinned in `package.json`. Start from a committed source tree and install the frozen lockfile.

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run --reporter=default --reporter=json --outputFile=.reports/offline.json
node scripts/record-test-evidence.mjs offline .reports/offline.json
pnpm typecheck
pnpm build
pnpm test:runtime
LIVE=1 pnpm exec vitest run --reporter=default --reporter=json --outputFile=.reports/live.json
LIVE=1 node scripts/record-test-evidence.mjs live .reports/live.json
```

The offline run skips cases that require public RPC. The live run enables them. Preserve collected, passed, failed, skipped and todo counts separately. A failed endpoint read is a failed live check, even when offline tests pass.

`record-test-evidence.mjs` saves the native report hash, counts, source commit, clean-tree status, runtime versions and workflow URL when available. It refuses a dirty source tree. If the actual command differs, pass its words after the report path so the summary records it, for example `pnpm exec vitest run --maxWorkers=2 ...`. Record the actual process exit status as well. A report summary cannot retroactively prove which command created an arbitrary file.

The Verification workflow uploads `.reports/` for its exact source revision. Its runtime smoke test boots the configured local Worker, loads the actual HTML and browser asset, and checks real HTTP guard routes. This catches runtime entrypoint failures that unit tests can miss. It neither deploys the app nor requests a wallet transaction.

## Browser-wallet proof

The payment connection requests ordinary `wallet_requestPermissions` account consent after network selection. This can add one Connect prompt per payment connection. MetaMask can expose an account globally without granting it signing access on a newly added chain. The app validates the permission reply and rechecks the original payer and selected chain. Only explicit unsupported-method errors 4200 or -32601 use the legacy path with the same readback. These checks do not prove scoped authorization in every provider. A send-time 4100 error remains unknown; it does not unlock or repeat a send.

The separate Browser wallet evidence workflow runs actual MetaMask in Chromium on a hosted Linux runner. It pins the official extension package digest and records its packaged identity. It uses a dedicated project test wallet and the local Worker. Never configure a production wallet for this harness.

This workflow is manual-only and serializes wallet runs across refs. The temporary CI seed used for the dated sprint test is removed during closeout. A future deliberate run needs a new task-only wallet secret and matching address variables. Inspect the previous journal and reconcile any uncertain send before starting another run.

A successful wallet run requires the public `browser-evidence.json`, not just a green download or build step. It must identify the source commit, actual wallet and chain, signed invoice, rejected payment request, approved payment hash, exact reference-bearing MUSD transfer, required confirmations and paid invoice state after reload. The payer and merchant remain project test addresses. This proves neither outside use nor revenue.

The missing-Web-Locks check hides that one API in an extra real browser page while retaining the actual MetaMask provider. It is a feature-absence simulation, not a claim that Chromium natively lacks Web Locks. Its evidence must show the app refused payment, no wallet prompt or action occurred, and pending nonce and saved payment state stayed unchanged.

Wallet profiles, seed phrases, passwords and secret-bearing traces are not public evidence. A failed or uncertain run must retain its stage and public result. After any possible broadcast, reconcile the chain and saved attempt before another run; a retry must not create a second payment.

## Borrowing proof

The browser offers two separate actions: prepare a review, then request one testnet loan. A simulation proves only that the call passed against the observed state. A mocked provider proves request guards. Neither proves that a wallet approved the request or that a loan was mined.

To inspect an existing loan without a wallet or key:

```sh
pnpm verify-borrow <testnet-transaction-hash> <borrower-address>
```

This command creates no loan. It checks the testnet transaction identity, exact `openTrove` call, canonical receipt and block metadata, MUSD mint to the borrower, and at least five confirmations. It reads the actual collateral, debt, trove status and MUSD balance at the end of the receipt block. Other transactions in that block may already have changed the position or wallet balance. Public RPC consistency is not independent consensus proof.

A new in-product borrowing claim needs the source revision, reviewed request, actual wallet action, transaction hash, verified mint and position result. Verifying an older script transaction does not supply that missing UI evidence. Rejected requests, uncertain broadcasts and unavailable RPC evidence must remain distinct from confirmed success.

## Historical baseline

The 26 October materials reported 337 passing tests: 330 offline and seven live RPC cases. The earlier 18 October materials reported 197. A 19 October revision had a stale 197 in the submission while the README said 204. Date and commit matter when comparing those counts.

`docs/evidence.json` contains historical contract reads, simulations and project testnet transactions. It has no native Vitest runner report, command exit status or test totals. The pitch deck and screenshots also predate the sprint. Preserve them as historical artifacts; do not relabel them as current browser proof.

The historical loan at [`0x1de64d3a…26f2`](https://explorer.test.mezo.org/tx/0x1de64d3a9fe0588d2707718ed3c247d793f5d5f818efd502ae80ee8dc70a26f2) minted 1,800 MUSD against 0.049 test BTC. Its 2,001.8 MUSD debt comprised that mint, a 1.8 MUSD fee and a 200 MUSD GasPool reserve. It was a project script loan, not a newly opened loan through the current page.
