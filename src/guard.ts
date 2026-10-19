// Payer-side guard: decide whether a MUSD payment link is safe to pay, and build the transfer if it is.

import { encodeFunctionData, erc20Abi } from "viem";

import { checkAddress, looksLike } from "./address.ts";
import { formatAmount, MAX_UINT256, parseAmount, parseEip681Number } from "./amount.ts";
import { chainById, MEZO_CHAINS, MUSD_DECIMALS } from "./chains.ts";
import { MEMO_PATTERN, parseEip681, type Reason } from "./eip681.ts";

export interface PayerPolicy {
  /** Highest amount the payer accepts, as a decimal MUSD string ("250") or base units (bigint). Required. */
  maxAmount: string | bigint;
  /** Optional list of recipients the payer trusts. When set, every other recipient is refused. */
  allowlist?: readonly string[];
  /** Chains the payer accepts. Defaults to Mezo Testnet and Mezo Mainnet. */
  allowedChains?: readonly number[];
  /** Refuse addresses without an EIP-55 checksum. Defaults to true. */
  requireChecksum?: boolean;
}

export interface CheckedPayment {
  chainId: number;
  chainName: string;
  token: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
  amountText: string;
  memo: string | null;
}

export interface TransferRequest {
  chainId: number;
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
}

export type CheckResult =
  | { ok: true; payment: CheckedPayment; tx: TransferRequest; reasons: [] }
  | { ok: false; reasons: Reason[] };

const ZERO = "0x0000000000000000000000000000000000000000";

function resolveLimit(max: string | bigint): bigint | null {
  if (typeof max === "bigint") return max >= 0n && max <= MAX_UINT256 ? max : null;
  return parseAmount(max);
}

export function memoToHex(memo: string): `0x${string}` {
  let hex = "";
  for (let i = 0; i < memo.length; i++) hex += memo.charCodeAt(i).toString(16).padStart(2, "0");
  return `0x${hex}`;
}

/** Build the exact calldata: transfer(recipient, amount), then the ASCII memo bytes if present. */
export function buildTransferData(recipient: `0x${string}`, amount: bigint, memo: string | null): `0x${string}` {
  const call = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount] });
  return memo ? (`${call}${memoToHex(memo).slice(2)}` as `0x${string}`) : call;
}

function checkToken(target: string, chainId: number, requireChecksum: boolean, reasons: Reason[]): void {
  const chain = chainById(chainId)!;
  const addr = checkAddress(target, false);
  if (!addr.ok) {
    reasons.push({ code: `token_${addr.code}`, message: `Token address ${addr.message}` });
    return;
  }
  const lower = target.toLowerCase();
  if (lower === chain.musd.toLowerCase()) {
    if (requireChecksum && !addr.checksummed && /[a-fA-F]/.test(target.slice(2))) {
      reasons.push({ code: "token_no_checksum", message: "The MUSD address in the link has no EIP-55 checksum." });
    }
    return;
  }
  const other = MEZO_CHAINS.find((c) => c.musd.toLowerCase() === lower);
  if (other) {
    reasons.push({
      code: "token_chain_mismatch",
      message: `This is the MUSD contract on ${other.name}, but the link says chain ${chainId} (${chain.name}). Refused so funds do not go to the wrong network.`,
    });
  } else if (looksLike(target, chain.musd)) {
    reasons.push({
      code: "lookalike_token",
      message: `Token ${target} starts and ends like MUSD (${chain.musd}) but is a different contract. This is a lookalike token.`,
    });
  } else {
    reasons.push({ code: "not_musd", message: `Token ${target} is not MUSD on ${chain.name}. MUSD is ${chain.musd}.` });
  }
}

function checkRecipient(value: string | undefined, policy: PayerPolicy, requireChecksum: boolean, reasons: Reason[]): `0x${string}` | null {
  if (value === undefined) {
    reasons.push({ code: "missing_recipient", message: "The link has no address= parameter, so there is no recipient." });
    return null;
  }
  const r = checkAddress(value, requireChecksum);
  if (!r.ok) {
    reasons.push({ code: `recipient_${r.code}`, message: `Recipient ${r.message}` });
    return null;
  }
  const lower = r.address.toLowerCase();
  if (lower === ZERO) {
    reasons.push({ code: "recipient_zero", message: "The recipient is the zero address. Tokens sent there are lost." });
  }
  if (MEZO_CHAINS.some((c) => c.musd.toLowerCase() === lower)) {
    reasons.push({ code: "recipient_is_token", message: "The recipient is the MUSD contract itself. Tokens sent there are lost." });
  }
  if (policy.allowlist && policy.allowlist.length > 0) {
    const allowed = policy.allowlist.map((a) => a.toLowerCase());
    if (!allowed.includes(lower)) {
      const twin = policy.allowlist.find((a) => looksLike(a, r.address));
      reasons.push(
        twin
          ? {
              code: "recipient_lookalike",
              message: `Recipient ${r.address} looks like your saved ${twin} but is a different address (address poisoning).`,
            }
          : { code: "not_in_allowlist", message: `Recipient ${r.address} is not on your allowlist.` },
      );
    }
  }
  return r.address;
}

function checkAmount(value: string | undefined, limit: bigint, reasons: Reason[]): bigint | null {
  if (value === undefined) {
    reasons.push({ code: "missing_amount", message: "The link has no uint256= amount. Refused rather than letting you type one." });
    return null;
  }
  const amount = parseEip681Number(value);
  if (amount === null) {
    const syntaxOk = /^\d+(?:\.\d+)?(?:[eE]\d+)?$/.test(value);
    reasons.push(
      syntaxOk && value.length <= 100
        ? { code: "amount_overflow", message: "The amount is larger than uint256 or is not a whole number of base units." }
        : { code: "bad_amount", message: `The amount "${value.slice(0, 40)}" is not a valid EIP-681 number.` },
    );
    return null;
  }
  if (amount === 0n) {
    reasons.push({ code: "zero_amount", message: "The amount is zero." });
    return null;
  }
  if (amount > limit) {
    reasons.push({
      code: "over_limit",
      message: `The link asks for ${formatAmount(amount)} MUSD. Your limit is ${formatAmount(limit)} MUSD.`,
    });
  }
  return amount;
}

/** Check a MUSD payment link against the payer's policy. Never throws. */
export function checkPaymentLink(link: unknown, policy: PayerPolicy): CheckResult {
  const limit = resolveLimit(policy.maxAmount);
  if (limit === null) {
    return { ok: false, reasons: [{ code: "bad_policy", message: "The payer limit is not a valid MUSD amount." }] };
  }
  const parsed = parseEip681(link);
  if (!parsed.ok) return { ok: false, reasons: [parsed.reason] };
  const raw = parsed.link;
  const requireChecksum = policy.requireChecksum ?? true;
  const allowedChains = policy.allowedChains ?? MEZO_CHAINS.map((c) => c.id);

  if (raw.chainId === null) {
    return {
      ok: false,
      reasons: [{ code: "missing_chain_id", message: "The link has no @chain_id. A wallet would guess the network, so it is refused." }],
    };
  }
  const chain = chainById(raw.chainId);
  if (!chain) {
    return {
      ok: false,
      reasons: [{ code: "wrong_chain", message: `Chain ${raw.chainId} is not Mezo. MUSD links must use 31611 (testnet) or 31612 (mainnet).` }],
    };
  }
  if (!allowedChains.includes(chain.id)) {
    return { ok: false, reasons: [{ code: "chain_not_allowed", message: `You do not accept payments on ${chain.name}.` }] };
  }
  if (raw.functionName === null) {
    return {
      ok: false,
      reasons: [{ code: "not_token_transfer", message: "The link has no /transfer, so it is a native BTC payment, not MUSD." }],
    };
  }
  if (raw.functionName !== "transfer") {
    return { ok: false, reasons: [{ code: "wrong_function", message: `The link calls "${raw.functionName}". Only transfer is allowed.` }] };
  }

  const reasons: Reason[] = [];
  checkToken(raw.target, chain.id, requireChecksum, reasons);
  const recipient = checkRecipient(raw.params.get("address"), policy, requireChecksum, reasons);
  const amount = checkAmount(raw.params.get("uint256"), limit, reasons);
  const memo = raw.params.get("memo") ?? null;
  if (memo !== null && !MEMO_PATTERN.test(memo)) {
    reasons.push({ code: "bad_memo", message: "The memo must be 1 to 32 characters. Letters, digits and the characters dot, underscore, colon, slash and hyphen are allowed. The # character is not." });
  }
  if (reasons.length > 0 || recipient === null || amount === null) return { ok: false, reasons };

  const payment: CheckedPayment = {
    chainId: chain.id,
    chainName: chain.name,
    token: chain.musd,
    recipient,
    amount,
    amountText: formatAmount(amount, MUSD_DECIMALS),
    memo,
  };
  const tx: TransferRequest = { chainId: chain.id, to: chain.musd, value: 0n, data: buildTransferData(recipient, amount, memo) };
  return { ok: true, payment, tx, reasons: [] };
}
