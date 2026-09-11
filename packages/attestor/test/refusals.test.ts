import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attest, RATIO_BEARING_REASONS } from "../src/attest.js";
import { FixtureCoverageSource, LiveCoverageSource } from "../src/coverage/index.js";
import {
  createAttestorSigner,
  isAssetRefusalMessage,
  recoverRefusalSigner,
  refusalToWire,
} from "../src/eip712.js";
import { ALL_REFUSAL_REASONS, familyOf, httpStatusFor, type RefusalReason } from "../src/reasons.js";
import { TEST_ATTESTOR_KEY } from "./helpers.js";

const signer = createAttestorSigner(TEST_ATTESTOR_KEY);
const source = new FixtureCoverageSource();

/** One fixture per reason. Every entry in the taxonomy must be reachable. */
const REASON_FIXTURES: Record<RefusalReason, string> = {
  coverage_below_floor: "NOTE-BRAVO",
  declared_exceeds_real: "NOTE-CHARLIE",
  no_attributable_positions: "NOTE-HOTEL",
  source_unavailable: "NOTE-INDIA",
  data_stale: "NOTE-DELTA",
  sources_disagree: "NOTE-ECHO",
  vault_unresolved: "NOTE-FOXTROT",
  vault_set_drift: "NOTE-GOLF",
};

describe("the refusal taxonomy", () => {
  it("has a fixture for every declared reason and no orphans", () => {
    assert.deepEqual(
      [...ALL_REFUSAL_REASONS].sort(),
      Object.keys(REASON_FIXTURES).sort(),
      "every reason must be exercised, and every exercised reason must be declared",
    );
  });

  for (const [reason, noteId] of Object.entries(REASON_FIXTURES) as [RefusalReason, string][]) {
    it(`produces ${reason} for ${noteId}, signed and unchargeable`, async () => {
      const verdict = await attest(noteId, { source, signer });
      assert.equal(verdict.decision, "refused");
      assert.equal(verdict.reason, reason);
      assert.equal(verdict.family, familyOf(reason));
      assert.equal(verdict.httpStatus, httpStatusFor(familyOf(reason)));
      assert.equal(verdict.chargeable, false);
      assert.equal(verdict.message.reason, reason);
      // The family is carried by the EIP-712 type name, not a field, so a
      // signature over one family cannot be re-encoded as the other.
      assert.equal(
        isAssetRefusalMessage(verdict.message),
        familyOf(reason) === "asset",
      );

      const recovered = await recoverRefusalSigner(verdict.message, verdict.signature);
      assert.equal(recovered, signer.address, "the refusal must be signed by the attestor");
    });
  }
});

describe("the two families stay distinct", () => {
  it("gives asset findings 422 and evidence statements 424", () => {
    assert.equal(httpStatusFor("asset"), 422);
    assert.equal(httpStatusFor("evidence"), 424);
  });

  it("never lets an evidence refusal carry a ratio", async () => {
    for (const [reason, noteId] of Object.entries(REASON_FIXTURES) as [RefusalReason, string][]) {
      if (familyOf(reason) !== "evidence") continue;
      const verdict = await attest(noteId, { source, signer });
      assert.equal(verdict.decision, "refused");
      assert.equal(verdict.coverageKnown, false, `${reason} must not claim to know a ratio`);
      assert.equal(
        verdict.coverageBps,
        null,
        `${reason} must report no ratio at all; a zero reads as zero percent coverage`,
      );
      assert.equal(verdict.evidence, null, `${reason} must not publish evidence it distrusts`);
      assert.equal(verdict.sourceHash, null);

      // The signed payload has nowhere to put a figure.
      assert.equal(isAssetRefusalMessage(verdict.message), false);
      const wire = refusalToWire(verdict.message);
      for (const key of ["coverageBps", "coverageKnown", "asOfBlock", "vaultSetHash", "sourceHash"]) {
        assert.equal(key in wire, false, `${reason} wire form must not contain ${key}`);
      }
    }
  });

  it("makes ratio-bearing asset findings quote the ratio they are about", async () => {
    for (const reason of RATIO_BEARING_REASONS) {
      const verdict = await attest(REASON_FIXTURES[reason], { source, signer });
      assert.equal(verdict.decision, "refused");
      assert.equal(verdict.coverageKnown, true, `${reason} must quote its ratio`);
      assert.ok(isAssetRefusalMessage(verdict.message));
      assert.equal(verdict.message.coverageKnown, true);
    }
  });

  it("reports a short note with the ratio that made it short", async () => {
    const verdict = await attest("NOTE-BRAVO", { source, signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.reason, "coverage_below_floor");
    assert.equal(verdict.coverageBps, 8700);
    assert.equal(verdict.detail.floorBps, 10000);
  });

  it("says nothing about the ratio when the source is simply down", async () => {
    const verdict = await attest("NOTE-ALPHA", { source: new LiveCoverageSource(), signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.family, "evidence");
    assert.equal(verdict.evidence, null, "no evidence means no evidence, not empty evidence");
    assert.equal(isAssetRefusalMessage(verdict.message), false, "signed as EvidenceRefusal");
  });
});

describe("binding to real state", () => {
  it("refuses when the issuer declares more shares than the address holds", async () => {
    const verdict = await attest("NOTE-CHARLIE", { source, signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.reason, "declared_exceeds_real");
    assert.equal(verdict.family, "asset", "an inflated claim is a finding, not a data problem");

    const positions = verdict.detail.positions as Array<Record<string, string>>;
    assert.equal(positions.length, 1);
    assert.ok(
      BigInt(positions[0]!.declaredShares!) > BigInt(positions[0]!.actualShares!),
      "the refusal must name the gap it found",
    );
  });

  it("values the real balance, never the declared one", async () => {
    const verdict = await attest("NOTE-CHARLIE", { source, signer });
    assert.equal(verdict.decision, "refused");
    const position = verdict.evidence!.positions[0]!;
    assert.equal(position.shares, "100000000000");
    assert.equal(position.declaredShares, "150000000000");
    // The evidence records both, so the discrepancy is auditable afterwards.
    assert.notEqual(position.shares, position.declaredShares);
  });

  it("prefers 'nothing is backing this' over 'the ratio is zero'", async () => {
    const verdict = await attest("NOTE-HOTEL", { source, signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.reason, "no_attributable_positions");
    assert.equal(verdict.coverageBps, 0);
  });

  it("refuses stale data rather than quoting a ratio from it", async () => {
    const verdict = await attest("NOTE-DELTA", { source, signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.reason, "data_stale");
    assert.ok(
      (verdict.detail.ageSeconds as number) > (verdict.detail.toleranceSeconds as number),
      "the refusal must show it exceeded the tolerance",
    );
  });
});
