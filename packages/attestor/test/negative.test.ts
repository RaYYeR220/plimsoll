import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { after, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { attest } from "../src/attest.js";
import { buildAnchorRecord } from "../src/anchor.js";
import { FixtureCoverageSource } from "../src/coverage/index.js";
import {
  ATTESTOR_DOMAIN,
  ATTESTATION_TYPES,
  attestationToWire,
  createAttestorSigner,
  recoverRefusalSigner,
  refusalToWire,
} from "../src/eip712.js";
import { NonceStore } from "../src/receipts.js";
import type { StoredReceipt } from "../src/receipts.js";
import {
  checkAnchorBinding,
  checkNoPhantomRatio,
  checkReceipt,
  verifyAttestation,
} from "../src/verify.js";
import { TEST_ATTESTOR_KEY } from "./helpers.js";

/**
 * Negative controls.
 *
 * Every test here asserts that something MUST fail. A verifier that cannot be
 * made to say no is not verifying anything, so these are the tests that give
 * the passing ones their meaning.
 */

const signer = createAttestorSigner(TEST_ATTESTOR_KEY);
const source = new FixtureCoverageSource();
const DATA_DIR = `data/test/${randomBytes(4).toString("hex")}`;

after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function toReceipt(verdict: Awaited<ReturnType<typeof attest>>): StoredReceipt {
  return {
    requestId: "deadbeefdeadbeef",
    noteId: verdict.noteId,
    decision: verdict.decision,
    family: verdict.decision === "refused" ? verdict.family : null,
    reason: verdict.decision === "refused" ? verdict.reason : null,
    coverageBps: verdict.coverageBps,
    coverageKnown: verdict.decision === "attested" ? true : verdict.coverageKnown,
    message:
      verdict.decision === "attested"
        ? attestationToWire(verdict.message as never)
        : refusalToWire(verdict.message),
    signature: verdict.signature,
    attestor: verdict.attestor,
    sourceHash: verdict.sourceHash,
    evidence: verdict.evidence,
    chargeTransactionId: null,
    payTo: "0.0.999001",
    amountTinybar: "100000",
    payer: "0.0.999002",
    requestedAt: 1788800800,
    respondedAt: 1788800801,
    httpStatus: verdict.httpStatus,
    anchor: null,
    anchorRecord: null,
  };
}

describe("a forged signature must fail", () => {
  it("rejects an attestation signed by anyone else", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    assert.equal(verdict.decision, "attested");

    // A different key signs the very same message.
    const impostor = privateKeyToAccount(
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    );
    const forged = await impostor.signTypedData({
      domain: ATTESTOR_DOMAIN,
      types: ATTESTATION_TYPES,
      primaryType: "Attestation",
      message: verdict.message,
    });
    assert.notEqual(forged, verdict.signature);

    const result = await verifyAttestation({
      message: attestationToWire(verdict.message as never),
      signature: forged,
      expectedAttestor: signer.address,
    });
    assert.equal(result.valid, false, "a forged signature MUST NOT verify");
    assert.match(result.reasons.join(" "), /recovers to/);
  });

  it("rejects a receipt whose signature does not match its attestor", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    const receipt = toReceipt(verdict);
    receipt.attestor = "0x0000000000000000000000000000000000000001";

    const checks = await checkReceipt(receipt);
    const signature = checks.find((c) => c.id === "signature")!;
    assert.equal(signature.passed, false);
  });

  it("rejects a signature with a flipped byte", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    // Flip a byte inside r. Touching the trailing recovery byte is not a valid
    // negative control: v is normalised, so 0x00 and 0x1b mean the same thing
    // and the signature would still recover correctly.
    const flipped = verdict.signature[10] === "a" ? "b" : "a";
    const mangled = `${verdict.signature.slice(0, 10)}${flipped}${verdict.signature.slice(11)}`;
    assert.notEqual(mangled, verdict.signature);
    const result = await verifyAttestation({
      message: attestationToWire(verdict.message as never),
      signature: mangled,
      expectedAttestor: signer.address,
    });
    assert.equal(result.valid, false);
  });
});

describe("tampered evidence must fail", () => {
  it("detects a coverage figure edited after signing", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    const receipt = toReceipt(verdict);
    (receipt.message as Record<string, unknown>).coverageBps = 20000;

    const checks = await checkReceipt(receipt);
    assert.equal(checks.find((c) => c.id === "signature")!.passed, false,
      "changing the message must break the signature");
  });

  it("detects evidence edited underneath an untouched sourceHash", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    const receipt = toReceipt(verdict);
    receipt.evidence!.positions[0]!.assets = "999999999999";

    const checks = await checkReceipt(receipt);
    assert.equal(checks.find((c) => c.id === "evidence-hash")!.passed, false,
      "the sourceHash must stop matching edited evidence");
  });
});

describe("a tampered HCS record must fail", () => {
  it("detects a record whose ratio was rewritten", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    const receipt = toReceipt(verdict);
    const record = buildAnchorRecord({ requestId: receipt.requestId, verdict, charge: null });

    record.bps = 20000;
    const checks = checkAnchorBinding(record, receipt);
    assert.equal(checks[0]!.passed, false);
    assert.match(checks[0]!.detail, /coverageBps/);
  });

  it("detects a record that claims a charge the receipt does not", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    const receipt = toReceipt(verdict);
    const record = buildAnchorRecord({ requestId: receipt.requestId, verdict, charge: null });

    record.chg = true;
    record.tx = "0.0.7162784@1788800815.386309402";
    const checks = checkAnchorBinding(record, receipt);
    assert.equal(checks[0]!.passed, false);
    assert.match(checks[0]!.detail, /charged/);
  });

  it("detects a swapped signature", async () => {
    const alpha = await attest("NOTE-ALPHA", { source, signer });
    const juliet = await attest("NOTE-JULIET", { source, signer });
    const receipt = toReceipt(alpha);
    const record = buildAnchorRecord({ requestId: receipt.requestId, verdict: alpha, charge: null });

    record.sig = juliet.signature;
    const checks = checkAnchorBinding(record, receipt);
    assert.equal(checks[0]!.passed, false);
    assert.match(checks[0]!.detail, /signature/);
  });
});

describe("a phantom coverage figure must fail", () => {
  it("rejects an evidence refusal whose record carries a bps key at all", async () => {
    const verdict = await attest("NOTE-INDIA", { source, signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.family, "evidence");

    const record = buildAnchorRecord({ requestId: "deadbeefdeadbeef", verdict, charge: null });
    assert.equal(checkNoPhantomRatio(record).passed, true, "a correct record must pass");

    // Re-introduce the defect exactly as it shipped: a zero, not a wrong number.
    (record as unknown as Record<string, unknown>).bps = 0;
    const reintroduced = checkNoPhantomRatio(record);
    assert.equal(reintroduced.passed, false, "an evidence refusal carrying bps=0 MUST fail");
    assert.match(reintroduced.detail, /bps=0/);
    assert.match(reintroduced.detail, /reads as zero percent coverage/);
  });

  it("rejects the rest of the zeroed evidence block too", async () => {
    const verdict = await attest("NOTE-INDIA", { source, signer });
    for (const [key, value] of [
      ["floor", 0],
      ["blk", "0"],
      ["obs", 0],
      ["val", "0"],
      ["obl", "0"],
      ["ss", "none"],
      ["vsh", ""],
      ["srch", `0x${"00".repeat(32)}`],
    ] as const) {
      const record = buildAnchorRecord({ requestId: "deadbeefdeadbeef", verdict, charge: null });
      (record as unknown as Record<string, unknown>)[key] = value;
      assert.equal(
        checkNoPhantomRatio(record).passed,
        false,
        `an evidence refusal carrying "${key}" MUST fail, even as a sentinel`,
      );
    }
  });

  it("rejects a ratio smuggled into an asset finding that established none", async () => {
    const verdict = await attest("NOTE-CHARLIE", { source, signer });
    const record = buildAnchorRecord({ requestId: "deadbeefdeadbeef", verdict, charge: null });
    assert.equal(checkNoPhantomRatio(record).passed, true);

    (record as unknown as Record<string, unknown>).bps = 13125;
    assert.equal(
      checkNoPhantomRatio(record).passed,
      false,
      "declared_exceeds_real quotes no ratio, so a bps key is a fabrication",
    );
  });

  it("cannot re-encode a signed evidence refusal as one carrying a figure", async () => {
    const verdict = await attest("NOTE-INDIA", { source, signer });
    assert.equal(verdict.decision, "refused");

    // Take the genuine signature and try to present it as an asset refusal that
    // reports zero coverage. The primary type is hashed into the digest, so the
    // forgery recovers to a different address.
    const forged = {
      noteId: verdict.noteId,
      reason: verdict.reason,
      coverageKnown: false,
      coverageBps: 0,
      asOfBlock: 0n,
      vaultSetHash: `0x${"00".repeat(32)}`,
      sourceHash: `0x${"00".repeat(32)}`,
      expiry: verdict.message.expiry,
      nonce: verdict.message.nonce,
    } as const;

    const recovered = await recoverRefusalSigner(forged as never, verdict.signature);
    assert.notEqual(
      recovered.toLowerCase(),
      signer.address.toLowerCase(),
      "an EvidenceRefusal signature MUST NOT validate as an AssetRefusal",
    );
  });
});

describe("a replayed nonce must fail", () => {
  it("refuses to issue the same nonce twice", async () => {
    const nonces = new NonceStore(DATA_DIR);
    const nonce = `0x${"ab".repeat(32)}`;
    assert.equal(nonces.claim(nonce), true, "the first use is fine");
    assert.equal(nonces.claim(nonce), false, "the second use MUST be rejected");
  });

  it("rejects an attestation whose nonce a consumer has already seen", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    assert.equal(verdict.decision, "attested");

    const seen = new Set<string>([verdict.message.nonce]);
    const result = await verifyAttestation({
      message: attestationToWire(verdict.message as never),
      signature: verdict.signature,
      expectedAttestor: signer.address,
      seenNonces: seen,
    });
    assert.equal(result.valid, false, "a replayed attestation MUST NOT verify");
    assert.match(result.reasons.join(" "), /already been used/);
  });

  it("issues a distinct nonce for every verdict", async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const verdict = await attest("NOTE-ALPHA", { source, signer });
      assert.equal(nonces.has(verdict.message.nonce), false, "nonces must never repeat");
      nonces.add(verdict.message.nonce);
    }
    assert.equal(nonces.size, 25);
  });
});

describe("an expired attestation must fail", () => {
  it("rejects one past its expiry", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    const expiry = Number(verdict.message.expiry);

    const stillFresh = await verifyAttestation({
      message: attestationToWire(verdict.message as never),
      signature: verdict.signature,
      expectedAttestor: signer.address,
      now: expiry - 1,
    });
    assert.equal(stillFresh.valid, true, "it must be valid right up to its expiry");

    const expired = await verifyAttestation({
      message: attestationToWire(verdict.message as never),
      signature: verdict.signature,
      expectedAttestor: signer.address,
      now: expiry + 1,
    });
    assert.equal(expired.valid, false, "an expired attestation MUST NOT verify");
    assert.match(expired.reasons.join(" "), /expired/);
  });
});

describe("declared greater than real must fail", () => {
  it("never attests a note whose issuer overstated their holdings", async () => {
    const verdict = await attest("NOTE-CHARLIE", { source, signer });
    assert.notEqual(verdict.decision, "attested", "an inflated claim MUST NOT be attested");
    assert.equal(verdict.chargeable, false);
  });

  it("refuses even when the real balance would have cleared the floor on its own", async () => {
    // 105,000 of real value against an 80,000 obligation is 13125 bps: this
    // note would sail through on value alone. It is refused anyway, because the
    // nomination it was asked to attest is not one the chain supports.
    const inflated = new FixtureCoverageSource({}, [
      {
        noteId: "NOTE-INFLATED",
        holder: "0x00000000000000000000000000000000006f1a55",
        nominatedVaults: ["0x4626aa11c0ffee0000000000000000000000a001"],
        notesOutstanding: "80000",
        parPerNote: "1000000",
        unitDecimals: 6,
        asOfBlock: "10",
        observedAt: -5,
        sourceSet: { kind: "fixture", dataset: "inflated", endpoints: [] },
        positions: [
          {
            vault: "0x4626aa11c0ffee0000000000000000000000a001",
            shares: "100000000000",
            declaredShares: "100000000001",
            assets: "105000000000",
            assetDecimals: 6,
            blockNumber: "10",
          },
        ],
      },
    ]);
    const verdict = await attest("NOTE-INFLATED", { source: inflated, signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.reason, "declared_exceeds_real",
      "a single atomic unit of overstatement is still an overstatement");
  });
});
