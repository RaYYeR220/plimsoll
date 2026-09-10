/**
 * The refusal taxonomy.
 *
 * The distinction the two families draw is the product. "This note is
 * under-backed" is a finding about somebody else's asset; "we could not tell"
 * is a confession about our own evidence. Collapsing them would let a data
 * outage read as an accusation, which is the failure mode that makes an
 * attestation service worthless. They stay separated in the reason code, in the
 * HTTP status, in the signed payload, and in the HCS record.
 */
export type RefusalFamily = "asset" | "evidence";

export const REFUSAL_FAMILY_CODE: Record<RefusalFamily, number> = {
  asset: 1,
  evidence: 2,
};

/** A finding about the asset: we could tell, and the answer is no. */
export type AssetRefusalReason =
  | "coverage_below_floor"
  | "declared_exceeds_real"
  | "no_attributable_positions";

/** A statement about our own evidence: we could not tell. */
export type EvidenceRefusalReason =
  | "source_unavailable"
  | "data_stale"
  | "sources_disagree"
  | "vault_unresolved"
  | "vault_set_drift";

export type RefusalReason = AssetRefusalReason | EvidenceRefusalReason;

const ASSET_REASONS = new Set<string>([
  "coverage_below_floor",
  "declared_exceeds_real",
  "no_attributable_positions",
]);

const EVIDENCE_REASONS = new Set<string>([
  "source_unavailable",
  "data_stale",
  "sources_disagree",
  "vault_unresolved",
  "vault_set_drift",
]);

export const ALL_REFUSAL_REASONS: readonly RefusalReason[] = [
  ...ASSET_REASONS,
  ...EVIDENCE_REASONS,
] as RefusalReason[];

export function familyOf(reason: RefusalReason): RefusalFamily {
  if (ASSET_REASONS.has(reason)) return "asset";
  if (EVIDENCE_REASONS.has(reason)) return "evidence";
  throw new Error(`unknown refusal reason: ${reason}`);
}

/**
 * HTTP status per family. Both are >= 400, which is what makes them free — the
 * x402 middleware cancels settlement for any 4xx/5xx — but they are different
 * codes so the distinction survives into an access log a judge can read without
 * parsing a body.
 *
 * 422 says: the request was fine, the entity it describes does not clear.
 * 424 says: this failed on a dependency of ours, not on anything about you.
 */
export function httpStatusFor(family: RefusalFamily): 422 | 424 {
  return family === "asset" ? 422 : 424;
}

/** One-line human explanations, surfaced in the response and in `--explain`. */
export const REFUSAL_DESCRIPTIONS: Record<RefusalReason, string> = {
  coverage_below_floor:
    "Attributable vault value is below the load line for this note.",
  declared_exceeds_real:
    "The issuer declared more vault shares than the nominated address actually holds.",
  no_attributable_positions:
    "The nominated address holds no positions in the note's vault set.",
  source_unavailable:
    "The coverage source could not be reached, so no ratio was computed.",
  data_stale:
    "The most recent observation is older than the policy's staleness tolerance.",
  sources_disagree:
    "Independent readings of the same position differ beyond tolerance.",
  vault_unresolved:
    "A vault in the set did not return a usable convertToAssets reading.",
  vault_set_drift:
    "The observed vault set does not match the set the issuer nominated.",
};
