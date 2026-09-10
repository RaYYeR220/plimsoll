import { createHash } from "node:crypto";

/**
 * Deterministic JSON with lexicographically ordered object keys.
 *
 * Every hash a third party has to reproduce — `sourceHash`, `vaultSetHash`, the
 * ERC-8004 `feedbackHash` — is taken over the output of this function. Key order
 * is therefore part of the wire contract: two parties that disagree about it
 * compute different digests and the verifier reports a DISCREPANCY for what is
 * really a serialisation bug. Arrays keep their order because for us array order
 * is meaningful (a vault set is sorted before it gets here, not by the encoder).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") {
    // bigint has no JSON representation; forcing decimal strings here keeps
    // amounts exact instead of letting them decay through Number.
    return typeof value === "bigint" ? value.toString() : value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key]);
  return out;
}

/** SHA-256 over the canonical encoding, as a 0x-prefixed hex string. */
export function canonicalHash(value: unknown): `0x${string}` {
  return `0x${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** First `bytes` of a canonical hash, for the space-constrained HCS record. */
export function shortHash(hash: string, bytes = 8): string {
  return hash.startsWith("0x") ? hash.slice(2, 2 + bytes * 2) : hash.slice(0, bytes * 2);
}
