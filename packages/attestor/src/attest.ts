import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { canonicalHash } from "./canonical.js";
import {
  type CoverageSnapshot,
  type CoverageSource,
  CoverageSourceError,
  UnknownNote,
} from "./coverage/index.js";
import {
  type AttestationMessage,
  type AttestorSigner,
  type RefusalMessage,
  noteIdOf,
} from "./eip712.js";
import { DEFAULT_POLICY, type CoveragePolicy, policyHash } from "./policy.js";
import {
  REFUSAL_DESCRIPTIONS,
  type AssetRefusalReason,
  type RefusalFamily,
  type RefusalReason,
  familyOf,
  httpStatusFor,
} from "./reasons.js";

/** The upstream handed us something that cannot be adjudicated at all. */
export class MalformedSnapshot extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "MalformedSnapshot";
    this.detail = detail;
  }
}

/**
 * `CoverageOracle` rejects anything above this as a malformed feed rather than
 * a solvent issuer, so the ratio is capped here too. Capping can only ever
 * understate coverage, and an understated ratio that still clears the load line
 * is safe; reporting 200x as 100x costs nothing, while signing a number the
 * oracle will refuse costs the whole attestation.
 */
export const MAX_PLAUSIBLE_COVERAGE_BPS = 1_000_000n;

/** One position after decimal normalisation, kept so a stranger can redo the sum. */
export interface NormalisedPosition {
  vault: string;
  shares: string;
  declaredShares: string;
  assets: string;
  assetDecimals: number;
  /** `assets` restated in `unitDecimals`. This is the number that is summed. */
  normalisedAssets: string;
  blockNumber: string;
}

/**
 * Everything the verdict was computed from, and nothing else. This object is
 * hashed into `sourceHash`, so it is simultaneously the audit record and the
 * commitment: a stranger who re-reads the vaults at `asOfBlock` must be able to
 * rebuild this byte for byte.
 */
export interface Evidence {
  noteId: string;
  /** keccak256 of the market code: the id the oracle knows the note by. */
  noteIdHash: string;
  holder: string;
  policyId: string;
  policyHash: Hex;
  floorBps: number;
  asOfBlock: string;
  observedAt: number;
  unitDecimals: number;
  notesOutstanding: string;
  parPerNote: string;
  /** notesOutstanding * parPerNote, in unitDecimals. The denominator. */
  obligation: string;
  positions: NormalisedPosition[];
  /** Sum of normalisedAssets. The numerator. */
  attributableValue: string;
  sourceSet: { kind: string; dataset: string; endpoints: string[] };
  /** What the attestation commits to: the set registered on the oracle. */
  vaultSetHash: string;
  /** What the vault set we actually read hashes to. Anyone can compare the two. */
  observedVaultSetHash: Hex;
}

export interface AttestedVerdict {
  decision: "attested";
  httpStatus: 200;
  noteId: string;
  noteIdHash: Hex;
  coverageBps: number;
  /** Source that produced the readings. "fixture" means simulated, not measured. */
  feed: string;
  message: AttestationMessage;
  signature: Hex;
  attestor: string;
  evidence: Evidence;
  sourceHash: Hex;
  /** True when this verdict is the one a charge is warranted for. */
  chargeable: true;
}

export interface RefusedVerdict {
  decision: "refused";
  httpStatus: 422 | 424;
  noteId: string;
  noteIdHash: Hex;
  family: RefusalFamily;
  reason: RefusalReason;
  description: string;
  /** Only ever true for the asset family. */
  coverageKnown: boolean;
  /** Null whenever no ratio was established. Never zero: zero is a claim. */
  coverageBps: number | null;
  /** Source that produced the readings. "fixture" means simulated, not measured. */
  feed: string;
  message: RefusalMessage;
  signature: Hex;
  /** Always null for the evidence family, which asserts it has none. */
  evidence: Evidence | null;
  attestor: string;
  sourceHash: Hex | null;
  detail: Record<string, unknown>;
  chargeable: false;
}

export type Verdict = AttestedVerdict | RefusedVerdict;

/**
 * Nonces are `uint64` and must strictly increase per note: the oracle rejects
 * anything at or below the nonce it already recorded. Wall-clock seconds are
 * monotonic and need no coordination, with a bump when two verdicts land in the
 * same second.
 */
export interface NonceSource {
  next(noteIdHash: string): bigint;
}

export class ClockNonces implements NonceSource {
  private readonly issued = new Map<string, bigint>();
  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}
  next(noteIdHash: string): bigint {
    const seconds = BigInt(this.now());
    const last = this.issued.get(noteIdHash);
    const nonce = last === undefined || seconds > last ? seconds : last + 1n;
    this.issued.set(noteIdHash, nonce);
    return nonce;
  }
}

export interface AttestOptions {
  source: CoverageSource;
  signer: AttestorSigner;
  policy?: CoveragePolicy;
  /** Injected clock in unix seconds, so expiry and staleness are testable. */
  now?: () => number;
  nonces?: NonceSource;
  atBlock?: bigint;
}

const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

/**
 * Adjudicate one note.
 *
 * Exactly one of two things comes back, both signed: a coverage attestation, or
 * a refusal. There is no third branch and no path that returns a number the
 * source did not support. Every failure below is mapped to a named reason
 * before it can reach a caller.
 *
 * @throws {UnknownNote} when the note does not exist (a 404, not a verdict).
 * @throws {MalformedSnapshot} when the source returned something unadjudicable.
 */
export async function attest(noteId: string, options: AttestOptions): Promise<Verdict> {
  const policy = options.policy ?? DEFAULT_POLICY;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const nonces = options.nonces ?? new ClockNonces(now);
  const noteIdHash = noteIdOf(noteId);

  let snapshot: CoverageSnapshot;
  try {
    snapshot = await options.source.positionsFor(noteId, options.atBlock);
  } catch (error) {
    if (error instanceof UnknownNote) throw error;
    if (error instanceof CoverageSourceError) {
      // The source failed. We have no evidence at all, so the refusal carries
      // no ratio and no vault set: signing a zero here would be a lie the
      // shape of a fact.
      return refuse({
        noteId,
        noteIdHash,
        reason: error.reason,
        evidence: null,
        coverage: null,
        detail: error.detail,
        policy,
        signer: options.signer,
        feed: options.source.id,
        now: now(),
        nonce: nonces.next(noteIdHash),
      });
    }
    throw error;
  }

  if (snapshot.notesOutstanding <= 0n || snapshot.parPerNote <= 0n) {
    throw new MalformedSnapshot("a note must have positive outstanding supply and par", {
      noteId: snapshot.noteId,
      notesOutstanding: snapshot.notesOutstanding.toString(),
      parPerNote: snapshot.parPerNote.toString(),
    });
  }

  const evidence = buildEvidence(snapshot, policy, noteIdHash);
  const timestamp = now();

  // Staleness first: a ratio computed from data we already consider unusable
  // must never be quoted, not even to say it was low.
  const age = timestamp - snapshot.observedAt;
  if (age > policy.maxStalenessSeconds) {
    return refuse({
      noteId: snapshot.noteId,
      noteIdHash,
      reason: "data_stale",
      evidence,
      coverage: null,
      detail: { ageSeconds: age, toleranceSeconds: policy.maxStalenessSeconds },
      policy,
      signer: options.signer,
      feed: options.source.id,
      now: timestamp,
      nonce: nonces.next(noteIdHash),
    });
  }

  // Bind to real state: an issuer may nominate an address and a vault set, but
  // the balance that gets valued is the one the chain reports. Declaring more
  // than is held is a finding about the note, not a data problem.
  const overdeclared = snapshot.positions.filter((p) => p.declaredShares > p.shares);
  if (overdeclared.length > 0) {
    return refuse({
      noteId: snapshot.noteId,
      noteIdHash,
      reason: "declared_exceeds_real",
      evidence,
      coverage: null,
      detail: {
        positions: overdeclared.map((p) => ({
          vault: p.vault,
          declaredShares: p.declaredShares.toString(),
          actualShares: p.shares.toString(),
        })),
      },
      policy,
      signer: options.signer,
      feed: options.source.id,
      now: timestamp,
      nonce: nonces.next(noteIdHash),
    });
  }

  const attributable = BigInt(evidence.attributableValue);
  const obligation = BigInt(evidence.obligation);

  // Checked before the ratio, because "nothing is backing this" is a more
  // precise finding than "the ratio is 0". A source that reads the chain and
  // finds no positions has told us something true about the asset.
  if (snapshot.positions.length === 0 || attributable === 0n) {
    return refuse({
      noteId: snapshot.noteId,
      noteIdHash,
      reason: "no_attributable_positions",
      evidence,
      coverage: 0,
      detail: { positions: snapshot.positions.length },
      policy,
      signer: options.signer,
      feed: options.source.id,
      now: timestamp,
      nonce: nonces.next(noteIdHash),
    });
  }

  const coverageBps = coverageBpsOf(attributable, obligation);
  if (coverageBps < snapshot.thresholdBps) {
    return refuse({
      noteId: snapshot.noteId,
      noteIdHash,
      reason: "coverage_below_floor",
      evidence,
      coverage: coverageBps,
      detail: { coverageBps, floorBps: snapshot.thresholdBps },
      policy,
      signer: options.signer,
      feed: options.source.id,
      now: timestamp,
      nonce: nonces.next(noteIdHash),
    });
  }

  const sourceHash = canonicalHash(evidence);
  const message: AttestationMessage = {
    noteId: noteIdHash,
    coverageBps: BigInt(coverageBps),
    asOfBlock: snapshot.asOfBlock,
    vaultSetHash: evidence.vaultSetHash as Hex,
    sourceHash,
    expiry: BigInt(timestamp + policy.attestationTtlSeconds),
    nonce: nonces.next(noteIdHash),
  };
  const signature = await options.signer.signAttestation(message);

  return {
    decision: "attested",
    httpStatus: 200,
    noteId: snapshot.noteId,
    noteIdHash,
    coverageBps,
    message,
    signature,
    attestor: options.signer.address,
    evidence,
    sourceHash,
    feed: options.source.id,
    chargeable: true,
  };
}

/**
 * Coverage in basis points, floored.
 *
 * Flooring is deliberate: rounding up could push a note that is a hair short
 * over the load line, and the whole point of the load line is that it is not
 * negotiable. Integer maths throughout; no float ever touches a ratio.
 */
export function coverageBpsOf(attributableValue: bigint, obligation: bigint): number {
  if (obligation <= 0n) throw new MalformedSnapshot("obligation must be positive");
  const bps = (attributableValue * 10_000n) / obligation;
  return Number(bps > MAX_PLAUSIBLE_COVERAGE_BPS ? MAX_PLAUSIBLE_COVERAGE_BPS : bps);
}

function buildEvidence(snapshot: CoverageSnapshot, policy: CoveragePolicy, noteIdHash: Hex): Evidence {
  const positions: NormalisedPosition[] = snapshot.positions.map((p) => ({
    vault: p.vault,
    shares: p.shares.toString(),
    declaredShares: p.declaredShares.toString(),
    assets: p.assets.toString(),
    assetDecimals: p.assetDecimals,
    normalisedAssets: normalise(p.assets, p.assetDecimals, snapshot.unitDecimals).toString(),
    blockNumber: p.blockNumber.toString(),
  }));

  const attributableValue = positions.reduce((sum, p) => sum + BigInt(p.normalisedAssets), 0n);
  const obligation = snapshot.notesOutstanding * snapshot.parPerNote;

  return {
    noteId: snapshot.noteId,
    noteIdHash,
    holder: snapshot.holder,
    policyId: policy.id,
    policyHash: policyHash(policy),
    // The note's own line, as its source read it from LoadLine. Never a policy value.
    floorBps: snapshot.thresholdBps,
    asOfBlock: snapshot.asOfBlock.toString(),
    observedAt: snapshot.observedAt,
    unitDecimals: snapshot.unitDecimals,
    notesOutstanding: snapshot.notesOutstanding.toString(),
    parPerNote: snapshot.parPerNote.toString(),
    obligation: obligation.toString(),
    positions,
    attributableValue: attributableValue.toString(),
    sourceSet: {
      kind: snapshot.sourceSet.kind,
      dataset: snapshot.sourceSet.dataset,
      endpoints: [...snapshot.sourceSet.endpoints],
    },
    vaultSetHash: snapshot.registeredVaultSetHash,
    observedVaultSetHash: canonicalHash([...snapshot.nominatedVaults].sort()),
  };
}

/**
 * Restate an amount from `from` decimals to `to` decimals.
 *
 * Scaling down truncates, which biases every conversion slightly against the
 * issuer. That is the correct direction for a solvency check: an attestor that
 * rounds in the issuer's favour eventually attests something that is short.
 */
export function normalise(amount: bigint, from: number, to: number): bigint {
  if (from === to) return amount;
  return from < to ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to);
}

interface RefuseArgs {
  noteId: string;
  noteIdHash: Hex;
  reason: RefusalReason;
  evidence: Evidence | null;
  /** The ratio, when we actually have one. `null` means we could not tell. */
  coverage: number | null;
  detail: Record<string, unknown>;
  policy: CoveragePolicy;
  signer: AttestorSigner;
  /** Source that produced the readings, carried onto the verdict and the record. */
  feed: string;
  now: number;
  nonce: bigint;
}

async function refuse(args: RefuseArgs): Promise<RefusedVerdict> {
  const family = familyOf(args.reason);

  // The invariant that keeps the two families from blurring: only an asset
  // finding may carry a ratio. If this ever trips it is a programming error,
  // not a data condition, so it throws rather than degrading quietly.
  if (family === "evidence" && args.coverage !== null) {
    throw new Error(`evidence refusal ${args.reason} must not carry a coverage ratio`);
  }

  const sourceHash = args.evidence ? canonicalHash(args.evidence) : null;
  const expiry = BigInt(args.now + args.policy.attestationTtlSeconds);

  // An evidence refusal is signed as a type that has no room for a ratio, a
  // block or a hash. Absence is unambiguous where a zero is not.
  const message: RefusalMessage =
    family === "evidence"
      ? { noteId: args.noteIdHash, reason: args.reason, expiry, nonce: args.nonce }
      : {
          noteId: args.noteIdHash,
          reason: args.reason,
          coverageKnown: args.coverage !== null,
          coverageBps: BigInt(args.coverage ?? 0),
          asOfBlock: args.evidence ? BigInt(args.evidence.asOfBlock) : 0n,
          vaultSetHash: (args.evidence?.vaultSetHash as Hex) ?? ZERO_HASH,
          sourceHash: sourceHash ?? ZERO_HASH,
          expiry,
          nonce: args.nonce,
        };
  const signature = await args.signer.signRefusal(message);

  // An evidence refusal publishes nothing it declined to trust. Keeping the
  // snapshot under the name "evidence" would reintroduce, one layer down, the
  // conflation the split type exists to prevent. The diagnostic that explains
  // the refusal lives in `detail`, which is not a coverage claim.
  const publishedEvidence = family === "evidence" ? null : args.evidence;

  return {
    decision: "refused",
    httpStatus: httpStatusFor(family),
    noteId: args.noteId,
    noteIdHash: args.noteIdHash,
    family,
    reason: args.reason,
    description: REFUSAL_DESCRIPTIONS[args.reason],
    coverageKnown: args.coverage !== null,
    coverageBps: args.coverage,
    message,
    signature,
    evidence: publishedEvidence,
    attestor: args.signer.address,
    sourceHash: publishedEvidence ? sourceHash : null,
    detail: args.detail,
    feed: args.feed,
    chargeable: false,
  };
}

/** Reason codes that may legally carry a ratio. Used by the verifier too. */
export const RATIO_BEARING_REASONS: readonly AssetRefusalReason[] = [
  "coverage_below_floor",
  "no_attributable_positions",
];

/** Kept for callers that want an opaque request-scoped value. */
export function randomHex32(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}
