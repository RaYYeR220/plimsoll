import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MalformedSnapshot, attest, coverageBpsOf, normalise } from "../src/attest.js";
import { FixtureCoverageSource, LiveCoverageSource, UnknownNote } from "../src/coverage/index.js";
import { createAttestorSigner } from "../src/eip712.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { TEST_ATTESTOR_KEY } from "./helpers.js";

const signer = createAttestorSigner(TEST_ATTESTOR_KEY);
const source = new FixtureCoverageSource();

describe("coverage arithmetic", () => {
  it("floors rather than rounds, so a note a hair short stays short", () => {
    // 9999.99... bps must never present as 10000.
    assert.equal(coverageBpsOf(9_999_999n, 10_000_000n), 9999);
    assert.equal(coverageBpsOf(10_000_000n, 10_000_000n), 10000);
  });

  it("rejects a zero obligation instead of dividing by it", () => {
    assert.throws(() => coverageBpsOf(1n, 0n), MalformedSnapshot);
  });

  it("normalises decimals in both directions, truncating downward", () => {
    assert.equal(normalise(1n, 6, 18), 10n ** 12n);
    assert.equal(normalise(10n ** 12n, 18, 6), 1n);
    // Scaling down loses the remainder, and loses it against the issuer.
    assert.equal(normalise(1_999_999_999_999n, 18, 6), 1n);
    assert.equal(normalise(5n, 6, 6), 5n);
  });
});

describe("the decision engine", () => {
  it("attests a covered note and binds every field of the verdict", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    assert.equal(verdict.decision, "attested");
    assert.equal(verdict.httpStatus, 200);
    assert.equal(verdict.coverageBps, 13000);
    assert.equal(verdict.chargeable, true);
    assert.equal(verdict.message.noteId, "NOTE-ALPHA");
    assert.equal(verdict.message.coverageBps, 13000);
    assert.equal(verdict.message.asOfBlock, 21480311n);
    assert.match(verdict.message.vaultSetHash, /^0x[0-9a-f]{64}$/);
    assert.match(verdict.message.sourceHash, /^0x[0-9a-f]{64}$/);
    assert.match(verdict.message.nonce, /^0x[0-9a-f]{64}$/);
    assert.ok(verdict.message.expiry > 0n);
    assert.equal(verdict.attestor, signer.address);
  });

  it("sums positions across different asset decimals", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    assert.equal(verdict.decision, "attested");
    // 150,000 from a 6-decimal vault plus 175,000 from an 18-decimal one.
    assert.equal(verdict.evidence!.attributableValue, "325000000000");
    assert.equal(verdict.evidence!.obligation, "250000000000");
    const decimals = verdict.evidence!.positions.map((p) => p.assetDecimals).sort((a, b) => a - b);
    assert.deepEqual(decimals, [6, 18]);
  });

  it("treats the load line as inclusive: exactly at par clears", async () => {
    const verdict = await attest("NOTE-JULIET", { source, signer });
    assert.equal(verdict.decision, "attested");
    assert.equal(verdict.coverageBps, DEFAULT_POLICY.floorBps);
  });

  it("refuses one basis point below the line", async () => {
    const shaved = new FixtureCoverageSource({}, [
      {
        noteId: "NOTE-HAIR",
        holder: "0x00000000000000000000000000000000006f1a55",
        nominatedVaults: ["0x4626aa11c0ffee0000000000000000000000a001"],
        notesOutstanding: "100000",
        parPerNote: "1000000",
        unitDecimals: 6,
        asOfBlock: "1",
        observedAt: -1,
        sourceSet: { kind: "fixture", dataset: "hair", endpoints: [] },
        positions: [
          {
            vault: "0x4626aa11c0ffee0000000000000000000000a001",
            shares: "1",
            assets: "99999999999",
            assetDecimals: 6,
            blockNumber: "1",
          },
        ],
      },
    ]);
    const verdict = await attest("NOTE-HAIR", { source: shaved, signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.coverageBps, 9999);
  });

  it("raises UnknownNote rather than refusing for a note it has never seen", async () => {
    await assert.rejects(() => attest("NOTE-NOPE", { source, signer }), UnknownNote);
  });

  it("rejects a snapshot with nothing outstanding instead of inventing a ratio", async () => {
    const empty = new FixtureCoverageSource({}, [
      {
        noteId: "NOTE-VOID",
        holder: "0x00000000000000000000000000000000006f1a55",
        nominatedVaults: [],
        notesOutstanding: "0",
        parPerNote: "1000000",
        unitDecimals: 6,
        asOfBlock: "1",
        observedAt: -1,
        sourceSet: { kind: "fixture", dataset: "void", endpoints: [] },
        positions: [],
      },
    ]);
    await assert.rejects(() => attest("NOTE-VOID", { source: empty, signer }), MalformedSnapshot);
  });
});

describe("the live source seam", () => {
  it("refuses rather than guessing, because it is not wired yet", async () => {
    const verdict = await attest("NOTE-ALPHA", { source: new LiveCoverageSource(), signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.reason, "source_unavailable");
    assert.equal(verdict.family, "evidence");
    assert.equal(verdict.coverageKnown, false);
    assert.equal(verdict.coverageBps, 0);
    assert.equal(verdict.evidence, null);
  });
});
