/**
 * Anchor record format versions.
 *
 * v1 always emitted the full numeric block, zeroing whatever it did not know,
 * and signed refusals as a single `Refusal` struct. v2 omits every figure that
 * was not established and signs the two refusal families as separate types.
 *
 * The version is what lets a stranger read a record correctly from the public
 * topic alone. Some v1-labelled records were written after the encoding changed
 * but before the label did, which is exactly the failure a version exists to
 * prevent: the label must change whenever the encoding does, and a record whose
 * label and encoding disagree fails verification.
 *
 * Kept free of imports so the verifier can depend on it without loading the
 * Hedera SDK that anchoring needs.
 */
export const CURRENT_FORMAT = 2 as const;

export type FormatVersion = 1 | 2;

export const KNOWN_FORMATS: readonly FormatVersion[] = [1, 2];

/**
 * Keys the v1 encoder wrote on every record, whether or not it knew them. A
 * record that declares v1 but lacks any of these was not written by the v1
 * encoder.
 */
export const V1_ALWAYS_PRESENT = [
  "bps",
  "floor",
  "blk",
  "obs",
  "pol",
  "ud",
  "out",
  "par",
  "obl",
  "val",
  "ss",
  "vsh",
  "srch",
  "full",
] as const;
