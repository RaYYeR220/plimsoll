/**
 * The refusal taxonomy, mirroring packages/attestor/src/reasons.ts.
 *
 * "This is under-backed" is a finding about somebody else's asset. "We could
 * not tell" is a statement about our own evidence. An agent that acts on
 * answers has to be able to branch on that difference without parsing prose:
 * it should never retry an asset finding, and it should retry an evidence
 * refusal with a backoff. So the family is a field, and evidence refusals are
 * constructed with no slot a figure could go in.
 */
import type { Provenance } from "./provenance.js";

export type AssetRefusalReason = "coverage_below_floor" | "no_attributable_positions";

export type EvidenceRefusalReason =
  | "source_unavailable"
  | "data_stale"
  | "vault_unresolved"
  | "vault_set_drift";

export type RefusalReason = AssetRefusalReason | EvidenceRefusalReason;

const DESCRIPTIONS: Record<RefusalReason, string> = {
  coverage_below_floor: "Attributable vault value is below the load line for this note.",
  no_attributable_positions: "The nominated holder has no position in the note's vault set.",
  source_unavailable: "The Graph Market stream is not connected or has produced no data yet, so nothing was computed.",
  data_stale: "The most recent observation is older than the staleness tolerance, so it is not served as current.",
  vault_unresolved: "The vault could not be resolved to a conforming ERC-4626 reading.",
  vault_set_drift: "The note's committed vault set does not match the vaults it nominates.",
};

export interface EvidenceRefusal {
  readonly result: "refused";
  readonly family: "evidence";
  readonly reason: EvidenceRefusalReason;
  readonly message: string;
  /** Always false: no figure was established. */
  readonly coverageKnown: false;
  /** Non-numeric context only: which vault, which threshold was crossed, and why. */
  readonly detail: Readonly<Record<string, string | boolean | readonly string[]>>;
  readonly provenance: Provenance;
}

export interface AssetRefusal {
  readonly result: "refused";
  readonly family: "asset";
  readonly reason: AssetRefusalReason;
  readonly message: string;
  readonly coverageKnown: true;
  readonly coverageBps: number;
  readonly floorBps: number;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly provenance: Provenance;
}

export type Refusal = EvidenceRefusal | AssetRefusal;

/**
 * The detail type admits only strings, booleans and string arrays. A number
 * cannot be attached to an evidence refusal even by accident, because
 * "the figure is 0" and "there is no figure" must never look alike.
 */
export function evidenceRefusal(
  reason: EvidenceRefusalReason,
  provenance: Provenance,
  detail: Record<string, string | boolean | readonly string[]> = {},
  message = DESCRIPTIONS[reason],
): EvidenceRefusal {
  return { result: "refused", family: "evidence", reason, message, coverageKnown: false, detail, provenance };
}

export function assetRefusal(
  reason: AssetRefusalReason,
  coverageBps: number,
  floorBps: number,
  provenance: Provenance,
  detail: Record<string, unknown> = {},
): AssetRefusal {
  return {
    result: "refused",
    family: "asset",
    reason,
    message: DESCRIPTIONS[reason],
    coverageKnown: true,
    coverageBps,
    floorBps,
    detail,
    provenance,
  };
}

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && (value as { result?: unknown }).result === "refused";
}
