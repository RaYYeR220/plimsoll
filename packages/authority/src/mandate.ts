/**
 * The mandate: the exact bytes a human approves on the Ledger, and the exact bytes the
 * on-chain verifier hashes.
 *
 * `signMessage` on the Ethereum app is EIP-191 personal-sign over a raw string. There is no
 * schema, no type system and no on-device parser -- whatever string we hand the device is what
 * the human reads, and whatever string the contract reconstructs is what it recovers against.
 * If those two strings differ by a single byte, the privileged action either becomes
 * unauthorisable or, worse, a human approves text that does not describe what executes. So the
 * canonical form is defined once, here, and mirrored by exactly one other implementation:
 * `mandateText()` in MandateVerifier.sol.
 *
 * The contract *formats*, it never *parses*. `parseMandate` below exists for round-trip tests
 * and for showing an operator what was signed; nothing on the trust path consumes it.
 */

import { hashMessage, recoverAddress } from "ethers";

/** 0x-prefixed hex string. Structural, so callers on viem or ethers both fit. */
export type Hex = `0x${string}`;

export type MandateAction = "HALT" | "RESUME" | "SET-THRESHOLD";

export const MANDATE_ACTIONS: readonly MandateAction[] = ["HALT", "RESUME", "SET-THRESHOLD"];

/** Canonical mandate. Every field is already in canonical form; `formatMandate` throws otherwise. */
export interface Mandate {
  readonly action: MandateAction;
  /** Market code, e.g. `SEA-2026-A`. Uppercase alphanumeric with single interior hyphens. */
  readonly market: string;
  /** Measured coverage, basis points of par. 9860 renders as `98.60%`. */
  readonly coverageBps: number;
  /** The load line in force *after* this mandate executes, basis points of par. */
  readonly loadLineBps: number;
  /** Single-use, enforced on chain. */
  readonly nonce: bigint;
  /** Unix seconds, UTC. Rendered as ISO-8601 so the human can actually read it. */
  readonly expiry: bigint;
  readonly chainId: number;
  /** Address of the MandateVerifier that will consume this mandate. Lowercase hex. */
  readonly verifyingContract: Hex;
}

export class MandateFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MandateFormatError";
  }
}

export const MANDATE_HEADER = "PLIMSOLL MANDATE v1";

/** Field order is part of the format. Changing it changes every signature. */
export const MANDATE_KEYS = [
  "ACTION",
  "MARKET",
  "COVERAGE",
  "LOAD LINE",
  "NONCE",
  "EXPIRES",
  "CHAIN",
  "VERIFIER",
] as const;

const MAX_BPS = 99_999; // 999.99%
const MAX_MARKET_LEN = 24;
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * Expiry is bounded so the Solidity date formatter stays inside a range it has been tested
 * over, and so an absurd far-future expiry cannot slip past a human skimming the screen.
 */
export const MIN_EXPIRY = 1_704_067_200n; // 2024-01-01T00:00:00Z
export const MAX_EXPIRY = 4_133_980_799n; // 2100-12-31T23:59:59Z

const MARKET_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const PERCENT_RE = /^(0|[1-9]\d{0,2})\.(\d{2})%$/;
const UINT_RE = /^(0|[1-9]\d*)$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const EXPIRY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e\n]+$/;

function fail(what: string): never {
  throw new MandateFormatError(what);
}

/** Lowercase and validate an address for use as `verifyingContract`. */
export function normalizeAddress(address: string): Hex {
  const lower = address.toLowerCase();
  if (!ADDRESS_RE.test(lower)) fail(`not a 20-byte hex address: ${JSON.stringify(address)}`);
  return lower as Hex;
}

export function formatBasisPoints(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS) {
    fail(`basis points must be an integer in [0, ${MAX_BPS}], got ${bps}`);
  }
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
}

export function parseBasisPoints(text: string): number {
  const m = PERCENT_RE.exec(text);
  if (!m) fail(`not a canonical percentage: ${JSON.stringify(text)}`);
  return Number(m[1]) * 100 + Number(m[2]);
}

export function formatExpiry(unixSeconds: bigint): string {
  if (unixSeconds < MIN_EXPIRY || unixSeconds > MAX_EXPIRY) {
    fail(`expiry ${unixSeconds} outside [${MIN_EXPIRY}, ${MAX_EXPIRY}]`);
  }
  return `${new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 19)}Z`;
}

export function parseExpiry(text: string): bigint {
  if (!EXPIRY_RE.test(text)) fail(`not a canonical UTC timestamp: ${JSON.stringify(text)}`);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) fail(`unparseable timestamp: ${JSON.stringify(text)}`);
  const unix = BigInt(ms / 1000);
  // Re-rendering is the validation: it rejects 2026-02-30, month 13, hour 25 and every other
  // well-shaped-but-nonexistent instant that Date.parse would happily roll over.
  if (formatExpiry(unix) !== text) fail(`timestamp is not a real UTC instant: ${text}`);
  return unix;
}

function assertMarket(market: string): void {
  if (market.length === 0 || market.length > MAX_MARKET_LEN) {
    fail(`market code must be 1..${MAX_MARKET_LEN} characters, got ${market.length}`);
  }
  if (!MARKET_RE.test(market)) {
    fail(
      `market code must be uppercase alphanumeric with single interior hyphens: ${JSON.stringify(market)}`,
    );
  }
}

function assertUint64(value: bigint, label: string): void {
  if (value < 0n || value > MAX_UINT64) fail(`${label} must fit in uint64, got ${value}`);
}

/**
 * Render the mandate.
 *
 * The device reflows the string: newlines become spaces and the text is greedily wrapped to the
 * screen width, so the human never sees the line structure. Field boundaries survive only
 * because the `KEY: ` tokens are distinctive and because no value may contain whitespace or a
 * colon-space -- both enforced here. That is what stops a market code of `SEA-2026-A NONCE: 9`
 * from rendering as a mandate with two nonces.
 */
export function formatMandate(m: Mandate): string {
  if (!MANDATE_ACTIONS.includes(m.action)) fail(`unknown action ${JSON.stringify(m.action)}`);
  assertMarket(m.market);
  assertUint64(m.nonce, "nonce");
  if (!Number.isInteger(m.chainId) || m.chainId < 1 || m.chainId > Number.MAX_SAFE_INTEGER) {
    fail(`chainId must be a positive safe integer, got ${m.chainId}`);
  }
  if (
    typeof m.verifyingContract !== "string" ||
    m.verifyingContract !== m.verifyingContract.toLowerCase() ||
    !ADDRESS_RE.test(m.verifyingContract)
  ) {
    fail(`verifyingContract must be lowercase 20-byte hex (use normalizeAddress): ${m.verifyingContract}`);
  }

  const text = [
    MANDATE_HEADER,
    `ACTION: ${m.action}`,
    `MARKET: ${m.market}`,
    `COVERAGE: ${formatBasisPoints(m.coverageBps)}`,
    `LOAD LINE: ${formatBasisPoints(m.loadLineBps)}`,
    `NONCE: ${m.nonce}`,
    `EXPIRES: ${formatExpiry(m.expiry)}`,
    `CHAIN: ${m.chainId}`,
    `VERIFIER: ${m.verifyingContract}`,
  ].join("\n");

  // Printable ASCII only. EIP-191 prefixes the *byte* length; one byte per character means the
  // length the device counts and the length the contract writes agree without either side
  // doing UTF-8 arithmetic.
  if (!PRINTABLE_ASCII_RE.test(text)) fail("mandate contains non-printable or non-ASCII characters");
  return text;
}

/** Round-trips with `formatMandate`. Field order, spelling and spacing are all load-bearing. */
export function parseMandate(text: string): Mandate {
  const lines = text.split("\n");
  if (lines.length !== MANDATE_KEYS.length + 1) {
    fail(`expected ${MANDATE_KEYS.length + 1} lines, got ${lines.length}`);
  }
  if (lines[0] !== MANDATE_HEADER) fail(`bad header: ${JSON.stringify(lines[0])}`);

  const values = MANDATE_KEYS.map((key, i) => {
    const line = lines[i + 1] as string;
    const prefix = `${key}: `;
    if (!line.startsWith(prefix)) {
      fail(`line ${i + 1} must start with ${JSON.stringify(prefix)}, got ${JSON.stringify(line)}`);
    }
    return line.slice(prefix.length);
  });

  const [action, market, coverage, loadLine, nonce, expiry, chain, verifier] = values as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (!MANDATE_ACTIONS.includes(action as MandateAction)) fail(`unknown action ${JSON.stringify(action)}`);
  assertMarket(market);
  if (!UINT_RE.test(nonce)) fail(`nonce must be a canonical decimal, got ${JSON.stringify(nonce)}`);
  if (!UINT_RE.test(chain)) fail(`chain id must be a canonical decimal, got ${JSON.stringify(chain)}`);
  const nonceValue = BigInt(nonce);
  assertUint64(nonceValue, "nonce");

  const parsed: Mandate = {
    action: action as MandateAction,
    market,
    coverageBps: parseBasisPoints(coverage),
    loadLineBps: parseBasisPoints(loadLine),
    nonce: nonceValue,
    expiry: parseExpiry(expiry),
    chainId: Number(chain),
    verifyingContract: normalizeAddress(verifier),
  };

  // Cheap defence against formatter/parser drift, and it makes the round trip total: anything
  // that survives parsing renders back to the byte string it came from.
  if (formatMandate(parsed) !== text) fail("mandate is not in canonical form");
  return parsed;
}

/** EIP-191 personal-sign digest of the canonical text. This is what `ecrecover` runs against. */
export function hashMandate(m: Mandate): Hex {
  return hashMessage(formatMandate(m)) as Hex;
}

/** Same digest for text that is already canonical, so tamper tests can perturb single bytes. */
export function hashMandateText(text: string): Hex {
  return hashMessage(text) as Hex;
}

/** DMK returns `{ r, s, v }`; the contract and viem both want 65 packed bytes. */
export function packSignature(sig: { r: string; s: string; v: number }): Hex {
  const r = sig.r.replace(/^0x/, "").padStart(64, "0");
  const s = sig.s.replace(/^0x/, "").padStart(64, "0");
  if (sig.v !== 27 && sig.v !== 28) throw new MandateFormatError(`unexpected recovery id ${sig.v}`);
  return `0x${r}${s}${sig.v.toString(16)}` as Hex;
}

/** Who actually signed these bytes. Returns the recovered address; the caller compares it. */
export function recoverMandateSigner(m: Mandate, signature: Hex): Hex {
  return recoverAddress(hashMandate(m), signature) as Hex;
}

export function isExpired(
  m: Mandate,
  atUnixSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): boolean {
  return atUnixSeconds > m.expiry;
}
