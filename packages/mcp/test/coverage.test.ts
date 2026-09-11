/**
 * note_coverage. The vault list for the real notes is not final, so these use
 * placeholder notes and SYNTHETIC position readings (helpers.positionsBlock),
 * applied to a feed that otherwise replays RECORDED Base stream output. Registry
 * figures come from FakeChain. The arithmetic is the attestor's own, imported.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChainReadError } from "../src/chain.js";
import { vaultSetHash } from "../src/canonical.js";
import type { NetworkName } from "../src/config.js";
import type { FeedHandle } from "../src/feed.js";
import type { Refusal } from "../src/refusals.js";
import { observedOf } from "../src/state.js";
import { noteCoverage } from "../src/tools.js";
import { assertProvenance, deps, FakeChain, figuresIn, HOLDER, loadedFrom, loadRecording, note, notesFile, positionsBlock, replay, testConfig } from "./helpers.js";

const rec = loadRecording("base");
const config = testConfig();
const loaded = loadedFrom(rec);

const TWIN = "0x" + "a1".repeat(32); // under-backed negative control
const RIGHT = "0x" + "b2".repeat(32); // right-sized placeholder
const V1 = "0x" + "11".repeat(20);
const V2 = "0x" + "22".repeat(20);

function setup(opts: { positions?: Parameters<typeof positionsBlock>; facts?: Record<string, unknown>; notes?: ReturnType<typeof note>[]; age?: number; holders?: Map<string, string> } = {}) {
  const feed = replay(rec, config);
  const head = feed.state.head!;
  const readAt = head.timestamp - (opts.age ?? 0);
  if (opts.positions) {
    feed.state.applyBlock(observedOf(head.number + 1n, "0xfeed", readAt), head.number, "c", positionsBlock(...opts.positions));
    // the head moves on so the stream itself is fresh
    feed.state.applyBlock(observedOf(head.number + 2n, "0xfeed2", head.timestamp + 2), head.number + 1n, "c2", undefined);
  }
  const noteList = opts.notes ?? [note(TWIN, [V1], { negativeControl: true }), note(RIGHT, [V2])];
  const hashes = new Map(noteList.map((n) => [n.noteId, vaultSetHash(n.vaults)]));
  const chain = new FakeChain((id) => ({ onchainVaultSetHash: hashes.get(id) ?? vaultSetHash([]), ...(opts.facts ?? {}) }) as never);
  const d = deps({
    feeds: new Map<NetworkName, FeedHandle>([["base", feed]]),
    now: (head.timestamp + 5) * 1000,
    loaded,
    notes: notesFile(noteList),
    chain,
    holders: opts.holders ?? new Map(noteList.map((n) => [n.noteId, HOLDER])),
    config,
  });
  return { feed, d };
}

const evidence: Refusal[] = [];
function refusal(r: unknown, reason: string, family: "asset" | "evidence"): Record<string, any> {
  const x = r as Record<string, any>;
  assert.equal(x.result, "refused", JSON.stringify(r).slice(0, 500));
  assert.equal(x.family, family);
  assert.equal(x.reason, reason);
  assertProvenance(x.provenance);
  assert.match(x.attestation.signedAttestation, /\/attest\?noteId=0x[0-9a-f]{64}$/);
  if (family === "evidence") evidence.push(x as Refusal);
  return x;
}

test("under-backed twin refuses coverage_below_floor and quotes the figure", async () => {
  // $15 of USDC against 10,000.00 notes x 100.00 par = $1,000,000.
  const { d } = setup({ positions: [TWIN, V1, "15000000", "14000000000000000000"] });
  const r = refusal(await noteCoverage(d, { noteId: TWIN }), "coverage_below_floor", "asset");
  assert.equal(r.coverageKnown, true);
  assert.equal(typeof r.coverageBps, "number");
  assert.equal(r.coverageBps, 0);
  assert.equal(r.floorBps, 9500);
  assert.equal(r.detail.obligation, (1_000_000n * 10_000n).toString());
  assert.equal(r.detail.negativeControl, true);
  assert.equal(r.provenance.reads.find((x: any) => x.method === "totalSupply()").value, "1000000");
});

test("a right-sized note is covered, with provenance for both the stream and the registry", async () => {
  // 10.00 notes x 1.00 par = $10 against $15 → 15000 bps.
  const { d } = setup({ positions: [RIGHT, V2, "15000000", "14000000000000000000"], facts: { totalSupply: 1_000n, nominal: 100n } });
  const r = (await noteCoverage(d, { noteId: RIGHT })) as Record<string, any>;
  assert.equal(r.result, "covered");
  assert.equal(r.coverageBps, 15_000);
  assert.equal(r.thresholdBps, 9500);
  assertProvenance(r.provenance);
  assert.ok(r.provenance.reads.length >= 2);
  assert.equal(r.controlViolated, undefined);
});

test("a negative control that clears is flagged as a defect, not reported as good news", async () => {
  const { d } = setup({ positions: [TWIN, V1, "15000000", "1"], facts: { totalSupply: 1_000n, nominal: 100n } });
  const r = (await noteCoverage(d, { noteId: TWIN })) as Record<string, any>;
  assert.equal(r.result, "covered");
  assert.equal(r.controlViolated, true);
});

test("no shares held is an asset finding with ratio 0", async () => {
  const { d } = setup({ positions: [RIGHT, V2, "0", "0"] });
  const r = refusal(await noteCoverage(d, { noteId: RIGHT }), "no_attributable_positions", "asset");
  assert.equal(r.coverageBps, 0);
});

test("vault_set_drift when the committed on-chain vault set differs from the file", async () => {
  const { d } = setup({ positions: [RIGHT, V2, "15000000", "1"], facts: { onchainVaultSetHash: "0x2627c1d5" + "0".repeat(56) } });
  const r = refusal(await noteCoverage(d, { noteId: RIGHT }), "vault_set_drift", "evidence");
  assert.equal(r.detail.notesFileVaultSetHash, vaultSetHash([V2]));
});

test("vault_set_drift when one vault would back two notes of the same holder", async () => {
  const notes = [note(TWIN, [V1], { negativeControl: true }), note(RIGHT, [V1, V2])];
  const { d } = setup({ notes, positions: [RIGHT, V2, "15000000", "1"] });
  const r = refusal(await noteCoverage(d, { noteId: RIGHT }), "vault_set_drift", "evidence");
  assert.equal(r.detail.cause, "vault_backs_another_note");
  assert.deepEqual(r.detail.vaults, [V1]);
});

test("an ambiguous issuer is an evidence refusal: the holder is derived, never guessed", async () => {
  const { d } = setup({ positions: [RIGHT, V2, "15000000", "1"], facts: { holder: null, issuerCount: 2 } });
  const r = refusal(await noteCoverage(d, { noteId: RIGHT }), "source_unavailable", "evidence");
  assert.equal(r.detail.cause, "issuer_ambiguous");
});

test("a failed registry read refuses source_unavailable and names the read", async () => {
  const feed = replay(rec, config);
  const d = deps({
    feeds: new Map<NetworkName, FeedHandle>([["base", feed]]),
    now: (feed.state.head!.timestamp + 5) * 1000,
    loaded,
    notes: notesFile([note(RIGHT, [V2])]),
    chain: new FakeChain(() => new ChainReadError("0xnote", "getNominalValue()", "FunctionNotFound")),
  });
  const r = refusal(await noteCoverage(d, { noteId: RIGHT }), "source_unavailable", "evidence");
  assert.equal(r.detail.read, "getNominalValue()");
});

test("a position reading older than the staleness policy is refused, not served", async () => {
  const { d } = setup({ positions: [RIGHT, V2, "15000000", "1"], age: config.maxStalenessSeconds + 60 });
  const r = refusal(await noteCoverage(d, { noteId: RIGHT }), "data_stale", "evidence");
  assert.equal(r.detail.stale, "position_reading");
});

test("a reverted position read is vault_unresolved", async () => {
  const { d } = setup({ positions: [RIGHT, V2, "", "", { ok: false }] });
  refusal(await noteCoverage(d, { noteId: RIGHT }), "vault_unresolved", "evidence");
});

test("a note the stream has no reading for yet is source_unavailable", async () => {
  const { d } = setup();
  const r = refusal(await noteCoverage(d, { noteId: RIGHT }), "source_unavailable", "evidence");
  assert.equal(r.detail.cause, "no_position_reading_yet");
});

test("unknown note ids are reported as unknown, with provenance", async () => {
  const { d } = setup();
  const r = (await noteCoverage(d, { noteId: "0x" + "ff".repeat(32) })) as Record<string, any>;
  assert.equal(r.result, "unknown_note");
  assertProvenance(r.provenance);
});

test("evidence refusals from note_coverage quote no figure, not even in their registry reads", () => {
  assert.ok(evidence.length >= 6);
  for (const r of evidence) {
    assert.deepEqual(figuresIn(r), [], `${r.reason}: ${figuresIn(r).join(", ")}`);
    for (const read of r.provenance.reads ?? []) if (read.kind === "quantity") assert.equal(read.value, undefined);
  }
});
