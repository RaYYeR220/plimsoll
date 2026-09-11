import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { attest, type Verdict } from "../src/attest.js";
import { buildAnchorRecord, type AnchorRecord } from "../src/anchor.js";
import { FixtureCoverageSource } from "../src/coverage/index.js";
import {
  ATTESTOR_DOMAIN,
  LEGACY_REFUSAL_TYPES,
  attestationToWire,
  createAttestorSigner,
  isAssetRefusalMessage,
  refusalToWire,
} from "../src/eip712.js";
import { CURRENT_FORMAT, V1_ALWAYS_PRESENT } from "../src/format.js";
import type { StoredReceipt } from "../src/receipts.js";
import { checkEncoding, checkFamilyInvariant, checkReceipt } from "../src/verify.js";
import { TEST_ATTESTOR_KEY } from "./helpers.js";

/**
 * The format version, and the rule that a record's label must describe its
 * encoding. These are negative controls in the same sense as the rest of the
 * suite: each mismatch here MUST fail.
 */

const signer = createAttestorSigner(TEST_ATTESTOR_KEY);
const account = privateKeyToAccount(TEST_ATTESTOR_KEY);
const source = new FixtureCoverageSource();
const ZERO_HASH = `0x${"00".repeat(32)}`;

/** Re-encode a record the way the retired v1 encoder wrote it: every key, zeroed where unknown. */
function asV1(record: AnchorRecord): AnchorRecord {
  const v1: Record<string, unknown> = { ...record, v: 1 };
  const zeroes: Record<string, unknown> = {
    bps: 0,
    floor: 0,
    blk: "0",
    obs: 0,
    pol: record.pol,
    ud: 0,
    out: "0",
    par: "0",
    obl: "0",
    val: "0",
    ss: "none",
    vsh: "",
    srch: ZERO_HASH,
    full: 1,
  };
  for (const key of V1_ALWAYS_PRESENT) if (!(key in v1)) v1[key] = zeroes[key];
  return v1 as unknown as AnchorRecord;
}

async function verdictAndRecord(noteId: string): Promise<{ verdict: Verdict; record: AnchorRecord }> {
  const verdict = await attest(noteId, { source, signer });
  const record = buildAnchorRecord({ requestId: "cafecafecafecafe", verdict, charge: null });
  return { verdict, record };
}

function receiptFor(
  verdict: Verdict,
  message: Record<string, unknown>,
  signature: string,
  overrides: Partial<StoredReceipt> = {},
): StoredReceipt {
  return {
    requestId: "cafecafecafecafe",
    noteId: verdict.noteId,
    decision: verdict.decision,
    family: verdict.decision === "refused" ? verdict.family : null,
    reason: verdict.decision === "refused" ? verdict.reason : null,
    coverageBps: verdict.coverageBps,
    coverageKnown: verdict.decision === "attested" ? true : verdict.coverageKnown,
    message,
    signature,
    attestor: verdict.attestor,
    sourceHash: verdict.sourceHash,
    evidence: verdict.evidence,
    chargeTransactionId: null,
    payTo: "0.0.999001",
    amountTinybar: "100000",
    payer: null,
    requestedAt: 1788800800,
    respondedAt: 1788800801,
    httpStatus: verdict.httpStatus,
    anchor: null,
    anchorRecord: null,
    ...overrides,
  };
}

/** Sign an asset refusal the way v1 did: as the single legacy Refusal struct. */
async function legacySignedReceipt(): Promise<StoredReceipt> {
  const { verdict } = await verdictAndRecord("NOTE-BRAVO");
  assert.equal(verdict.decision, "refused");
  assert.ok(isAssetRefusalMessage(verdict.message));
  const m = verdict.message;
  const legacy = {
    noteId: m.noteId,
    family: 1,
    reason: m.reason,
    coverageKnown: m.coverageKnown,
    coverageBps: m.coverageBps,
    asOfBlock: m.asOfBlock,
    vaultSetHash: m.vaultSetHash,
    sourceHash: m.sourceHash,
    expiry: m.expiry,
    nonce: m.nonce,
  };
  const signature = await account.signTypedData({
    domain: ATTESTOR_DOMAIN,
    types: LEGACY_REFUSAL_TYPES,
    primaryType: "Refusal",
    message: legacy,
  });
  const wire = { ...legacy, asOfBlock: legacy.asOfBlock.toString(), expiry: legacy.expiry.toString() };
  return receiptFor(verdict, wire, signature);
}

describe("the format version is self-describing", () => {
  it("writes the current format on every new record", async () => {
    for (const noteId of ["NOTE-ALPHA", "NOTE-BRAVO", "NOTE-CHARLIE", "NOTE-INDIA"]) {
      const { record } = await verdictAndRecord(noteId);
      assert.equal(record.v, CURRENT_FORMAT);
      assert.equal(record.v, 2);
    }
  });

  it("passes a genuine v1 evidence refusal under v1 rules, and calls out the zero", async () => {
    const { record } = await verdictAndRecord("NOTE-INDIA");
    const result = checkEncoding(asV1(record));
    assert.equal(result.passed, true, "a v1 record is held to v1 rules, not rejected");
    assert.equal(result.note, true, "the zeroed figure must be flagged, not passed silently");
    assert.match(result.detail, /not a coverage reading/);
  });

  it("passes a v1 record with a genuine ratio without a note", async () => {
    const { record } = await verdictAndRecord("NOTE-BRAVO");
    const result = checkEncoding(asV1(record));
    assert.equal(result.passed, true);
    assert.equal(result.note, undefined);
  });

  it("verifies a legacy Refusal signature under v1, so historical records stay checkable", async () => {
    const receipt = await legacySignedReceipt();
    const signature = (await checkReceipt(receipt, 1)).find((c) => c.id === "signature")!;
    assert.equal(signature.passed, true, signature.detail);
  });

  it("verifies attestations under either format, because that struct never changed", async () => {
    const { verdict } = await verdictAndRecord("NOTE-ALPHA");
    assert.equal(verdict.decision, "attested");
    const receipt = receiptFor(verdict, attestationToWire(verdict.message), verdict.signature);
    for (const version of [1, 2] as const) {
      const signature = (await checkReceipt(receipt, version)).find((c) => c.id === "signature")!;
      assert.equal(signature.passed, true, `v${version}: ${signature.detail}`);
    }
  });
});

describe("a record whose version and encoding disagree must fail", () => {
  it("rejects the v1 zeroed encoding under a v2 label", async () => {
    const { record } = await verdictAndRecord("NOTE-INDIA");
    const mislabelled = { ...asV1(record), v: 2 } as AnchorRecord;
    const result = checkEncoding(mislabelled);
    assert.equal(result.passed, false, "v2 promises no figure where none was established");
    assert.match(result.detail, /bps=0/);
  });

  it("rejects the v2 omission encoding under a v1 label", async () => {
    const { record } = await verdictAndRecord("NOTE-INDIA");
    const mislabelled = { ...record, v: 1 } as AnchorRecord;
    const result = checkEncoding(mislabelled);
    assert.equal(result.passed, false, "v1 always wrote the numeric block");
    assert.match(result.detail, /v2 encoding under a v1 label/);
  });

  it("rejects an unknown format version", async () => {
    const { record } = await verdictAndRecord("NOTE-ALPHA");
    const result = checkEncoding({ ...record, v: 3 } as unknown as AnchorRecord);
    assert.equal(result.passed, false);
    assert.match(result.detail, /unknown format version 3/);
  });

  it("rejects a v2 refusal signed over the retired v1 struct", async () => {
    const receipt = await legacySignedReceipt();
    const signature = (await checkReceipt(receipt, 2)).find((c) => c.id === "signature")!;
    assert.equal(signature.passed, false, "a legacy payload under a v2 label MUST fail");
    assert.match(signature.detail, /retired v1 Refusal struct/);
  });

  it("rejects a v1 refusal signed over a v2 type", async () => {
    for (const noteId of ["NOTE-BRAVO", "NOTE-INDIA"]) {
      const { verdict } = await verdictAndRecord(noteId);
      assert.equal(verdict.decision, "refused");
      const receipt = receiptFor(verdict, refusalToWire(verdict.message), verdict.signature);
      const signature = (await checkReceipt(receipt, 1)).find((c) => c.id === "signature")!;
      assert.equal(signature.passed, false, `${noteId}: a v2 payload under a v1 label MUST fail`);
      assert.match(signature.detail, /signed over a v2 type/);
    }
  });

  it("accepts a zeroed evidence figure only under the format that wrote zeroes", async () => {
    const { verdict } = await verdictAndRecord("NOTE-INDIA");
    const zeroed = receiptFor(verdict, {}, "0x", { coverageBps: 0, coverageKnown: false });

    const underV1 = checkFamilyInvariant(zeroed, 1);
    assert.equal(underV1.passed, true);
    assert.equal(underV1.note, true, "passes under v1, but never silently");

    const underV2 = checkFamilyInvariant(zeroed, 2);
    assert.equal(underV2.passed, false, "under v2 a zero on an evidence refusal is a fabrication");
  });
});
