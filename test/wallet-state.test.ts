import { describe, expect, it } from "vitest";

import { clearFailedWalletAttempt, clearRejectedAttempt, markWalletAttemptUnknown, readWalletAttempt, recordWalletHash, walletAttemptKey, writeWalletAttempt, type AttemptStorage } from "../src/wallet-state.ts";

const HASH = "0x" + "ab".repeat(32);
const pending = { status: "requesting" as const, id: "one-request", at: 123, from: "0x1111111111111111111111111111111111111111" };
function storage(): AttemptStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
}

describe("browser-local invoice attempt state", () => {
  it("keeps a request visible through reloads before a wallet returns a hash", () => {
    const saved = storage();
    writeWalletAttempt(saved, 31611, "INV-A", pending);
    expect(readWalletAttempt(saved, 31611, "INV-A")).toEqual(pending);
    expect(readWalletAttempt(saved, 31612, "INV-A")).toBeNull();
    expect(readWalletAttempt(saved, 31611, "INV-B")).toBeNull();
  });

  it("does not expire an unknown send just because time passed", () => {
    const saved = storage();
    const unknown = { ...pending, status: "unknown" as const, at: 0 };
    writeWalletAttempt(saved, 31611, "INV-A", unknown);
    expect(readWalletAttempt(saved, 31611, "INV-A")).toEqual(unknown);
  });

  it("reads legacy hashes written by previous versions", () => {
    const saved = storage();
    saved.setItem(walletAttemptKey(31611, "INV-A"), HASH + "|123");
    expect(readWalletAttempt(saved, 31611, "INV-A")).toEqual({ status: "sent", hash: HASH, at: 123 });
  });

  it("replaces the request marker with its returned hash", () => {
    const saved = storage();
    writeWalletAttempt(saved, 31611, "INV-A", pending);
    writeWalletAttempt(saved, 31611, "INV-A", { status: "sent", hash: HASH as `0x${string}`, at: 456 });
    expect(readWalletAttempt(saved, 31611, "INV-A")).toEqual({ status: "sent", hash: HASH, at: 456 });
  });

  it("clears an explicit rejection of this request but preserves another tab's newer state", () => {
    const saved = storage();
    writeWalletAttempt(saved, 31611, "INV-A", pending);
    clearRejectedAttempt(saved, 31611, "INV-A", "different-request");
    expect(readWalletAttempt(saved, 31611, "INV-A")).toEqual(pending);
    clearRejectedAttempt(saved, 31611, "INV-A", pending.id);
    expect(readWalletAttempt(saved, 31611, "INV-A")).toBeNull();
    writeWalletAttempt(saved, 31611, "INV-A", { status: "sent", hash: HASH as `0x${string}`, at: 456 });
    clearRejectedAttempt(saved, 31611, "INV-A", pending.id);
    expect(readWalletAttempt(saved, 31611, "INV-A")?.status).toBe("sent");
  });

  it("distinguishes a missing key from unreadable stored bytes", () => {
    const saved = storage();
    expect(readWalletAttempt(saved, 31611, "INV-A")).toBeNull();
    for (const bad of ["", "not-json", "null", JSON.stringify({ status: "sent", hash: "0x1234", at: 1 }), JSON.stringify({ ...pending, at: -1 })]) {
      saved.setItem(walletAttemptKey(31611, "INV-A"), bad);
      expect(() => readWalletAttempt(saved, 31611, "INV-A")).toThrow("state is unreadable");
      expect(saved.getItem(walletAttemptKey(31611, "INV-A"))).toBe(bad);
    }
  });

  it("does not clear or overwrite a marker when storage reads fail", () => {
    let writes = 0;
    const blocked: AttemptStorage = { getItem: () => { throw new Error("storage read blocked"); }, setItem: () => { writes++; }, removeItem: () => { writes++; } };
    const actions = [
      () => readWalletAttempt(blocked, 31611, "INV-A"),
      () => clearRejectedAttempt(blocked, 31611, "INV-A", pending.id),
      () => markWalletAttemptUnknown(blocked, 31611, "INV-A", pending.id),
      () => recordWalletHash(blocked, 31611, "INV-A", pending.id, HASH as `0x${string}`, 456),
      () => clearFailedWalletAttempt(blocked, 31611, "INV-A", HASH),
    ];
    for (const action of actions) expect(action).toThrow("storage read blocked");
    expect(writes).toBe(0);
  });

  it("preserves malformed earlier state instead of replacing it with a new result", () => {
    const saved = storage(); const key = walletAttemptKey(31611, "INV-A"); saved.setItem(key, "damaged-record");
    for (const action of [
      () => clearRejectedAttempt(saved, 31611, "INV-A", pending.id),
      () => markWalletAttemptUnknown(saved, 31611, "INV-A", pending.id),
      () => recordWalletHash(saved, 31611, "INV-A", pending.id, HASH as `0x${string}`, 456),
      () => clearFailedWalletAttempt(saved, 31611, "INV-A", HASH),
    ]) expect(action).toThrow("state is unreadable");
    expect(saved.getItem(key)).toBe("damaged-record");
  });

  it("changes a request or clears a reverted hash only while it still owns that state", () => {
    const saved = storage(); writeWalletAttempt(saved, 31611, "INV-A", pending);
    expect(markWalletAttemptUnknown(saved, 31611, "INV-A", "another-request")).toBe(false);
    expect(recordWalletHash(saved, 31611, "INV-A", "another-request", HASH as `0x${string}`, 456)).toBe(false);
    expect(readWalletAttempt(saved, 31611, "INV-A")).toEqual(pending);
    expect(markWalletAttemptUnknown(saved, 31611, "INV-A", pending.id)).toBe(true);
    expect(recordWalletHash(saved, 31611, "INV-A", pending.id, HASH as `0x${string}`, 456)).toBe(true);
    expect(markWalletAttemptUnknown(saved, 31611, "INV-A", pending.id)).toBe(false);
    expect(clearFailedWalletAttempt(saved, 31611, "INV-A", "0x" + "cd".repeat(32))).toBe(false);
    expect(readWalletAttempt(saved, 31611, "INV-A")?.status).toBe("sent");
    expect(clearFailedWalletAttempt(saved, 31611, "INV-A", HASH)).toBe(true);
    expect(readWalletAttempt(saved, 31611, "INV-A")).toBeNull();
  });
});
