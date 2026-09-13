import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalHash } from "@plimsoll/attestor/dist/src/canonical.js";
import { VAULTS } from "../src/config.js";
import { vaultSetHash } from "../src/liabilities.js";
import { PlanError, resolveLegs, scenarios } from "../src/plan.js";

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
/** PLIM-B on-chain: 10.00 notes at 1.00 USD, against a 100.00% line. */
const PLIM_B_OBLIGATION = USDC(10);
const LINE = 10_000;
/** The control takes its dollar first, so PLIM-B is sized from what is left. */
const forPlimB = (wallet: number) => USDC(wallet) - USDC(1);

describe("the PLIM-B split", () => {
  it("splits the 14 USDC left after the control as 8 / 3 / 3", () => {
    const { legs, idle } = resolveLegs("PLIM-B", forPlimB(15));
    assert.deepEqual(
      legs.map((l) => [l.vault.key, l.amount]),
      [
        ["morpho", USDC(8)],
        ["aave", USDC(3)],
        ["spark", USDC(3)],
      ],
    );
    assert.equal(idle, 0n);
  });

  it("(a) funded is comfortably clear, (b) the named redemption is clearly below, (c) redepositing clears", () => {
    const { legs } = resolveLegs("PLIM-B", forPlimB(15));
    const s = scenarios(legs, PLIM_B_OBLIGATION);
    assert.equal(s.funded, 14_000);
    assert.equal(s.withoutNamed, 6_000);
    assert.equal(s.redeposited, 14_000);
    assert.ok(s.funded - LINE >= 2_000, "at least 20 points of headroom");
    assert.ok(LINE - s.withoutNamed >= 1_000, "at least 10 points under, never onto the line");
  });

  it("losing either other position alone does not break the line", () => {
    const { legs } = resolveLegs("PLIM-B", forPlimB(15));
    const { withoutEachOther } = scenarios(legs, PLIM_B_OBLIGATION);
    assert.deepEqual(withoutEachOther, { aave: 11_000, spark: 11_000 });
  });

  it("holds (a) to (c) for any balance the funding could plausibly land at", () => {
    for (let cents = 1300; cents <= 2500; cents += 25) {
      const wallet = cents / 100;
      const { legs, idle } = resolveLegs("PLIM-B", forPlimB(wallet));
      const s = scenarios(legs, PLIM_B_OBLIGATION);
      assert.ok(s.funded >= 12_000, `${wallet} USDC: funded ${s.funded}`);
      assert.ok(s.withoutNamed <= 7_000, `${wallet} USDC: without the named position ${s.withoutNamed}`);
      assert.ok(legs.every((l) => l.amount > 0n));
      assert.equal(legs.reduce((sum, l) => sum + l.amount, 0n) + idle, forPlimB(wallet));
    }
  });

  it("caps the last leg and leaves the excess idle rather than weakening the named position", () => {
    const { legs, idle } = resolveLegs("PLIM-B", forPlimB(20));
    assert.equal(legs.find((l) => l.vault.key === "spark")!.amount, USDC(4));
    assert.equal(idle, USDC(4));
  });

  it("refuses a balance too small to fund the plan", () => {
    assert.throws(() => resolveLegs("PLIM-B", USDC(10.99)), PlanError);
    assert.throws(() => resolveLegs("PLIM-B", USDC(11.4)), PlanError);
  });

  it("gives the control a fixed dollar and nothing else", () => {
    const { legs } = resolveLegs("PLIM-A", USDC(15));
    assert.deepEqual(
      legs.map((l) => [l.vault.key, l.amount]),
      [["fluid", USDC(1)]],
    );
  });

  it("resumes an interrupted plan by sizing only the legs with no position yet", () => {
    // Morpho and Aave landed, then the Spark deposit reverted: its 3 USDC is
    // still in the wallet, and running the plan again should put it there.
    const resumed = resolveLegs("PLIM-B", USDC(3), new Set(["morpho", "aave"]));
    assert.deepEqual(
      resumed.legs.map((l) => [l.vault.key, l.amount]),
      [["spark", USDC(3)]],
    );
    assert.equal(resumed.idle, 0n);

    assert.deepEqual(resolveLegs("PLIM-B", USDC(3), new Set(["morpho", "aave", "spark"])).legs, []);
    // A funded leg is never topped up to make up for money that is not there.
    assert.throws(() => resolveLegs("PLIM-B", USDC(2), new Set(["morpho"])), PlanError);
  });
});

describe("the vault sets", () => {
  it("hashes with the attestor's own canonicalHash, not a copy of it", () => {
    const vaults = ["0x2222222222222222222222222222222222222222", "0x1111111111111111111111111111111111111111"];
    assert.equal(vaultSetHash(vaults), canonicalHash(vaults.map((v) => v.toLowerCase()).sort()));
    // Vectors pinned from that same function, so a change in either is caught.
    assert.equal(vaultSetHash(vaults), "0x6b1424f15091427569834af02fc76da685fd016c97b58eee5a51ad244c437b7e");
    assert.equal(vaultSetHash([]), "0x4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  });

  it("gives each note its own, disjoint set", () => {
    const b = VAULTS.filter((v) => v.market === "PLIM-B").map((v) => v.address);
    const a = VAULTS.filter((v) => v.market === "PLIM-A").map((v) => v.address);
    assert.equal(vaultSetHash(b), "0xb1e9d3e61ec546b9efbea1d67b18058f2e9563e19c0a46491a86a05bc004f81e");
    assert.equal(vaultSetHash(a), "0xbaf33c99aa83d554b782e7dc98ad3e0f5e8838abfdd64c125f0a2e9627d8fa5c");
    assert.equal(b.filter((v) => a.includes(v)).length, 0);
  });
});
