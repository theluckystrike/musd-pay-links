// Remote CI evidence only: real MetaMask UI, real Mezo Testnet, isolated local Worker.
// No provider injection, wallet-state injection, mainnet transaction, trace, video or seed screenshot.
// MetaMask selectors: v13.55.0 test/e2e/page-objects/pages/{onboarding,accounts,confirmations}.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createPublicClient, decodeEventLog, erc20Abi, http, parseUnits, stringToHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const ORIGIN = process.env.MUSD_EVIDENCE_ORIGIN ?? 'http://127.0.0.1:8787';
const RPC = 'https://rpc.test.mezo.org';
const CHAIN_ID = 31611;
const TOKEN = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503';
const EXTENSION_VERSION = '13.55.0';
// The verified v13.55.0 Chrome ZIP uses Chrome's four-part version plus a human version_name.
const EXTENSION_CHROME_VERSION = '13.55.0.0';
const EXTENSION_PACKAGE_SHA256 = '36ce2660b08ec7c52886438d5ca5c00ce79e883bacee87c16760371cfa88878f';
const EXTENSION_MANIFEST_SHA256 = '85c380740218de335423e7327fa60f99d8125c8f8ac9109b03ba5a263492c44f';
const OUT = resolve('.reports/browser');
const DEADLINE = Date.now() + 18 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stage = 'preflight';
let context;
let wallet;
let app;
let walletReady = false;
let secretEntryStarted = false;
let extensionId;
let pumpRunning = false;
let pumpError;
let confirmMode = 'none';
let transactionRejections = 0;
let transactionApprovals = 0;
let signatureApprovals = 0;
let walletPromptActions = 0;
let pumpPromise;
let evidenceWrite = Promise.resolve();
const acted = new WeakMap();
const evidence = {
  startedAt: new Date().toISOString(),
  status: 'incomplete',
  chainId: CHAIN_ID,
  token: TOKEN,
  origin: ORIGIN,
  applicationEnvironment: 'Isolated local Wrangler with real public Mezo Testnet RPC',
  wallet: { product: 'MetaMask', expectedVersion: EXTENSION_VERSION, providerInjectedByHarness: false },
  checks: [],
  images: [],
  walletActionJournal: [],
  extensionPageErrors: [],
  limits: [
    'Both accounts and all funds are project-owned testnet test data.',
    'This is a local preview, not proof of a production deployment or outside adoption.',
    'Only a successful on-chain receipt with the invoice transfer and reference proves payment.',
  ],
};
function check(name, passed, detail = undefined) {
  evidence.checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
  assert(passed, name);
}
function setStage(name) {
  stage = name;
  console.log(`browser-evidence stage: ${name}`);
}
function errorClass(error) {
  // Error names can be application-controlled; publish only standard class names.
  return ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error';
}
async function persistEvidence() {
  evidence.wallet.confirmations = { signatureApprovals, transactionRejections, transactionApprovals, walletPromptActions, countsAreActionAttempts: true };
  if (transactionApprovals > 0 && !evidence.payment?.hash) evidence.paymentDispatch = 'unknown: approval attempted; hash not observed; no automatic resend';
  // Commit the public snapshot before any wallet action. No secret fields enter evidence.
  const snapshot = JSON.stringify(evidence, null, 2) + '\n';
  evidenceWrite = evidenceWrite.catch(() => {}).then(async () => {
    const pending = join(OUT, 'browser-evidence.next');
    await writeFile(pending, snapshot);
    await rename(pending, join(OUT, 'browser-evidence.json'));
  });
  await evidenceWrite;
}
async function journalWalletAction(kind, action) {
  evidence.walletActionJournal.push({ kind, action, stage, origin: ORIGIN, chainId: CHAIN_ID,
    ...(evidence.wallet.selectedAccount ? { account: evidence.wallet.selectedAccount } : {}), at: new Date().toISOString() });
  await persistEvidence();
}
function isExtensionPage(page) {
  return !page.isClosed() && page.url().startsWith(`chrome-extension://${extensionId}/`);
}
async function pageMetadata(page) {
  const url = new URL(page.url());
  const metadata = { pathname: url.pathname, route: url.hash.split('?')[0], isHarnessWalletPage: page === wallet };
  try {
    metadata.elements = await page.locator('*').evaluateAll((nodes) => nodes.map((node) => ({
      id: node.getAttribute('data-testid'), tag: node.tagName, type: node.getAttribute('type'),
      visible: typeof node.getClientRects === 'function' && node.getClientRects().length > 0,
    })));
  } catch (error) { metadata.collectionErrorClass = errorClass(error); }
  return metadata;
}
function observePageErrors(page) {
  page.on('pageerror', (error) => {
    if (isExtensionPage(page) && evidence.extensionPageErrors.length < 30) {
      evidence.extensionPageErrors.push({ errorClass: errorClass(error), framePathname: new URL(page.mainFrame().url()).pathname });
    }
  });
  page.on('crash', () => {
    if (isExtensionPage(page) && evidence.extensionPageErrors.length < 30) {
      evidence.extensionPageErrors.push({ errorClass: 'PageCrash', framePathname: new URL(page.mainFrame().url()).pathname });
    }
  });
}
async function reconcileUnknownPayment() {
  // Read-only observations cannot establish that a delayed wallet request was never dispatched.
  const before = evidence.prePayment;
  const record = { status: 'unknown-requires-manual-chain-review', automaticResendPermitted: false, observedAt: new Date().toISOString() };
  evidence.unknownPaymentReconciliation = record;
  if (!before || !evidence.accounts) return;
  const client = createPublicClient({ transport: http(RPC, { timeout: 4_000, retryCount: 0 }) });
  const { payer, merchant } = evidence.accounts;
  const readings = await Promise.allSettled([
    client.getTransactionCount({ address: payer, blockTag: 'pending' }),
    client.getTransactionCount({ address: payer, blockTag: 'latest' }),
    client.getBalance({ address: payer }),
    client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [payer] }),
    client.getBlockNumber(),
  ]);
  for (const [index, name] of ['pendingNonce', 'latestNonce', 'nativeBalance', 'musdBalance', 'headBlock'].entries()) {
    const result = readings[index];
    record[name] = result.status === 'fulfilled' ? result.value.toString() : { errorClass: errorClass(result.reason) };
  }
  if (readings[4].status !== 'fulfilled') return;
  const head = readings[4].value;
  const start = BigInt(before.block);
  const fromBlock = head > 255n && start < head - 255n ? head - 255n : start;
  record.transferSearch = { fromBlock: fromBlock.toString(), toBlock: head.toString(), boundedTo256Blocks: true };
  try {
    const logs = await client.getContractEvents({ address: TOKEN, abi: erc20Abi, eventName: 'Transfer', args: { from: payer, to: merchant }, fromBlock, toBlock: head });
    record.candidateTransfers = logs.slice(-10).map((log) => ({ hash: log.transactionHash, block: log.blockNumber?.toString(), amount: log.args.value?.toString() }));
    record.limit = 'Matching transfers are candidates only; verify exact transaction sender, invoice reference, receipt and confirmations before any retry.';
  } catch (error) { record.transferSearch.errorClass = errorClass(error); }
}
async function waitFor(fn, ms = 30_000, interval = 250) {
  const until = Math.min(Date.now() + ms, DEADLINE);
  while (Date.now() < until) {
    if (pumpError) throw pumpError;
    const result = await fn();
    if (result) return result;
    await sleep(interval);
  }
  throw new Error('Bounded evidence step timed out');
}
async function visible(page, testId) {
  return await page.getByTestId(testId).isVisible().catch(() => false);
}
async function clickIfVisible(page, testId) {
  if (!(await visible(page, testId))) return false;
  await page.getByTestId(testId).click();
  return true;
}
async function appShot(name) {
  // App pages never contain recovery phrases or wallet password fields.
  if (!app || app.isClosed() || !app.url().startsWith(ORIGIN)) return;
  const file = `${name}.png`;
  await app.screenshot({ path: join(OUT, file), fullPage: false });
  evidence.images.push(file);
}
async function publicWalletShot(page, name) {
  if (!walletReady || !page.url().startsWith(`chrome-extension://${extensionId}/`)) return;
  // Save only reviewed confirmations after onboarding. Never capture home/account settings or inputs.
  if (!/\/(?:notification|home)\.html.*#\/(?:confirmation|confirm|connect)/.test(page.url())) return;
  if ((await page.locator('input[type="password"], [data-testid*="srp"], [data-testid*="password"]').count()) > 0) return;
  const file = `${name}.png`;
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  evidence.images.push(file);
}
async function importWallet(mnemonic, password) {
  setStage('wallet-import');
  // Production onInstall opens its own tab. Reuse it instead of creating a second onboarding UI.
  await wallet.getByTestId('onboarding-import-wallet').click();
  setStage('wallet-existing-login');
  const note = wallet.getByTestId('srp-input-import__srp-note');
  let selectedSrp = false;
  // WelcomeLogin waits100ms before rendering login=existing options. An immediate isVisible check
  // can miss the SRP choice and then wait forever on the next screen. Follow the rendered UI.
  await waitFor(async () => {
    if (await note.isVisible().catch(() => false)) return true; // Builds without social login go here directly.
    if (selectedSrp) return false;
    const byId = wallet.getByTestId('onboarding-import-with-srp-button');
    // This exact accessible name comes from v13.55.0 app/_locales/en/messages.json.
    const byName = wallet.getByRole('button', { name: 'Import using Secret Recovery Phrase', exact: true });
    const option = await byId.isVisible().catch(() => false) ? byId : byName;
    if (!(await option.isVisible().catch(() => false))) return false;
    selectedSrp = true;
    await option.click();
    return false;
  }, 45_000);
  setStage('wallet-srp-entry');
  // Word-by-word entry matches MetaMask's own onboarding page object. The secret is never logged.
  const words = mnemonic.trim().split(/\s+/);
  secretEntryStarted = true; // Set BEFORE any secret fill; a failed fill can still have entered bytes.
  await note.fill(words[0]);
  await note.press('Space');
  for (let i = 1; i < words.length; i++) {
    const input = wallet.getByTestId(`import-srp__srp-word-${i}`);
    await input.fill(words[i]);
    if (i < words.length - 1) await input.press('Space');
  }
  await wallet.getByTestId('import-srp-confirm').click();
  setStage('wallet-password');
  secretEntryStarted = true;
  await wallet.getByTestId('create-password-new-input').fill(password);
  await wallet.getByTestId('create-password-confirm-input').fill(password);
  await wallet.getByTestId('create-password-terms').click();
  await waitFor(async () => !(await wallet.getByTestId('create-password-submit').isDisabled()));
  await wallet.getByTestId('create-password-submit').click();
  setStage('wallet-onboarding-finish');
  let doneClicked = false;
  let unlockAttempted = false;
  await waitFor(async () => {
    // OnboardingFlow explicitly requests a password when the in-memory SRP was lost.
    if (new URL(wallet.url()).hash.split('?')[0] === '#/onboarding/unlock' && await visible(wallet, 'unlock-password')) {
      if (unlockAttempted) return false;
      unlockAttempted = true;
      secretEntryStarted = true;
      evidence.wallet.onboardingUnlockAttempts = 1;
      await wallet.getByTestId('unlock-password').fill(password);
      await waitFor(async () => !(await wallet.getByTestId('unlock-submit').isDisabled()));
      await wallet.getByTestId('unlock-submit').click();
      return false;
    }
    if (await clickIfVisible(wallet, 'passkey-maybe-later-button')) return false;
    if (await visible(wallet, 'parent-selector-onboarding-metrics')) {
      for (const id of ['metametrics-data-collection-checkbox', 'metametrics-checkbox']) {
        const box = wallet.getByTestId(id);
        if (await box.isVisible().catch(() => false)) {
          const checked = await box.getAttribute('data-checked');
          const ariaChecked = await box.getAttribute('aria-checked');
          if (checked === 'true' || ariaChecked === 'true') await box.click();
        }
      }
      await wallet.getByTestId('metametrics-i-agree').click();
      return false;
    }
    if (await clickIfVisible(wallet, 'download-app-continue')) return false;
    if (!doneClicked && await visible(wallet, 'onboarding-complete-done')) {
      doneClicked = true;
      await wallet.getByTestId('onboarding-complete-done').click();
      // CreationSuccessful.onDone awaits completeOnboarding. A forced goto here races persistence.
      return false;
    }
    return await visible(wallet, 'account-menu-icon');
  }, 90_000);
  walletReady = true;
  check('Task-only wallet imported through MetaMask UI', true);
}
async function chooseAccount(label, { create = false } = {}) {
  const accountStage = `select-${label.replaceAll(' ', '-').toLowerCase()}`;
  setStage(`${accountStage}-open-list`);
  await wallet.bringToFront();
  if (!(await visible(wallet, 'account-menu-icon'))) await wallet.goto(`chrome-extension://${extensionId}/home.html`);
  await wallet.getByTestId('account-menu-icon').click();
  // HeaderNavbar.openAccountMenu in the pinned release waits for this page before using its rows.
  await wallet.getByTestId('parent-selector-account-list-page').waitFor({ state: 'visible' });
  const target = wallet.getByTestId(`multichain-account-cell-name-${label}`);
  if (create && !(await target.isVisible())) {
    setStage(`${accountStage}-wait-create-ready`);
    const add = wallet.getByTestId('add-multichain-account-button').first();
    let readySince = 0;
    // AddMultichainAccount is a DIV, not a disabled button. While syncing its handler is a no-op.
    // Follow AccountListPage.waitForAddAccountButtonStablyReady: exact ready label for 1 second.
    const ready = await waitFor(async () => {
      if (await target.isVisible().catch(() => false)) return 'existing';
      const renderedReady = await add.isVisible().catch(() => false)
        && (await add.innerText()).trim() === 'Add account'
        && await add.locator('.add-multichain-account__icon-box__icon-loading').count() === 0;
      if (!renderedReady) {
        readySince = 0;
        return false;
      }
      readySince ||= Date.now();
      return Date.now() - readySince >= 1_000 ? 'create' : false;
    }, 60_000);
    if (ready === 'create') {
      setStage(`${accountStage}-create-once`);
      evidence.wallet.accountCreationAttempts = (evidence.wallet.accountCreationAttempts ?? 0) + 1;
      check('Only one account-creation UI click is attempted', evidence.wallet.accountCreationAttempts === 1);
      await add.click();
    }
  }
  setStage(`${accountStage}-wait-row`);
  await target.waitFor({ state: 'visible', timeout: 60_000 });
  setStage(`${accountStage}-select-row`);
  await target.click();
  setStage(`${accountStage}-verify-selection`);
  await waitFor(async () => await visible(wallet, 'account-menu-icon')
    && (await wallet.getByTestId('account-menu-icon').innerText()).includes(label), 45_000);
  check(`MetaMask selected ${label}`, true);
  evidence.wallet.selectedAccount = label === 'Account 1' ? evidence.accounts.payer : evidence.accounts.merchant;
}
function classifyConfirmation(text, url) {
  if (/Secret Recovery Phrase|Enter your password|unlock your wallet/i.test(text)) return 'forbidden';
  if (/Connect this website with MetaMask|Review permissions/i.test(text) || /#\/connect\//.test(url)) return 'connect';
  if (/Signature request|Sign-in request/i.test(text)) return 'signature';
  if (/Add Mezo Testnet|Switch to Mezo Testnet|Switch network|Switch to this network/i.test(text)) return 'network';
  if (/Transaction request|Transaction|Send|Transfer/i.test(text) && /confirm/i.test(text)) return 'transaction';
  return 'unknown';
}
async function confirmationPump() {
  while (pumpRunning && Date.now() < DEADLINE) {
    for (const page of context.pages()) {
      if (page === wallet || page === app || page.isClosed()) continue;
      const url = page.url();
      if (!url.startsWith(`chrome-extension://${extensionId}/`)) continue;
      if (!/(?:notification|home)\.html/.test(url)) continue;
      try {
        const text = await page.locator('body').innerText({ timeout: 1500 });
        const kind = classifyConfirmation(text, url);
        if (kind === 'forbidden') throw new Error('Unexpected sensitive wallet screen');
        if (kind === 'unknown') continue; // Never blindly approve an unfamiliar screen.
        if (confirmMode === 'feature-absence') throw new Error('A wallet prompt appeared during the missing-Web-Locks check');
        // UI progression can reuse one window. Its route/title/button text identify each reviewed step.
        const title = await page.getByTestId('confirm-title-text').innerText().catch(() => kind);
        const connectStep = kind === 'connect' && /Review permissions/i.test(text) ? 'review-permissions' : '';
        const key = `${url}|${title}|${kind}|${connectStep}|${confirmMode}`;
        evidence.lastWalletScreen = {
          route: new URL(url).hash,
          kind,
          title,
          // Only public button labels/identifiers. No input values, raw error stack or whole DOM.
          buttons: await page.locator('button').evaluateAll((buttons) => buttons.slice(0, 25).map((button) => ({
            id: button.getAttribute('data-testid'),
            text: button.innerText.slice(0, 80),
            disabled: button.disabled,
          }))),
        };
        if (acted.get(page) === key) continue;
        if (kind === 'connect' || kind === 'signature') {
          check(`Wallet ${kind} belongs to the local test application`, /127\.0\.0\.1|localhost/.test(text));
        }
        if (kind === 'signature') {
          check('Signed content names MUSD invoice creation', /MUSD Pay Links|create invoice/i.test(text));
        }
        if (kind === 'network') {
          check('Wallet network request is Mezo Testnet', /Mezo Testnet|31611/.test(text));
        }
        if (kind === 'transaction') {
          check('Only the authorized testnet payment reaches wallet approval', ['reject-once', 'pay-once'].includes(confirmMode));
          const walletChain = await app.evaluate(async () => await window.ethereum.request({ method: 'eth_chainId' }));
          check('Wallet remains on Mezo Testnet at the confirmation action', Number(walletChain) === CHAIN_ID);
          if (confirmMode === 'reject-once') {
            if (!pumpRunning) return;
            if (transactionRejections !== 0) throw new Error('More than one rejection request');
            acted.set(page, key); // Save the attempt before the action, even if the window closes early.
            transactionRejections++;
            walletPromptActions++;
            await journalWalletAction(kind, 'reject');
            if (!pumpRunning) return;
            await page.getByTestId('confirm-footer-cancel-button').click();
            continue;
          }
          if (transactionApprovals !== 0) throw new Error('A second transaction approval is forbidden');
          await publicWalletShot(page, 'wallet-payment-review');
        }
        const bottom = page.locator('.confirm-scroll-to-bottom__button');
        if (await bottom.isVisible().catch(() => false)) await bottom.click();
        const confirm = kind === 'connect'
          ? page.locator('[data-testid="confirm-btn"], [data-testid="page-container-footer-next"]:visible').first()
          : page.getByTestId('confirm-footer-button');
        if (!(await confirm.isVisible().catch(() => false)) || await confirm.isDisabled()) continue;
        if (!pumpRunning) return;
        acted.set(page, key);
        if (kind === 'signature') signatureApprovals++;
        if (kind === 'transaction') transactionApprovals++;
        walletPromptActions++;
        await journalWalletAction(kind, 'approve');
        if (!pumpRunning) return;
        await confirm.click();
      } catch (error) {
        if (!page.isClosed() && !(error?.message ?? '').includes('Target page, context or browser has been closed')) {
          pumpError = new Error('Wallet confirmation did not complete safely');
          evidence.confirmationFailure = { kind: 'ui-review-failed' };
          return;
        }
      }
    }
    await sleep(250);
  }
}
async function connectedAccount(expected) {
  const accounts = await app.evaluate(async () => await window.ethereum.request({ method: 'eth_requestAccounts' }));
  check('Dapp sees the expected task-only selected account', Array.isArray(accounts) && accounts[0]?.toLowerCase() === expected.toLowerCase(), { selected: Array.isArray(accounts) ? accounts[0] : null });
}

async function verifyMissingWebLocks(client, payer, payURL, memo) {
  setStage('feature-absence-web-locks');
  const previousMode = confirmMode;
  confirmMode = 'feature-absence';
  const beforeActions = { walletPromptActions, transactionRejections, transactionApprovals, signatureApprovals };
  const nonceBefore = await client.getTransactionCount({ address: payer, blockTag: 'pending' });
  const promptViews = [];
  const observedPages = new Map();
  const isPromptURL = (url) => url.startsWith(`chrome-extension://${extensionId}/`)
    && (/\/notification\.html/.test(url) || /#\/(?:confirmation|confirm|connect)(?:\/|$)/.test(url));
  const observe = (page) => {
    const inspect = () => {
      if (isPromptURL(page.url()) && promptViews.length < 10) promptViews.push({ route: new URL(page.url()).hash, observedAt: new Date().toISOString() });
    };
    const onNavigation = (frame) => { if (frame === page.mainFrame()) inspect(); };
    page.on('framenavigated', onNavigation);
    observedPages.set(page, onNavigation);
    inspect();
  };
  for (const page of context.pages()) observe(page);
  context.on('page', observe);
  let noLocks;
  const record = {
    status: 'incomplete',
    method: 'Feature-absence simulation in a real Chromium page with the real MetaMask extension.',
    override: 'This page alone exposes navigator.locks as undefined before application code runs.',
    nativeBrowserClaim: 'This does not claim native Chromium lacks Web Locks.',
    nonceBefore,
    promptViews,
    quietObservationMs: 2_000,
  };
  evidence.missingWebLocks = record;
  try {
    check('No wallet prompt is pending before the feature-absence check', promptViews.length === 0);
    noLocks = await context.newPage();
    await noLocks.addInitScript(() => {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    });
    await noLocks.goto(payURL.href, { waitUntil: 'domcontentloaded' });
    await noLocks.waitForFunction(() => Boolean(window.ethereum?.isMetaMask));
    check('Feature-absence page retains the actual MetaMask provider', await noLocks.evaluate(() => window.ethereum.isMetaMask === true));
    check('Feature-absence page has Web Locks hidden', await noLocks.evaluate(() => typeof navigator.locks === 'undefined'));
    check('Original application page retains native Web Locks', await app.evaluate(() => typeof navigator.locks?.request === 'function'));
    await waitFor(async () => !(await noLocks.locator('#pv-pay').isDisabled()), 60_000);
    const attemptKey = `musd-sent:${CHAIN_ID}:${memo}`;
    const storedBefore = await noLocks.evaluate((key) => localStorage.getItem(key), attemptKey);
    await noLocks.locator('#pv-pay').click();
    await waitFor(async () => /cannot coordinate invoice payments across tabs/i.test(await noLocks.locator('#pv-out').innerText()), 15_000);
    record.message = await noLocks.locator('#pv-out').innerText();
    check('Missing Web Locks stops the payment with a plain explanation', /Web Locks support/i.test(record.message) && /No payment was requested/i.test(record.message));
    check('Missing Web Locks leaves Pay locked', await noLocks.locator('#pv-pay').isDisabled());
    // Observe a bounded quiet window after the synchronous guard. A fault must not be approved by the pump.
    await sleep(2_000);
    if (pumpError) throw pumpError;
    record.nonceAfter = await client.getTransactionCount({ address: payer, blockTag: 'pending' });
    record.walletPromptActionDelta = walletPromptActions - beforeActions.walletPromptActions;
    check('Feature-absence check creates no wallet prompt', promptViews.length === 0);
    check('Feature-absence check takes no wallet approval or rejection action', walletPromptActions === beforeActions.walletPromptActions
      && transactionRejections === beforeActions.transactionRejections
      && transactionApprovals === beforeActions.transactionApprovals
      && signatureApprovals === beforeActions.signatureApprovals);
    check('Feature-absence check leaves the payer pending nonce unchanged', record.nonceAfter === nonceBefore);
    check('Feature-absence check leaves saved payment state unchanged', await noLocks.evaluate((key) => localStorage.getItem(key), attemptKey) === storedBefore);
    const file = 'feature-absence-web-locks.png';
    await noLocks.screenshot({ path: join(OUT, file), fullPage: false });
    evidence.images.push(file);
    record.status = 'passed';
    record.completedAt = new Date().toISOString();
  } finally {
    context.off('page', observe);
    for (const [page, listener] of observedPages) page.off('framenavigated', listener);
    if (noLocks && !noLocks.isClosed()) await noLocks.close();
    confirmMode = previousMode;
    if (app && !app.isClosed()) await app.bringToFront();
  }
}

await mkdir(OUT, { recursive: true });
try {
  check('Harness runs only in GitHub-hosted Linux CI', process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux');
  const parsedOrigin = new URL(ORIGIN);
  check('Application is an isolated loopback preview', parsedOrigin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsedOrigin.hostname));
  let mnemonic = process.env.MUSD_EVIDENCE_MNEMONIC;
  check('A task-only mnemonic was supplied', typeof mnemonic === 'string' && [12, 24].includes(mnemonic.trim().split(/\s+/).length));
  const payer = mnemonicToAccount(mnemonic, { addressIndex: 0 }).address;
  const merchant = mnemonicToAccount(mnemonic, { addressIndex: 1 }).address;
  // Child browser/server processes never inherit the mnemonic environment variable.
  delete process.env.MUSD_EVIDENCE_MNEMONIC;
  evidence.accounts = { payer, merchant, derivation: "m/44'/60'/0'/0/{0,1}", bothProjectOwned: true };
  if (process.env.MUSD_EVIDENCE_PAYER_ADDRESS) check('Payer matches the prepared funding destination', payer.toLowerCase() === process.env.MUSD_EVIDENCE_PAYER_ADDRESS.toLowerCase());
  if (process.env.MUSD_EVIDENCE_MERCHANT_ADDRESS) check('Merchant matches the prepared test identity', merchant.toLowerCase() === process.env.MUSD_EVIDENCE_MERCHANT_ADDRESS.toLowerCase());
  const amountText = process.env.MUSD_EVIDENCE_AMOUNT ?? '1';
  check('Payment amount is capped test data', /^(?:0\.[0-9]{1,6}|[1-5](?:\.0{1,6})?)$/.test(amountText));
  const amount = parseUnits(amountText, 18);
  check('Payment amount is positive', amount > 0n);
  const client = createPublicClient({ transport: http(RPC, { timeout: 15_000, retryCount: 2 }) });
  check('Public RPC serves Mezo Testnet', await client.getChainId() === CHAIN_ID);
  const [nativeBalance, tokenBalance] = await Promise.all([
    client.getBalance({ address: payer }),
    client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [payer] }),
  ]);
  evidence.funding = { checkedAt: new Date().toISOString(), nativeBalance: nativeBalance.toString(), musdBalance: tokenBalance.toString(), requiredMUSD: amount.toString() };
  check('Test payer has native gas and MUSD', nativeBalance > 0n && tokenBalance >= amount);
  const extensionPath = resolve(process.env.METAMASK_EXTENSION_PATH ?? '');
  const manifestBytes = await readFile(join(extensionPath, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString());
  // Save public identity metadata before checking it, so a setup failure remains diagnosable.
  evidence.wallet.manifest = {
    version: manifest.version,
    versionName: manifest.version_name,
    manifestVersion: manifest.manifest_version,
    serviceWorker: manifest.background?.service_worker,
  };
  evidence.wallet.actualVersion = manifest.version;
  evidence.wallet.actualReleaseVersion = manifest.version_name;
  evidence.wallet.manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  evidence.wallet.packageSha256 = (await readFile(join(OUT, 'metamask-package.sha256'), 'utf8')).trim().split(/\s+/)[0];
  check('Loaded package is the pinned MetaMask release',
    manifest.version === EXTENSION_CHROME_VERSION
    && manifest.version_name === EXTENSION_VERSION
    && manifest.manifest_version === 3
    && manifest.background?.service_worker === 'service-worker.js'
    && evidence.wallet.manifestSha256 === EXTENSION_MANIFEST_SHA256
    && evidence.wallet.packageSha256 === EXTENSION_PACKAGE_SHA256);
  evidence.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  check('Workflow checks the exact source commit', !process.env.GITHUB_SHA || evidence.commit === process.env.GITHUB_SHA);
  const profile = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'musd-wallet-profile-'));
  const password = `Test-only-${randomBytes(18).toString('hex')}`;
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: false, locale: 'en-US', viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  context.setDefaultTimeout(15_000);
  context.on('page', observePageErrors);
  for (const page of context.pages()) observePageErrors(page);
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = new URL(worker.url()).host;
  evidence.wallet.extensionId = extensionId;
  wallet = await waitFor(async () => context.pages().find((page) => isExtensionPage(page)
    && new URL(page.url()).pathname === '/home.html'), 30_000);
  evidence.wallet.onboardingPageSource = 'MetaMask production onInstall tab';
  await wallet.getByTestId('onboarding-import-wallet').waitFor({ state: 'visible', timeout: 45_000 });
  await importWallet(mnemonic, password);
  mnemonic = undefined;
  await chooseAccount('Account 2', { create: true });
  app = await context.newPage();
  await app.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await app.waitForFunction(() => Boolean(window.ethereum?.isMetaMask));
  check('Dapp uses real MetaMask injection', await app.evaluate(() => window.ethereum.isMetaMask === true));
  pumpRunning = true;
  pumpPromise = confirmationPump();
  setStage('connect-merchant');
  await connectedAccount(merchant);
  const chainBefore = await app.evaluate(async () => await window.ethereum.request({ method: 'eth_chainId' }));
  evidence.wallet.chainBeforePayment = chainBefore;
  setStage('create-signed-invoice');
  await app.locator('#m-chain').selectOption(String(CHAIN_ID));
  await app.locator('#m-to').fill(merchant);
  await app.locator('#m-amount').fill(amountText);
  const invoiceResponse = app.waitForResponse((r) => new URL(r.url()).pathname === '/api/invoices' && r.request().method() === 'POST', { timeout: 90_000 });
  await app.locator('#m-go').click();
  const createdResponse = await invoiceResponse;
  const created = await createdResponse.json();
  check('Invoice was created by the normal merchant UI', createdResponse.status() === 201 && created.ok === true && created.invoice?.signed === true);
  check('Invoice binds expected testnet recipient and amount', created.invoice.chainId === CHAIN_ID && created.invoice.to.toLowerCase() === merchant.toLowerCase() && created.invoice.units === amount.toString());
  check('MetaMask approved one invoice signature', signatureApprovals === 1);
  evidence.invoice = created.invoice;
  await appShot('01-signed-invoice');
  await chooseAccount('Account 1');
  await connectedAccount(payer);
  const payURL = new URL(created.invoice.payUrl);
  check('Invoice pay page stays within the local preview', payURL.origin === new URL(ORIGIN).origin);
  await verifyMissingWebLocks(client, payer, payURL, created.invoice.memo);
  await app.goto(payURL.href, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => !(await app.locator('#pv-pay').isDisabled()), 60_000);
  await appShot('02-open-invoice');
  const nonceBefore = await client.getTransactionCount({ address: payer, blockTag: 'pending' });
  setStage('reject-one-payment');
  confirmMode = 'reject-once';
  await app.locator('#pv-pay').click();
  await waitFor(async () => transactionRejections === 1 && /rejected/i.test(await app.locator('#pv-out').innerText()), 90_000);
  check('Explicit wallet rejection leaves no project transaction', await client.getTransactionCount({ address: payer, blockTag: 'pending' }) === nonceBefore);
  await waitFor(async () => !(await app.locator('#pv-pay').isDisabled()));
  evidence.wallet.chainAfterConnection = await app.evaluate(async () => await window.ethereum.request({ method: 'eth_chainId' }));
  check('Client selected Mezo Testnet before a payment request', Number(evidence.wallet.chainAfterConnection) === CHAIN_ID);
  await appShot('03-wallet-rejected');
  setStage('send-one-payment');
  const [preNonce, preBlock, preNative, preToken] = await Promise.all([
    client.getTransactionCount({ address: payer, blockTag: 'pending' }), client.getBlockNumber(),
    client.getBalance({ address: payer }),
    client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [payer] }),
  ]);
  evidence.prePayment = { at: new Date().toISOString(), pendingNonce: preNonce, block: preBlock.toString(), nativeBalance: preNative.toString(), musdBalance: preToken.toString(), invoiceReference: created.invoice.memo };
  await persistEvidence();
  confirmMode = 'pay-once';
  await app.locator('#pv-pay').click();
  const hash = await waitFor(async () => {
    const hrefs = await app.locator('#pv-out a[href]').evaluateAll((links) => links.map((a) => a.href));
    return hrefs.map((href) => /\/tx\/(0x[0-9a-fA-F]{64})/.exec(href)?.[1]).find(Boolean);
  }, 120_000);
  evidence.payment = { hash, sender: payer, recipient: merchant, amount: amountText, reference: created.invoice.memo, chainId: CHAIN_ID, sentFromActualBrowserWallet: true };
  evidence.paymentDispatch = 'transaction hash observed; verification pending';
  await persistEvidence();
  check('Only one transaction was approved', transactionApprovals === 1);
  setStage('verify-on-chain');
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 5, timeout: 150_000, pollingInterval: 2_000 });
  const transaction = await client.getTransaction({ hash });
  check('Receipt succeeded on testnet', receipt.status === 'success' && await client.getChainId() === CHAIN_ID);
  check('Actual transaction binds payer and MUSD contract', transaction.from.toLowerCase() === payer.toLowerCase() && transaction.to?.toLowerCase() === TOKEN.toLowerCase());
  const referenceHex = stringToHex(created.invoice.memo).slice(2).toLowerCase();
  check('Wallet retained the invoice reference bytes', transaction.input.toLowerCase().endsWith(referenceHex));
  let received = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== TOKEN.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (decoded.eventName === 'Transfer' && decoded.args.to.toLowerCase() === merchant.toLowerCase()) received += decoded.args.value;
    } catch { /* Other token events do not prove this payment. */ }
  }
  check('MUSD Transfer events pay the actual invoice amount', received === amount, { received: received.toString(), required: amount.toString() });
  const head = await client.getBlockNumber();
  check('Payment has at least five confirmations', head - receipt.blockNumber + 1n >= 5n);
  evidence.payment = { ...evidence.payment, block: receipt.blockNumber.toString(), blockHash: receipt.blockHash, receiptStatus: receipt.status, transactionNonce: transaction.nonce, confirmations: (head - receipt.blockNumber + 1n).toString(), gasUsed: receipt.gasUsed.toString(), received: received.toString(), explorer: `https://explorer.test.mezo.org/tx/${hash}` };
  evidence.paymentDispatch = 'exact invoice payment verified on chain';
  setStage('verify-invoice-ui');
  await app.locator('#pv-check').click();
  await waitFor(async () => /^Paid\./i.test((await app.locator('#pv-status').innerText()).trim()), 60_000, 1_000);
  check('Invoice UI says paid and locks Pay', await app.locator('#pv-pay').isDisabled());
  await appShot('04-paid-invoice');
  setStage('reload-paid-invoice');
  await app.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => /^Paid\./i.test((await app.locator('#pv-status').innerText()).trim()), 60_000, 1_000);
  check('Reload preserves the paid lock', await app.locator('#pv-pay').isDisabled());
  const invoiceCheck = await app.request.get(`${ORIGIN}/api/invoices/${encodeURIComponent(created.invoice.memo)}?chain=${CHAIN_ID}&check=0`);
  const saved = await invoiceCheck.json();
  check('Stored invoice names this exact transaction', saved.invoice?.paid?.txHash?.toLowerCase() === hash.toLowerCase());
  evidence.finalInvoice = saved;
  await appShot('05-reloaded-paid-lock');
  pumpRunning = false;
  await pumpPromise;
  evidence.status = 'passed';
  evidence.completedAt = new Date().toISOString();
  setStage('complete');
} catch (error) {
  evidence.failedAt = new Date().toISOString();
  evidence.failure = { stage, type: errorClass(error) };
  if (!walletReady && wallet && !wallet.isClosed()) {
    evidence.onboardingDiagnostic = {
      ...await pageMetadata(wallet),
      secretEntryStarted,
    };
    if (!secretEntryStarted) {
      const file = 'onboarding-before-secret-failure.png';
      await wallet.screenshot({ path: join(OUT, file), fullPage: false }).then(() => evidence.images.push(file)).catch(() => {});
    }
  }
  if (walletReady && stage.startsWith('select-account-') && wallet && !wallet.isClosed()) {
    evidence.accountDiagnostic = await pageMetadata(wallet);
  }
  // Do not emit Playwright error/stack or locator call logs: onboarding calls contain secret input.
  console.error(`Browser evidence incomplete at public stage ${stage}. No raw wallet error is emitted.`);
  if (walletReady) await appShot('failure-app').catch(() => {});
  process.exitCode = 1;
} finally {
  pumpRunning = false;
  await persistEvidence(); // Counters and approval journal survive every handled failure.
  if (pumpPromise) await Promise.race([pumpPromise.catch(() => {}), sleep(5_000)]);
  if (context && evidence.status !== 'passed') {
    evidence.extensionPages = await Promise.all(context.pages().filter(isExtensionPage).map(pageMetadata));
  }
  if (transactionApprovals > 0 && !evidence.payment?.hash) {
    await reconcileUnknownPayment().catch((error) => {
      evidence.unknownPaymentReconciliation = { status: 'unknown-requires-manual-chain-review', automaticResendPermitted: false, errorClass: errorClass(error) };
    });
  }
  await persistEvidence();
  if (context) await context.close().catch(() => {});
  console.log(JSON.stringify({ status: evidence.status, stage, checks: evidence.checks.length, failedChecks: evidence.checks.filter((c) => !c.passed).map((c) => c.name), transaction: evidence.payment?.hash ?? null }));
}
