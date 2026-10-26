// Browser side of the demo. Uses the same library as the API; nothing is checked only on the server.

import { getAddress, stringToHex } from "viem";

import { formatAmount, parseAmount } from "../src/amount.ts";
import { invoiceMessage } from "../src/auth.ts";
import { pct } from "../src/borrow.ts";
import { chainById, CONFIRMATIONS_REQUIRED, MEZO_TESTNET } from "../src/chains.ts";
import { checkPaymentLink, type CheckResult } from "../src/guard.ts";
import { createPaymentLink } from "../src/merchant.ts";
import { payPageLock } from "../src/paystate.ts";
import { newReference } from "../src/invoices.ts";
import { qrSvg } from "../src/qr.ts";

const $ = <T = HTMLInputElement>(id: string) => document.getElementById(id) as unknown as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Show invisible characters so the user can see what the guard saw. */
function visible(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += cp < 0x21 || cp > 0x7e ? `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]` : ch;
  }
  return out;
}

const T = MEZO_TESTNET.musd;
const SHOP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ONE = 10n ** 18n;
function lookalike(a: string): string {
  const i = 20;
  return getAddress(a.slice(0, i) + (a[i] === "0" ? "1" : "0") + a.slice(i + 1));
}
const EXAMPLES: [string, string][] = [
  ["Wrong chain", `ethereum:${T}@1/transfer?address=${SHOP}&uint256=${5n * ONE}`],
  ["Lookalike token", `ethereum:${lookalike(T)}@31611/transfer?address=${SHOP}&uint256=${5n * ONE}`],
  ["Amount overflow", `ethereum:${T}@31611/transfer?address=${SHOP}&uint256=${((1n << 256n) + 5n * ONE).toString()}`],
  ["Over my limit", `ethereum:${T}@31611/transfer?address=${SHOP}&uint256=${5000n * ONE}`],
  ["Bad checksum", `ethereum:${T}@31611/transfer?address=${SHOP.replace("aAeb", "AAeb")}&uint256=${5n * ONE}`],
  ["Zero-width space", `ethereum:${T}@31611/transfer?address=${SHOP.slice(0, 12)}​${SHOP.slice(12)}&uint256=${5n * ONE}`],
  ["Extra parameter", `ethereum:${T}@31611/transfer?address=${SHOP}&uint256=${5n * ONE}&value=1000000000000000000`],
  ["Duplicate address", `ethereum:${T}@31611/transfer?address=${SHOP}&address=${lookalike(SHOP)}&uint256=${5n * ONE}`],
  ["Approve instead of transfer", `ethereum:${T}@31611/approve?address=${SHOP}&uint256=${5n * ONE}`],
];

let lastCheck: CheckResult | null = null;
/** The invoice behind a pay page (/?invoice=...), or null for a plain link. */
let payInvoice: { chainId: number; memo: string; to?: string; units?: string } | null = null;
/** true from the first click on Pay until the attempt ends. A second click while the wallet window is open does nothing. */
let paying = false;
/** Why Pay is locked, or null. A pay page locks Pay when the chain shows a matching payment, or when it cannot tell. */
let payLock: string | null = null;
/** Polling interval of "Watch for this payment". 4 calls a minute, so a merchant who watches stays far below the read limit. */
const WATCH_INTERVAL_MS = 15_000;

function setPayButton(): void {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  const b = $<HTMLButtonElement>("p-pay");
  b.disabled = !(lastCheck?.ok && eth) || payLock !== null || paying;
  b.title = payLock ?? (eth ? "" : "No browser wallet found");
}

function renderVerdict(r: CheckResult): string {
  if (!r.ok) {
    const items = r.reasons.map((x) => `<li><code>${esc(x.code)}</code> ${esc(x.message)}</li>`).join("");
    return `<div class="verdict bad"><strong>Refused. No transfer was built.</strong><ul>${items}</ul></div>`;
  }
  const p = r.payment;
  const chain = chainById(p.chainId)!;
  const warn = r.warnings.length ? r.warnings.map((w) => `<div class="note"><code>${esc(w.code)}</code> ${esc(w.message)}</div>`).join("") : "";
  return `<div class="verdict ok"><strong>${r.warnings.length ? "Safe to pay after one check. Read the warning." : "Safe to pay. All checks passed."}</strong>${warn}
    <dl class="kv">
      <dt>Network</dt><dd>${esc(p.chainName)} (${p.chainId})</dd>
      <dt>Token</dt><dd><a href="${chain.explorer}/token/${p.token}" target="_blank" rel="noopener">MUSD ${esc(p.token)}</a></dd>
      <dt>Recipient</dt><dd>${esc(p.recipient)}</dd>
      <dt>Amount</dt><dd>${esc(p.amountText)} MUSD</dd>
      ${p.memo ? `<dt>Reference</dt><dd>${esc(p.memo)}</dd>` : ""}
    </dl>
    <div class="muted" style="margin-top:8px">Transaction to sign (value 0, call to the MUSD contract)</div>
    <pre>${esc(JSON.stringify({ chainId: r.tx.chainId, to: r.tx.to, value: "0", data: r.tx.data }, null, 2))}</pre></div>`;
}

function runCheck(): void {
  const link = $<HTMLTextAreaElement>("p-link").value;
  const allow = $<HTMLTextAreaElement>("p-allow").value.split(/\s+/).filter(Boolean);
  const net = $<HTMLSelectElement>("p-net").value;
  const r = checkPaymentLink(link, {
    allowedChains: net === "both" ? undefined : [Number(net)],
    maxAmount: $("p-max").value.trim(),
    allowlist: allow.length ? allow : undefined,
    requireChecksum: $<HTMLSelectElement>("p-check").value === "1",
  });
  lastCheck = r;
  const shown = /[^\x21-\x7e]/.test(link) ? `<div class="muted">What the guard sees</div><div class="mono">${esc(visible(link))}</div>` : "";
  $("p-out").innerHTML = shown + renderVerdict(r) + (payLock ? `<div class="note">${esc(payLock)}</div>` : "");
  setPayButton();
}

// Invoices live in the Worker's KV store, so they survive a reload and work on another device.
interface ServerInvoice {
  chainId: number; to: string; amount: string; units: string; memo: string; fromBlock: number; createdAt: string; link: string;
  payUrl: string; explorer: string | null; signed?: boolean; paid?: { txHash: string; block: number; from: string; amount: string };
}
interface InvoiceAnswer {
  status: string; checked?: boolean; http?: number; partial?: InboxPayment[]; invoice?: ServerInvoice; possible?: InboxPayment[]; clamped?: boolean; truncated?: boolean; head?: number; message?: string; error?: string;
  reasons?: { code: string; message: string }[]; payment?: InboxPayment & { explorer?: string }; confirmations?: number; required?: number;
}
interface InboxPayment { txHash: string; block: number; from: string; amount: string; memo: string | null; possible?: boolean | null }

let memoEdited = false;

async function loadInvoices(): Promise<void> {
  const box = $("m-list");
  const chain = $<HTMLSelectElement>("m-chain").value;
  const to = $("m-to").value.trim();
  try {
    const res = await fetch(`/api/invoices?chain=${chain}&to=${encodeURIComponent(to)}`);
    const v = (await res.json()) as { invoices?: ServerInvoice[]; error?: string };
    if (!v.invoices) throw new Error(v.error ?? `HTTP ${res.status}`);
    if (v.invoices.length === 0) {
      box.innerHTML = `<div class="muted">No invoices for this address yet.</div>`;
      return;
    }
    box.innerHTML = `<table class="inv"><thead><tr><th>Reference</th><th>MUSD</th><th>Status</th><th></th></tr></thead><tbody>${v.invoices
      .map((x, i) => `<tr><td class="mono-cell"><a href="${esc(x.payUrl)}" target="_blank" rel="noopener">${esc(x.memo)}</a></td><td>${esc(x.amount)}${x.signed ? "" : ` <span class="muted" title="Made before invoices were signed (26 October 2026)">unsigned</span>`}</td><td id="inv-st-${i}">${x.paid && x.explorer ? `<a href="${esc(x.explorer)}" target="_blank" rel="noopener">paid</a>` : "open"}</td><td>${x.paid ? "" : `<button class="ghost small" data-memo="${esc(x.memo)}" data-i="${i}">Check</button>`}</td></tr>`)
      .join("")}</tbody></table>`;
    box.querySelectorAll<HTMLButtonElement>("button[data-memo]").forEach((b) => {
      b.onclick = async () => {
        const cell = $(`inv-st-${b.dataset.i}`);
        cell.textContent = "checking...";
        const a = await fetchInvoice(Number(chain), b.dataset.memo!, true);
        cell.innerHTML = a.status === "paid" && a.invoice?.explorer ? `<a href="${esc(a.invoice.explorer)}" target="_blank" rel="noopener">paid</a>`
          : a.status === "confirming" ? esc(`confirming, ${a.confirmations} of ${a.required}`)
          : esc(a.status === "open" ? (a.possible?.length ? "open, possible match" : "open") : (a.message ?? a.error ?? a.status));
      };
    });
  } catch (e) {
    box.innerHTML = `<div class="muted">Could not load the invoices (${esc((e as Error).message)}).</div>`;
  }
}

async function fetchInvoice(chainId: number, memo: string, check: boolean): Promise<InvoiceAnswer> {
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(memo)}?chain=${chainId}${check ? "" : "&check=0"}`);
    return { ...((await res.json()) as InvoiceAnswer), http: res.status };
  } catch {
    return { status: "unavailable", message: "The network did not answer." };
  }
}

async function headBlock(chainId: number): Promise<number | null> {
  try {
    const r = (await (await fetch(`/api/head?chain=${chainId}`)).json()) as { block?: number };
    return typeof r.block === "number" ? r.block : null;
  } catch {
    return null;
  }
}

let watchTimer: number | null = null;

async function runCreate(fillVerify = true): Promise<void> {
  if (fillVerify && !memoEdited) $("m-memo").value = "";
  const chainId = Number($<HTMLSelectElement>("m-chain").value);
  const local = createPaymentLink({ chainId, recipient: $("m-to").value, amount: $("m-amount").value, memo: $("m-memo").value || "INV-PREVIEW" });
  if (!local.ok) {
    $("m-out").innerHTML = renderVerdict(local);
    return;
  }
  if (!fillVerify) {
    // First paint: show a preview without writing an invoice.
    $("m-out").innerHTML = `<div class="muted">Press "Create invoice" to save an invoice with a fresh reference and get its pay page. Your wallet signs it as the recipient.</div>
      <div class="qr" role="img" aria-label="QR code preview">${qrSvg(local.link)}</div>`;
    return;
  }
  // Only the wallet that receives the payment can save an invoice for it. It signs a message (free, no transaction).
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) {
    $("m-out").innerHTML = `<div class="verdict bad"><strong>Saving an invoice needs a browser wallet that holds the recipient address.</strong> The wallet signs a message. It sends no transaction and costs nothing. Without a wallet you can still use this plain link and QR code. It is not saved and has no invoice page.</div>
      <div class="mono">${esc(local.link)}</div><div class="qr" role="img" aria-label="QR code of the plain link">${qrSvg(local.link)}</div>`;
    return;
  }
  let a: InvoiceAnswer & { ok?: boolean; qrSvg?: string };
  try {
    const [account] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!account || account.toLowerCase() !== local.payment.recipient.toLowerCase()) {
      const mine = account ? getAddress(account) : "";
      $("m-out").innerHTML = `<div class="verdict bad"><strong>Only the recipient can save this invoice.</strong> Your wallet is ${esc(mine || "not connected")}. The recipient is ${esc(local.payment.recipient)}.
        ${mine ? `<div class="actions"><button class="ghost" id="m-use-mine" type="button">Use my wallet address</button></div>` : ""}</div>`;
      const use = document.getElementById("m-use-mine");
      if (use) use.onclick = () => {
        $("m-to").value = mine;
        void loadInvoices();
        void runCreate();
      };
      return;
    }
    const memo = memoEdited ? $("m-memo").value.trim() : newReference();
    const claim = { chainId, to: local.payment.recipient, amount: local.payment.amountText, memo, timestamp: Math.floor(Date.now() / 1000) };
    $("m-out").innerHTML = `<div class="muted">Sign the invoice in your wallet. It is a message, not a transaction.</div>`;
    const signature = (await eth.request({ method: "personal_sign", params: [stringToHex(invoiceMessage(claim)), account] })) as string;
    $("m-out").innerHTML = `<div class="muted">Saving the invoice and stamping it with the current block...</div>`;
    const res = await fetch("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain: chainId, to: claim.to, amount: claim.amount, memo, timestamp: claim.timestamp, signature }),
    });
    a = (await res.json()) as typeof a;
  } catch (e) {
    const msg = (e as { message?: string }).message;
    a = { status: "unavailable", error: msg ? `Not saved. ${msg}` : "The network did not answer." };
  }
  if (!a.ok || !a.invoice) {
    const reasons = a.reasons ?? [{ code: "unavailable", message: a.error ?? a.message ?? "The invoice was not saved." }];
    $("m-out").innerHTML = renderVerdict({ ok: false, reasons });
    return;
  }
  const inv = a.invoice;
  memoEdited = false;
  $("m-memo").value = inv.memo;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(inv.payUrl)}&text=${encodeURIComponent(`Please pay ${inv.amount} MUSD on ${chainById(chainId)!.name}, invoice ${inv.memo}`)}`;
  $("m-out").innerHTML = `<div class="verdict ok"><strong>Invoice ${esc(inv.memo)} saved. Stamped at block ${inv.fromBlock.toLocaleString("en-US")}.</strong> Payments mined before it do not count, and this reference is unique on ${esc(chainById(chainId)!.name)}.</div>
    <div class="muted" style="margin-top:10px">EIP-681 link</div><div class="mono">${esc(inv.link)}</div>
    <div class="qr" role="img" aria-label="QR code of the payment link">${a.qrSvg ?? qrSvg(inv.link)}</div>
    <div class="muted" style="margin-top:10px">Pay page to send in a chat</div><div class="mono">${esc(inv.payUrl)}</div>
    <div class="actions"><button class="ghost" id="m-copy">Copy link</button><button class="ghost" id="m-copy-page">Copy pay page</button>
    <a class="button ghost" href="${esc(tg)}" target="_blank" rel="noopener">Share in Telegram</a>
    <button class="ghost" id="m-send">Check it as the payer</button></div>
    <div class="actions"><button id="m-watch">Watch for this payment</button></div>
    <div class="out" id="m-watch-out" aria-live="polite"></div>`;
  $("m-copy").onclick = () => navigator.clipboard?.writeText(inv.link);
  $("m-copy-page").onclick = () => navigator.clipboard?.writeText(inv.payUrl);
  $("m-send").onclick = () => {
    $<HTMLSelectElement>("p-net").value = String(chainId);
    $<HTMLTextAreaElement>("p-link").value = inv.link;
    runCheck();
    $("p-h").scrollIntoView({ behavior: "smooth" });
  };
  $("m-watch").onclick = () => void watchInvoice(chainId, inv.memo);
  // Fill the confirm panel with this invoice, so the merchant can also check a hash by hand.
  $<HTMLSelectElement>("v-chain").value = String(chainId);
  $("v-to").value = inv.to;
  $("v-amount").value = inv.amount;
  $("v-memo").value = inv.memo;
  $("v-from").value = String(inv.fromBlock);
  $("v-tx").value = "";
  void loadInvoices();
}

function renderInvoiceAnswer(a: InvoiceAnswer): string {
  const inv = a.invoice;
  if (a.status === "paid" && inv?.paid) {
    return `<div class="verdict ok"><strong>Paid. ${esc(inv.paid.amount)} MUSD with reference ${esc(inv.memo)}.</strong>
      <dl class="kv"><dt>From</dt><dd>${esc(inv.paid.from)}</dd><dt>Block</dt><dd>${inv.paid.block}</dd>
      <dt>Transaction</dt><dd><a href="${esc(inv.explorer ?? "")}" target="_blank" rel="noopener">${esc(inv.paid.txHash)}</a></dd></dl></div>`;
  }
  if (a.status === "confirming" && a.payment) {
    return `<div class="verdict ok"><strong>Payment found. ${esc(String(a.confirmations))} of ${esc(String(a.required))} confirmations.</strong> The invoice is recorded as paid at ${esc(String(a.required))} confirmations, about 20 seconds.
      <dl class="kv"><dt>Transaction</dt><dd><a href="${esc(a.payment.explorer ?? "")}" target="_blank" rel="noopener">${esc(a.payment.txHash)}</a></dd></dl></div>`;
  }
  if (a.status !== "open") return `<div class="muted">${esc(a.message ?? a.error ?? a.status)} Trying again.</div>`;
  const possible = a.possible ?? [];
  const maybe = possible.length
    ? `<div class="verdict bad" style="margin-top:8px"><strong>Possible match. ${possible.length} payment(s) of exactly this amount arrived without a reference.</strong> Some wallets drop the reference. Ask the payer which one is theirs, then confirm it by hash in panel 3.</div>`
    : "";
  const warn = [
    a.clamped ? "The invoice is older than the search window (about 23 hours), so earlier blocks were not searched. Confirm by hash in panel 3." : "",
    a.truncated ? "This address receives many payments. Only the newest 50 were read. Confirm by hash in panel 3." : "",
  ].filter(Boolean).map((w) => `<div class="note">${esc(w)}</div>`).join("");
  return `<div class="muted">No payment with reference ${esc(inv?.memo ?? "")} yet. Searched up to block ${(a.head ?? 0).toLocaleString("en-US")}.</div>${maybe}${warn}`;
}

async function watchInvoice(chainId: number, memo: string): Promise<void> {
  if (watchTimer !== null) clearTimeout(watchTimer);
  const out = $("m-watch-out");
  const started = Date.now();
  out.innerHTML = `<div class="muted">Watching the MUSD contract for invoice ${esc(memo)}...</div>`;
  const tick = async () => {
    const a = await fetchInvoice(chainId, memo, true);
    out.innerHTML = renderInvoiceAnswer(a);
    if (a.status === "paid") {
      void loadInvoices();
      return;
    }
    if (Date.now() - started > 15 * 60_000) return;
    watchTimer = window.setTimeout(() => void tick(), WATCH_INTERVAL_MS);
  };
  await tick();
}

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/**
 * Pay page state from a chain check of the invoice. Pay stays locked unless the chain shows that the
 * invoice is open and the search covered every block since the invoice was created.
 */
/** Payments without the reference (or too small) that the payer said are not theirs. They no longer lock Pay. */
const acknowledged = new Set<string>();
function withoutAcknowledged(a: InvoiceAnswer): InvoiceAnswer {
  const keep = (l?: InboxPayment[]) => l?.filter((x) => !acknowledged.has(x.txHash.toLowerCase()));
  return { ...a, possible: keep(a.possible), partial: keep(a.partial) };
}

function applyInvoiceState(answer: InvoiceAnswer): void {
  const a = withoutAcknowledged(answer);
  const inv = a.invoice;
  const banner = $("pay-banner");
  const again = `<div class="actions"><button class="ghost small" id="pay-recheck" type="button">Check again</button></div>`;
  const lock = payPageLock(a);
  if (lock === "not_found") {
    payLock = "This invoice was not found.";
    banner.innerHTML = `<strong>${esc(a.error ?? "This invoice was not found.")}</strong>`;
  } else if (lock === "paid" && inv) {
    payLock = "This invoice is already paid. Do not pay it again.";
    banner.innerHTML = `<strong>Invoice ${esc(inv.memo)} is already paid.</strong> Do not pay it again. <a href="${esc(inv.explorer ?? "")}" target="_blank" rel="noopener">See the payment</a>.`;
  } else if (lock === "confirming" && inv) {
    payLock = "A payment for this invoice is already on chain. Do not pay it again.";
    banner.innerHTML = `<strong>A payment for invoice ${esc(inv.memo)} is on chain, ${esc(String(a.confirmations))} of ${esc(String(a.required))} confirmations.</strong> Do not pay it again. <a href="${esc(a.payment?.explorer ?? "")}" target="_blank" rel="noopener">See the payment</a>.${again}`;
  } else if (lock === "cannot_prove" && inv) {
    payLock = "This page cannot prove that the invoice is unpaid.";
    banner.innerHTML = `<strong>Invoice ${esc(inv.memo)}. This page cannot prove that it is unpaid.</strong> ${a.clamped ? "The invoice is older than the search window of about 23 hours." : "The merchant address has more payments than the page reads."} Ask the merchant for a new invoice.`;
  } else if ((lock === "possible" || lock === "partial") && inv) {
    const list = (lock === "partial" ? a.partial : a.possible) ?? [];
    payLock = lock === "partial" ? "A smaller payment with this reference exists. Ask the merchant before you pay." : "A payment of exactly this amount without the reference exists. Check that it is not yours.";
    const rows = list.map((x) => `<li>${esc(x.amount)} MUSD from ${esc(x.from)} in block ${x.block}</li>`).join("");
    const head = lock === "partial"
      ? `Invoice ${esc(inv.memo)}. ${list.length} payment(s) with this reference but less than ${esc(inv.amount)} MUSD arrived.</strong> Paying the full amount again would overpay. Ask the merchant how much is still open.`
      : `Invoice ${esc(inv.memo)}. ${list.length} payment(s) of exactly ${esc(inv.amount)} MUSD arrived without the reference.</strong> Some wallets drop the reference. If one of these is yours, do not pay again.`;
    banner.innerHTML = `<strong>${head}<ul>${rows}</ul>
      <div class="actions"><button class="ghost small" id="pay-unlock" type="button">${lock === "partial" ? "The merchant told me to pay. Unlock Pay" : "None of these is mine. Unlock Pay"}</button></div>`;
    const unlock = document.getElementById("pay-unlock");
    if (unlock) unlock.onclick = () => {
      for (const x of list) acknowledged.add(x.txHash.toLowerCase());
      applyInvoiceState(answer);
      runCheck();
    };
  } else if (lock === null && inv) {
    payLock = null;
    banner.innerHTML = `<strong>Invoice ${esc(inv.memo)}. ${esc(inv.amount)} MUSD on ${esc(chainById(inv.chainId)?.name ?? "")}.</strong> The chain shows no payment for it up to block ${(a.head ?? 0).toLocaleString("en-US")}. The guard below checked the link in your browser. Set your limit, then pay from your wallet or check your balance first.`;
  } else {
    payLock = "The chain could not be checked, so Pay is locked.";
    banner.innerHTML = `<strong>Could not check on chain whether invoice ${esc(inv?.memo ?? payInvoice?.memo ?? "")} is paid.</strong> ${esc(a.error ?? a.message ?? "")} Pay is locked until the check works.${again}`;
  }
  const btn = document.getElementById("pay-recheck");
  if (btn && payInvoice) btn.onclick = () => void loadPayInvoice(payInvoice!.chainId, payInvoice!.memo);
  setPayButton();
}

/** The hash this browser sent for an invoice, so a reload or a second tab does not pay again before the chain shows it. */
const sentKey = (chainId: number, memo: string) => `musd-sent:${chainId}:${memo}`;
/** A sent hash that the chain still does not know after this long was dropped, so it no longer locks Pay. */
const SENT_FORGET_MS = 15 * 60_000;
function readSent(chainId: number, memo: string): { hash: string; at: number } | null {
  try {
    const [hash, at] = (localStorage.getItem(sentKey(chainId, memo)) ?? "").split("|");
    return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? { hash, at: Number(at) || 0 } : null;
  } catch {
    return null;
  }
}
function writeSent(chainId: number, memo: string, hash: string | null): void {
  try {
    if (hash) localStorage.setItem(sentKey(chainId, memo), `${hash}|${Date.now()}`);
    else localStorage.removeItem(sentKey(chainId, memo));
  } catch {
    // Storage can be blocked. The chain check still runs.
  }
}

/**
 * A payment this browser sent for the invoice locks Pay, unless the chain says it reverted.
 * Returns true when Pay was locked for this reason.
 */
async function lockIfSentHere(chainId: number, memo: string, a: InvoiceAnswer): Promise<boolean> {
  const sent = readSent(chainId, memo);
  if (!sent || !a.invoice || payPageLock(withoutAcknowledged(a)) !== null) return false;
  const hash = sent.hash;
  const chain = chainById(chainId)!;
  try {
    const q = new URLSearchParams({ chain: String(chainId), tx: hash, to: a.invoice.to, amount: a.invoice.amount, memo, from_block: String(a.invoice.fromBlock) });
    const v = (await (await fetch(`/api/verify?${q}`)).json()) as { status?: string };
    const dropped = v.status === "not_found" && Date.now() - sent.at > SENT_FORGET_MS;
    if (v.status === "failed" || v.status === "mismatch" || dropped) {
      writeSent(chainId, memo, null);
      return false;
    }
  } catch {
    // Keep the lock when the check fails.
  }
  payLock = "This browser already sent a payment for this invoice.";
  $("pay-banner").innerHTML = `<strong>This browser already sent a payment for invoice ${esc(memo)}.</strong> The chain does not show it as final yet. Do not pay again. <a href="${chain.explorer}/tx/${esc(hash)}" target="_blank" rel="noopener">See the payment</a>.
    <div class="actions"><button class="ghost small" id="pay-recheck" type="button">Check again</button></div>`;
  const btn = document.getElementById("pay-recheck");
  if (btn) btn.onclick = () => void loadPayInvoice(chainId, memo);
  setPayButton();
  return true;
}

async function loadPayInvoice(chainId: number, memo: string): Promise<InvoiceAnswer> {
  payInvoice = { chainId, memo };
  payLock = "Checking the chain for an earlier payment...";
  setPayButton();
  $("pay-banner").innerHTML = `<strong>Checking the chain for a payment of invoice ${esc(memo)}...</strong>`;
  const a = await fetchInvoice(chainId, memo, true);
  if (a.invoice) {
    payInvoice = { chainId, memo, to: a.invoice.to, units: a.invoice.units };
    $<HTMLSelectElement>("p-net").value = String(chainId);
    $<HTMLTextAreaElement>("p-link").value = a.invoice.link;
  }
  applyInvoiceState(a);
  await lockIfSentHere(chainId, memo, a);
  if (a.invoice) runCheck();
  return a;
}

async function confirmByHash(chainId: number, memo: string, tx: string): Promise<InvoiceAnswer> {
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(memo)}/confirm?chain=${chainId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx }),
    });
    return (await res.json()) as InvoiceAnswer;
  } catch {
    return { status: "unavailable", message: "The network did not answer." };
  }
}

/** Stop when the link in the box is not the invoice of this pay page, for example after a chip replaced it. */
function linkMatchesInvoice(payment: { recipient: string; amount: bigint; memo: string | null }): boolean {
  if (!payInvoice) return true;
  return !!payInvoice.to && payment.recipient.toLowerCase() === payInvoice.to.toLowerCase() && payment.amount.toString() === payInvoice.units && payment.memo === payInvoice.memo;
}

/** Ask the chain again. Returns false and shows why when Pay must stay locked. */
async function recheckBeforeSend(): Promise<boolean> {
  if (!payInvoice) return true;
  const a = await fetchInvoice(payInvoice.chainId, payInvoice.memo, true);
  applyInvoiceState(a);
  await lockIfSentHere(payInvoice.chainId, payInvoice.memo, a);
  return payLock === null;
}

async function payWithWallet(): Promise<void> {
  if (!lastCheck || !lastCheck.ok || payLock || paying) return;
  paying = true; // before any await, so a second click cannot start a second payment
  setPayButton();
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  const { tx, payment } = lastCheck;
  const chain = chainById(tx.chainId)!;
  const out = $("p-out");
  const check = lastCheck;
  const status = (html: string) => (out.innerHTML = renderVerdict(check) + `<div class="note">${html}</div>`);
  let hash: string | null = null;
  try {
    if (!eth) return;
    if (!linkMatchesInvoice(payment)) {
      status("The link in the box is not the invoice of this page. Reload the page to pay the invoice. Nothing was sent.");
      return;
    }
    const [from] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    const hexId = "0x" + chain.id.toString(16);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hexId, chainName: chain.name, nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 }, rpcUrls: [chain.rpc], blockExplorerUrls: [chain.explorer] }],
      });
    }
    const bal = (await (await fetch(`/api/balance?chain=${chain.id}&address=${from}`)).json()) as { balance?: string; error?: string };
    if (!bal.balance) throw new Error(bal.error ?? "balance read failed");
    if (BigInt(bal.balance) < payment.amount) {
      status(`Your wallet holds ${esc(formatAmount(BigInt(bal.balance)))} MUSD on ${esc(chain.name)}, less than ${esc(payment.amountText)}. Nothing was sent. See below how much BTC would mint the rest.`);
      $("b-need").value = formatAmount(payment.amount - BigInt(bal.balance));
      $<HTMLSelectElement>("b-chain").value = String(chain.id);
      void runBorrow();
      return;
    }
    // Check the chain again right before the wallet window opens. The page may have been open for a long time.
    if (!(await recheckBeforeSend())) {
      status(`${esc(payLock ?? "Pay is locked.")} Nothing was sent.`);
      return;
    }
    hash = (await eth.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, value: "0x0", data: tx.data }] })) as string;
  } catch (e) {
    status(`Wallet error. ${esc((e as Error).message ?? String(e))} Nothing was sent.`);
  } finally {
    if (!hash) {
      paying = false;
      setPayButton();
    }
  }
  if (!hash) return;
  // From here the money has left. The page never offers to pay again and never says "error" for a network hiccup.
  if (payInvoice) writeSent(payInvoice.chainId, payInvoice.memo, hash);
  payLock = "You sent a payment from this page. Do not pay again.";
  paying = false;
  setPayButton();
  await followPayment(hash, payment, chain, status);
}

async function followPayment(hash: string, payment: { recipient: string; amountText: string; memo: string | null }, chain: NonNullable<ReturnType<typeof chainById>>, status: (html: string) => void): Promise<void> {
  const link = `<a href="${chain.explorer}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(hash)}</a>`;
  status(`Sent. ${link}. Waiting for the receipt. Do not pay again.`);
  const q = new URLSearchParams({ chain: String(chain.id), tx: hash, to: payment.recipient, amount: payment.amountText, memo: payment.memo ?? "" });
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 4000));
    let v: { status?: string; confirmations?: number; message?: string };
    try {
      v = (await (await fetch(`/api/verify?${q}`)).json()) as typeof v;
    } catch {
      continue; // a 502 page or a dropped connection, ask again
    }
    if (v.status === "paid" && (v.confirmations ?? 0) < CONFIRMATIONS_REQUIRED) {
      status(`Mined. ${link}. ${v.confirmations} of ${CONFIRMATIONS_REQUIRED} confirmations. Do not pay again.`);
      continue;
    }
    if (v.status === "paid") {
      let rec = "";
      if (payInvoice) {
        const c = await confirmByHash(payInvoice.chainId, payInvoice.memo, hash);
        rec = c.status === "paid" ? ` Invoice ${esc(payInvoice.memo)} is recorded as paid.`
          : c.status === "already_paid" ? ` <strong>The invoice was already paid by another transaction, so this is a second payment.</strong> Ask the merchant for a refund.`
          : ` The invoice is not recorded yet (${esc(c.message ?? c.status)}). It is recorded on the next check, or the merchant can record it by hash.`;
      }
      status(`Confirmed on chain. ${esc(payment.amountText)} MUSD received, ${v.confirmations} confirmations. ${link}.${rec}`);
      return;
    }
    if (v.status === "failed" || v.status === "mismatch") {
      if (payInvoice) writeSent(payInvoice.chainId, payInvoice.memo, null);
      status(`${esc(v.message ?? v.status)} ${link}. Reload the page before you try again.`);
      return;
    }
    // pending, not_found, unavailable, 429: ask again
  }
  status(`No final answer after 160 seconds. ${link}. Do not pay again. Reload the page to see the state of the invoice.`);
}

const VERIFY_RETRY_MESSAGE = "The network did not answer in time. Try again in a moment.";
const VERIFY_NOT_FOUND_MESSAGE = "No transaction with this hash on this network. Check the hash and the network.";
const VERIFY_TRIES = 3;

function renderVerify(v: Record<string, unknown>, paid: boolean, memo: string): string {
  const head = paid ? `Paid. ${esc(String(v.paid))} MUSD reached the recipient.` : esc(String(v.message ?? v.error ?? v.status));
  const deep = Number(v.confirmations ?? 0) >= CONFIRMATIONS_REQUIRED;
  return `<div class="verdict ${paid ? "ok" : "bad"}"><strong>${head}</strong>
    ${paid ? `<dl class="kv"><dt>Block</dt><dd>${v.block}</dd><dt>Confirmations</dt><dd>${v.confirmations} (${deep ? "final" : `${CONFIRMATIONS_REQUIRED} needed`})</dd><dt>Reference</dt><dd>${v.memoMatched === null ? "not checked" : v.memoMatched ? "matches" : "does not match"}</dd></dl>` : ""}
    ${v.explorer ? `<div style="margin-top:6px"><a href="${esc(String(v.explorer))}" target="_blank" rel="noopener">Open in explorer</a></div>` : ""}
    ${paid && memo ? `<div class="actions"><button class="ghost small" id="v-record" type="button">Record invoice ${esc(memo)} as paid</button></div><div id="v-record-out" class="muted"></div>` : ""}</div>`;
}

async function runVerify(): Promise<void> {
  const q = new URLSearchParams({
    chain: $<HTMLSelectElement>("v-chain").value,
    tx: $("v-tx").value.trim(),
    to: $("v-to").value.trim(),
    amount: $("v-amount").value.trim(),
    memo: $("v-memo").value.trim(),
    from_block: $("v-from").value.trim(),
  });
  const out = $("v-out");
  for (let attempt = 1; attempt <= VERIFY_TRIES; attempt++) {
    out.innerHTML = `<div class="muted">Reading the receipt from Mezo, attempt ${attempt} of ${VERIFY_TRIES}...</div>`;
    let v: Record<string, unknown>;
    try {
      const res = await fetch(`/api/verify?${q}`);
      v = (await res.json()) as Record<string, unknown>;
    } catch {
      v = { status: "unavailable" };
    }
    const status = String(v.status ?? (v.error ? "unavailable" : ""));
    if (status === "not_found" || status === "pending" || status === "unavailable") {
      if (attempt < VERIFY_TRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      out.innerHTML = `<div class="verdict bad"><strong>${esc(status === "not_found" ? VERIFY_NOT_FOUND_MESSAGE : VERIFY_RETRY_MESSAGE)}</strong></div>`;
      return;
    }
    out.innerHTML = renderVerify(v, status === "paid", q.get("memo") ?? "");
    const rec = document.getElementById("v-record");
    if (rec) {
      rec.onclick = async () => {
        const c = await confirmByHash(Number(q.get("chain")), q.get("memo")!, q.get("tx")!);
        $("v-record-out").textContent = c.status === "paid" ? (c.message ?? `Invoice ${q.get("memo")} is recorded as paid.`) : c.status === "confirming" ? `${c.confirmations} of ${c.required} confirmations. Press again in a few seconds.` : (c.message ?? c.error ?? c.status);
        void loadInvoices();
      };
    }
    return;
  }
}

interface BorrowAnswer {
  error?: string;
  borrowAt: string;
  terms: { price: string; mcr: string; ccr: string; minNetDebt: string; gasCompensation: string; borrowingRate: string; interestRateBps: number; tcr: string; recoveryMode: boolean; troves: number };
  quote: { need: string; borrow: string; fee: string; totalDebt: string; ratio: string; collateral: string; minCollateral: string; liquidationPrice: string; yearlyInterest: string; notes: string[] };
}

const usd = (units: string) => Number(formatAmount(BigInt(units)).split(".")[0]).toLocaleString("en-US");
const btc = (units: string) => {
  const [w, f = ""] = formatAmount(BigInt(units)).split(".");
  return f ? `${w}.${f.slice(0, 8).replace(/0+$/, "") || "0"}` : w!;
};
const musd = (units: string) => {
  const [w, f = ""] = formatAmount(BigInt(units)).split(".");
  return `${Number(w).toLocaleString("en-US")}${f ? "." + f.slice(0, 2).padEnd(2, "0") : ""}`;
};

async function runBorrow(): Promise<void> {
  const chain = $<HTMLSelectElement>("b-chain").value;
  const need = $("b-need").value.trim();
  const ratio = $("b-ratio").value.trim();
  const out = $("b-out");
  if (parseAmount(need) === null) {
    out.innerHTML = `<div class="verdict bad"><strong>Enter the MUSD you need, for example 25.</strong></div>`;
    return;
  }
  out.innerHTML = `<div class="muted">Reading the MUSD protocol contracts...</div>`;
  try {
    const q = new URLSearchParams({ chain, need, ratio });
    const res = await fetch(`/api/borrow?${q}`);
    const v = (await res.json()) as BorrowAnswer;
    if (!res.ok || v.error) throw new Error(v.error ?? `HTTP ${res.status}`);
    const t = v.terms;
    const k = v.quote;
    const rate = (Number(BigInt(t.borrowingRate) * 10000n / 10n ** 18n) / 100).toString();
    out.innerHTML = `<div class="verdict ok"><strong>Lock ${btc(k.collateral)} BTC to mint ${musd(k.borrow)} MUSD at a ${pct(BigInt(k.ratio))} ratio.</strong>
      <dl class="kv">
        <dt>BTC price (PriceFeed)</dt><dd>${usd(t.price)} USD</dd>
        <dt>Debt on the trove</dt><dd>${musd(k.totalDebt)} MUSD (${musd(k.borrow)} borrowed, ${musd(k.fee)} fee at ${rate}%, ${musd(t.gasCompensation)} gas compensation)</dd>
        <dt>Hard floor at MCR ${pct(BigInt(t.mcr))}</dt><dd>${btc(k.minCollateral)} BTC</dd>
        <dt>Liquidation price</dt><dd>${usd(k.liquidationPrice)} USD per BTC</dd>
        <dt>Interest</dt><dd>${(t.interestRateBps / 100).toString()}% a year fixed, about ${musd(k.yearlyInterest)} MUSD a year</dd>
        <dt>System</dt><dd>${t.troves} trove${t.troves === 1 ? "" : "s"}, total ratio ${pct(BigInt(t.tcr))}, recovery mode ${t.recoveryMode ? "on" : "off"}</dd>
      </dl>
      <ul class="muted">${k.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      <div class="actions"><a class="button" href="${esc(v.borrowAt)}" target="_blank" rel="noopener">Borrow MUSD in the Mezo app (borrow page)</a></div></div>`;
  } catch (e) {
    out.innerHTML = `<div class="verdict bad"><strong>Could not read the MUSD protocol right now. ${esc((e as Error).message)}</strong></div>`;
  }
}

async function runCanPay(): Promise<void> {
  const out = $("p-bal-out");
  if (!lastCheck || !lastCheck.ok) {
    out.innerHTML = `<div class="muted">Check a valid link first.</div>`;
    return;
  }
  const addr = $("p-from").value.trim();
  const { payment } = lastCheck;
  try {
    const res = await fetch(`/api/balance?chain=${payment.chainId}&address=${encodeURIComponent(addr)}`);
    const bal = (await res.json()) as { balance?: string; error?: string };
    if (!bal.balance) throw new Error(bal.error ?? `HTTP ${res.status}`);
    const have = BigInt(bal.balance);
    if (have >= payment.amount) {
      out.innerHTML = `<div class="verdict ok"><strong>This address holds ${esc(formatAmount(have))} MUSD. Enough to pay ${esc(payment.amountText)} MUSD.</strong></div>`;
      return;
    }
    out.innerHTML = `<div class="verdict bad"><strong>This address holds ${esc(formatAmount(have))} MUSD, short by ${esc(formatAmount(payment.amount - have))}. You can mint MUSD against BTC without selling it. The quote is below.</strong></div>`;
    $("b-need").value = formatAmount(payment.amount - have);
    $<HTMLSelectElement>("b-chain").value = String(payment.chainId);
    void runBorrow();
  } catch (e) {
    out.innerHTML = `<div class="verdict bad"><strong>${esc((e as Error).message)}</strong></div>`;
  }
}

async function loadLive(): Promise<void> {
  try {
    const r = (await (await fetch("/api/token?chain=all")).json()) as { tokens: { chainId: number; address: string; name: string; symbol: string; decimals: number; totalSupply: string; block: number }[] };
    $("live-cards").innerHTML = r.tokens
      .map((t) => {
        const c = chainById(t.chainId)!;
        const supply = Number(t.totalSupply.split(".")[0]).toLocaleString("en-US");
        return `<div><strong>${esc(c.name)}</strong> <span class="muted">chain ${t.chainId}, block ${t.block.toLocaleString("en-US")}</span>
        <dl class="kv"><dt>Contract</dt><dd><a href="${c.explorer}/token/${t.address}" target="_blank" rel="noopener">${esc(t.address)}</a></dd>
        <dt>name()</dt><dd>${esc(t.name)}</dd><dt>symbol()</dt><dd>${esc(t.symbol)}</dd><dt>decimals()</dt><dd>${t.decimals}</dd>
        <dt>totalSupply()</dt><dd>${supply} MUSD</dd></dl></div>`;
      })
      .join("");
  } catch (e) {
    $("live-cards").innerHTML = `<div class="muted">Could not read the contracts right now (${esc(String(e))}).</div>`;
  }
}

function init(): void {
  const chips = $("p-examples");
  for (const [name, link] of EXAMPLES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = name;
    b.onclick = () => {
      $<HTMLTextAreaElement>("p-link").value = link;
      runCheck();
    };
    chips.appendChild(b);
  }
  $("m-go").onclick = () => void runCreate();
  $("m-memo").oninput = () => (memoEdited = $("m-memo").value.trim() !== "");
  $("m-to").onchange = () => void loadInvoices();
  $("m-chain").onchange = () => void loadInvoices();
  $("p-go").onclick = runCheck;
  $("p-pay").onclick = () => void payWithWallet();
  $("p-can").onclick = () => void runCanPay();
  $("v-go").onclick = () => void runVerify();
  $("b-go").onclick = () => void runBorrow();
  $("p-net").onchange = runCheck;
  const qs = new URLSearchParams(location.search);
  const shared = qs.get("pay");
  const invoiceRef = qs.get("invoice");
  if (shared || invoiceRef) {
    $("pay-banner").hidden = false;
    $("m-panel").hidden = true;
    $("steps").hidden = true;
    if (shared) {
      $<HTMLTextAreaElement>("p-link").value = shared;
      runCheck();
    } else {
      // The chain is checked on load, so a link that was already paid cannot be paid a second time.
      void loadPayInvoice(Number(qs.get("chain") ?? "31611"), invoiceRef!);
    }
    $("p-h").scrollIntoView();
  } else {
    void loadInvoices();
    void runCreate(false);
    const first = createPaymentLink({ chainId: 31611, recipient: SHOP, amount: "12.50", memo: "INV-1042" });
    if (first.ok) $<HTMLTextAreaElement>("p-link").value = first.link;
    runCheck();
  }
  void loadLive();
  void runBorrow();
}

init();
