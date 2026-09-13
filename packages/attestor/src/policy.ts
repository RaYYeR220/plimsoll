import { canonicalHash } from "./canonical.js";

/**
 * The adjudication policy, versioned and hashed.
 *
 * Everything a verdict depends on that is *not* on-chain data lives here, so a
 * third party recomputing a ratio knows which rules were in force. The policy id
 * is written into every attestation, every refusal and every HCS record: change
 * a tolerance and old receipts stay verifiable against the policy they were
 * decided under rather than silently re-scoring.
 *
 * The load line is deliberately absent. It used to live here as a single
 * service-wide floor, which made the one number that decides whether value
 * moves a value somebody typed into a config file. It is on-chain data — each
 * note has its own line in `LoadLine` — so it is read with the note's other
 * figures, and a source that cannot read it refuses.
 */
export interface CoveragePolicy {
  readonly id: string;
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
  // 1.1.0: the load line left the policy and is read per note from LoadLine.
  // The rules changed, so the id does too; 1.0.0 records stay what they were.
  id: "plimsoll-coverage-1.1.0",
  maxStalenessSeconds: 900,
  crossSourceToleranceBps: 10,
  attestationTtlSeconds: 300,
  maxAnchoredPositions: 6,
};

export function policyHash(policy: CoveragePolicy): `0x${string}` {
  return canonicalHash(policy);
}
