import {
  Client,
  PrivateKey,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import type { AnchorConfig } from "./config.js";
import type { Verdict } from "./attest.js";
import { shortHash } from "./canonical.js";

/**
 * A consensus message is capped at 1024 bytes. The SDK will happily chunk
 * beyond that up to 20KB, but each chunk lands as a separate mirror-node
 * message that a verifier then has to find and reassemble in the right order.
 * A receipt that is hard to read is a receipt nobody checks, so we stay inside
 * one message and prove it.
 */
export const HCS_MESSAGE_LIMIT = 1024;

/** Raised when a record cannot be made to fit. Never swallowed. */
export class AnchorTooLarge extends Error {
  constructor(bytes: number) {
    super(`anchor record is ${bytes} bytes, over the ${HCS_MESSAGE_LIMIT} byte consensus limit`);
    this.name = "AnchorTooLarge";
  }
}

/**
 * Compact position row: `[vault, rawAssets, shares, assetDecimals]`.
 *
 * Short keys and positional rows are not premature optimisation; they are what
 * buys room for the full source hash and the full signature inside 1024 bytes.
 * The `0x` prefix is dropped from the vault because it is implied.
 */
export type AnchoredPosition = [string, string, string, number];

export interface AnchorRecord {
  /** Format discriminator, so a reader can reject anything else on this topic. */
  p: "plimsoll/coverage";
  v: 1;
  /** Request id, the join key between this record, the receipt and the charge. */
  rid: string;
  n: string;
  d: "attested" | "refused";
  fam?: "asset" | "evidence";
  rsn?: string;
  /** Whether a ratio was known. Absent on an attestation, where it is implied. */
  known?: boolean;
  bps: number;
  floor: number;
  blk: string;
  obs: number;
  pol: string;
  ud: number;
  out: string;
  par: string;
  obl: string;
  val: string;
  ss: string;
  vsh: string;
  srch: string;
  att: string;
  sig: string;
  /** Whether HBAR moved. The claim the verifier checks against the mirror node. */
  chg: boolean;
  tx?: string;
  pos?: AnchoredPosition[];
  /** 1 when positions are inline, 0 when they were dropped to fit. */
  full: 0 | 1;
}

export interface AnchorInput {
  requestId: string;
  verdict: Verdict;
  /** Settlement, when one happened. Absence is itself the claim. */
  charge: { transactionId: string } | null;
  maxPositions?: number;
}

/**
 * Build the on-chain receipt.
 *
 * It carries the whole recomputable input set: the vaults, the raw
 * `convertToAssets` readings, the share balances, the block, the source set,
 * the floor, the ratio, the policy id, and whether a charge occurred. That is
 * the point: a stranger re-reads the vaults at `blk`, redoes the division, and
 * checks the mirror node for `tx`. Charge present must equal attestation
 * warranted, or the receipt convicts us.
 */
export function buildAnchorRecord(input: AnchorInput): AnchorRecord {
  const { verdict, requestId, charge } = input;
  const evidence = verdict.evidence;
  const maxPositions = input.maxPositions ?? 6;

  const base: AnchorRecord = {
    p: "plimsoll/coverage",
    v: 1,
    rid: requestId,
    n: verdict.noteId,
    d: verdict.decision,
    bps: verdict.decision === "attested" ? verdict.coverageBps : verdict.coverageBps,
    floor: evidence?.floorBps ?? 0,
    blk: evidence?.asOfBlock ?? "0",
    obs: evidence?.observedAt ?? 0,
    pol: evidence?.policyId ?? "unknown",
    ud: evidence?.unitDecimals ?? 0,
    out: evidence?.notesOutstanding ?? "0",
    par: evidence?.parPerNote ?? "0",
    obl: evidence?.obligation ?? "0",
    val: evidence?.attributableValue ?? "0",
    ss: evidence ? `${evidence.sourceSet.kind}:${evidence.sourceSet.dataset}` : "none",
    vsh: shortHash(evidence?.vaultSetHash ?? "0x", 8),
    srch: verdict.sourceHash,
    att: verdict.attestor,
    sig: verdict.signature,
    chg: charge !== null,
    full: 1,
  };

  if (verdict.decision === "refused") {
    base.fam = verdict.family;
    base.rsn = verdict.reason;
    base.known = verdict.coverageKnown;
  }
  if (charge) base.tx = charge.transactionId;

  const positions = (evidence?.positions ?? []).map(
    (p): AnchoredPosition => [p.vault.replace(/^0x/, ""), p.assets, p.shares, p.assetDecimals],
  );

  if (positions.length > 0 && positions.length <= maxPositions) {
    base.pos = positions;
  } else if (positions.length > maxPositions) {
    // Too many legs to carry inline. The source hash still commits to all of
    // them, so the evidence is not lost, but the verifier has to fetch it
    // off-chain and is told so rather than quietly assuming it was complete.
    base.full = 0;
  }

  const size = byteLength(base);
  if (size > HCS_MESSAGE_LIMIT && base.pos) {
    delete base.pos;
    base.full = 0;
  }
  const finalSize = byteLength(base);
  if (finalSize > HCS_MESSAGE_LIMIT) throw new AnchorTooLarge(finalSize);
  return base;
}

export function byteLength(record: AnchorRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

export interface AnchorReceipt {
  sequenceNumber: number;
  transactionId: string;
  topicId: string;
  bytes: number;
}

export interface Anchor {
  submit(record: AnchorRecord): Promise<AnchorReceipt>;
  close(): Promise<void>;
}

/**
 * HCS-backed anchor.
 *
 * The topic is expected to have been created with a submit key and no admin
 * key. Without a submit key anyone could write plausible receipts to it and the
 * audit trail would prove nothing; without an admin key nobody, us included,
 * can rewrite its properties later.
 */
export class HcsAnchor implements Anchor {
  private readonly client: Client;
  private readonly topicId: string;

  constructor(config: AnchorConfig) {
    this.client =
      config.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
    const key = PrivateKey.fromStringECDSA(normaliseKey(config.operatorKey));
    this.client.setOperator(config.operatorId, key);
    this.topicId = config.topicId;
  }

  async submit(record: AnchorRecord): Promise<AnchorReceipt> {
    const payload = JSON.stringify(record);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > HCS_MESSAGE_LIMIT) throw new AnchorTooLarge(bytes);

    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(payload)
      .execute(this.client);
    const receipt = await response.getReceipt(this.client);

    return {
      sequenceNumber: Number(receipt.topicSequenceNumber?.toString() ?? "0"),
      transactionId: response.transactionId.toString(),
      topicId: this.topicId,
      bytes,
    };
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

/** Used when anchoring is not configured, so callers need no null checks. */
export class NullAnchor implements Anchor {
  async submit(record: AnchorRecord): Promise<AnchorReceipt> {
    return { sequenceNumber: 0, transactionId: "", topicId: "", bytes: byteLength(record) };
  }
  async close(): Promise<void> {}
}

function normaliseKey(key: string): string {
  return key.startsWith("0x") ? key.slice(2) : key;
}
