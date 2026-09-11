/**
 * Vault tools against RECORDED real stream output (test/fixtures/recorded-*.json,
 * captured from The Graph Market by bin/record.ts). Clock and staleness are
 * driven explicitly so freshness decisions are deterministic.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NetworkName } from "../src/config.js";
import type { FeedHandle } from "../src/feed.js";
import type { Refusal } from "../src/refusals.js";
import { FeedState, observedOf } from "../src/state.js";
import { feedStatus, InputError, vaultBacking, vaultSharePriceSeries } from "../src/tools.js";
import { assertProvenance, deps, figuresIn, loadedFrom, loadRecording, replay, ReplayFeed, testConfig } from "./helpers.js";

const rec = loadRecording("mainnet");
const config = testConfig();
const loaded = loadedFrom(rec);
const headTs = rec.head!.timestamp;

function feedMap(feed: FeedHandle): Map<NetworkName, FeedHandle> {
  return new Map([["mainnet", feed]]);
}

/** The most recently observed vault whose state and rates are good. */
function goodVault(feed: ReplayFeed): string {
  let best: [string, number] | null = null;
  for (const [v, o] of feed.state.vaults) {
    if (o.vb.stateOk && o.vb.ratesConsistent && (!best || o.block.timestamp > best[1])) best = [v, o.block.timestamp];
  }
  assert.ok(best, "recording holds at least one consistent vault");
  return best[0];
}

const evidenceSeen: Refusal[] = [];
function refused(r: unknown, reason: string, family = "evidence"): Refusal {
  const x = r as Refusal;
  assert.equal(x.result, "refused", JSON.stringify(r).slice(0, 400));
  assert.equal(x.family, family);
  assert.equal(x.reason, reason);
  assertProvenance(x.provenance);
  if (x.family === "evidence") evidenceSeen.push(x);
  return x;
}

test("recording is labelled as recorded real output", () => {
  assert.match(rec.about, /RECORDED/);
  assert.ok(rec.blocks.length > 0);
  assert.match(rec.module.hash, /^[0-9a-f]{40}$/);
});

test("vault_backing answers from the recorded stream with full provenance", () => {
  const feed = replay(rec, config);
  const vault = goodVault(feed);
  const obs = feed.state.vaults.get(vault)!;
  const r = vaultBacking(deps({ feeds: feedMap(feed), now: headTs + 5, loaded, config: testConfig({ maxStalenessSeconds: 86_400 }) }), { network: "mainnet", vault }) as Record<string, any>;
  assert.equal(r.result, "backing");
  assert.equal(r.totalAssets.raw, obs.vb.totalAssets);
  assert.equal(r.sharePrice, obs.vb.statePrice);
  assertProvenance(r.provenance);
  assert.equal(r.provenance.block.number, obs.block.number.toString());
  assert.equal(r.provenance.block.hash, obs.block.hash);
  assert.equal(r.provenance.module.hash, rec.module.hash);
  assert.equal(r.provenance.package.sha256, rec.package.sha256);
  assert.equal(r.provenance.endpoint, config.networks.mainnet.endpoint);
  assert.ok(r.provenance.head.lagSeconds <= 5);
});

test("entry and exit rates are carried forward separately, never blended", () => {
  const feed = new ReplayFeed(config.networks.mainnet, "map_vault_blocks", "0".repeat(40));
  const v = "0x9d39a5de30e57443bff2a8307a4256c8797a3497";
  const base = { vault: v, stateOk: true, ratesConsistent: true, statePrice: "1.2", totalAssets: "1", totalSupply: "1" };
  feed.state.applyBlock(observedOf(10n, "0xa", 1000), 9n, "c10", { vaults: [{ ...base, entryRate: "1.2000001" }] });
  feed.state.applyBlock(observedOf(11n, "0xb", 1012), 10n, "c11", { vaults: [{ ...base, exitRate: "1.1999999" }] });
  const r = vaultBacking(deps({ feeds: feedMap(feed), now: 1020_000, loaded, config: testConfig({ maxStalenessSeconds: 1e9 }) }), { network: "mainnet", vault: v }) as Record<string, any>;
  assert.deepEqual(r.entryRate, { rate: "1.2000001", block: "10" });
  assert.deepEqual(r.exitRate, { rate: "1.1999999", block: "11" });
});

test("refuses data_stale when the stream head is older than the head-lag threshold", () => {
  const feed = replay(rec, config);
  const now = (headTs + config.networks.mainnet.headMaxLagSeconds + 1) * 1000;
  const r = refused(vaultBacking(deps({ feeds: feedMap(feed), now, loaded }), { network: "mainnet", vault: goodVault(feed) }), "data_stale");
  assert.equal((r as any).detail.stale, "stream_head");
});

test("refuses data_stale when the vault's own observation is older than the staleness policy", () => {
  const feed = replay(rec, config);
  const vault = goodVault(feed);
  const obsTs = feed.state.vaults.get(vault)!.block.timestamp;
  // Head keeps moving (fresh), the vault has had no flow since: its reading ages out.
  const later = obsTs + config.maxStalenessSeconds + 60;
  feed.state.applyBlock(observedOf(feed.state.head!.number + 1000n, "0xhead", later), null, "c", undefined);
  const r = refused(vaultBacking(deps({ feeds: feedMap(feed), now: (later + 1) * 1000, loaded }), { network: "mainnet", vault }), "data_stale");
  assert.equal((r as any).detail.stale, "vault_observation");
});

test("negative control: a frozen feed's cached value is never served as fresh", () => {
  const feed = replay(rec, config);
  const vault = goodVault(feed);
  const obs = feed.state.vaults.get(vault)!;
  const t0 = Math.max(headTs, obs.block.timestamp) + 1;
  const d = (now: number) => deps({ feeds: feedMap(feed), now: now * 1000, loaded });
  const fresh = vaultBacking(d(t0), { network: "mainnet", vault }) as Record<string, any>;
  if (fresh.result !== "backing") refused(fresh, "data_stale"); // recording older than policy: still a refusal, never a number
  // The feed stops (no more blocks) and the clock moves past every threshold.
  const stale = vaultBacking(d(t0 + config.maxStalenessSeconds + config.networks.mainnet.headMaxLagSeconds + 1), { network: "mainnet", vault });
  refused(stale, "data_stale");
  const text = JSON.stringify(stale);
  assert.ok(!text.includes(`"${obs.vb.totalAssets}"`), "cached totalAssets must not appear in a stale refusal");
  assert.ok(!obs.vb.statePrice || !text.includes(obs.vb.statePrice), "cached share price must not appear in a stale refusal");
});

test("refuses vault_unresolved for an address the stream has never seen", () => {
  const feed = replay(rec, config);
  const r = refused(
    vaultBacking(deps({ feeds: feedMap(feed), now: (headTs + 5) * 1000, loaded }), { network: "mainnet", vault: "0x000000000000000000000000000000000000dead" }),
    "vault_unresolved",
  );
  assert.equal((r as any).detail.cause, "no_conforming_flow_observed");
});

test("refuses vault_unresolved when a vault's events contradict its own accounting", () => {
  const feed = replay(rec, config);
  // 0x4f95…: asset() is USDC, yet deposits imply a price near 1 against a
  // totalAssets/totalSupply near 2e-6. Use the recorded row if the window caught
  // one; otherwise flip the flag on a recorded row (labelled below).
  let vault = "0x4f95c5ba0c7c69fb2f9340e190ccee890b3bd87c";
  if (!feed.state.vaults.has(vault)) {
    vault = goodVault(feed);
    const o = feed.state.vaults.get(vault)!;
    feed.state.vaults.set(vault, { ...o, vb: { ...o.vb, ratesConsistent: false } }); // SYNTHETIC flip of a recorded row
  }
  const r = refused(
    vaultBacking(deps({ feeds: feedMap(feed), now: (headTs + 5) * 1000, loaded, config: testConfig({ maxStalenessSeconds: 86_400 }) }), { network: "mainnet", vault }),
    "vault_unresolved",
  );
  assert.equal((r as any).detail.cause, "event_rates_inconsistent_with_vault_price");
});

test("source_unavailable when the network is not streamed, and while a feed has no data yet", () => {
  const empty = new ReplayFeed(config.networks.base, "map_positions", "0".repeat(40));
  empty.status = "warming";
  const d = deps({ feeds: new Map([["base", empty]]), now: Date.now(), loaded });
  const a = refused(vaultBacking(d, { network: "mainnet", vault: "0x9d39a5de30e57443bff2a8307a4256c8797a3497" }), "source_unavailable");
  assert.equal((a as any).detail.cause, "network_not_streamed");
  const b = refused(vaultBacking(d, { network: "base", vault: "0x9d39a5de30e57443bff2a8307a4256c8797a3497" }), "source_unavailable");
  assert.equal((b as any).detail.cause, "warming_up");
});

test("a concurrency refusal from the provider surfaces as a typed cause", () => {
  const f = new ReplayFeed(config.networks.base, "map_positions", "0".repeat(40));
  f.status = "backoff";
  f.lastError = { kind: "concurrent_stream_limit", message: "Concurrent stream limit exceeded (active sessions: 2/2)", at: new Date().toISOString() };
  const r = refused(vaultBacking(deps({ feeds: new Map([["base", f]]), now: Date.now(), loaded }), { network: "base", vault: "0x9d39a5de30e57443bff2a8307a4256c8797a3497" }), "source_unavailable");
  assert.equal((r as any).detail.cause, "concurrent_stream_limit");
});

test("bad input is an input error, not a refusal", () => {
  const d = deps({ feeds: new Map(), now: Date.now(), loaded });
  assert.throws(() => vaultBacking(d, { network: "mainnet", vault: "nope" }), InputError);
  assert.throws(() => vaultBacking(d, { network: "polygon", vault: "0x9d39a5de30e57443bff2a8307a4256c8797a3497" }), InputError);
});

test("share-price series from the buffer carries points, derived stats and provenance", async () => {
  const feed = replay(rec, config);
  let vault = goodVault(feed);
  for (const [v, pts] of feed.state.series) if (pts.length > (feed.state.series.get(vault)?.length ?? 0) && pts.some((p) => p.statePrice)) vault = v;
  const r = (await vaultSharePriceSeries(deps({ feeds: feedMap(feed), now: (headTs + 5) * 1000, loaded }), { network: "mainnet", vault })) as Record<string, any>;
  assert.equal(r.result, "series");
  assert.equal(r.source, "stream_buffer");
  assert.ok(r.points.length >= 1);
  assert.equal(typeof r.stats.eip4626Ordering.held, "boolean");
  assert.match(r.stats.eip4626Ordering.entryAtOrAbovePrice, /^\d+\/\d+$/);
  assertProvenance(r.provenance);
});

test("a series 'up to now' refuses when the head is stale; an explicit past range is still history", async () => {
  const feed = replay(rec, config);
  const vault = goodVault(feed);
  const late = (headTs + config.networks.mainnet.headMaxLagSeconds + 10) * 1000;
  refused(await vaultSharePriceSeries(deps({ feeds: feedMap(feed), now: late, loaded }), { network: "mainnet", vault }), "data_stale");
  const past = (await vaultSharePriceSeries(deps({ feeds: feedMap(feed), now: late, loaded }), {
    network: "mainnet",
    vault,
    fromBlock: feed.state.firstBlock!.toString(),
    toBlock: feed.state.head!.number.toString(),
  })) as Record<string, any>;
  assert.equal(past.result, "series");
});

test("a range older than the buffer goes to a live range request, and fails closed without one", async () => {
  const feed = replay(rec, config);
  const vault = goodVault(feed);
  const from = feed.state.firstBlock! - 1000n;
  const args = { network: "mainnet", vault, fromBlock: from.toString(), toBlock: (from + 100n).toString() };
  const none = refused(await vaultSharePriceSeries(deps({ feeds: feedMap(feed), now: (headTs + 5) * 1000, loaded }), args), "source_unavailable");
  assert.equal((none as any).detail.cause, "range_requests_disabled");
  const busy = {
    vaultSeries: async () =>
      ({
        result: "refused",
        family: "evidence",
        reason: "source_unavailable",
        message: "busy",
        coverageKnown: false,
        detail: { cause: "stream_capacity" },
        provenance: (none as any).provenance,
      }) as const,
  };
  const r = refused(await vaultSharePriceSeries(deps({ feeds: feedMap(feed), now: (headTs + 5) * 1000, loaded, range: busy as never }), args), "source_unavailable");
  assert.equal((r as any).detail.cause, "stream_capacity");
  await assert.rejects(
    vaultSharePriceSeries(deps({ feeds: feedMap(feed), now: 0, loaded }), { ...args, toBlock: (from + 1_000_000n).toString() }),
    InputError,
  );
});

test("feed_status reports every network with provenance", () => {
  const feed = replay(rec, config);
  const s = feedStatus(deps({ feeds: feedMap(feed), now: (headTs + 5) * 1000, loaded })) as Record<string, any>;
  assert.equal(s.networks.mainnet.streaming, true);
  assertProvenance(s.networks.mainnet.provenance);
  assert.equal(s.networks.base.streaming, false);
});

test("evidence refusals carry no figure anywhere in the object (deep scan)", () => {
  assert.ok(evidenceSeen.length >= 8, `collected ${evidenceSeen.length} evidence refusals`);
  for (const r of evidenceSeen) {
    assert.equal(r.coverageKnown, false);
    assert.deepEqual(figuresIn(r), [], `figures in ${r.reason}: ${figuresIn(r).join(", ")}`);
  }
});

test("the scanner does catch a figure (so a clean scan means something)", () => {
  assert.deepEqual(figuresIn({ detail: { coverageBps: 0 } }), ["detail.coverageBps"]);
  assert.deepEqual(figuresIn({ a: [{ totalAssets: "12" }] }), ["a[0].totalAssets"]);
  assert.deepEqual(figuresIn({ provenance: { block: { number: "1" } } }), []);
});

test("FeedState alone never invents a head", () => {
  assert.equal(new FeedState(10).head, null);
});
