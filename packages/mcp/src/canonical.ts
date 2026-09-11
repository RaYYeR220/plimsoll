import { createHash } from "node:crypto";

/**
 * Byte-for-byte the encoding in packages/attestor/src/canonical.ts. It is
 * re-implemented rather than imported so this package does not depend on the
 * attestor's build, and a pinned vector in the tests (computed by running the
 * attestor's own function) keeps the two from drifting. A vault-set hash that
 * differs by one byte would make every note read as `vault_set_drift`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key]);
  return out;
}

export function canonicalHash(value: unknown): `0x${string}` {
  return `0x${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** The note's vault-set commitment, as CoverageOracle stores it. */
export function vaultSetHash(vaults: readonly string[]): `0x${string}` {
  return canonicalHash([...vaults].map((v) => v.toLowerCase()).sort());
}
