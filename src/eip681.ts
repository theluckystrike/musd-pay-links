// Strict EIP-681 parser for ERC-20 transfer links.
// Grammar (EIP-681):
//   ethereum:[pay-]<target_address>[@<chain_id>][/<function_name>][?<parameters>]
// This parser accepts only what a MUSD transfer needs and refuses everything else with a reason.

export type Reason = { code: string; message: string };

export interface RawLink {
  target: string;
  chainId: number | null;
  functionName: string | null;
  params: Map<string, string>;
}

export const MAX_LINK_LENGTH = 512;
export const ALLOWED_PARAMS = new Set(["address", "uint256", "memo"]);
const EXECUTION_PARAMS = new Set(["value", "gas", "gaslimit", "gasprice", "maxfeepergas", "maxpriorityfeepergas", "nonce", "data"]);
const DANGEROUS_FUNCTIONS = new Set(["approve", "increaseallowance", "transferfrom", "permit", "setapprovalforall"]);

export const MEMO_PATTERN = /^[A-Za-z0-9._:/-]{1,32}$/;

function describeCodePoint(cp: number): string {
  const hex = "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
  if (cp === 0x20) return `${hex} (space)`;
  if (cp < 0x20 || cp === 0x7f) return `${hex} (control character)`;
  if ((cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff || cp === 0x2060) return `${hex} (invisible zero-width character)`;
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return `${hex} (bidirectional override, can reorder what you see)`;
  if (cp >= 0xff01 && cp <= 0xff5e) return `${hex} (full-width lookalike of an ASCII character)`;
  return `${hex} (non-ASCII character, possible lookalike)`;
}

function fail(code: string, message: string): { ok: false; reason: Reason } {
  return { ok: false, reason: { code, message } };
}

/** Syntax-level parse. Returns the first problem found; nothing is decoded or normalised. */
export function parseEip681(input: unknown): { ok: true; link: RawLink } | { ok: false; reason: Reason } {
  if (typeof input !== "string") return fail("not_a_string", "The link must be text.");
  if (input.length === 0) return fail("empty", "The link is empty.");
  if (input.length > MAX_LINK_LENGTH) {
    return fail("too_long", `The link is ${input.length} characters long. The limit is ${MAX_LINK_LENGTH}.`);
  }
  let pos = 0;
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x21 || cp > 0x7e) {
      return fail("unicode_trick", `Character ${describeCodePoint(cp)} at position ${pos}. Payment links must be plain ASCII.`);
    }
    pos += ch.length;
  }
  if (input.includes("%")) {
    return fail("percent_encoding", "The link uses percent-encoding. A MUSD link never needs it, and it can hide characters.");
  }
  if (input.includes("#")) return fail("fragment", "The link has a # fragment. Nothing after # is part of a payment request.");
  if (input.slice(0, 9).toLowerCase() !== "ethereum:") {
    return fail("bad_scheme", "Not an EIP-681 link. It must start with ethereum:");
  }
  let rest = input.slice(9);
  if (rest.toLowerCase().startsWith("pay-")) rest = rest.slice(4);

  const m = /^([^@/?]*)(?:@([^/?]*))?(?:\/([^?]*))?(?:\?(.*))?$/.exec(rest);
  if (!m) return fail("malformed", "The link structure is not valid EIP-681.");
  const [, target = "", chainText, fnText, query] = m;

  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
    if (/^0x/i.test(target)) return fail("bad_token_address", "The token address is not 0x followed by 40 hex characters.");
    return fail("ens_or_bad_target", "The target is not a hex address. Names (ENS) are not resolved on Mezo, so they are refused.");
  }

  let chainId: number | null = null;
  if (chainText !== undefined) {
    if (!/^[1-9]\d{0,9}$/.test(chainText)) {
      return fail("bad_chain_id", "The chain id must be a plain decimal number without leading zeros.");
    }
    chainId = Number(chainText);
  }

  let functionName: string | null = null;
  if (fnText !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(fnText)) return fail("bad_function", "The function name is not valid.");
    functionName = fnText;
  }

  const params = new Map<string, string>();
  if (query !== undefined) {
    if (query === "") return fail("malformed_query", "The link ends with ? but has no parameters.");
    for (const segment of query.split("&")) {
      const eq = segment.indexOf("=");
      if (segment === "" || eq <= 0 || eq === segment.length - 1) {
        return fail("malformed_query", `Parameter "${segment}" is not in key=value form.`);
      }
      const key = segment.slice(0, eq);
      const value = segment.slice(eq + 1);
      if (params.has(key)) {
        return fail("duplicate_param", `Parameter "${key}" appears more than once. Wallets disagree on which copy wins.`);
      }
      if (!ALLOWED_PARAMS.has(key)) {
        if (EXECUTION_PARAMS.has(key.toLowerCase())) {
          return fail("forbidden_param", `Parameter "${key}" would change how the transaction executes. A MUSD transfer link must not set it.`);
        }
        if (ALLOWED_PARAMS.has(key.toLowerCase())) {
          return fail("param_case", `Parameter "${key}" has the wrong case. Expected "${key.toLowerCase()}".`);
        }
        return fail("unknown_param", `Unknown parameter "${key}". Only address, uint256 and memo are accepted.`);
      }
      params.set(key, value);
    }
  }

  if (functionName !== null && DANGEROUS_FUNCTIONS.has(functionName.toLowerCase())) {
    return fail(
      "dangerous_function",
      `The link calls "${functionName}", which gives someone else control of your tokens. Only transfer is allowed.`,
    );
  }

  return { ok: true, link: { target, chainId, functionName, params } };
}
