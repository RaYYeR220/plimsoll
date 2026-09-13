import type { EvidenceRefusalReason } from "../reasons.js";

/**
 * ============================ SEAM ============================
 * This module is the boundary between the attestation service and the data
 * that backs it. Everything above this line is real: the decision logic, the
 * signing, the payment flow, the anchoring, the verifier.
 *
 * Behind this interface today there is exactly one usable implementation,
 * `FixtureCoverageSource`, which reads checked-in JSON. The production
 * implementation reads real ERC-4626 positions on Base and is being built
 * separately; `LiveCoverageSource` is its typed placeholder and throws
 * `SourceUnavailable` on every call.
 *
 * The rule that makes the seam safe: a source may return a reading or it may
 * fail, and it may never do anything in between. There is no default, no
 * last-known-good, no zero-fill. If the data is not there the service refuses
 * and says so. A real zero is different from an absence: a source that reads
 * the chain and finds nothing backing the note returns an empty position set,
 * which is a finding about the asset, not a failure of ours. See MOCKS.md.
 * ==============================================================
 */

/** A single ERC-4626 position held by the issuer's nominated address. */
export interface VaultPosition {
  /** ERC-4626 vault address, lowercase 0x hex. */
  readonly vault: string;
  /** Share balance actually held by the nominated address at `blockNumber`. */
  readonly shares: bigint;
  /**
   * What the issuer claims to hold. Present so the service can reject an
   * issuer who nominates more than the chain agrees they own; it is never used
   * as a value input.
   */
  readonly declaredShares: bigint;
  /** `convertToAssets(shares)` as read at `blockNumber`. */
  readonly assets: bigint;
  /** Decimals of the vault's underlying asset, for normalisation. */
  readonly assetDecimals: number;
  /** Block the two readings above were taken at. */
  readonly blockNumber: bigint;
}

/** Where a snapshot came from, precisely enough to be re-fetched by a stranger. */
export interface SourceSetDescriptor {
  /** Stable id of the implementation, e.g. `fixture` or `base`. */
  readonly kind: string;
  /** Dataset identity, e.g. an indexer package hash or fixture set version. */
  readonly dataset: string;
  /** Independent endpoints that agreed on this snapshot. */
  readonly endpoints: readonly string[];
}

/** One coherent observation of a note's backing. */
export interface CoverageSnapshot {
  /** The market code a human reads, e.g. `PLIM-B`. */
  readonly noteId: string;
  /**
   * The vault-set hash the note is registered with on the oracle.
   *
   * The attestation commits to this value, because that is what
   * `CoverageOracle` compares against; an attestation carrying anything else
   * is rejected outright. It is the registry's identifier for the backing set,
   * not something this service is free to compute. `observedVaultSetHash` on
   * the evidence records what the vault set we actually read hashes to, so the
   * two can be compared by anyone.
   */
  readonly registeredVaultSetHash: string;
  /**
   * The load line for this note in basis points, read from `LoadLine.lineOf`.
   *
   * This is not a policy setting and must never come from one. The threshold is
   * the single number that decides whether value moves, so it is read from the
   * chain, per note, at the time of the reading — a threshold living in our own
   * configuration would be exactly the unverifiable number this project exists
   * to refuse. A source that cannot read it fails; there is no default.
   */
  readonly thresholdBps: number;
  /** The address the issuer nominated as holding the backing. */
  readonly holder: string;
  /** The vault set the issuer nominated, lowercase and sorted. */
  readonly nominatedVaults: readonly string[];
  readonly positions: readonly VaultPosition[];
  readonly notesOutstanding: bigint;
  /** Par value of one note, in `unitDecimals`. */
  readonly parPerNote: bigint;
  /** Decimals every amount is normalised to before the ratio is taken. */
  readonly unitDecimals: number;
  /** Block on the source chain the readings were taken at. */
  readonly asOfBlock: bigint;
  /** Unix seconds at which the underlying chain state was observed. */
  readonly observedAt: number;
  readonly sourceSet: SourceSetDescriptor;
}

export interface CoverageSource {
  readonly id: string;
  /**
   * @param noteId - Market code of the note to value.
   * @param atBlock - Pin the reading to a block; omitted means latest.
   * @throws {CoverageSourceError} when a ratio cannot be honestly produced.
   */
  positionsFor(noteId: string, atBlock?: bigint): Promise<CoverageSnapshot>;
}

/**
 * Base class for every failure a source is allowed to have. Each carries the
 * evidence-family refusal reason it maps to, so `attest()` never has to guess
 * what an unexpected exception meant.
 */
export class CoverageSourceError extends Error {
  readonly reason: EvidenceRefusalReason;
  readonly detail: Record<string, unknown>;

  constructor(reason: EvidenceRefusalReason, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.reason = reason;
    this.detail = detail;
  }
}

/** The source could not be reached at all. The live pipeline throws this today. */
export class SourceUnavailable extends CoverageSourceError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("source_unavailable", message, detail);
  }
}

/** A vault in the set returned no usable `convertToAssets` reading. */
export class VaultUnresolved extends CoverageSourceError {
  constructor(vault: string, message: string) {
    super("vault_unresolved", message, { vault });
  }
}

/** Two independent endpoints disagreed about the same position. */
export class SourcesDisagree extends CoverageSourceError {
  constructor(vault: string, left: string, right: string, toleranceBps: number) {
    super("sources_disagree", `readings for ${vault} differ beyond ${toleranceBps}bps`, {
      vault,
      left,
      right,
      toleranceBps,
    });
  }
}

/** The observed vault set is not the one the issuer nominated. */
export class VaultSetDrift extends CoverageSourceError {
  constructor(expected: readonly string[], observed: readonly string[]) {
    super("vault_set_drift", "observed vault set does not match the nominated set", {
      expected: [...expected],
      observed: [...observed],
    });
  }
}
