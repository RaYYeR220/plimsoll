import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { attest, type AttestedVerdict, type Verdict } from "../src/attest.js";
import { buildAnchorRecord, type AnchorRecord } from "../src/anchor.js";
import { FixtureCoverageSource } from "../src/coverage/index.js";
import {
  attestationToWire,
  createAttestorSigner,
  isAssetRefusalMessage,
  refusalToWire,
} from "../src/eip712.js";
import { RETIRED_DOMAIN, V1_REFUSAL_TYPES } from "../src/legacy.js";
import { CURRENT_FORMAT, V1_ALWAYS_PRESENT } from "../src/format.js";
import type { StoredReceipt } from "../src/receipts.js";
import { checkEncoding, checkFamilyInvariant, checkReceipt } from "../src/verify.js";
import { TEST_ANCHOR_ORACLE, TEST_ATTESTOR_KEY, TEST_ORACLE, TEST_PAY_TO } from "./helpers.js";

/**
 * The format version, and the rule that a record's label must describe its
 * encoding. These are negative controls in the same sense as the rest of the
 * suite: each mismatch here MUST fail.
 *
 * v3 is the version where the signed types stopped being ours to choose. v1 and
 * v2 signed a struct `CoverageOracle` does not recover — a string note id, a
 * uint32 coverage, a random nonce, a domain naming no contract — so their
 * signatures could never have been accepted on chain. Records in those formats
 * are still verified under their own rules, because the topic has no admin key
 * and they cannot be withdrawn, but a payload from one format under another
 * format's label must fail.
 */

const signer = createAttestorSigner(TEST_ATTESTOR_KEY, TEST_ORACLE);
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

/** Narrow to an attestation, loudly. A refusal reaching these tests is a bug in them. */
function attested(verdict: Verdict): AttestedVerdict {
  if (verdict.decision !== "attested") {
    throw new Error(`expected an attestation for ${verdict.noteId}, got ${verdict.reason}`);
  }
  return verdict;
}

async function verdictAndRecord(noteId: string): Promise<{ verdict: Verdict; record: AnchorRecord }> {
  const verdict = await attest(noteId, { source, signer });
  const record = buildAnchorRecord({
    payTo: TEST_PAY_TO,
    oracle: TEST_ANCHOR_ORACLE,
    requestId: "cafecafecafecafe",
    verdict,
    charge: null,
  });
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
    feed: verdict.feed,
    sourceHash: verdict.sourceHash,
    evidence: verdict.evidence,
    chargeTransactionId: null,
    payTo: TEST_PAY_TO,
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

/**
 * Sign an asset refusal the way v1 did: one `Refusal` struct, the market code as
 * a string, a uint32 ratio and a random nonce, under a domain naming no contract.
 */
async function legacySignedReceipt(): Promise<StoredReceipt> {
  const { verdict } = await verdictAndRecord("NOTE-BRAVO");
  assert.equal(verdict.decision, "refused");
  assert.ok(isAssetRefusalMessage(verdict.message));
  const m = verdict.message;
  const legacy = {
    noteId: verdict.noteId,
    family: 1,
    reason: m.reason,
    coverageKnown: m.coverageKnown,
    coverageBps: Number(m.coverageBps),
    asOfBlock: m.asOfBlock,
    vaultSetHash: m.vaultSetHash,
    sourceHash: m.sourceHash,
    expiry: m.expiry,
    nonce: `0x${"1a".repeat(32)}` as Hex,
  };
  const signature = await account.signTypedData({
    domain: RETIRED_DOMAIN,
    types: V1_REFUSAL_TYPES,
    primaryType: "Refusal",
    message: legacy,
  });
  const wire = {
    ...legacy,
    asOfBlock: legacy.asOfBlock.toString(),
    expiry: legacy.expiry.toString(),
  };
  return receiptFor(verdict, wire, signature);
}

describe("the format version is self-describing", () => {
  it("writes the current format on every new record", async () => {
    for (const noteId of ["NOTE-ALPHA", "NOTE-BRAVO", "NOTE-CHARLIE", "NOTE-INDIA"]) {
      const { record } = await verdictAndRecord(noteId);
      assert.equal(record.v, CURRENT_FORMAT);
      assert.equal(record.v, 3);
    }
  });

  it("carries everything a stranger needs to check it without us", async () => {
    const { record, verdict } = await verdictAndRecord("NOTE-ALPHA");
    // The note id the oracle knows, the oracle the signature is bound to, its
    // chain, the account a charge would have credited, and where the readings
    // came from. Each one exists because the record has to stand on its own.
    assert.equal(record.nid, verdict.noteIdHash);
    assert.equal(record.orc, TEST_ANCHOR_ORACLE.address);
    assert.equal(record.cid, TEST_ANCHOR_ORACLE.chainId);
    assert.equal(record.pay, TEST_PAY_TO);
    assert.equal(record.feed, "fixture");
    assert.equal(checkEncoding(record).passed, true);
  });

  it("rejects a v3 record missing any of them", async () => {
    for (const key of ["nid", "orc", "cid", "feed"] as const) {
      const { record } = await verdictAndRecord("NOTE-ALPHA");
      delete (record as unknown as Record<string, unknown>)[key];
      const result = checkEncoding(record);
      assert.equal(result.passed, false, `a v3 record without "${key}" MUST fail`);
      assert.match(result.detail, new RegExp(key));
    }
  });

  it("marks a fixture-derived record as simulated, in the record itself", async () => {
    // The integrity rule: an HCS sequence outlives every document that explains
    // it, so a record built from checked-in JSON has to say so on its own.
    const { record } = await verdictAndRecord("NOTE-ALPHA");
    assert.equal(record.feed, "fixture");
    assert.match(JSON.stringify(record), /"feed":"fixture"/);
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

  it("verifies a v3 attestation under v3", async () => {
    const { verdict } = await verdictAndRecord("NOTE-ALPHA");
    assert.equal(verdict.decision, "attested");
    const receipt = receiptFor(verdict, attestationToWire(attested(verdict).message), verdict.signature);
    const signature = (await checkReceipt(receipt, 3, TEST_ORACLE)).find((c) => c.id === "signature")!;
    assert.equal(signature.passed, true, signature.detail);
  });
});

describe("a record whose version and encoding disagree must fail", () => {
  it("rejects the v1 zeroed encoding under a v3 label", async () => {
    const { record } = await verdictAndRecord("NOTE-INDIA");
    const mislabelled = { ...asV1(record), v: 3 } as AnchorRecord;
    const result = checkEncoding(mislabelled);
    assert.equal(result.passed, false, "v3 promises no figure where none was established");
    assert.match(result.detail, /bps=0/);
  });

  it("rejects the v3 omission encoding under a v1 label", async () => {
    const { record } = await verdictAndRecord("NOTE-INDIA");
    const mislabelled = { ...record, v: 1 } as AnchorRecord;
    const result = checkEncoding(mislabelled);
    assert.equal(result.passed, false, "v1 always wrote the numeric block");
    assert.match(result.detail, /later encoding under a v1 label/);
  });

  it("rejects an unknown format version", async () => {
    const { record } = await verdictAndRecord("NOTE-ALPHA");
    const result = checkEncoding({ ...record, v: 4 } as unknown as AnchorRecord);
    assert.equal(result.passed, false);
    assert.match(result.detail, /unknown format version 4/);
  });

  it("rejects a v2 refusal signed over the retired v1 struct", async () => {
    const receipt = await legacySignedReceipt();
    const signature = (await checkReceipt(receipt, 2)).find((c) => c.id === "signature")!;
    assert.equal(signature.passed, false, "a legacy payload under a v2 label MUST fail");
    assert.match(signature.detail, /retired v1 struct/);
  });

  it("rejects a v3 refusal payload under a v1 label", async () => {
    for (const noteId of ["NOTE-BRAVO", "NOTE-INDIA"]) {
      const { verdict } = await verdictAndRecord(noteId);
      assert.equal(verdict.decision, "refused");
      const receipt = receiptFor(verdict, refusalToWire(verdict.message), verdict.signature);
      const signature = (await checkReceipt(receipt, 1)).find((c) => c.id === "signature")!;
      assert.equal(signature.passed, false, `${noteId}: a v3 payload under a v1 label MUST fail`);
    }
  });

  it("rejects a v3 attestation under a retired label, because that struct did change", async () => {
    // v1 and v2 signed `Attestation(string noteId,uint32 coverageBps,...)` with a
    // bytes32 nonce, under a domain naming no contract. v3 signs the oracle's
    // struct. The same values under the other label cannot recover.
    const { verdict } = await verdictAndRecord("NOTE-ALPHA");
    const receipt = receiptFor(verdict, attestationToWire(attested(verdict).message), verdict.signature);
    for (const version of [1, 2] as const) {
      const signature = (await checkReceipt(receipt, version)).find((c) => c.id === "signature")!;
      assert.equal(signature.passed, false, `a v3 attestation under a v${version} label MUST fail`);
    }
  });

  it("cannot check a v3 signature when the record names no oracle", async () => {
    // Without the oracle and chain there is no domain, and a verifier that
    // guessed one would be inventing the binding it is supposed to be checking.
    const { verdict } = await verdictAndRecord("NOTE-ALPHA");
    const receipt = receiptFor(verdict, attestationToWire(attested(verdict).message), verdict.signature);
    const signature = (await checkReceipt(receipt, 3, null)).find((c) => c.id === "signature")!;
    assert.equal(signature.passed, false);
    assert.match(signature.detail, /names no oracle/);
  });

  it("accepts a zeroed evidence figure only under the format that wrote zeroes", async () => {
    const { verdict } = await verdictAndRecord("NOTE-INDIA");
    const zeroed = receiptFor(verdict, {}, "0x", { coverageBps: 0, coverageKnown: false });

    const underV1 = checkFamilyInvariant(zeroed, 1);
    assert.equal(underV1.passed, true);
    assert.equal(underV1.note, true, "passes under v1, but never silently");

    for (const version of [2, 3] as const) {
      const later = checkFamilyInvariant(zeroed, version);
      assert.equal(later.passed, false, `under v${version} a zero on an evidence refusal is a fabrication`);
    }
  });
});
