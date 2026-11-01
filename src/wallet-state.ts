// Browser-local payment attempts survive reloads. Missing RPC data never proves an attempt was dropped.

import { isTransactionHash } from "./wallet.ts";

export type WalletAttempt =
  | { status: "requesting" | "unknown"; id: string; at: number; from: string }
  | { status: "sent"; hash: `0x${string}`; at: number };

export interface AttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const walletAttemptKey = (chainId: number, memo: string) => `musd-sent:${chainId}:${memo}`;

export function readWalletAttempt(storage: AttemptStorage, chainId: number, memo: string): WalletAttempt | null {
  const raw = storage.getItem(walletAttemptKey(chainId, memo));
  // null means an absent key. Empty, malformed or unreadable state cannot establish that no request exists.
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error("Saved payment state is unreadable. Check wallet activity before paying.");
  // Keep hashes written by earlier versions readable.
  const [hash, at] = raw.split("|");
  if (isTransactionHash(hash)) return { status: "sent", hash, at: Number(at) || 0 };
  try {
    const value = JSON.parse(raw) as Partial<WalletAttempt>;
    if (!Number.isFinite(value.at) || typeof value.at !== "number" || value.at < 0) throw new Error("Invalid payment state time");
    if (value.status === "sent" && "hash" in value && isTransactionHash(value.hash)) return { status: "sent", hash: value.hash, at: value.at };
    if ((value.status === "requesting" || value.status === "unknown") && "id" in value && typeof value.id === "string" && value.id && "from" in value && typeof value.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.from)) {
      return { status: value.status, id: value.id, at: value.at, from: value.from };
    }
  } catch { /* The caller must keep Pay locked for unreadable state. */ }
  throw new Error("Saved payment state is unreadable. Check wallet activity before paying.");
}

export function writeWalletAttempt(storage: AttemptStorage, chainId: number, memo: string, attempt: WalletAttempt | null): void {
  if (attempt) storage.setItem(walletAttemptKey(chainId, memo), JSON.stringify(attempt));
  else storage.removeItem(walletAttemptKey(chainId, memo));
}

/** Clear only this rejected request. Do not remove another tab's newer payment record. */
export function clearRejectedAttempt(storage: AttemptStorage, chainId: number, memo: string, id: string): void {
  const current = readWalletAttempt(storage, chainId, memo);
  if (current && current.status !== "sent" && current.id === id) writeWalletAttempt(storage, chainId, memo, null);
}

/** Replace only this request marker. A failed read or a different tab's marker is never overwritten. */
export function recordWalletHash(storage: AttemptStorage, chainId: number, memo: string, id: string, hash: `0x${string}`, at: number): boolean {
  const current = readWalletAttempt(storage, chainId, memo);
  if (!current || current.status === "sent" || current.id !== id || !isTransactionHash(hash)) return false;
  writeWalletAttempt(storage, chainId, memo, { status: "sent", hash, at });
  return true;
}

export function markWalletAttemptUnknown(storage: AttemptStorage, chainId: number, memo: string, id: string): boolean {
  const current = readWalletAttempt(storage, chainId, memo);
  if (!current || current.status === "sent" || current.id !== id) return false;
  writeWalletAttempt(storage, chainId, memo, { ...current, status: "unknown" });
  return true;
}

/** A verified revert can clear only the same recorded hash, never a newer attempt. */
export function clearFailedWalletAttempt(storage: AttemptStorage, chainId: number, memo: string, hash: string): boolean {
  const current = readWalletAttempt(storage, chainId, memo);
  if (!current || current.status !== "sent" || current.hash.toLowerCase() !== hash.toLowerCase()) return false;
  writeWalletAttempt(storage, chainId, memo, null);
  return true;
}
