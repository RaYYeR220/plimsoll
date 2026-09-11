/**
 * LIVE against The Graph Market. Skipped unless SUBSTREAMS_API_TOKEN (or
 * SUBSTREAMS_ENV_FILE) is set. It takes one stream slot for as long as it
 * runs and releases it by cancelling the stream.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModuleHashHex } from "@substreams/core";
import { loadConfig, readToken } from "../src/config.js";
import { NetworkFeed, StreamSlots } from "../src/feed.js";
import { configure, loadPackage } from "../src/spkg.js";
import { vaultBacking } from "../src/tools.js";
import { assertProvenance, deps } from "./helpers.js";

const token = readToken();

test("live: Base feed reaches the head and answers vault_backing with real provenance", { skip: !token && "no SUBSTREAMS_API_TOKEN", timeout: 420_000 }, async () => {
  const config = loadConfig();
  const loaded = loadPackage(config.packagePath);
  const configured = await configure(loaded, "base", "map_vault_blocks");
  assert.equal(configured.moduleHash, await createModuleHashHex(configured.pkg.modules!, "map_vault_blocks"));
  const slots = new StreamSlots(1);
  const feed = new NetworkFeed({ spec: config.networks.base, configured, token, slots, startBlocksBack: 60, maxPoints: 100 });
  feed.start();
  try {
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline && !(feed.status === "live" && feed.state.vaults.size > 0)) await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(feed.status, "live", `feed status ${feed.status} ${JSON.stringify(feed.lastError)}`);
    const [vault, obs] = [...feed.state.vaults.entries()].sort((a, b) => b[1].block.timestamp - a[1].block.timestamp)[0]!;
    assert.equal(obs.vb.asset === undefined || /^0x[0-9a-f]{40}$/.test(obs.vb.asset), true);
    const r = vaultBacking(deps({ feeds: new Map([["base", feed]]), now: Date.now(), loaded, config }), { network: "base", vault }) as Record<string, any>;
    assertProvenance(r.provenance);
    assert.equal(r.provenance.module.hash, configured.moduleHash);
    assert.equal(r.provenance.endpoint, "https://base-mainnet.streamingfast.io");
    assert.ok(["backing", "refused"].includes(r.result));
  } finally {
    await feed.stop();
    assert.equal(slots.inUse, 0, "slot released after stop");
  }
});
