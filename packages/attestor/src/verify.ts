import type { Hex } from "viem";
import type { AnchorRecord } from "./anchor.js";
import { canonicalHash } from "./canonical.js";
import {
  attestationFromWire,
  attestorDomain,
  recoverAttestationSigner,
  recoverRefusalSigner,
  refusalFromWire,
  type OracleDomain,
} from "./eip712.js";
import { CURRENT_FORMAT, KNOWN_FORMATS, V1_ALWAYS_PRESENT, type FormatVersion } from "./format.js";
import {
  isV1RefusalWire,
  recoverRetiredAttestationSigner,
  recoverV1RefusalSigner,
  recoverV2RefusalSigner,
  retiredAttestationFromWire,
  v1RefusalFromWire,
  v2RefusalFromWire,
} from "./legacy.js";
import { familyOf, type RefusalReason } from "./reasons.js";
import { RATIO_BEARING_REASONS } from "./attest.js";
import type { StoredReceipt } from "./receipts.js";

/**
 * Verification primitives, shared by the CLI, the buyer and the tests.
 *
 * Nothing in this module needs a credential and nothing in it trusts the
 * service. Every function takes the artifacts a stranger can obtain — a receipt,
 * an anchored record, a mirror-node response — and returns a checkable result.
 *
 * Records are verified under the rules of the format they declare. A record in
 * a retired format is not rejected for being old; it is held to what that
 * format promised, and a record whose declared version and actual encoding
 * disagree fails.
 */

export interface Check {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  /**
   * Passed, but carries something a reader must not miss. Used where a record
   * is correct under the rules it was written to and those rules were bad.
   */
  note?: boolean;
}

export function check(id: string, label: string, passed: boolean, detail: string, note = false): Check {
  return note ? { id, label, passed, detail, note: true } : { id, label, passed, detail };
}

/**
 * Recompute coverage from raw readings.
 *
 * This deliberately does not call `coverageBpsOf` from the service. A verifier
 * that reuses the implementation it is auditing cannot catch a bug in it: the
 * two would agree on the wrong answer. The arithmetic below is written out
 * again, from the anchored inputs, in the plainest form that is correct.
 */
export function recomputeCoverageBps(args: {
  positions: Array<{ assets: string; assetDecimals: number }>;
  unitDecimals: number;
  notesOutstanding: string;
  parPerNote: string;
}): { attributableValue: bigint; obligation: bigint; bps: number } {
  let attributableValue = 0n;
  for (const position of args.positions) {
    const raw = BigInt(position.assets);
    const from = position.assetDecimals;
    const to = args.unitDecimals;
    const scaled =
      from === to ? raw : from < to ? raw * 10n ** BigInt(to - from) : raw / 10n ** BigInt(from - to);
    attributableValue += scaled;
  }
  const obligation = BigInt(args.notesOutstanding) * BigInt(args.parPerNote);
  if (obligation <= 0n) throw new Error("obligation is not positive; nothing can be verified");
  const bps = (attributableValue * 10_000n) / obligation;
  return { attributableValue, obligation, bps: Number(bps) };
}

/** The oracle a v3 signature is bound to, rebuilt from the record itself. */
export function oracleFromRecord(record: AnchorRecord | null | undefined): OracleDomain | null {
  if (!record?.orc || typeof record.cid !== "number") return null;
  return { chainId: record.cid, verifyingContract: record.orc as `0x${string}` };
}

/**
 * Verify a stored receipt's own internal consistency, under the rules of the
 * format its record declares.
 */
export async function checkReceipt(
  receipt: StoredReceipt,
  version: FormatVersion = CURRENT_FORMAT,
  oracle: OracleDomain | null = oracleFromRecord(receipt.anchorRecord),
): Promise<Check[]> {
  const checks: Check[] = [];

  if (receipt.evidence) {
    const recomputed = canonicalHash(receipt.evidence);
    checks.push(
      check(
        "evidence-hash",
        "sourceHash commits to the stored evidence",
        recomputed === receipt.sourceHash,
        recomputed === receipt.sourceHash
          ? String(receipt.sourceHash)
          : `stored ${receipt.sourceHash} but evidence hashes to ${recomputed}`,
      ),
    );
  } else {
    checks.push(
      check(
        "evidence-hash",
        "sourceHash commits to the stored evidence",
        true,
        "no evidence: the source failed before any snapshot existed, which the refusal states",
      ),
    );
  }

  checks.push(await checkSignature(receipt, version, oracle));
  checks.push(checkFamilyInvariant(receipt, version));
  return checks;
}

/**
 * The signed payload type is selected by the declared format, never guessed.
 *
 * v1 signed every refusal as one `Refusal` struct; v2 split it in two; both
 * signed under a domain of this service's own invention. v3 signs the struct
 * `CoverageOracle` actually recovers, under a domain bound to that oracle, so
 * its signatures are the ones the chain can accept. A payload in another
 * format's shape means the record's label does not describe what was signed,
 * and fails before recovery is attempted.
 */
async function checkSignature(
  receipt: StoredReceipt,
  version: FormatVersion,
  oracle: OracleDomain | null,
): Promise<Check> {
  const label = "EIP-712 signature recovers to the declared attestor";
  const signature = receipt.signature as Hex;
  try {
    let recovered: string;
    if (version === 3) {
      if (!oracle) {
        return check(
          "signature",
          label,
          false,
          "the record names no oracle, so the domain a v3 signature is bound to cannot be rebuilt",
        );
      }
      if (receipt.decision !== "attested" && isV1RefusalWire(receipt.message)) {
        return check("signature", label, false, "a v3 record carrying the retired v1 refusal payload");
      }
      const domain = attestorDomain(oracle);
      recovered =
        receipt.decision === "attested"
          ? await recoverAttestationSigner(domain, attestationFromWire(receipt.message), signature)
          : await recoverRefusalSigner(domain, refusalFromWire(receipt.message), signature);
    } else if (receipt.decision === "attested") {
      recovered = await recoverRetiredAttestationSigner(retiredAttestationFromWire(receipt.message), signature);
    } else {
      const legacyShape = isV1RefusalWire(receipt.message);
      if (version === 1 && !legacyShape) {
        return check(
          "signature",
          label,
          false,
          "the record declares format v1, but this refusal is signed over a later type; " +
            "v1 signed refusals as the single Refusal struct",
        );
      }
      if (version === 2 && legacyShape) {
        return check("signature", label, false, "the record declares format v2, but this refusal is signed over the retired v1 struct");
      }
      recovered = legacyShape
        ? await recoverV1RefusalSigner(v1RefusalFromWire(receipt.message), signature)
        : await recoverV2RefusalSigner(v2RefusalFromWire(receipt.message), signature);
    }
    const matches = recovered.toLowerCase() === receipt.attestor.toLowerCase();
    return check(
      "signature",
      label,
      matches,
      matches ? `${recovered} (format v${version})` : `recovered ${recovered}, expected ${receipt.attestor}`,
    );
  } catch (error) {
    return check("signature", label, false, String(error));
  }
}

/**
 * The invariant that keeps the taxonomy honest.
 *
 * The guarantee worth enforcing is one-directional: an evidence refusal must
 * never carry a ratio, because a number attached to "we could not tell" would
 * be read as a finding. The converse is not required. `declared_exceeds_real`
 * is an asset finding that deliberately quotes nothing — when an issuer has
 * misstated what they hold, publishing a coverage figure next to that would
 * invite someone to rely on it. Only the reasons that are *about* a ratio are
 * required to carry one.
 */
export function checkFamilyInvariant(
  receipt: StoredReceipt,
  version: FormatVersion = CURRENT_FORMAT,
): Check {
  if (receipt.decision === "attested") {
    return check(
      "family",
      "attestation carries a ratio",
      receipt.coverageBps !== null && receipt.coverageBps >= 0,
      `${receipt.coverageBps} bps`,
    );
  }
  const reason = receipt.reason as RefusalReason;
  const family = familyOf(reason);

  if (family === "evidence") {
    if (version === 1) {
      // v1 had no way to say "absent": it wrote a zero and set
      // coverageKnown=false. That is the defect later formats exist to fix, but
      // it is the rule this record was written under, so it is the rule applied
      // here, with the zero called out rather than passed silently.
      const ok = receipt.coverageKnown === false && receipt.coverageBps === 0;
      return check(
        "family",
        "evidence refusal states no ratio",
        ok,
        ok
          ? "format v1: coverageBps is zeroed and coverageKnown=false marks it meaningless; it is not a coverage reading"
          : `format v1 zeroed the figure on an evidence refusal, but this receipt has ` +
              `coverageKnown=${receipt.coverageKnown} and coverageBps=${JSON.stringify(receipt.coverageBps)}`,
        ok,
      );
    }
    const ok = receipt.coverageKnown === false && receipt.coverageBps === null;
    return check(
      "family",
      "evidence refusal states no ratio",
      ok,
      ok
        ? "no ratio quoted, as an evidence refusal requires"
        : `an evidence refusal reported coverageKnown=${receipt.coverageKnown} and coverageBps=${JSON.stringify(receipt.coverageBps)}, ` +
          `which conflates "we could not tell" with a finding about the asset`,
    );
  }

  const mustQuoteRatio = (RATIO_BEARING_REASONS as readonly string[]).includes(reason);
  const ok = mustQuoteRatio ? receipt.coverageKnown === true : true;
  return check(
    "family",
    "asset finding quotes a ratio when the reason is about one",
    ok,
    ok
      ? mustQuoteRatio
        ? `${reason}: ${receipt.coverageBps} bps`
        : `${reason}: a finding about the issuer's claim, not about a ratio`
      : `${reason} must quote the ratio it is a finding about, but coverageKnown=${receipt.coverageKnown}`,
  );
}

/**
 * The ratio we assert, as opposed to the readings a reader may divide.
 *
 * `val` and `obl` are measured quantities: on an asset finding they are the
 * finding, and a reader who divides them gets a true number about a real
 * position. `bps` and `floor` are our verdict, and publishing them where no
 * verdict was reached is the fabrication.
 */
const ASSERTED_RATIO_KEYS = ["bps", "floor"] as const;

/** An evidence refusal has no measurements either, so it publishes none. */
const EVIDENCE_FORBIDDEN_KEYS = [
  ...ASSERTED_RATIO_KEYS,
  "blk",
  "obs",
  "ud",
  "out",
  "par",
  "obl",
  "val",
  "ss",
  "vsh",
  "srch",
  "pos",
] as const;

/** Keys v3 added, which a record in that format must carry. */
const V3_REQUIRED_KEYS = ["nid", "orc", "cid", "feed"] as const;

/**
 * Feed ids whose readings are invented rather than measured.
 *
 * A record produced from fixtures is a demonstration of the mechanism, not a
 * statement about anybody's balance sheet. It is still a true record — the
 * signature, the arithmetic and the charge all check out — which is precisely
 * why it has to be labelled: everything about it looks like a live reading.
 */
export const SIMULATED_FEEDS: readonly string[] = ["fixture"];

/**
 * Say plainly where the numbers came from.
 *
 * This passes either way: simulated inputs do not make a charge unwarranted,
 * and refusing them here would just mean the demo reports a false discrepancy.
 * What it must never do is stay quiet, so a fixture-derived record is flagged
 * as a note and the wording leaves no room to read it as a measurement.
 */
export function checkProvenance(record: AnchorRecord): Check {
  const feed = record.feed;
  if (feed === undefined) {
    return check(
      "provenance",
      "the record says where its readings came from",
      false,
      "the record names no source, so there is no way to tell a measurement from a simulation",
    );
  }
  const simulated = SIMULATED_FEEDS.includes(feed);
  return check(
    "provenance",
    "the record says where its readings came from",
    true,
    simulated
      ? `feed "${feed}": these figures come from checked-in fixtures, not from a chain. ` +
        `The mechanism is real and this record is genuine; the coverage it reports is not a measurement of anything`
      : `feed "${feed}": read from a chain`,
    simulated,
  );
}

/**
 * No figure is published where none was established.
 *
 * This is the negative control for the defect in the first encoding: an
 * evidence refusal carrying `"bps": 0` is not "no ratio", it is a claim of zero
 * percent coverage, byte-identical in that field to a genuine
 * `no_attributable_positions` finding. Absence is the only unambiguous
 * encoding, so presence alone is a failure regardless of the value.
 */
export function checkNoPhantomRatio(record: AnchorRecord): Check {
  const asRecord = record as unknown as Record<string, unknown>;
  const isEvidenceRefusal = record.d === "refused" && record.fam === "evidence";
  const forbidden = isEvidenceRefusal
    ? EVIDENCE_FORBIDDEN_KEYS
    : record.known === false
      ? ASSERTED_RATIO_KEYS
      : [];

  const present = forbidden.filter((key) => key in asRecord);
  return check(
    "no-phantom-ratio",
    "no coverage figure is published where none was established",
    present.length === 0,
    present.length === 0
      ? isEvidenceRefusal
        ? "evidence refusal carries no ratio, block, hash or readings"
        : record.known === false
          ? "no ratio is quoted, and no key from which one could be read"
          : "not applicable: a ratio was established"
      : `record contains ${present.map((k) => `${k}=${JSON.stringify(asRecord[k])}`).join(", ")} ` +
        `despite establishing no ratio; a zero here reads as zero percent coverage`,
  );
}

/**
 * Hold a record to the encoding its declared version promises.
 *
 * v3 forbids figures that were not established and requires the fields that
 * make it self-verifying: the note id the oracle knows, and the oracle and
 * chain its signature is bound to. v1 always wrote the full numeric block, so a
 * v1-labelled record missing any of it was written by a later encoder under the
 * wrong label and fails; one carrying a zeroed block on a refusal with no ratio
 * passes, because that is what v1 meant by "unknown", and is flagged so nobody
 * mistakes the zero for a reading.
 */
export function checkEncoding(record: AnchorRecord): Check {
  const asRecord = record as unknown as Record<string, unknown>;
  const version = asRecord.v;

  if (version === 3) {
    const missing = V3_REQUIRED_KEYS.filter((key) => !(key in asRecord));
    if (missing.length > 0) {
      return check(
        "encoding-v3",
        "record matches the v3 encoding it declares",
        false,
        `declares format v3 but omits ${missing.join(", ")}, without which its signature cannot be checked, ` +
          `or its readings traced to a source, from the record alone`,
      );
    }
    const rule = checkNoPhantomRatio(record);
    return { ...rule, detail: `format v3: ${rule.detail}` };
  }

  if (version === 2) {
    const rule = checkNoPhantomRatio(record);
    return { ...rule, detail: `format v2: ${rule.detail}` };
  }

  if (version === 1) {
    const label = "record matches the v1 encoding it declares";
    const missing = V1_ALWAYS_PRESENT.filter((key) => !(key in asRecord));
    if (missing.length > 0) {
      return check(
        "encoding-v1",
        label,
        false,
        `declares format v1 but omits ${missing.join(", ")}, which the v1 encoder wrote on every ` +
          "record; this is a later encoding under a v1 label",
      );
    }
    const zeroedUnknown = record.d === "refused" && record.known === false;
    return check(
      "encoding-v1",
      label,
      true,
      zeroedUnknown
        ? `format v1: the numeric block is present but zeroed, and known=false marks it meaningless. ` +
            `v1 had no way to omit a figure; bps=${JSON.stringify(record.bps)} here is not a coverage reading`
        : "format v1: full numeric block present, as that encoder always wrote it",
      zeroedUnknown,
    );
  }

  return check(
    "format",
    "record declares a known format version",
    false,
    `unknown format version ${JSON.stringify(version)}; expected one of ${KNOWN_FORMATS.join(", ")}`,
  );
}

/** Cross-check an anchored record against the receipt it claims to summarise. */
export function checkAnchorBinding(record: AnchorRecord, receipt: StoredReceipt): Check[] {
  const fields: Array<[string, unknown, unknown]> = [
    ["requestId", record.rid, receipt.requestId],
    ["noteId", record.n, receipt.noteId],
    ["decision", record.d, receipt.decision],
    // Both sides normalise absence to null, so a missing key and an explicit
    // null agree while a zero still stands out.
    ["sourceHash", record.srch ?? null, receipt.sourceHash ?? null],
    ["signature", record.sig, receipt.signature],
    ["attestor", record.att.toLowerCase(), receipt.attestor.toLowerCase()],
    ["coverageBps", record.bps ?? null, receipt.coverageBps ?? null],
    ["charged", record.chg, receipt.chargeTransactionId !== null],
  ];
  const mismatches = fields.filter(([, a, b]) => a !== b);
  return [
    check(
      "anchor-binding",
      "anchored record matches the off-chain receipt",
      mismatches.length === 0,
      mismatches.length === 0
        ? `${fields.length} fields agree`
        : mismatches.map(([name, a, b]) => `${name}: anchored ${String(a)} vs receipt ${String(b)}`).join("; "),
    ),
  ];
}

export interface AttestationValidity {
  valid: boolean;
  reasons: string[];
}

/**
 * What a consumer should check before relying on an attestation.
 *
 * Separate from the charge audit on purpose: an expired attestation was still
 * warranted when it was issued, so expiry belongs to the consumer's decision to
 * rely on it, not to the question of whether the charge was fair.
 */
export async function verifyAttestation(args: {
  message: Record<string, unknown>;
  signature: string;
  expectedAttestor: string;
  oracle: OracleDomain;
  now?: number;
  seenNonces?: Set<string>;
}): Promise<AttestationValidity> {
  const reasons: string[] = [];
  const message = attestationFromWire(args.message);
  const now = args.now ?? Math.floor(Date.now() / 1000);

  try {
    const recovered = await recoverAttestationSigner(attestorDomain(args.oracle), message, args.signature as Hex);
    if (recovered.toLowerCase() !== args.expectedAttestor.toLowerCase()) {
      reasons.push(`signature recovers to ${recovered}, not ${args.expectedAttestor}`);
    }
  } catch (error) {
    reasons.push(`signature does not recover: ${String(error)}`);
  }

  if (message.expiry <= BigInt(now)) {
    reasons.push(`expired at ${message.expiry} (now ${now})`);
  }
  if (args.seenNonces?.has(message.nonce.toString())) {
    reasons.push(`nonce ${message.nonce} has already been used`);
  }

  return { valid: reasons.length === 0, reasons };
}
