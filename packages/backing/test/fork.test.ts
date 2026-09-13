import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { toHex, type Address } from "viem";
import { publicClientFor } from "../src/chain.js";
import { TOKENS } from "../src/config.js";
import { dryRun, planDeposit, planWithdraw, status, type Context } from "../src/commands.js";
import { impersonatedSender, mappingSlot, run, type Sent } from "../src/tx.js";

/**
 * The whole demo cycle on a local fork of Base mainnet: fund, deposit the
 * plan, redeem the named position, deposit it back. The same code paths as a
 * real run, with anvil impersonating the holder so no key is involved.
 *
 * Needs `anvil` on PATH and a reachable Base endpoint (FORK_URL, default the
 * public one). Skips loudly otherwise.
 */

const hasAnvil = spawnSync("anvil", ["--version"], { encoding: "utf8" }).status === 0;
const skip = hasAnvil ? false : "SKIPPED (fork cycle): anvil is not on PATH";
const FORK_URL = process.env.FORK_URL?.trim() || "https://base.gateway.tenderly.co";

/**
 * A fresh address that has never touched these vaults, impersonated by anvil;
 * no key for it exists or is needed. Not the issuer: the issuer's real
 * positions are on mainnet now, so a fork of any recent block inherits them,
 * and a test about funding an empty wallet cannot start from a funded one.
 */
const HOLDER = "0x5f1c0a7e3b9d2c4e6a8f0b1d3c5e7a9b2d4f6e81" as Address;
const PORT = 18_545 + Math.floor(Math.random() * 1_000);
const RPC = `http://127.0.0.1:${PORT}`;

let anvil: ChildProcess | null = null;
let workdir = "";
let ctx: Context;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  if (!hasAnvil) return;
  const head = await publicClientFor(FORK_URL).getBlockNumber();
  anvil = spawn(
    "anvil",
    ["--fork-url", FORK_URL, "--fork-block-number", String(head - 5n), "--port", String(PORT), "--silent", "--retries", "10"],
    { stdio: "ignore" },
  );
  const client = publicClientFor(RPC);
  for (let i = 0; i < 120; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await sleep(500);
    }
  }
  // An empty notes file keeps this test off Hedera: PLIM-B uses its planned figures.
  workdir = mkdtempSync(join(tmpdir(), "plimsoll-backing-"));
  writeFileSync(join(workdir, "notes.json"), JSON.stringify({ version: 2, notes: {} }));
  // `registries: {}` keeps this test off Hedera: PLIM-B uses its planned figures.
  // A fork only has as many blocks as transactions sent, so reads pin to the head.
  ctx = {
    client,
    rpcLabel: "anvil fork",
    holder: HOLDER,
    notesPath: join(workdir, "notes.json"),
    registries: {},
    confirmations: 0n,
  };
});

after(() => {
  anvil?.kill();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

async function coverage(market: "PLIM-B" | "PLIM-A") {
  const report = await status(ctx);
  return report.notes.find((n) => n.market === market)!;
}

function gasLine(sent: readonly Sent[]): string {
  return sent.map((s) => `${s.label}: ${s.gasUsed}`).join("; ");
}

describe("fork: the demo cycle end to end", { skip }, () => {
  it("simulates the whole plan for an unfunded holder, stating what it assumed", async () => {
    const plan = await planDeposit(ctx, {});
    const simulated = await dryRun(ctx, plan);
    assert.equal(plan.steps.length, 8, "an approval and a deposit for the control, then three of each for PLIM-B");
    for (const s of simulated.simulations) assert.ok(s.ok, `${s.step.label}: ${s.error}`);
    const deposits = simulated.simulations.filter((s) => s.step.label.startsWith("deposit"));
    assert.ok(deposits.every((s) => s.assumed.length > 0), "an unfunded deposit can only be simulated with stated assumptions");
  });

  it("funds the fork's holder and sends the plan", async (t) => {
    await ctx.client.request({
      method: "anvil_setStorageAt",
      params: [TOKENS.USDC.address, mappingSlot(HOLDER, TOKENS.USDC.balanceSlot), toHex(15_000_000n, { size: 32 })],
    } as never);
    // A whole ether, because anvil prices gas off its own fee estimation rather
    // than Base's. What a real run costs is measured by the dry run instead.
    await ctx.client.request({ method: "anvil_setBalance", params: [HOLDER, toHex(10n ** 18n)] } as never);

    const plan = await planDeposit(ctx, { forSend: true });
    const sent = await run(ctx.client, await impersonatedSender(ctx.client, HOLDER, RPC), plan.steps);
    t.diagnostic(gasLine(sent));
    assert.equal(sent.length, 8);
    assert.ok(sent.every((s) => s.status === "success"));
  });

  it("(a) reads PLIM-B well above its line, and the control's dollar", async (t) => {
    const b = await coverage("PLIM-B");
    const a = await coverage("PLIM-A");
    t.diagnostic(`PLIM-B ${b.coverageBps} bps, backing ${b.backingMicro}; PLIM-A backing ${a.backingMicro} micro-USD`);
    assert.equal(b.liabilities?.source, "planned");
    assert.ok(b.coverageBps! >= 13_990 && b.coverageBps! <= 14_000, `${b.coverageBps}`);
    assert.ok(a.backingMicro > 900_000n && a.backingMicro <= 1_000_000n);
  });

  it("(b) redeeming the named position takes PLIM-B clearly below the line", async (t) => {
    const plan = await planWithdraw(ctx, { vault: "morpho", all: true });
    const sent = await run(ctx.client, await impersonatedSender(ctx.client, HOLDER, RPC), plan.steps);
    t.diagnostic(gasLine(sent));
    const b = await coverage("PLIM-B");
    t.diagnostic(`PLIM-B ${b.coverageBps} bps after the redemption`);
    assert.ok(b.coverageBps! < 10_000 && b.coverageBps! <= 6_001, `${b.coverageBps}`);
    assert.equal(b.positions.find((p) => p.vault.key === "morpho")!.shares, 0n);
  });

  it("(c) depositing it back clears the line again", async (t) => {
    const plan = await planDeposit(ctx, { vault: "morpho", allBalance: true, forSend: true });
    const sent = await run(ctx.client, await impersonatedSender(ctx.client, HOLDER, RPC), plan.steps);
    t.diagnostic(gasLine(sent));
    const b = await coverage("PLIM-B");
    t.diagnostic(`PLIM-B ${b.coverageBps} bps after the redeposit`);
    assert.ok(b.coverageBps! >= 13_990, `${b.coverageBps}`);
  });

  it("refuses to run the full plan twice", async () => {
    await assert.rejects(() => planDeposit(ctx, { forSend: true }), /already has a position/);
  });
});
