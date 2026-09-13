import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MalformedSnapshot, attest, coverageBpsOf, normalise } from "../src/attest.js";
import {
  FixtureCoverageSource,
  LiveCoverageSource,
  UnknownNote,
  type FixtureNote,
} from "../src/coverage/index.js";
import { createAttestorSigner, noteIdOf } from "../src/eip712.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { TEST_ATTESTOR_KEY, TEST_ORACLE } from "./helpers.js";

const signer = createAttestorSigner(TEST_ATTESTOR_KEY, TEST_ORACLE);
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
    // The oracle knows a note by the keccak of its market code, not by the label.
    assert.equal(verdict.message.noteId, noteIdOf("NOTE-ALPHA"));
    assert.equal(verdict.message.coverageBps, 13000n);
    assert.equal(verdict.message.asOfBlock, 21480311n);
    assert.match(verdict.message.vaultSetHash, /^0x[0-9a-f]{64}$/);
    assert.match(verdict.message.sourceHash, /^0x[0-9a-f]{64}$/);
    // A uint64 that has to increase, not a random bytes32.
    assert.ok(verdict.message.nonce > 0n);
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
    assert.equal(verdict.coverageBps, 10000, "exactly at NOTE-JULIET's own line");
  });

  it("refuses one basis point below the line", async () => {
    const shaved = new FixtureCoverageSource({}, [
      {
        noteId: "NOTE-HAIR",
        thresholdBps: 10000,
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
        thresholdBps: 10000,
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

describe("the load line is read with the note, never taken from policy", () => {
  /** 96,000 of backing against a 100,000 obligation: 9600 bps. */
  function note9600(noteId: string, thresholdBps?: number): FixtureNote {
    return {
      noteId,
      ...(thresholdBps === undefined ? {} : { thresholdBps }),
      holder: "0x00000000000000000000000000000000006f1a55",
      nominatedVaults: ["0x4626aa11c0ffee0000000000000000000000a001"],
      notesOutstanding: "100000",
      parPerNote: "1000000",
      unitDecimals: 6,
      asOfBlock: "1",
      observedAt: -1,
      sourceSet: { kind: "fixture", dataset: "line", endpoints: [] },
      positions: [
        {
          vault: "0x4626aa11c0ffee0000000000000000000000a001",
          shares: "1",
          assets: "96000000000",
          assetDecimals: 6,
          blockNumber: "1",
        },
      ],
    };
  }

  it("attests 9600 bps against a note whose line is 9500", async () => {
    const verdict = await attest("NOTE-LINE", {
      source: new FixtureCoverageSource({}, [note9600("NOTE-LINE", 9500)]),
      signer,
    });
    assert.equal(verdict.decision, "attested");
    assert.equal(verdict.evidence!.floorBps, 9500, "the evidence names the line that was applied");
  });

  it("refuses the identical readings against a note whose line is 10000", async () => {
    // Same backing, same obligation, different line. If the threshold came from
    // a service-wide setting these two would get the same answer.
    const verdict = await attest("NOTE-LINE", {
      source: new FixtureCoverageSource({}, [note9600("NOTE-LINE", 10000)]),
      signer,
    });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.reason, "coverage_below_floor");
    assert.equal(verdict.detail.floorBps, 10000);
  });

  it("refuses as an evidence failure when the line cannot be read, rather than falling back", async () => {
    const verdict = await attest("NOTE-LINE", {
      source: new FixtureCoverageSource({}, [note9600("NOTE-LINE")]),
      signer,
    });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.family, "evidence", "no line is a gap in our evidence, not a finding about the note");
    assert.equal(verdict.reason, "source_unavailable");
    assert.equal(verdict.coverageBps, null, "no ratio is quoted against a line nobody read");
  });
});

describe("the live source seam", () => {
  it("refuses rather than guessing, because it is not wired yet", async () => {
    const verdict = await attest("NOTE-ALPHA", { source: new LiveCoverageSource(), signer });
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.reason, "source_unavailable");
    assert.equal(verdict.family, "evidence");
    assert.equal(verdict.coverageKnown, false);
    // null, not 0: an unreachable source establishes no ratio, and a zero here
    // would read as zero percent coverage.
    assert.equal(verdict.coverageBps, null);
    assert.equal(verdict.evidence, null);
    assert.equal(verdict.sourceHash, null);
  });
});
