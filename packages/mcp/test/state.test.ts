import assert from "node:assert/strict";
import { test } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { classify, StreamSlots } from "../src/feed.js";
import { overlappingVaults, parseNotes, positionsParams } from "../src/notes.js";
import { FeedState, observedOf } from "../src/state.js";

const V = "0x9d39a5de30e57443bff2a8307a4256c8797a3497";
const vb = (price: string) => ({ vault: V, stateOk: true, ratesConsistent: true, statePrice: price });

test("a reorg rolls vault state, series and position readings back to the last valid block", () => {
  const s = new FeedState(100);
  s.applyBlock(observedOf(100n, "0xa", 1000), 90n, "c100", { vaults: [vb("1.0")] });
  s.applyBlock(observedOf(101n, "0xb", 1012), 90n, "c101", {
    vaults: [vb("1.1")],
    positionsRead: true,
    positions: [{ note: "n1", vault: V, ok: true, assets: "5" }],
  });
  assert.equal(s.vaults.get(V)!.vb.statePrice, "1.1");
  assert.equal(s.series.get(V)!.length, 2);
  assert.ok(s.notes.has("n1"));
  const undone = s.undoTo(100n, "c100");
  assert.equal(undone, 1);
  assert.equal(s.vaults.get(V)!.vb.statePrice, "1.0");
  assert.equal(s.series.get(V)!.length, 1);
  assert.equal(s.notes.has("n1"), false);
  assert.equal(s.head!.number, 100n);
  assert.equal(s.cursor, "c100");
});

test("finalised blocks leave the journal: an undo can never reach below finality", () => {
  const s = new FeedState(100);
  s.applyBlock(observedOf(100n, "0xa", 1000), 99n, "c100", { vaults: [vb("1.0")] });
  s.applyBlock(observedOf(101n, "0xb", 1012), 101n, "c101", { vaults: [vb("1.1")] });
  assert.equal(s.undoTo(50n, "c50"), 0);
  assert.equal(s.vaults.get(V)!.vb.statePrice, "1.1");
});

test("stream slots enforce the provider's cap and fail fast when full", async () => {
  const slots = new StreamSlots(2);
  const a = await slots.tryAcquire(0);
  const b = await slots.tryAcquire(0);
  assert.ok(a && b);
  assert.equal(await slots.tryAcquire(20), null);
  const waiting = slots.tryAcquire(1_000);
  a!();
  const c = await waiting;
  assert.ok(c);
  assert.equal(slots.inUse, 2);
  b!();
  c!();
  c!(); // double release is harmless
  assert.equal(slots.inUse, 0);
});

test("a ResourceExhausted from the provider is typed as the concurrent stream limit", () => {
  const e = classify(new ConnectError("Concurrent stream limit exceeded (active sessions: 2/2)", Code.ResourceExhausted));
  assert.equal(e.kind, "concurrent_stream_limit");
  assert.equal(classify(new ConnectError("bad token", Code.Unauthenticated)).kind, "auth");
});

test("notes: map_positions params keep the manifest cadence and add one entry per streamable note", () => {
  const n1 = "0x" + "a1".repeat(32);
  const n2 = "0x" + "b2".repeat(32);
  const file = parseNotes({
    notes: {
      [n1]: { market: "A", network: "base", chainId: 8453, vaults: ["0x" + "11".repeat(20)], registry: null },
      [n2]: { market: "B", network: "base", chainId: 8453, vaults: [], registry: null },
    },
  });
  const holders = new Map([[n1, "0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a"], [n2, "0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a"]]);
  assert.equal(positionsParams(file, "base", holders, "every=150"), `every=150;${n1}=0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a:0x${"11".repeat(20)}`);
  assert.equal(positionsParams(file, "mainnet", holders, "every=50"), "every=50");
  assert.deepEqual(overlappingVaults(file, n1, (id) => holders.get(id)), []);
});

test("notes: malformed entries are rejected at load, not at the first query", () => {
  assert.throws(() => parseNotes({ notes: { "0x12": { network: "base", vaults: [] } } }));
  assert.throws(() => parseNotes({ notes: { ["0x" + "a1".repeat(32)]: { network: "polygon", vaults: [] } } }));
  assert.throws(() => parseNotes({ notes: { ["0x" + "a1".repeat(32)]: { network: "base", vaults: ["0xnope"] } } }));
});
