// Browser side of the demo. Uses the same library as the API; nothing is checked only on the server.

import { getAddress } from "viem";

import { formatAmount } from "../src/amount.ts";
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
  const r = checkPaymentLink(link, {
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

function runCreate(): void {
  const r = createPaymentLink({
    chainId: Number($<HTMLSelectElement>("m-chain").value),
    recipient: $("m-to").value,
    amount: $("m-amount").value,
    memo: $("m-memo").value,
  });
  if (!r.ok) {
    $("m-out").innerHTML = renderVerdict(r);
    return;
  }
  $("m-out").innerHTML = `<div class="muted">EIP-681 link</div><div class="mono" id="m-link">${esc(r.link)}</div>
    <div class="qr" role="img" aria-label="QR code of the payment link">${qrSvg(r.link)}</div>
    <div class="actions"><button class="ghost" id="m-copy">Copy link</button><button class="ghost" id="m-send">Check it as the payer</button></div>`;
  $("m-copy").onclick = () => navigator.clipboard?.writeText(r.link);
  $("m-send").onclick = () => {
    $<HTMLTextAreaElement>("p-link").value = r.link;
    runCheck();
    $("p-h").scrollIntoView({ behavior: "smooth" });
  };
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
      status(`Your wallet holds ${esc(formatAmount(BigInt(bal.balance)))} MUSD on ${esc(chain.name)}, less than ${esc(payment.amountText)}. Nothing was sent.`);
      return;
    }
    const hash = (await eth.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, value: "0x0", data: tx.data }] })) as string;
    status(`Sent. <a href="${chain.explorer}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(hash)}</a>. Waiting for the receipt...`);
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const q = new URLSearchParams({ chain: String(chain.id), tx: hash, to: payment.recipient, amount: payment.amountText, memo: payment.memo ?? "" });
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
      out.innerHTML = `<div class="verdict bad"><strong>${esc(VERIFY_RETRY_MESSAGE)}</strong></div>`;
      return;
    }
    out.innerHTML = renderVerify(v, status === "paid");
    return;
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
  $("m-go").onclick = runCreate;
  $("p-go").onclick = runCheck;
  $("p-pay").onclick = () => void payWithWallet();
  $("v-go").onclick = () => void runVerify();
  runCreate();
  const first = createPaymentLink({ chainId: 31611, recipient: SHOP, amount: "12.50", memo: "INV-1042" });
  if (first.ok) $<HTMLTextAreaElement>("p-link").value = first.link;
  runCheck();
  void loadLive();
}

init();
