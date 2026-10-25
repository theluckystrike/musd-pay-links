// Browser side of the demo. Uses the same library as the API; nothing is checked only on the server.

import { getAddress } from "viem";

import { formatAmount, parseAmount } from "../src/amount.ts";
import { pct } from "../src/borrow.ts";
import { chainById, MEZO_TESTNET } from "../src/chains.ts";
import { checkPaymentLink, type CheckResult } from "../src/guard.ts";
import { createPaymentLink } from "../src/merchant.ts";
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

function renderVerdict(r: CheckResult): string {
  if (!r.ok) {
    const items = r.reasons.map((x) => `<li><code>${esc(x.code)}</code> ${esc(x.message)}</li>`).join("");
    return `<div class="verdict bad"><strong>Refused. No transfer was built.</strong><ul>${items}</ul></div>`;
  }
  const p = r.payment;
  const chain = chainById(p.chainId)!;
  return `<div class="verdict ok"><strong>Safe to pay. All checks passed.</strong>
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
  $("p-out").innerHTML = shown + renderVerdict(r);
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  $<HTMLButtonElement>("p-pay").disabled = !(r.ok && eth);
  $<HTMLButtonElement>("p-pay").title = eth ? "" : "No browser wallet found";
}

/** A fresh invoice reference, so every link can be matched to exactly one payment. */
function newMemo(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "INV-" + [...bytes].map((b) => A[b % A.length]).join(""); // about 40 bits, unique per invoice
}

// Invoices this browser created. Kept in localStorage as a convenience only. The chain is the record.
interface Invoice { chainId: number; to: string; amount: string; memo: string; block: number | null; at: string; paidTx?: string }
const STORE = "musd-pay-links.invoices.v1";
function loadInvoices(): Invoice[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]") as Invoice[];
    return Array.isArray(v) ? v.slice(0, 20) : [];
  } catch {
    return [];
  }
}
function saveInvoices(list: Invoice[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* storage blocked, the page still works */
  }
}
function upsertInvoice(inv: Invoice): void {
  const list = loadInvoices().filter((x) => !(x.memo === inv.memo && x.to === inv.to && x.chainId === inv.chainId));
  saveInvoices([inv, ...list]);
  renderInvoices();
}
function renderInvoices(): void {
  const list = loadInvoices();
  const box = $("m-list");
  if (list.length === 0) {
    box.innerHTML = `<div class="muted">No invoices in this browser yet.</div>`;
    return;
  }
  box.innerHTML = `<table class="inv"><thead><tr><th>Reference</th><th>MUSD</th><th>Network</th><th>Status</th><th></th></tr></thead><tbody>${list
    .map((x, i) => {
      const c = chainById(x.chainId);
      const st = x.paidTx ? `<a href="${c?.explorer}/tx/${esc(x.paidTx)}" target="_blank" rel="noopener">paid</a>` : "open";
      return `<tr><td class="mono-cell">${esc(x.memo)}</td><td>${esc(x.amount)}</td><td>${c?.testnet ? "Testnet" : "Mainnet"}</td><td id="inv-st-${i}">${st}</td><td><button class="ghost small" data-inv="${i}">Check</button></td></tr>`;
    })
    .join("")}</tbody></table>`;
  box.querySelectorAll<HTMLButtonElement>("button[data-inv]").forEach((b) => {
    b.onclick = () => void checkInvoice(Number(b.dataset.inv));
  });
}
async function checkInvoice(i: number): Promise<void> {
  const inv = loadInvoices()[i];
  if (!inv) return;
  const cell = $(`inv-st-${i}`);
  cell.textContent = "checking...";
  const q = new URLSearchParams({ chain: String(inv.chainId), to: inv.to, amount: inv.amount, memo: inv.memo, from_block: inv.block === null ? "" : String(inv.block) });
  try {
    const v = (await (await fetch(`/api/payments?${q}`)).json()) as InboxAnswer;
    if (v.status !== "ok") throw new Error(v.error ?? v.message ?? "unavailable");
    if (v.paid) upsertInvoice({ ...inv, paidTx: v.paid.txHash });
    else cell.textContent = v.clamped ? "open (older than about 23 h, check by hash)" : "open";
  } catch (e) {
    cell.textContent = `not checked (${(e as Error).message})`;
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

function payPageUrl(link: string): string {
  return `${location.origin}/?pay=${encodeURIComponent(link)}`;
}

let watchTimer: number | null = null;

async function runCreate(fillVerify = true): Promise<void> {
  if (!$("m-memo").value.trim()) $("m-memo").value = newMemo();
  const chainId = Number($<HTMLSelectElement>("m-chain").value);
  const reused = loadInvoices().some((x) => x.memo === $("m-memo").value.trim() && x.to.toLowerCase() === $("m-to").value.trim().toLowerCase());
  const r = createPaymentLink({ chainId, recipient: $("m-to").value, amount: $("m-amount").value, memo: $("m-memo").value });
  if (!r.ok) {
    $("m-out").innerHTML = renderVerdict(r);
    return;
  }
  const page = payPageUrl(r.link);
  const tg = `https://t.me/share/url?url=${encodeURIComponent(page)}&text=${encodeURIComponent(`Please pay ${r.payment.amountText} MUSD on ${r.payment.chainName}, reference ${r.payment.memo}`)}`;
  $("m-out").innerHTML = `<div class="muted">EIP-681 link</div><div class="mono" id="m-link">${esc(r.link)}</div>
    <div class="qr" role="img" aria-label="QR code of the payment link">${qrSvg(r.link)}</div>
    <div class="muted" style="margin-top:10px">Pay page to send in a chat</div><div class="mono">${esc(page)}</div>
    <div class="actions"><button class="ghost" id="m-copy">Copy link</button><button class="ghost" id="m-copy-page">Copy pay page</button>
    <a class="button ghost" href="${esc(tg)}" target="_blank" rel="noopener">Share in Telegram</a>
    <button class="ghost" id="m-send">Check it as the payer</button></div>
    <div class="actions"><button id="m-watch">Watch for this payment</button></div>
    ${reused ? `<div class="verdict bad" style="margin-top:10px"><strong>You already used this reference for this address. One payment could then match two invoices. Press "New invoice" for a fresh reference.</strong></div>` : ""}
    <div class="out" id="m-watch-out" aria-live="polite"><div class="muted">Stamping the invoice with the current block...</div></div>`;
  $("m-copy").onclick = () => navigator.clipboard?.writeText(r.link);
  $("m-copy-page").onclick = () => navigator.clipboard?.writeText(page);
  $("m-send").onclick = () => {
    $<HTMLSelectElement>("p-net").value = String(chainId);
    $<HTMLTextAreaElement>("p-link").value = r.link;
    runCheck();
    $("p-h").scrollIntoView({ behavior: "smooth" });
  };
  const block = await headBlock(chainId);
  const stamp = block === null ? "The block could not be read, so older payments are not excluded." : `Invoice created at block ${block.toLocaleString("en-US")}. Payments mined before it do not count.`;
  $("m-watch-out").innerHTML = `<div class="muted">${esc(stamp)}</div>`;
  if (fillVerify && !reused) upsertInvoice({ chainId, to: r.payment.recipient, amount: r.payment.amountText, memo: r.payment.memo ?? "", block, at: new Date().toISOString() });
  $("m-watch").onclick = () => void watchPayment(chainId, r.payment.recipient, r.payment.amountText, r.payment.memo ?? "", block);
  if (!fillVerify) return;
  // Fill the confirm panel with this invoice, so the merchant can also check a hash by hand.
  $<HTMLSelectElement>("v-chain").value = String(chainId);
  $("v-to").value = r.payment.recipient;
  $("v-amount").value = r.payment.amountText;
  $("v-memo").value = r.payment.memo ?? "";
  $("v-from").value = block === null ? "" : String(block);
  $("v-tx").value = "";
}

function renderInbox(v: InboxAnswer, chainId: number): string {
  const c = chainById(chainId)!;
  if (v.paid) {
    return `<div class="verdict ok"><strong>Paid. ${esc(v.paid.amount)} MUSD with reference ${esc(String(v.paid.memo))}.</strong>
      <dl class="kv"><dt>From</dt><dd>${esc(v.paid.from)}</dd><dt>Block</dt><dd>${v.paid.block}</dd>
      <dt>Transaction</dt><dd><a href="${c.explorer}/tx/${esc(v.paid.txHash)}" target="_blank" rel="noopener">${esc(v.paid.txHash)}</a></dd></dl></div>`;
  }
  const rows = v.payments
    .slice(0, 5)
    .map((p) => `<li><a href="${c.explorer}/tx/${esc(p.txHash)}" target="_blank" rel="noopener">${esc(p.txHash.slice(0, 12))}...</a> ${esc(p.amount)} MUSD, reference ${p.memo ? esc(p.memo) : "none"}</li>`)
    .join("");
  const possible = v.payments.filter((p) => p.possible);
  const maybe = possible.length
    ? `<div class="verdict bad" style="margin-top:8px"><strong>Possible match. ${possible.length} payment(s) of exactly this amount arrived without a reference.</strong> Some wallets drop the reference. Ask the payer which one is theirs, then confirm it by hash in panel 3.</div>`
    : "";
  const warn = [
    v.clamped ? "The invoice is older than the inbox window (about 23 hours), so earlier blocks were not searched. Confirm by hash in panel 3." : "",
    v.truncated ? "This address receives many payments. Only the newest 50 were read." : "",
  ].filter(Boolean).map((w) => `<div class="note">${esc(w)}</div>`).join("");
  return `<div class="muted">No payment with this reference yet. Searched blocks ${v.fromBlock.toLocaleString("en-US")} to ${v.head.toLocaleString("en-US")}.</div>${maybe}${warn}${rows ? `<div class="muted" style="margin-top:6px">Other MUSD payments to this address</div><ul class="muted">${rows}</ul>` : ""}`;
}

interface InboxPayment { txHash: string; block: number; from: string; amount: string; memo: string | null; possible?: boolean }
interface InboxAnswer { status: string; head: number; fromBlock: number; clamped?: boolean; truncated?: boolean; payments: InboxPayment[]; paid: InboxPayment | null; message?: string; error?: string }

async function watchPayment(chainId: number, to: string, amount: string, memo: string, fromBlock: number | null): Promise<void> {
  if (watchTimer !== null) clearTimeout(watchTimer);
  const out = $("m-watch-out");
  const q = new URLSearchParams({ chain: String(chainId), to, amount, memo, from_block: fromBlock === null ? "" : String(fromBlock) });
  const started = Date.now();
  const tick = async () => {
    let v: InboxAnswer;
    try {
      v = (await (await fetch(`/api/payments?${q}`)).json()) as InboxAnswer;
    } catch {
      v = { status: "unavailable", head: 0, fromBlock: 0, payments: [], paid: null };
    }
    if (v.status === "ok") {
      out.innerHTML = renderInbox(v, chainId);
      if (v.paid) {
        const inv = loadInvoices().find((x) => x.memo === memo && x.to === to && x.chainId === chainId);
        if (inv) upsertInvoice({ ...inv, paidTx: v.paid.txHash });
      }
    }
    else out.innerHTML = `<div class="muted">${esc(v.message ?? v.error ?? "The network did not answer.")} Trying again.</div>`;
    if (v.paid || Date.now() - started > 15 * 60_000) return;
    watchTimer = window.setTimeout(() => void tick(), 8000);
  };
  out.innerHTML = `<div class="muted">Watching the MUSD contract for a transfer to ${esc(to)} with reference ${esc(memo)}...</div>`;
  await tick();
}

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

async function payWithWallet(): Promise<void> {
  if (!lastCheck || !lastCheck.ok) return;
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) return;
  const { tx, payment } = lastCheck;
  const chain = chainById(tx.chainId)!;
  const out = $("p-out");
  const status = (html: string) => (out.innerHTML = renderVerdict(lastCheck!) + `<div class="note">${html}</div>`);
  try {
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
    const sentAfter = await headBlock(chain.id);
    const hash = (await eth.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, value: "0x0", data: tx.data }] })) as string;
    status(`Sent. <a href="${chain.explorer}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(hash)}</a>. Waiting for the receipt...`);
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const q = new URLSearchParams({ chain: String(chain.id), tx: hash, to: payment.recipient, amount: payment.amountText, memo: payment.memo ?? "", from_block: sentAfter === null ? "" : String(sentAfter) });
      const v = (await (await fetch(`/api/verify?${q}`)).json()) as { status: string; confirmations?: number; message?: string };
      if (v.status === "paid") {
        status(`Confirmed on chain. ${esc(payment.amountText)} MUSD received, ${v.confirmations} confirmation(s). <a href="${chain.explorer}/tx/${esc(hash)}" target="_blank" rel="noopener">View in explorer</a>`);
        return;
      }
      if (v.status !== "pending" && v.status !== "not_found") {
        status(esc(v.message ?? v.status));
        return;
      }
    }
  } catch (e) {
    status(`Wallet error. ${esc((e as Error).message ?? String(e))}`);
  }
}

const VERIFY_RETRY_MESSAGE = "The network did not answer in time. Try again in a moment.";
const VERIFY_NOT_FOUND_MESSAGE = "No transaction with this hash on this network. Check the hash and the network.";
const VERIFY_TRIES = 3;

function renderVerify(v: Record<string, unknown>, paid: boolean): string {
  const head = paid ? `Paid. ${esc(String(v.paid))} MUSD reached the recipient.` : esc(String(v.message ?? v.error ?? v.status));
  return `<div class="verdict ${paid ? "ok" : "bad"}"><strong>${head}</strong>
    ${paid ? `<dl class="kv"><dt>Block</dt><dd>${v.block}</dd><dt>Confirmations</dt><dd>${v.confirmations}</dd><dt>Reference</dt><dd>${v.memoMatched === null ? "not checked" : v.memoMatched ? "matches" : "does not match"}</dd></dl>` : ""}
    ${v.explorer ? `<div style="margin-top:6px"><a href="${esc(String(v.explorer))}" target="_blank" rel="noopener">Open in explorer</a></div>` : ""}</div>`;
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
    out.innerHTML = renderVerify(v, status === "paid");
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
      <div class="actions"><a class="button" href="${esc(v.borrowAt)}" target="_blank" rel="noopener">Borrow MUSD in the Mezo app</a></div></div>`;
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
  $("m-new").onclick = () => {
    $("m-memo").value = newMemo();
    void runCreate();
  };
  $("p-go").onclick = runCheck;
  $("p-pay").onclick = () => void payWithWallet();
  $("p-can").onclick = () => void runCanPay();
  $("v-go").onclick = () => void runVerify();
  $("b-go").onclick = () => void runBorrow();
  $("m-memo").value = newMemo();
  $("p-net").onchange = runCheck;
  renderInvoices();
  const shared = new URLSearchParams(location.search).get("pay");
  if (shared) {
    $<HTMLTextAreaElement>("p-link").value = shared;
    $("pay-banner").hidden = false;
    $("m-panel").hidden = true;
    $("steps").hidden = true;
    runCheck();
    $("p-h").scrollIntoView();
  } else {
    void runCreate(false);
    const first = createPaymentLink({ chainId: 31611, recipient: SHOP, amount: "12.50", memo: $("m-memo").value });
    if (first.ok) $<HTMLTextAreaElement>("p-link").value = first.link;
    runCheck();
  }
  void loadLive();
  void runBorrow();
}

init();
