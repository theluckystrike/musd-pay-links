// Explicit two-step review for one testnet loan. Mainnet borrowing stays in the external Mezo app.
import { formatAmount, parseAmount } from "../src/amount.ts";
import { quoteBorrow, readBorrowTerms, pct } from "../src/borrow.ts";
import { OPEN_TROVE_EXECUTION_NOTICE, prepareOpenTrove, type PreparedOpenTrove, type OpenTroveTransaction } from "../src/borrow-action.ts";
import { requestReviewedOpenTrove } from "../src/borrow-wallet.ts";
import { verifyOpenTrove } from "../src/borrow-receipt.ts";
import { CONFIRMATIONS_REQUIRED, MEZO_TESTNET } from "../src/chains.ts";
import { connectPaymentWallet, type Eip1193, type WalletSession } from "../src/wallet.ts";
import { clearFailedWalletAttempt, clearRejectedAttempt, markWalletAttemptUnknown, readWalletAttempt, recordWalletHash, writeWalletAttempt } from "../src/wallet-state.ts";

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const box = (id: string) => document.getElementById(id) as HTMLElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const memo = (account: string) => `open-trove:${account.toLowerCase()}`;
const form = () => ["b-chain", "b-need", "b-ratio", "b-collateral"].map((id) => field(id).value.trim()).join("|");
let busy = false;
let wallet: WalletSession | null = null;
let reviewed: PreparedOpenTrove | null = null;
let reviewedForm: string | null = null;
let knownHash: `0x${string}` | null = null;
let knownAccount: `0x${string}` | null = null;
let knownExpected: OpenTroveTransaction | undefined;

function message(text: string): void { box("b-wallet-status").textContent = text; }
function resetReview(): void {
  reviewed = null; reviewedForm = null;
  wallet?.close(); wallet = null;
  button("b-open").disabled = true;
  box("b-loan-review").replaceChildren();
}
function requireTestnet(): void {
  if (field("b-chain").value !== String(MEZO_TESTNET.id)) throw new Error("In-product borrowing is available only on Mezo Testnet. Use the Mezo app for mainnet.");
  if (!navigator.locks?.request) throw new Error("This browser cannot coordinate loan requests across tabs. Use a browser with Web Locks before opening a loan here.");
}
function renderReview(prepared: PreparedOpenTrove): void {
  const q = prepared.quote;
  const position = prepared.position;
  box("b-loan-review").innerHTML = `<div class="verdict ok loan-review">
    <strong>Review this Mezo Testnet loan.</strong>
    <dl class="kv">
      <dt>Borrower</dt><dd>${esc(prepared.account)}</dd>
      <dt>Test BTC to lock</dt><dd>${formatAmount(position.actualCollateral)} BTC</dd>
      <dt>MUSD sent to your wallet</dt><dd>${formatAmount(q.borrow)} MUSD</dd>
      <dt>Total debt</dt><dd>${formatAmount(q.totalDebt)} MUSD</dd>
      <dt>One-time fee</dt><dd>${formatAmount(q.fee)} MUSD</dd>
      <dt>Protocol gas reserve</dt><dd>${formatAmount(q.gasCompensation)} MUSD, held in GasPool. This is not spendable money or a refund to you.</dd>
      <dt>Collateral ratio now</dt><dd>${pct(position.actualRatio)}</dd>
      <dt>Liquidation price</dt><dd>${formatAmount(position.liquidationPrice)} USD per BTC</dd>
      <dt>Fixed yearly interest</dt><dd>${prepared.terms.interestRateBps / 100}%</dd>
      <dt>Maximum gas at this review</dt><dd>${formatAmount(prepared.maxGasCost)} test BTC</dd>
      <dt>Reviewed block</dt><dd>${prepared.snapshot.block}</dd>
    </dl>
    <p class="note">The protocol minimum can make this loan much larger than the invoice. Review the full debt. Closing the page does not close a loan.</p>
    <p class="muted">${esc(OPEN_TROVE_EXECUTION_NOTICE)}</p>
    <p class="muted">This review expires at ${esc(new Date(prepared.expiresAt).toLocaleTimeString())}. Freshness is checked before requesting the wallet; terms can still change before mining. A changed price, fee, account or transaction requires another review.</p>
  </div>`;
}
async function reviewLoan(): Promise<void> {
  if (busy) return;
  busy = true; button("b-review").disabled = true; resetReview(); knownHash = null; knownExpected = undefined;
  button("b-loan-check").hidden = true;
  try {
    requireTestnet();
    const initial = form();
    const need = parseAmount(field("b-need").value.trim());
    const ratioPct = parseAmount(field("b-ratio").value.trim());
    if (need === null || need <= 0n || ratioPct === null || ratioPct <= 0n) throw new Error("Enter a positive MUSD amount and collateral ratio before reviewing a loan.");
    const provider = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    if (!provider) throw new Error("No browser wallet was found.");
    message("Connect your test wallet. This step prepares a review and sends no transaction.");
    wallet = await connectPaymentWallet(provider, MEZO_TESTNET);
    knownAccount = wallet.account;
    const previous = readWalletAttempt(localStorage, MEZO_TESTNET.id, memo(wallet.account));
    if (previous) {
      if (previous.status === "sent") { knownHash = previous.hash; button("b-loan-check").hidden = false; }
      throw new Error("This browser retains an earlier loan request for this account. Check its result and wallet activity before any retry.");
    }
    if (form() !== initial) throw new Error("The loan inputs changed while connecting. Review them again.");
    let collateral = parseAmount(field("b-collateral").value.trim());
    if (field("b-collateral").value.trim() === "") {
      const terms = await readBorrowTerms(MEZO_TESTNET, undefined, { account: wallet.account });
      const quote = quoteBorrow(terms, need, ratioPct / 100n);
      if (form() !== initial) throw new Error("The loan inputs changed while reading the quote. Review them again.");
      collateral = quote.collateral;
      field("b-collateral").value = formatAmount(collateral);
    }
    if (collateral === null || collateral <= 0n) throw new Error("Enter the test BTC to lock, or leave it empty to use the quote’s required collateral.");
    const fingerprint = form();
    message("Reading the deployed contracts and simulating the exact testnet loan with your real test balance.");
    const prepared = await prepareOpenTrove(MEZO_TESTNET, { account: wallet.account, need, collateral, ratio: ratioPct / 100n });
    await wallet.assertReady();
    if (form() !== fingerprint) throw new Error("The loan inputs changed during preparation. Review them again.");
    reviewed = prepared; reviewedForm = fingerprint;
    renderReview(prepared);
    button("b-open").disabled = false;
    message("Simulation passed. Review the full debt above. Open testnet loan is a separate wallet transaction.");
  } catch (error) {
    resetReview();
    message(error instanceof Error ? error.message : "The loan could not be prepared. No transaction was requested.");
  } finally {
    busy = false; button("b-review").disabled = false;
  }
}
async function openLoan(): Promise<void> {
  if (busy || !reviewed || !wallet || form() !== reviewedForm) return;
  busy = true; button("b-open").disabled = true; button("b-review").disabled = true;
  const prepared = reviewed;
  const connected = wallet;
  const provider = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  let requestId: string | null = null;
  let requested = false;
  try {
    requireTestnet();
    if (!provider) throw new Error("The browser wallet is unavailable.");
    const lockKey = `musd-loan:${MEZO_TESTNET.id}:${prepared.account.toLowerCase()}`;
    await navigator.locks.request(lockKey, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("Another tab is preparing a loan for this account. Check that tab first.");
      await connected.assertReady();
      message("Rechecking the wallet, price, debt, deployment and simulation before requesting approval.");
      const result = await requestReviewedOpenTrove(provider, prepared, () => {
        requireTestnet();
        if (reviewed !== prepared || form() !== reviewedForm) throw new Error("The loan review changed. Prepare a new review.");
        if (readWalletAttempt(localStorage, MEZO_TESTNET.id, memo(prepared.account))) throw new Error("This account has an earlier loan request. Check it before retrying.");
        requestId = crypto.randomUUID();
        writeWalletAttempt(localStorage, MEZO_TESTNET.id, memo(prepared.account), { status: "requesting", id: requestId, at: Date.now(), from: prepared.account });
        requested = true;
      });
      if (result.status === "rejected") {
        if (requestId) clearRejectedAttempt(localStorage, MEZO_TESTNET.id, memo(prepared.account), requestId);
        message(result.message + " Prepare a new review if you want to try again.");
      } else if (result.status === "unknown") {
        if (requestId) markWalletAttemptUnknown(localStorage, MEZO_TESTNET.id, memo(prepared.account), requestId);
        message(result.message + " Do not request another loan until the result is known.");
      } else {
        knownHash = result.hash; knownAccount = prepared.account; knownExpected = { ...result.prepared.transaction };
        if (requestId) recordWalletHash(localStorage, MEZO_TESTNET.id, memo(prepared.account), requestId, result.hash, Date.now());
        button("b-loan-check").hidden = false;
        message(`The wallet returned ${result.hash}. Check the loan result before any retry.`);
      }
    });
  } catch (error) {
    message((error instanceof Error ? error.message : "The loan request did not complete.")
      + (requested ? " Its result may be uncertain. Check wallet activity before any retry." : " No loan transaction was requested."));
  } finally {
    resetReview(); busy = false; button("b-review").disabled = false;
  }
}
async function checkLoan(): Promise<void> {
  if (busy || !knownHash || !knownAccount) return;
  busy = true; button("b-loan-check").disabled = true;
  try {
    message("Reading the testnet loan receipt and trove state.");
    const proof = await verifyOpenTrove(MEZO_TESTNET, { account: knownAccount, hash: knownHash, expected: knownExpected });
    if (proof.status === "confirmed" && proof.position) {
      message(`Loan confirmed at block ${proof.block}. Trove collateral: ${formatAmount(proof.position.collateral)} test BTC. Trove debt: ${formatAmount(proof.position.debt)} MUSD. Wallet MUSD at that block: ${formatAmount(proof.position.musdBalance)}. These are testnet results.`);
    } else if (proof.status === "failed" && proof.hash?.toLowerCase() === knownHash.toLowerCase()
      && proof.required >= CONFIRMATIONS_REQUIRED && proof.confirmations != null && proof.confirmations >= proof.required
      && navigator.locks?.request) {
      const cleared = await navigator.locks.request(`musd-loan:${MEZO_TESTNET.id}:${knownAccount.toLowerCase()}`, { mode: "exclusive" }, () =>
        clearFailedWalletAttempt(localStorage, MEZO_TESTNET.id, memo(knownAccount!), knownHash!));
      message(proof.message + (cleared ? " You can prepare a new loan review." : " The saved loan request was retained; check wallet activity before any retry."));
    } else message(proof.message);
  } catch (error) { message(error instanceof Error ? error.message : "The loan result is unavailable. Do not retry the loan."); }
  finally { busy = false; button("b-loan-check").disabled = false; }
}
export function initBorrowWallet(): void {
  if (!document.getElementById("b-direct")) return;
  const updateNetwork = () => {
    box("b-direct").hidden = field("b-chain").value !== String(MEZO_TESTNET.id);
    resetReview();
  };
  for (const id of ["b-need", "b-ratio", "b-collateral"]) field(id).addEventListener("input", () => {
    if (reviewed) { resetReview(); message("Loan inputs changed. Prepare a new review before opening a loan."); }
  });
  field("b-chain").addEventListener("change", updateNetwork);
  button("b-review").onclick = () => void reviewLoan();
  button("b-open").onclick = () => void openLoan();
  button("b-loan-check").onclick = () => void checkLoan();
  updateNetwork();
}
