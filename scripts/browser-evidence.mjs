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
import { createPublicClient, decodeEventLog, encodeFunctionData, erc20Abi, http, parseUnits, stringToHex } from 'viem';
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
const actedRequests = new Set();
const permissionReviewed = new Set();
const requestViews = new Map();
const sidepanelRepresentations = new Map();
let lastSidepanelScan = 0;
let activeProductGesture = null;
const evidence = {
  startedAt: new Date().toISOString(),
  status: 'incomplete',
  currentStage: stage,
  lastCheckpoint: { stage, boundary: 'harness-initialized', at: new Date().toISOString() },
  chainId: CHAIN_ID,
  token: TOKEN,
  origin: ORIGIN,
  applicationEnvironment: 'Isolated local Wrangler with real public Mezo Testnet RPC',
  wallet: { product: 'MetaMask', expectedVersion: EXTENSION_VERSION, providerInjectedByHarness: false,
    consentViewCleanupPolicy: 'Owned consent tabs remain open until context teardown, with at most eight logical request representations; no intermediate automatic close.' },
  checks: [],
  images: [],
  walletActionJournal: [],
  providerRequests: [],
  extensionPageErrors: [],
  walletRpcDiagnostics: [],
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
async function setStage(name) {
  stage = name;
  evidence.currentStage = name;
  evidence.lastCheckpoint = { stage: name, boundary: 'stage-entered', at: new Date().toISOString() };
  await persistEvidence();
  console.log(`browser-evidence stage: ${name}`);
}
async function checkpoint(boundary, detail = {}) {
  evidence.currentStage = stage;
  evidence.lastCheckpoint = { stage, boundary, ...detail, at: new Date().toISOString() };
  await persistEvidence();
}
async function beginProductGesture(kind) {
  check('Only one product wallet gesture is active', activeProductGesture === null);
  activeProductGesture = { kind, stage, startedAt: new Date().toISOString() };
  evidence.wallet.activeProductGesture = activeProductGesture;
  await checkpoint('product-wallet-gesture-started', { kind });
}
async function endProductGesture(outcome) {
  evidence.wallet.lastCompletedProductGesture = { ...activeProductGesture, outcome, finishedAt: new Date().toISOString() };
  activeProductGesture = null;
  evidence.wallet.activeProductGesture = null;
  await checkpoint('product-wallet-gesture-completed', { outcome });
}
async function bounded(operation, ms, { watchPump = false } = {}) {
  const until = Math.min(Date.now() + ms, DEADLINE);
  if (watchPump && pumpError) throw pumpError;
  const timeoutError = () => Object.assign(new Error('Bounded browser operation timed out'), { name: 'TimeoutError' });
  if (until <= Date.now()) throw timeoutError();
  let timer;
  const guard = new Promise((_, reject) => {
    const poll = () => {
      if (watchPump && pumpError) return reject(pumpError);
      const remaining = until - Date.now();
      if (remaining <= 0) return reject(timeoutError());
      timer = setTimeout(poll, Math.min(remaining, 250));
    };
    poll();
  });
  try { return await Promise.race([Promise.resolve().then(operation), guard]); }
  finally { clearTimeout(timer); }
}
async function providerRequest(method) {
  assert(['eth_accounts', 'eth_chainId'].includes(method), 'Harness provider calls are read-only; connection comes from product UI');
  const timeoutMs = 15_000;
  const request = { method, stage, status: 'pending', timeoutMs, startedAt: new Date().toISOString() };
  evidence.providerRequests.push(request);
  await checkpoint('provider-request-started', { method, timeoutMs });
  try {
    const result = await bounded(() => app.evaluate(async (requestedMethod) => await window.ethereum.request({ method: requestedMethod }), method), timeoutMs, { watchPump: true });
    request.status = 'resolved';
    request.finishedAt = new Date().toISOString();
    await checkpoint('provider-request-resolved', { method });
    return result;
  } catch (error) {
    request.status = errorReason(error) === 'timeout' ? 'timed-out' : 'failed';
    request.finishedAt = new Date().toISOString();
    request.errorClass = errorClass(error);
    request.reason = errorReason(error);
    request.limit = 'Outer wait ended; an in-flight provider request is not cancelled or retried. Wallet action attempts remain recorded separately.';
    pumpRunning = false;
    await checkpoint('provider-request-incomplete', { method, reason: request.reason });
    throw error;
  }
}
function errorClass(error) {
  // Error names can be application-controlled; publish only standard class names.
  return ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error';
}
function errorReason(error) {
  // Match locally, then discard. Never return the error message or captured substrings.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/execution context was destroyed|cannot find context|cannot find execution context/i.test(message)) return 'execution-context-destroyed';
  if (/target.*closed|session.*closed|page.*closed|browser.*closed/i.test(message)) return 'target-closed';
  if (/frame.*detached|detached.*frame/i.test(message)) return 'frame-detached';
  if (/content.security.policy|unsafe-eval|trustedscript|refused to evaluate|evaluation.*denied/i.test(message)) return 'evaluation-denied';
  if (/lavamoat|scuttl|globalthis.*inaccessible/i.test(message)) return 'global-intrinsics-restricted';
  if (/timeout|timed out/i.test(message) || error?.name === 'TimeoutError') return 'timeout';
  return 'unclassified';
}
async function persistEvidence() {
  evidence.wallet.confirmations = { signatureApprovals, transactionRejections, transactionApprovals, walletPromptActions, countsAreActionAttempts: true };
  if (paymentNeedsReconciliation()) evidence.paymentDispatch = 'unknown: approval attempt or product wallet-result uncertainty; hash not observed; no automatic resend';
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
  await checkpoint('wallet-action-attempt-recorded-before-click', { kind, action });
}
function isExtensionPage(page) {
  return !page.isClosed() && page.url().startsWith(`chrome-extension://${extensionId}/`);
}
function pendingSidepanelURL(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'chrome-extension:' || url.host !== extensionId || url.pathname !== '/sidepanel.html' || url.search) return null;
  // These are existing consent routes with one opaque request ID. Never represent other surfaces.
  if (!/^#\/(?:(?:connect|confirmation|confirm)\/[A-Za-z0-9_-]{4,128}|confirm-transaction\/[A-Za-z0-9_-]{4,128}(?:\/signature-request)?)$/.test(url.hash)) return null;
  if (/(?:snap|onboarding|settings)/i.test(url.hash)) return null;
  return url;
}
async function pendingSidepanelTargets() {
  let session;
  try {
    session = await context.newCDPSession(wallet);
    const inventory = await bounded(() => session.send('Target.getTargets'), 5_000);
    return inventory.targetInfos.filter((target) => target.type === 'page' && pendingSidepanelURL(target.url));
  } finally { if (session) await session.detach().catch(() => {}); }
}
async function representPendingSidepanelRequests() {
  if (Date.now() - lastSidepanelScan < 1_000) return;
  lastSidepanelScan = Date.now();
  const targets = await pendingSidepanelTargets();
  const representedTargetIds = new Set([...sidepanelRepresentations.values()].map((record) => record.targetId).filter(Boolean));
  // Filter out our own normal tabs: Target.getTargets also reports those as sidepanel.html pages.
  const sourceTargets = targets.filter((target) => !representedTargetIds.has(target.targetId));
  // Keep owned consent views until context teardown. Leaving one normal request can immediately
  // start another; closing its UI between those steps may disturb that ongoing product gesture.
  if (confirmMode === 'feature-absence' && sourceTargets.length) throw new Error('Wallet prompt appeared during feature-absence check');
  if (!pumpRunning || !walletReady || !['create-signed-invoice', 'reject-one-payment', 'send-one-payment'].includes(stage)) return;
  for (const target of sourceTargets) {
    const url = pendingSidepanelURL(target.url);
    const route = url.hash;
    if (sidepanelRepresentations.has(route)) continue; // Never reopen/retry a represented request.
    const actualPage = context.pages().find((page) => !page.isClosed() && page.url() === target.url);
    if (actualPage) {
      requestViews.set(route, actualPage);
      const priorView = [...sidepanelRepresentations.values()].find((item) => item.page === actualPage);
      if (priorView) {
        check('Side-panel request representations remain bounded', sidepanelRepresentations.size < 8);
        const publicRecord = { route, sourcePathname: url.pathname, sourceType: target.type,
          representation: 'Existing owned consent tab naturally advanced to this exact already-pending source route',
          reusedExistingView: true, providerRequestIssuedByRepresentation: false, controllerStateInjectedByHarness: false, observedAt: new Date().toISOString() };
        sidepanelRepresentations.set(route, { page: actualPage, targetId: priorView.targetId, sourceTargetId: target.targetId, evidence: publicRecord });
        evidence.wallet.pendingPromptRepresentations.push(publicRecord);
        await checkpoint('observe-owned-consent-view-transition', { route });
      }
      continue;
    }
    check('Side-panel request representations remain bounded', sidepanelRepresentations.size < 8);
    const publicRecord = { route, sourcePathname: url.pathname, sourceType: target.type,
      representation: 'One normal tab at the exact already-pending authenticated same-extension prompt URL',
      providerRequestIssuedByRepresentation: false, controllerStateInjectedByHarness: false, openedAt: new Date().toISOString() };
    const record = { page: null, sourceTargetId: target.targetId, evidence: publicRecord };
    sidepanelRepresentations.set(route, record); // Record BEFORE opening; failure must never cause a retry.
    evidence.wallet.pendingPromptRepresentations ??= [];
    evidence.wallet.pendingPromptRepresentations.push(publicRecord);
    await checkpoint('represent-already-pending-sidepanel-request', { route });
    if (!pumpRunning) return;
    record.page = await context.newPage();
    requestViews.set(route, record.page);
    let tabSession;
    try {
      tabSession = await context.newCDPSession(record.page);
      const { targetInfo } = await bounded(() => tabSession.send('Target.getTargetInfo'), 5_000);
      record.targetId = targetInfo.targetId; // Internal only: distinguish this tab from the same-URL source.
    } finally { if (tabSession) await tabSession.detach().catch(() => {}); }
    await record.page.goto(target.url, { waitUntil: 'domcontentloaded' });
  }
}
async function recordExtensionTargets(boundary) {
  const record = { boundary, at: new Date().toISOString(), targets: [] };
  evidence.extensionTargetInventory ??= [];
  evidence.extensionTargetInventory.push(record);
  let session;
  try {
    session = await context.newCDPSession(wallet);
    const inventory = await bounded(() => session.send('Target.getTargets'), 5_000);
    const pageURLs = new Set(context.pages().map((page) => page.url()));
    const representedTargetIds = new Set([...sidepanelRepresentations.values()].map((item) => item.targetId).filter(Boolean));
    const sourceTargetIds = new Set([...sidepanelRepresentations.values()].map((item) => item.sourceTargetId));
    record.targets = inventory.targetInfos.filter((target) => target.url.startsWith(`chrome-extension://${extensionId}/`)).map((target) => {
      const url = new URL(target.url);
      return { type: target.type, pathname: url.pathname, route: url.hash.split('?')[0],
        representedByPlaywrightPage: sourceTargetIds.has(target.targetId) ? false : pageURLs.has(target.url),
        normalTabRepresentation: representedTargetIds.has(target.targetId), sourceOfNormalTabRepresentation: sourceTargetIds.has(target.targetId) };
    });
    // No target titles, query strings, raw URLs, DOM, storage or target identifiers are retained.
  } catch (error) { record.failure = { errorClass: errorClass(error), reason: errorReason(error) }; }
  finally { if (session) await session.detach().catch(() => {}); }
  await persistEvidence();
}
async function pageMetadata(page) {
  const url = new URL(page.url());
  const metadata = { pathname: url.pathname, route: url.hash.split('?')[0], isHarnessWalletPage: page === wallet };
  let session;
  try {
    session = await context.newCDPSession(page);
    // CDP's raw document stays in memory. Never persist attributes, values, text or snapshots.
    const document = await Promise.race([
      session.send('DOM.getDocument', { depth: -1, pierce: false }),
      sleep(5_000).then(() => { throw new Error('Metadata collection timeout'); }),
    ]);
    const pending = [document.root];
    const elements = [];
    while (pending.length) {
      const node = pending.pop();
      if (node.nodeType === 1) {
        let id = null;
        let type = null;
        for (let i = 0; i < (node.attributes?.length ?? 0); i += 2) {
          if (node.attributes[i] === 'data-testid') id = node.attributes[i + 1];
          if (node.attributes[i] === 'type') type = node.attributes[i + 1];
        }
        elements.push({ id, tag: node.nodeName, type });
      }
      if (node.children) pending.push(...node.children);
    }
    metadata.method = 'CDP DOM.getDocument metadata projection; visibility not collected';
    metadata.elements = elements;
    metadata.nodeCount = elements.length;
  } catch (error) {
    metadata.collectionErrorClass = errorClass(error);
    metadata.collectionErrorReason = errorReason(error);
  } finally { if (session) await session.detach().catch(() => {}); }
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
function classifyWalletRpcConsole(raw) {
  // Only constant categories, whitelisted codes/methods leave this function. Raw console text is
  // transient: never serialize console arguments, messages, stack, payloads or URLs.
  const text = typeof raw === 'string' ? raw.slice(0, 16_384) : '';
  const allowedCodes = new Set([4001, 4100, 4200, 4900, 4901, 4902, -32700, -32600, -32601, -32602, -32603, -32000, -32001, -32002, -32003, -32004, -32005]);
  const codes = [...text.matchAll(/\bcode\b["'\s:=]+(-?\d{3,6})(?=\D|$)/g)].map((match) => Number(match[1])).filter((code) => allowedCodes.has(code));
  const methods = ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_requestAccounts', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'personal_sign', 'eth_estimateGas', 'eth_gasPrice', 'eth_getTransactionCount', 'eth_chainId', 'eth_accounts', 'eth_feeHistory', 'eth_maxPriorityFeePerGas'];
  const method = methods.find((candidate) => new RegExp(`\\b${candidate}\\b`).test(text));
  let category;
  if (/read.only|readonly|cannot assign|not extensible|non.extensible|cannot define property|frozen/i.test(text)) category = 'immutable-input-error';
  else if (codes.includes(4100) || /unauthorized|not authorized|not been authorized/i.test(text)) category = 'provider-unauthorized';
  else if (codes.includes(-32002) || /request.*already.*pending|already processing.*request/i.test(text)) category = 'wallet-request-already-pending';
  else if (/network.?client.*(?:unknown|not found|does not exist|invalid)|unknown network.?client/i.test(text)) category = 'unknown-network-client';
  else if (codes.includes(4902) || /unrecognized chain|unknown chain|unsupported chain|chain.*not supported|chain.*not.*added/i.test(text)) category = 'unsupported-or-unadded-chain';
  else if (/insufficient funds|insufficient balance/i.test(text)) category = 'insufficient-funds';
  else if (/execution reverted|transaction.*revert/i.test(text)) category = 'execution-reverted';
  else if (/user rejected|user denied/i.test(text) || codes.includes(4001)) category = 'user-rejected';
  else if (/rate.limit|too many requests|quota exceeded/i.test(text)) category = 'rpc-rate-limited';
  else if (/unsupported|not supported|method.*not found/i.test(text)) category = 'unsupported-rpc-method';
  else if (codes.includes(-32602) || /invalid params|invalid argument|invalid transaction/i.test(text)) category = 'invalid-rpc-parameters';
  else if (/nonce/i.test(text) && /error|invalid|low|high|replacement/i.test(text)) category = 'nonce-error';
  else if (/gas|fee/i.test(text) && /error|estimate|invalid|low|high/i.test(text)) category = 'gas-or-fee-error';
  else if (/lavamoat|scuttl|globalthis.*inaccessible/i.test(text)) category = 'global-intrinsics-restricted';
  else if (/timeout|timed out|failed to fetch|fetch failed|disconnected|network error/i.test(text)) category = 'rpc-transport-error';
  else if (/internal.*(?:rpc|error)|rpc.*error/i.test(text) || codes.includes(-32603)) category = 'internal-or-unclassified-rpc-error';
  if (!category && !codes.length) return null;
  return { category: category ?? 'whitelisted-rpc-code', codes: [...new Set(codes)], ...(method ? { method } : {}) };
}
function observeWalletConsole(message) {
  if (!walletReady || !['error', 'warning'].includes(message.type())) return;
  const page = message.page();
  const worker = message.worker?.();
  let source;
  if (worker?.url().startsWith(`chrome-extension://${extensionId}/`)) source = 'wallet-worker';
  else if (page && isExtensionPage(page)) source = 'wallet-extension';
  else if (page && /^https?:\/\//.test(page.url()) && new URL(page.url()).origin === new URL(ORIGIN).origin) source = 'application';
  if (!source) return;
  const classified = classifyWalletRpcConsole(message.text());
  if (!classified) return;
  const key = JSON.stringify({ source, stage, ...classified });
  const previous = evidence.walletRpcDiagnostics.find((item) => item.key === key);
  if (previous) { previous.count++; previous.lastAt = new Date().toISOString(); }
  else if (evidence.walletRpcDiagnostics.length < 40) evidence.walletRpcDiagnostics.push({ key, source, stage, ...classified,
    gesture: activeProductGesture?.kind ?? null, count: 1, at: new Date().toISOString(), limit: 'Console observation only; not proof of request dispatch or failure.' });
  void persistEvidence().catch(() => {});
}
function publicBrowserAttempt(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return { status: 'absent' };
  const legacy = /^(0x[0-9a-fA-F]{64})(?:\||$)/.exec(raw);
  if (legacy) return { status: 'sent', hash: legacy[1] };
  try {
    const value = JSON.parse(raw);
    if (!['requesting', 'unknown', 'sent'].includes(value?.status)) return { status: 'unreadable' };
    const result = { status: value.status };
    if (Number.isSafeInteger(value.at) && value.at >= 0) result.at = value.at;
    if (typeof value.from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.from)) result.from = value.from;
    if (value.status === 'sent' && typeof value.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value.hash)) result.hash = value.hash;
    return result;
  } catch { return { status: 'unreadable' }; }
}
function paymentNeedsReconciliation() {
  return !evidence.payment?.hash && (transactionApprovals > 0 || evidence.publicPaymentState?.uncertain === true);
}
async function capturePublicPaymentState() {
  if (!app || app.isClosed() || !evidence.invoice || new URL(app.url()).origin !== new URL(ORIGIN).origin) return;
  try {
    const state = await bounded(async () => {
      const status = (await app.locator('#pv-status').innerText({ timeout: 2_000 }).catch(() => '')).slice(0, 2_000);
      const message = (await app.locator('#pv-out').innerText({ timeout: 2_000 }).catch(() => '')).slice(0, 2_000);
      const attempt = await app.evaluate(publicBrowserAttempt, `musd-sent:${CHAIN_ID}:${evidence.invoice.memo}`);
      const payDisabled = await app.locator('#pv-pay').isDisabled().catch(() => null);
      return { observedAt: new Date().toISOString(), status, message, payDisabled, attempt,
        uncertain: ['requesting', 'unknown', 'sent'].includes(attempt.status)
          || /did not confirm whether|result is uncertain|do not pay again until|check wallet activity before any retry/i.test(`${status}\n${message}`) };
    }, 5_000);
    evidence.publicPaymentState = state;
    await checkpoint('public-payment-state-observed', { uncertain: state.uncertain, attemptStatus: state.attempt.status });
  } catch (error) { evidence.publicPaymentStateFailure = { errorClass: errorClass(error), reason: errorReason(error) }; }
}
async function failIfPaymentUnknown() {
  const status = await app.locator('#pv-status').innerText({ timeout: 2_000 }).catch(() => '');
  if (/did not confirm whether|result is uncertain|check wallet activity before any retry/i.test(status)) {
    pumpRunning = false;
    await capturePublicPaymentState();
    throw new Error('Application reports an uncertain wallet result; automatic retry forbidden');
  }
}
async function paymentBaseline(client, payer, purpose) {
  const [pendingNonce, block, nativeBalance, tokenBalance] = await Promise.all([
    client.getTransactionCount({ address: payer, blockTag: 'pending' }), client.getBlockNumber(), client.getBalance({ address: payer }),
    client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [payer] }),
  ]);
  const baseline = { at: new Date().toISOString(), purpose, pendingNonce, block: block.toString(), nativeBalance: nativeBalance.toString(), musdBalance: tokenBalance.toString(), invoiceReference: evidence.invoice.memo };
  evidence.prePayment = baseline;
  evidence.paymentBaselines ??= [];
  evidence.paymentBaselines.push(baseline);
  await checkpoint('read-only-payment-baseline-saved', { purpose });
  return baseline;
}
async function reconcileUnknownPayment() {
  // Read-only observations cannot establish that a delayed wallet request was never dispatched.
  const before = evidence.prePayment;
  const record = { status: 'unknown-requires-manual-chain-review', automaticResendPermitted: false, observedAt: new Date().toISOString() };
  evidence.unknownPaymentReconciliation = record;
  if (!evidence.accounts) return;
  record.baseline = before ?? null;
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
  const startValue = before?.block ?? evidence.invoice?.fromBlock;
  if (startValue === undefined) { record.transferSearch = { status: 'no-baseline-block-available' }; return; }
  const start = BigInt(startValue);
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
    const result = await bounded(fn, until - Date.now(), { watchPump: true });
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
  if (!/\/(?:notification|home|sidepanel)\.html.*#\/(?:confirmation|confirm-transaction|confirm|connect)(?:\/|$)/.test(page.url())) return;
  if ((await page.locator('input[type="password"], [data-testid*="srp"], [data-testid*="password"]').count()) > 0) return;
  const file = `${name}.png`;
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  evidence.images.push(file);
}
async function importWallet(mnemonic, password) {
  await setStage('wallet-import');
  // Production onInstall opens its own tab. Reuse it instead of creating a second onboarding UI.
  await wallet.getByTestId('onboarding-import-wallet').click();
  await setStage('wallet-existing-login');
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
  await setStage('wallet-srp-entry');
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
  await setStage('wallet-password');
  secretEntryStarted = true;
  await wallet.getByTestId('create-password-new-input').fill(password);
  await wallet.getByTestId('create-password-confirm-input').fill(password);
  await wallet.getByTestId('create-password-terms').click();
  await waitFor(async () => !(await wallet.getByTestId('create-password-submit').isDisabled()));
  await checkpoint('onboarding-password-submit');
  await wallet.getByTestId('create-password-submit').click();
  await setStage('wallet-onboarding-finish');
  let doneClicked = false;
  let doneReadySince = 0;
  let homeNavigationAttempted = false;
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
      const done = wallet.getByTestId('onboarding-complete-done');
      if (await done.isDisabled()) {
        doneReadySince = 0;
        return false;
      }
      doneReadySince ||= Date.now();
      if (Date.now() - doneReadySince < 2_000) return false;
      doneClicked = true;
      evidence.wallet.onboardingDoneAttempts = 1;
      await checkpoint('normal-onboarding-done-click');
      await done.click();
      return false;
    }
    if (doneClicked && !homeNavigationAttempted && new URL(wallet.url()).hash.split('?')[0] === '#/onboarding/completion') {
      // Production Done opens the side panel and leaves this tab on completion. Follow its normal
      // home entry once after settling. RequireAuthenticated redirects incomplete onboarding away
      // from Home; only its real home UI below can prove completion. No storage/state is evaluated.
      homeNavigationAttempted = true;
      evidence.wallet.postDoneHomeNavigationAttempts = 1;
      evidence.wallet.postDoneSettlingMs = 1_500;
      await sleep(1_500);
      await checkpoint('normal-home-navigation-after-done');
      await wallet.goto(`chrome-extension://${extensionId}/home.html`);
      return false;
    }
    const route = new URL(wallet.url()).hash.split('?')[0];
    return doneClicked && ['', '#', '#/'].includes(route) && await visible(wallet, 'account-menu-icon');
  }, 90_000);
  evidence.wallet.onboardingCompletionSignal = {
    kind: 'Actual account-menu UI on the normal home route behind RequireAuthenticated',
    route: new URL(wallet.url()).hash.split('?')[0],
    observedAfterNormalDoneUI: doneClicked,
    persistedBooleanObserved: false,
    at: new Date().toISOString(),
  };
  check('Normal home route and account UI prove onboarding completed', doneClicked
    && ['', '#', '#/'].includes(new URL(wallet.url()).hash.split('?')[0]) && await visible(wallet, 'account-menu-icon'));
  walletReady = true;
  check('Task-only wallet imported through MetaMask UI', true);
}
async function chooseAccount(label, { create = false } = {}) {
  const accountStage = `select-${label.replaceAll(' ', '-').toLowerCase()}`;
  await setStage(`${accountStage}-open-list`);
  await wallet.bringToFront();
  if (!(await visible(wallet, 'account-menu-icon'))) await wallet.goto(`chrome-extension://${extensionId}/home.html`);
  await checkpoint('account-menu-open');
  await wallet.getByTestId('account-menu-icon').click();
  // HeaderNavbar.openAccountMenu in the pinned release waits for this page before using its rows.
  await wallet.getByTestId('parent-selector-account-list-page').waitFor({ state: 'visible' });
  const target = wallet.getByTestId(`multichain-account-cell-name-${label}`);
  if (create && !(await target.isVisible())) {
    await setStage(`${accountStage}-wait-create-ready`);
    const add = wallet.getByTestId('add-multichain-account-button').first();
    const addWallet = wallet.getByTestId('account-list-add-wallet-button');
    const readiness = {
      startedAt: new Date().toISOString(), timeoutMs: 120_000, outcome: 'waiting', observations: [],
      conditions: 'Pinned AccountListPage: Add wallet enabled/not syncing for 2s, then normalized exact Add account label for 1s; no loading icon.',
      limit: 'Only public Add account/Add wallet readiness labels and flags are recorded. No account-creation click is retried.',
    };
    evidence.wallet.accountCreationReadiness = readiness;
    let footerReadySince = 0;
    let readySince = 0;
    let lastObservation = '';
    let lastReadinessSave = 0;
    // AddMultichainAccount is a DIV, not a disabled button. While syncing its handler is a no-op.
    // Match the helper's XPath normalize-space(.) and stable footer/account gates. Production
    // account discovery uses real external services, so allow a longer bounded wait than mocks.
    let ready;
    try {
      ready = await waitFor(async () => {
        const normalizeSpace = (text) => text.replace(/\s+/g, ' ').trim();
        const observed = { desiredAccountVisible: await target.isVisible().catch(() => false),
          addAccountVisible: await add.isVisible().catch(() => false),
          addWalletVisible: await addWallet.isVisible().catch(() => false) };
        try {
          observed.addAccountLabel = observed.addAccountVisible ? normalizeSpace(await add.innerText({ timeout: 2_000 })).slice(0, 120) : null;
          observed.addWalletLabel = observed.addWalletVisible ? normalizeSpace(await addWallet.innerText({ timeout: 2_000 })).slice(0, 120) : null;
          observed.addWalletDisabled = observed.addWalletVisible ? await addWallet.isDisabled() : null;
          observed.loadingIconCount = await add.locator('.add-multichain-account__icon-box__icon-loading').count();
          observed.loadingIconVisible = await add.locator('.add-multichain-account__icon-box__icon-loading').first().isVisible().catch(() => false);
        } catch (error) { observed.readFailure = { errorClass: errorClass(error), reason: errorReason(error) }; }
        readiness.latest = { ...observed, at: new Date().toISOString(), route: new URL(wallet.url()).hash.split('?')[0] };
        const signature = JSON.stringify(observed);
        if (signature !== lastObservation || Date.now() - lastReadinessSave >= 5_000) {
          if (readiness.observations.length < 24) readiness.observations.push(readiness.latest);
          lastObservation = signature;
          lastReadinessSave = Date.now();
          await persistEvidence();
        }
        if (observed.desiredAccountVisible) return 'existing';
        const footerReady = !observed.readFailure && observed.addWalletVisible && observed.addWalletDisabled === false && observed.addWalletLabel === 'Add wallet';
        if (!footerReady) { footerReadySince = 0; readySince = 0; return false; }
        footerReadySince ||= Date.now();
        if (Date.now() - footerReadySince < 2_000) return false;
        const renderedReady = observed.addAccountVisible && observed.addAccountLabel === 'Add account' && observed.loadingIconCount === 0;
        if (!renderedReady) { readySince = 0; return false; }
        readySince ||= Date.now();
        return Date.now() - readySince >= 1_000 ? 'create' : false;
      }, readiness.timeoutMs, 500);
      readiness.outcome = ready === 'existing' ? 'account-already-visible' : 'stably-ready-for-one-click';
      readiness.finishedAt = new Date().toISOString();
      await persistEvidence();
    } catch (error) {
      readiness.outcome = errorReason(error) === 'timeout' ? 'timed-out-without-create-click' : 'readiness-failed-without-create-click';
      readiness.finishedAt = new Date().toISOString();
      await persistEvidence();
      throw error;
    }
    if (ready === 'create') {
      await setStage(`${accountStage}-create-once`);
      evidence.wallet.accountCreationAttempts = (evidence.wallet.accountCreationAttempts ?? 0) + 1;
      check('Only one account-creation UI click is attempted', evidence.wallet.accountCreationAttempts === 1);
      await checkpoint('account-create-ui-click');
      await add.click();
    }
  }
  await setStage(`${accountStage}-wait-row`);
  await target.waitFor({ state: 'visible', timeout: 60_000 });
  await setStage(`${accountStage}-select-row`);
  await checkpoint('account-select-ui-click');
  await target.click();
  await setStage(`${accountStage}-verify-selection`);
  await waitFor(async () => await visible(wallet, 'account-menu-icon')
    && (await wallet.getByTestId('account-menu-icon').innerText()).includes(label), 45_000);
  check(`MetaMask selected ${label}`, true);
  evidence.wallet.selectedAccount = label === 'Account 1' ? evidence.accounts.payer : evidence.accounts.merchant;
}
function classifyConfirmation(text, url, title = '') {
  if (/Secret Recovery Phrase|Enter your password|unlock your wallet/i.test(text)) return 'forbidden';
  const publicText = `${title}\n${text}`;
  const signature = /Signature request|Sign-in request/i.test(publicText);
  const connect = /Connect this website with MetaMask|Review permissions/i.test(publicText);
  const network = /Add Mezo Testnet|Switch to Mezo Testnet|Switch network|Switch to this network/i.test(publicText);
  const transaction = /Transaction request|Transaction|Send|Transfer/i.test(publicText) && /confirm/i.test(publicText);
  if (/#\/connect(?:\/|$)/.test(url)) return connect && !signature ? 'connect' : signature || network || transaction ? 'transition' : 'unknown';
  if (/\/signature-request(?:$|\?)/.test(url)) return signature && !connect ? 'signature' : connect || network || transaction ? 'transition' : 'unknown';
  if (signature && !connect) return 'signature';
  if (connect) return 'transition';
  if (network) return 'network';
  if (transaction) return 'transaction';
  return 'unknown';
}
function consentRoute(page) { return new URL(page.url()).hash.split('?')[0]; }
function consentViewChanged() { return Object.assign(new Error('Consent view changed before action'), { code: 'CONSENT_VIEW_CHANGED' }); }
function requireConsentRoute(page, route) {
  if (page.isClosed() || consentRoute(page) !== route) throw consentViewChanged();
}
async function readConsentSnapshot(page) {
  const url = page.url();
  const text = await page.locator('body').innerText({ timeout: 1_500 });
  const titleNode = page.getByTestId('confirm-title-text');
  // Connect has no redesigned title node. Never wait for a future request to supply its title.
  const title = await titleNode.isVisible().catch(() => false) ? await titleNode.innerText({ timeout: 1_000 }).catch(() => '') : '';
  if (page.isClosed() || page.url() !== url) return null;
  const kind = classifyConfirmation(text, url, title);
  if (kind === 'transition') return null;
  const route = new URL(url).hash.split('?')[0];
  const connectStep = kind === 'connect' && /Review permissions/i.test(text) ? 'review-permissions' : '';
  return { url, route, text, kind, title: title || kind, connectStep, identity: `${route}|${title || kind}|${kind}|${connectStep}` };
}
async function requireFreshConsent(page, snapshot) {
  const fresh = await readConsentSnapshot(page);
  if (!fresh || fresh.identity !== snapshot.identity) throw consentViewChanged();
  return fresh;
}
function parseInvoiceClaim(message, expected, nowMs = Date.now()) {
  const match = /^MUSD Pay Links, create invoice\nchain (\d+)\nto (0x[0-9a-fA-F]{40})\namount ((?:0|[1-9]\d*)(?:\.\d{1,18})?) MUSD\nreference (INV-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8})\ntime (\d+)$/.exec(message.trim());
  assert(match, 'Wallet message is the exact canonical create-invoice claim');
  const claim = { chainId: Number(match[1]), to: match[2], amount: match[3], memo: match[4], timestamp: Number(match[5]) };
  assert(claim.chainId === CHAIN_ID && claim.to.toLowerCase() === expected.merchant.toLowerCase(), 'Wallet claim binds the task chain and merchant');
  assert(parseUnits(claim.amount, 18) === BigInt(expected.units), 'Wallet claim binds the exact task amount');
  assert(Number.isSafeInteger(claim.timestamp) && claim.timestamp >= Math.floor(expected.gestureStartedAt / 1_000) - 5
    && Math.abs(nowMs / 1_000 - claim.timestamp) <= 600, 'Wallet claim has a fresh whole-second timestamp');
  return claim;
}
async function reviewInvoiceClaim(page, snapshot) {
  await requireFreshConsent(page, snapshot);
  const message = page.locator('.confirm-info-row p').filter({ hasText: 'MUSD Pay Links, create invoice' });
  await waitFor(async () => {
    requireConsentRoute(page, snapshot.route);
    const count = await message.count();
    if (count > 1) {
      await requireFreshConsent(page, snapshot);
      check('Wallet exposes exactly one canonical invoice message', false);
    }
    return count === 1;
  }, 15_000);
  await requireFreshConsent(page, snapshot);
  check('Wallet exposes exactly one canonical invoice message', await message.count() === 1);
  const displayed = await message.innerText({ timeout: 2_000 });
  await requireFreshConsent(page, snapshot);
  const claim = parseInvoiceClaim(displayed, { merchant: evidence.accounts.merchant, units: evidence.funding.requiredMUSD,
    gestureStartedAt: Date.parse(activeProductGesture?.startedAt ?? '') });
  if (evidence.wallet.reviewedInvoiceClaim) check('A repeated signature view binds the same invoice claim', JSON.stringify(evidence.wallet.reviewedInvoiceClaim) === JSON.stringify(claim));
  evidence.wallet.reviewedInvoiceClaim = claim;
  check('Wallet message binds exact chain, merchant, amount, fresh reference and time', true);
}
async function publicButtonMetadata(page) {
  try {
    return { buttons: await bounded(async () => {
      const buttons = page.locator('button');
      const count = Math.min(await buttons.count(), 25);
      const records = [];
      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        // Normal locator methods run in Playwright's utility world, avoiding LavaMoat globals.
        records.push({ id: await button.getAttribute('data-testid'), text: (await button.innerText()).slice(0, 80), disabled: await button.isDisabled() });
      }
      return records;
    }, 5_000) };
  } catch (error) {
    // Optional public diagnostics must never prevent essential review and approval checks.
    return { buttons: [], buttonDiagnosticFailure: { errorClass: errorClass(error), reason: errorReason(error) } };
  }
}
async function verifyWalletOrigin(page, kind, snapshot) {
  const expected = new URL(ORIGIN);
  const diagnostic = { kind, route: new URL(page.url()).hash.split('?')[0], expectedOrigin: expected.origin, status: 'unverified' };
  evidence.wallet.originReviews ??= [];
  evidence.wallet.originReviews.push(diagnostic);
  try {
    if (snapshot) await requireFreshConsent(page, snapshot);
    check('Origin review contains no recovery or password input', await page.locator('input[type="password"], [data-testid*="srp"], [data-testid*="password"]').count() === 0);
    const webOrigins = new Set(context.pages().flatMap((candidate) => candidate.frames().map((frame) => frame.url()))
      .filter((raw) => /^https?:\/\//.test(raw)).map((raw) => new URL(raw).origin));
    diagnostic.appOrigin = new URL(app.url()).origin;
    diagnostic.observedWebOrigins = [...webOrigins];
    diagnostic.activeProductGesture = activeProductGesture?.kind ?? null;
    const isolatedGesture = diagnostic.appOrigin === expected.origin && webOrigins.size === 1 && webOrigins.has(expected.origin)
      && activeProductGesture?.stage === stage;
    if (kind === 'connect') {
      // v13.55.0 transformOriginToTitle deliberately displays hostname only, without scheme/port.
      const heading = page.getByTestId('parent-selector-connect-page').locator('.break-words.whitespace-normal').first();
      const hydrationStarted = Date.now();
      await waitFor(async () => {
        if (snapshot) requireConsentRoute(page, snapshot.route);
        diagnostic.displayedHostname = (await heading.innerText({ timeout: 2_000 }).catch((error) => {
          diagnostic.headingReadFailure = { errorClass: errorClass(error), reason: errorReason(error) };
          return '';
        })).trim().slice(0, 250);
        if (snapshot) requireConsentRoute(page, snapshot.route);
        return diagnostic.displayedHostname !== '' && diagnostic.displayedHostname !== 'Unknown Origin';
      }, 15_000);
      diagnostic.hydrationWaitMs = Date.now() - hydrationStarted;
      diagnostic.publicTitle = await heading.getAttribute('title');
      diagnostic.uiLimit = 'Connect displays hostname only. It does not expose scheme or port; those are checked through the real app URL, isolated web origin and one active product gesture.';
      diagnostic.persistedOrControllerStateRead = false;
      diagnostic.verified = isolatedGesture && diagnostic.displayedHostname === expected.hostname;
    } else {
      // PersonalSignInfo passes its origin to ConfirmInfoRowUrl: host:port plus HTTP badge.
      const origin = page.getByTestId('confirmation__details-origin');
      await waitFor(async () => {
        if (snapshot) requireConsentRoute(page, snapshot.route);
        return await origin.isVisible().catch(() => false);
      }, 15_000);
      diagnostic.displayedHostAndPort = (await origin.innerText()).trim().slice(0, 250);
      diagnostic.httpBadgeVisible = await origin.locator('..').getByText('HTTP', { exact: true }).isVisible().catch(() => false);
      diagnostic.verified = isolatedGesture && diagnostic.displayedHostAndPort === expected.host
        && expected.protocol === 'http:' && diagnostic.httpBadgeVisible;
    }
    diagnostic.status = diagnostic.verified ? 'verified-from-public-ui-and-isolated-product-context' : 'origin-mismatch';
  } catch (error) {
    if (error?.code === 'CONSENT_VIEW_CHANGED') {
      diagnostic.status = 'view-transitioned-during-origin-review';
      throw error;
    }
    diagnostic.errorClass = errorClass(error);
    diagnostic.reason = errorReason(error);
  }
  if (snapshot) await requireFreshConsent(page, snapshot);
  await checkpoint('wallet-origin-reviewed', { kind, verified: diagnostic.verified === true });
  if (!diagnostic.verified) await publicWalletShot(page, `wallet-${kind}-origin-unverified`).catch(() => {});
  return diagnostic.verified === true;
}
async function selectTaskAccountPermissions(page, snapshot) {
  // A normal consent tab can represent successive Connect requests. Review each opaque request
  // once, rather than treating the tab itself as already authorized for every future request.
  const requestIdentity = snapshot.route;
  if (permissionReviewed.has(requestIdentity) || !(await visible(page, 'account-selection-section'))) return;
  await bounded(async () => {
    if (snapshot) await requireFreshConsent(page, snapshot);
    walletPromptActions++;
    await journalWalletAction('connect', 'open-account-permission-selection');
    if (snapshot) requireConsentRoute(page, snapshot.route);
    if (!pumpRunning) throw new Error('Wallet review stopped');
    await page.getByTestId('account-selection-section').click();
    await page.getByTestId('edit-accounts-modal-header').waitFor({ state: 'visible' });
    check('Connect permission UI lists only the two task accounts', await page.locator('[data-testid^="multichain-account-cell-name-"]').count() === 2);
    for (const label of ['Account 2', 'Account 1']) {
      const row = page.locator('.multichain-account-cell').filter({ has: page.getByTestId(`multichain-account-cell-name-${label}`) });
      const checkbox = row.getByRole('checkbox');
      if (!(await checkbox.isChecked())) {
        if (snapshot) requireConsentRoute(page, snapshot.route);
        walletPromptActions++;
        await journalWalletAction('connect', `select-permitted-${label.replaceAll(' ', '-').toLowerCase()}`);
        if (snapshot) requireConsentRoute(page, snapshot.route);
        if (!pumpRunning) throw new Error('Wallet review stopped');
        await checkbox.check();
      }
      check(`Connect UI explicitly permits task ${label}`, await checkbox.isChecked());
    }
    if (snapshot) requireConsentRoute(page, snapshot.route);
    walletPromptActions++;
    await journalWalletAction('connect', 'save-task-account-permissions');
    if (snapshot) requireConsentRoute(page, snapshot.route);
    if (!pumpRunning) throw new Error('Wallet review stopped');
    await page.getByTestId('connect-more-accounts-button').click();
    await page.getByTestId('accounts-count-2').waitFor({ state: 'visible' });
    permissionReviewed.add(requestIdentity);
    evidence.wallet.accountPermissions = { method: 'Normal Connect edit-accounts UI', accounts: [evidence.accounts.merchant, evidence.accounts.payer], onlyTaskAccounts: true };
  }, 30_000, { watchPump: true });
}
async function confirmationPump() {
  while (pumpRunning && Date.now() < DEADLINE) {
    try { await representPendingSidepanelRequests(); }
    catch (error) {
      const failure = { kind: 'pending-sidepanel-representation-failed', stage, errorClass: errorClass(error), reason: errorReason(error), at: new Date().toISOString() };
      evidence.firstPumpError ??= failure;
      evidence.confirmationFailure ??= failure;
      pumpError ??= new Error('Pending wallet surface could not be represented safely');
      pumpRunning = false;
      await checkpoint('wallet-pump-failed', { reason: failure.reason });
      return;
    }
    for (const page of context.pages()) {
      if (page === app || page.isClosed()) continue;
      const url = page.url();
      if (!url.startsWith(`chrome-extension://${extensionId}/`)) continue;
      if (!/(?:notification|home|sidepanel)\.html/.test(url)) continue;
      // Pending requests can render in an existing full-page wallet, not just a new notification.
      // Do not inspect ordinary home/settings pages or any onboarding/recovery route.
      if (!/\/notification\.html/.test(url) && !/#\/(?:confirmation|confirm-transaction|confirm|connect)(?:\/|$)/.test(url)) continue;
      const requestRoute = new URL(url).hash.split('?')[0];
      const chosenView = requestViews.get(requestRoute);
      if (chosenView && chosenView !== page) continue;
      requestViews.set(requestRoute, page);
      let reviewKind = 'unknown';
      let actionAttempted = false;
      try {
        const snapshot = await readConsentSnapshot(page);
        if (!snapshot || snapshot.url !== url) {
          evidence.wallet.transitionalViewSkips = (evidence.wallet.transitionalViewSkips ?? 0) + 1;
          continue;
        }
        const { text, kind, title } = snapshot;
        reviewKind = kind;
        if (kind === 'forbidden') throw new Error('Unexpected sensitive wallet screen');
        if (kind === 'unknown') continue; // Never blindly approve an unfamiliar screen.
        if (confirmMode === 'feature-absence') throw new Error('A wallet prompt appeared during the missing-Web-Locks check');
        // One logical request is acted only once per reviewed step, across side panel/tab views.
        // Mode is deliberately excluded: a previously rejected request cannot be approved later.
        const key = snapshot.identity;
        const buttons = await publicButtonMetadata(page);
        await requireFreshConsent(page, snapshot);
        evidence.lastWalletScreen = {
          route: snapshot.route,
          kind,
          title,
          // Only public button labels/identifiers. No input values, raw error stack or whole DOM.
          ...buttons,
        };
        if (actedRequests.has(key)) continue;
        if (kind === 'connect' || kind === 'signature') {
          const originVerified = await verifyWalletOrigin(page, kind, snapshot);
          await requireFreshConsent(page, snapshot);
          check(`Wallet ${kind} belongs to the local test application`, originVerified);
        }
        if (kind === 'connect') await selectTaskAccountPermissions(page, snapshot);
        if (kind === 'signature') {
          await reviewInvoiceClaim(page, snapshot);
        }
        if (kind === 'network') {
          check('Wallet network request is Mezo Testnet', /Mezo Testnet|31611/.test(text));
        }
        if (kind === 'transaction') {
          check('Only the authorized testnet payment reaches wallet approval', ['reject-once', 'pay-once'].includes(confirmMode));
          const walletChain = await providerRequest('eth_chainId');
          check('Wallet remains on Mezo Testnet at the confirmation action', Number(walletChain) === CHAIN_ID);
          if (confirmMode === 'reject-once') {
            if (!pumpRunning || Date.now() >= DEADLINE) return;
            if (transactionRejections !== 0) throw new Error('More than one rejection request');
            await requireFreshConsent(page, snapshot);
            actedRequests.add(key); // Save the attempt before the action, even if the window closes early.
            transactionRejections++;
            walletPromptActions++;
            await journalWalletAction(kind, 'reject');
            if (!pumpRunning || Date.now() >= DEADLINE) return;
            try { await requireFreshConsent(page, snapshot); }
            catch {
              Object.assign(evidence.walletActionJournal.at(-1), { clickIssued: false, skipReason: 'consent-view-changed-after-journal' });
              await persistEvidence();
              throw new Error('Wallet view changed after rejection journal; click was not issued');
            }
            actionAttempted = true;
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
        if (!pumpRunning || Date.now() >= DEADLINE) return;
        await requireFreshConsent(page, snapshot);
        if (kind === 'signature' && signatureApprovals !== 0) throw new Error('A second invoice signature approval is forbidden');
        actedRequests.add(key);
        if (kind === 'signature') signatureApprovals++;
        if (kind === 'transaction') transactionApprovals++;
        walletPromptActions++;
        await journalWalletAction(kind, 'approve');
        if (!pumpRunning || Date.now() >= DEADLINE) return;
        try { await requireFreshConsent(page, snapshot); }
        catch {
          Object.assign(evidence.walletActionJournal.at(-1), { clickIssued: false, skipReason: 'consent-view-changed-after-journal' });
          await persistEvidence();
          throw new Error('Wallet view changed after approval journal; click was not issued');
        }
        actionAttempted = true;
        await confirm.click();
      } catch (error) {
        if (error?.code === 'CONSENT_VIEW_CHANGED') {
          evidence.wallet.transitionalViewSkips = (evidence.wallet.transitionalViewSkips ?? 0) + 1;
          await checkpoint('skip-transitional-consent-view', { reviewKind });
          continue;
        }
        const reason = errorReason(error);
        // A reviewed popup may close during its journaled action. Keep earlier substantive failures
        // even if the target then closes; never replace their safe class/reason with a closure error.
        if (reason === 'target-closed' && (actionAttempted || !pumpRunning)) continue;
        const failure = { kind: 'ui-review-failed', reviewKind, stage, errorClass: errorClass(error), reason, targetClosed: page.isClosed(), at: new Date().toISOString() };
        evidence.firstPumpError ??= failure;
        evidence.confirmationFailure ??= failure;
        pumpError ??= new Error('Wallet confirmation did not complete safely');
        pumpRunning = false;
        await checkpoint('wallet-pump-failed', { reviewKind, reason });
        return;
      }
    }
    await sleep(250);
  }
}
async function connectedAccount(expected) {
  const accounts = await providerRequest('eth_accounts');
  check('Dapp sees the expected task-only selected account', Array.isArray(accounts) && accounts[0]?.toLowerCase() === expected.toLowerCase(), { selected: Array.isArray(accounts) ? accounts[0] : null });
}

async function verifyMissingWebLocks(client, payer, payURL, memo) {
  await setStage('feature-absence-web-locks');
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
    await checkpoint('feature-absence-pay-ui-click');
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
  context.on('console', observeWalletConsole);
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
  await recordExtensionTargets('after-wallet-onboarding-and-account-selection');
  app = await context.newPage();
  await app.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await app.waitForFunction(() => Boolean(window.ethereum?.isMetaMask));
  check('Dapp uses real MetaMask injection', await app.evaluate(() => window.ethereum.isMetaMask === true));
  pumpRunning = true;
  pumpPromise = confirmationPump();
  await setStage('create-signed-invoice');
  await app.locator('#m-chain').selectOption(String(CHAIN_ID));
  await app.locator('#m-to').fill(merchant);
  await app.locator('#m-amount').fill(amountText);
  await app.bringToFront();
  await recordExtensionTargets('before-product-create-invoice-gesture');
  const invoiceResponse = app.waitForResponse((r) => new URL(r.url()).pathname === '/api/invoices' && r.request().method() === 'POST', { timeout: 90_000 });
  invoiceResponse.catch(() => {}); // A preceding UI failure must not leave an unhandled response waiter.
  evidence.wallet.connectionGesture = 'Normal product Create invoice button; harness issues no connection request';
  await beginProductGesture('create-invoice');
  await checkpoint('merchant-invoice-ui-submit');
  await app.locator('#m-go').click();
  const createdResponse = await bounded(() => invoiceResponse, 90_000, { watchPump: true });
  const created = await createdResponse.json();
  check('Invoice was created by the normal merchant UI', createdResponse.status() === 201 && created.ok === true && created.invoice?.signed === true);
  check('Invoice binds expected testnet recipient and amount', created.invoice.chainId === CHAIN_ID && created.invoice.to.toLowerCase() === merchant.toLowerCase() && created.invoice.units === amount.toString());
  check('Saved invoice uses the exact reference reviewed in the wallet', created.invoice.memo === evidence.wallet.reviewedInvoiceClaim?.memo);
  check('MetaMask approved one invoice signature', signatureApprovals === 1);
  evidence.invoice = created.invoice;
  await connectedAccount(merchant); // Read-only observation after the product's normal connection/signature.
  evidence.wallet.chainBeforePayment = await providerRequest('eth_chainId');
  await endProductGesture('signed-invoice-created');
  await appShot('01-signed-invoice');
  await chooseAccount('Account 1');
  await connectedAccount(payer); // Both task accounts were permitted through the actual Connect UI.
  const payURL = new URL(created.invoice.payUrl);
  check('Invoice pay page stays within the local preview', payURL.origin === new URL(ORIGIN).origin);
  await verifyMissingWebLocks(client, payer, payURL, created.invoice.memo);
  await app.goto(payURL.href, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => !(await app.locator('#pv-pay').isDisabled()), 60_000);
  await appShot('02-open-invoice');
  const nonceBefore = (await paymentBaseline(client, payer, 'rejection-test')).pendingNonce;
  await setStage('reject-one-payment');
  confirmMode = 'reject-once';
  await app.bringToFront();
  await recordExtensionTargets('before-product-payer-gesture');
  await beginProductGesture('pay-rejection-check');
  await checkpoint('rejected-payment-ui-request');
  await app.locator('#pv-pay').click();
  await waitFor(async () => {
    await failIfPaymentUnknown();
    return transactionRejections === 1 && /rejected/i.test(await app.locator('#pv-out').innerText());
  }, 90_000);
  check('Explicit wallet rejection leaves no project transaction', await client.getTransactionCount({ address: payer, blockTag: 'pending' }) === nonceBefore);
  await endProductGesture('payment-explicitly-rejected');
  await waitFor(async () => !(await app.locator('#pv-pay').isDisabled()));
  evidence.wallet.chainAfterConnection = await providerRequest('eth_chainId');
  check('Client selected Mezo Testnet before a payment request', Number(evidence.wallet.chainAfterConnection) === CHAIN_ID);
  await appShot('03-wallet-rejected');
  await setStage('send-one-payment');
  const preNonce = (await paymentBaseline(client, payer, 'single-payment')).pendingNonce;
  confirmMode = 'pay-once';
  await app.bringToFront();
  await beginProductGesture('pay-invoice');
  await checkpoint('payment-ui-request');
  await app.locator('#pv-pay').click();
  const hash = await waitFor(async () => {
    await failIfPaymentUnknown();
    const hrefs = await app.locator('#pv-out a[href]').evaluateAll((links) => links.map((a) => a.href));
    return hrefs.map((href) => /\/tx\/(0x[0-9a-fA-F]{64})/.exec(href)?.[1]).find(Boolean);
  }, 120_000);
  evidence.payment = { hash, sender: payer, recipient: merchant, amount: amountText, reference: created.invoice.memo, chainId: CHAIN_ID, sentFromActualBrowserWallet: true };
  evidence.paymentDispatch = 'transaction hash observed; verification pending';
  await persistEvidence();
  await endProductGesture('transaction-hash-observed');
  check('Only one transaction was approved', transactionApprovals === 1);
  await setStage('verify-on-chain');
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 5, timeout: 150_000, pollingInterval: 2_000 });
  const transaction = await client.getTransaction({ hash });
  const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  check('Receipt succeeded on testnet', receipt.status === 'success' && await client.getChainId() === CHAIN_ID);
  check('Transaction and receipt hashes bind the requested payment', transaction.hash.toLowerCase() === hash.toLowerCase() && receipt.transactionHash.toLowerCase() === hash.toLowerCase());
  check('Transaction and receipt share the canonical block', transaction.blockNumber === receipt.blockNumber
    && transaction.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase()
    && canonicalBlock.hash?.toLowerCase() === receipt.blockHash.toLowerCase());
  check('Actual transaction binds payer and MUSD contract', transaction.from.toLowerCase() === payer.toLowerCase() && transaction.to?.toLowerCase() === TOKEN.toLowerCase());
  check('Actual transaction sends zero native value at the observed payer nonce', transaction.value === 0n && transaction.nonce === preNonce);
  const referenceHex = stringToHex(created.invoice.memo).slice(2).toLowerCase();
  const expectedTransferData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [merchant, amount] }).toLowerCase() + referenceHex;
  check('Wallet retained the exact MUSD transfer calldata and invoice reference', transaction.input.toLowerCase() === expectedTransferData);
  let received = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== TOKEN.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (decoded.eventName === 'Transfer' && decoded.args.from.toLowerCase() === payer.toLowerCase()
        && decoded.args.to.toLowerCase() === merchant.toLowerCase()) received += decoded.args.value;
    } catch { /* Other token events do not prove this payment. */ }
  }
  check('MUSD Transfer events bind payer, recipient and exact invoice amount', received === amount, { received: received.toString(), required: amount.toString() });
  const head = await client.getBlockNumber();
  check('Payment has at least five confirmations', head - receipt.blockNumber + 1n >= 5n);
  evidence.payment = { ...evidence.payment, block: receipt.blockNumber.toString(), blockHash: receipt.blockHash, canonicalBlockHash: canonicalBlock.hash, receiptStatus: receipt.status, transactionNonce: transaction.nonce, confirmations: (head - receipt.blockNumber + 1n).toString(), gasUsed: receipt.gasUsed.toString(), received: received.toString(), exactCalldataMatched: true, nativeValue: transaction.value.toString(), explorer: `https://explorer.test.mezo.org/tx/${hash}` };
  evidence.paymentDispatch = 'exact invoice payment verified on chain';
  await setStage('verify-invoice-ui');
  await app.locator('#pv-check').click();
  await waitFor(async () => /^Paid\./i.test((await app.locator('#pv-status').innerText()).trim()), 60_000, 1_000);
  check('Invoice UI says paid and locks Pay', await app.locator('#pv-pay').isDisabled());
  await appShot('04-paid-invoice');
  await setStage('reload-paid-invoice');
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
  await setStage('complete');
} catch (error) {
  pumpRunning = false;
  evidence.failedAt = new Date().toISOString();
  evidence.failure = { stage, type: errorClass(error), reason: errorReason(error) };
  await checkpoint('harness-step-failed', { reason: evidence.failure.reason });
  if (walletReady) await capturePublicPaymentState();
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
    if (wallet && !wallet.isClosed()) await recordExtensionTargets('failure');
    evidence.extensionPages = await Promise.all(context.pages().filter(isExtensionPage).map(pageMetadata));
  }
  if (paymentNeedsReconciliation()) {
    await reconcileUnknownPayment().catch((error) => {
      evidence.unknownPaymentReconciliation = { status: 'unknown-requires-manual-chain-review', automaticResendPermitted: false, errorClass: errorClass(error) };
    });
  }
  await persistEvidence();
  if (context) await context.close().catch(() => {});
  console.log(JSON.stringify({ status: evidence.status, stage, checks: evidence.checks.length, failedChecks: evidence.checks.filter((c) => !c.passed).map((c) => c.name), transaction: evidence.payment?.hash ?? null }));
}
