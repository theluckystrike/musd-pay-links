// The browser-wallet boundary. Provider replies are checked before one payment request is made.

import { getAddress } from "viem";

import { MEZO_CHAINS, type MezoChain } from "./chains.ts";
import { MEMO_PATTERN } from "./eip681.ts";
import type { TransferRequest } from "./guard.ts";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type WalletSendResult =
  | { status: "sent"; hash: `0x${string}` }
  | { status: "rejected"; message: string }
  | { status: "unknown"; message: string };

export interface WalletSession {
  account: `0x${string}`;
  chain: MezoChain;
  /** Refuse a changed account or network, including changes reported during an awaited read. */
  assertReady(): Promise<void>;
  close(): void;
  /** Called only for a guarded MUSD transfer. beforeRequest runs immediately before the wallet request. */
  send(tx: TransferRequest, beforeRequest?: () => void): Promise<WalletSendResult>;
}

export function isTransactionHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function accountFrom(value: unknown): `0x${string}` {
  if (!Array.isArray(value) || typeof value[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value[0])) {
    throw new Error("The wallet did not provide a connected account.");
  }
  return getAddress(value[0]);
}

function matchesChain(value: unknown, chainId: number): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) && BigInt(value) === BigInt(chainId);
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** Runtime validation also applies to JavaScript callers that do not use TransferRequest's type. */
function isMusdTransferData(value: unknown): value is `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) return false;
  // selector + two32-byte ABI words, followed by no more than32ASCII reference bytes.
  if (value.length < 138 || value.length > 202 || value.slice(0, 10).toLowerCase() !== "0xa9059cbb") return false;
  const recipientWord = value.slice(10, 74);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(recipientWord)) return false;
  const recipient = "0x" + recipientWord.slice(24).toLowerCase();
  if (/^0x0{40}$/.test(recipient) || MEZO_CHAINS.some((chain) => chain.musd.toLowerCase() === recipient)) return false;
  if (BigInt("0x" + value.slice(74, 138)) === 0n) return false;
  const trailing = value.slice(138);
  if (!trailing) return true;
  let memo = "";
  for (let i = 0; i < trailing.length; i += 2) memo += String.fromCharCode(Number.parseInt(trailing.slice(i, i + 2), 16));
  return MEMO_PATTERN.test(memo);
}

/**
 * Adding a network does not select it (EIP-3085). Switch after adding it, then read the wallet's
 * actual chain and account. A successful method reply alone is not proof of the active network.
 */
export async function connectPaymentWallet(provider: Eip1193, chain: MezoChain): Promise<WalletSession> {
  const account = accountFrom(await provider.request({ method: "eth_requestAccounts" }));
  const chainId = "0x" + chain.id.toString(16);
  const switchChain = () => provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  try {
    await switchChain();
  } catch (error) {
    if (errorCode(error) !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId, chainName: chain.name, nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 }, rpcUrls: [chain.rpc], blockExplorerUrls: [chain.explorer] }],
    });
    await switchChain();
  }

  let changed = false;
  let requested = false;
  let closed = false;
  const onChain = (value: unknown) => { if (!matchesChain(value, chain.id)) changed = true; };
  const onAccounts = (value: unknown) => {
    try { if (accountFrom(value).toLowerCase() !== account.toLowerCase()) changed = true; }
    catch { changed = true; }
  };
  const onDisconnect = () => { changed = true; };
  const listeners: [string, (...args: unknown[]) => void][] = [["chainChanged", onChain], ["accountsChanged", onAccounts], ["disconnect", onDisconnect]];
  for (const [event, listener] of listeners) provider.on?.(event, listener);
  const close = () => { closed = true; for (const [event, listener] of listeners) provider.removeListener?.(event, listener); };
  const assertReady = async () => {
    if (closed) throw new Error("This wallet session is closed. Connect it again before paying.");
    if (changed) throw new Error("The wallet account or network changed. Start the payment again after checking them.");
    const [actualChain, accounts] = await Promise.all([
      provider.request({ method: "eth_chainId" }),
      provider.request({ method: "eth_accounts" }),
    ]);
    if (changed || !matchesChain(actualChain, chain.id)) throw new Error(`The wallet is not connected to ${chain.name}. No payment was requested.`);
    if (accountFrom(accounts).toLowerCase() !== account.toLowerCase()) throw new Error("The selected wallet account changed. No payment was requested.");
  };

  try { await assertReady(); }
  catch (error) { close(); throw error; }

  return {
    account, chain, assertReady, close,
    async send(tx, beforeRequest) {
      if (requested) throw new Error("A payment was already requested in this wallet session. Check its result before any retry.");
      if (tx.chainId !== chain.id || typeof tx.to !== "string" || tx.to.toLowerCase() !== chain.musd.toLowerCase() || tx.value !== 0n) {
        throw new Error("The prepared transfer does not match the selected MUSD network. No payment was requested.");
      }
      if (!isMusdTransferData(tx.data)) throw new Error("The prepared request is not a valid MUSD transfer. No payment was requested.");
      // Reserve the session before the awaited read, so two concurrent callers cannot both send.
      requested = true;
      try {
        await assertReady();
        beforeRequest?.();
      } catch (error) {
        requested = false; // No eth_sendTransaction request was made.
        throw error;
      }
      try {
        const hash = await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: account, chainId, to: tx.to, value: "0x0", data: tx.data }],
        });
        if (!isTransactionHash(hash)) return { status: "unknown", message: "The wallet did not return a valid transaction hash. Check its activity before any retry." };
        return { status: "sent", hash };
      } catch (error) {
        // EIP-1193 code4001 means that this request was rejected. A transport or internal error does
        // not prove that broadcast failed. Never repeat an uncertain eth_sendTransaction request.
        if (errorCode(error) === 4001) return { status: "rejected", message: "You rejected the payment request in the wallet." };
        return { status: "unknown", message: "The wallet did not confirm whether the payment was sent. Check its activity before any retry." };
      }
    },
  };
}
