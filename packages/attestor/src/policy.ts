import { canonicalHash } from "./canonical.js";

/**
 * The adjudication policy, versioned and hashed.
 *
 * Everything a verdict depends on that is *not* on-chain data lives here, so a
 * third party recomputing a ratio knows which rules were in force. The policy id
 * is written into every attestation, every refusal and every HCS record: change
 * a threshold and old receipts stay verifiable against the policy they were
 * decided under rather than silently re-scoring.
 */
export interface CoveragePolicy {
  readonly id: string;
  /** Coverage at or above this clears. 10000 bps = 1.00x = exactly at par. */
  readonly floorBps: number;
  /** Observations older than this are refused rather than used. */
  readonly maxStalenessSeconds: number;
  /** Two readings of one position may differ by at most this, in bps. */
  readonly crossSourceToleranceBps: number;
  /** How long a signed verdict stays fresh. */
  readonly attestationTtlSeconds: number;
  /** Positions carried inline in the 1KB HCS record before it degrades to a digest. */
  readonly maxAnchoredPositions: number;
}

export const DEFAULT_POLICY: CoveragePolicy = {
  id: "plimsoll-coverage-1.0.0",
  // A note is "at the load line" at exactly par. We do not ship a buffer here:
  // a buffer is an issuer's risk parameter, not an attestor's, and baking one in
  // would mean refusing notes that are in fact fully covered.
  floorBps: 10_000,
  maxStalenessSeconds: 900,
  crossSourceToleranceBps: 10,
  attestationTtlSeconds: 300,
  maxAnchoredPositions: 6,
};

export function policyHash(policy: CoveragePolicy): `0x${string}` {
  return canonicalHash(policy);
}
