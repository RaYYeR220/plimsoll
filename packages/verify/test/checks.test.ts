import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkAts, parseStatedBalances } from "../src/checks/ats.js";
import { checkContracts } from "../src/checks/contracts.js";
import { ACCOUNT_IS_BLOCKED, checkDenial, decodeAccountIsBlocked } from "../src/checks/denial.js";
import { checkGithub, checkSubstreams } from "../src/checks/external.js";
import { checkCashLeg } from "../src/checks/token.js";
import { encodeContractKey } from "../src/protobufKey.js";
import { parseSubstreamsPackage, supersededGenerations } from "../src/inputs.js";
import type { CheckResult } from "../src/result.js";
import { BEFORE_WINDOW, BUYER, buildWorld, find, makeContext, realInputs } from "./fakes.js";

const failures = (rows: CheckResult[]) => rows.filter((r) => r.status === "fail");

function setup() {
  const inputs = realInputs();
  const world = buildWorld(inputs);
  return { inputs, world, ctx: makeContext(inputs, world) };
}

describe("1 · contracts", () => {
  it("passes every current contract against a faithful world", async () => {
    const { inputs, ctx } = setup();
    const rows = await checkContracts(ctx);
    assert.deepEqual(failures(rows), []);
    for (const name of Object.keys(inputs.record.contracts)) {
      const row = find(rows, name);
      assert.equal(row.status, "pass");
      assert.match(row.detail, /Sourcify exact_match/);
      assert.match(row.detail, /created by the recorded tx/);
    }
  });

  it("lists superseded contracts as history, never as failures, and never queries them", async () => {
    const { inputs, world, ctx } = setup();
    const rows = await checkContracts(ctx);
    const retired = find(rows, /superseded contracts$/);
    assert.equal(retired.status, "skip");
    for (const entry of supersededGenerations(inputs.record).flatMap((g) => Object.values(g.contracts ?? {}))) {
      assert.ok(!world.mirror.asked.includes(entry.address.toLowerCase()), `asked about ${entry.address}`);
    }
  });

  it("reads superseded history whether the record keeps one generation or a list of them", async () => {
    const { inputs, world } = setup();
    const first = supersededGenerations(inputs.record)[0]!;
    inputs.record.superseded = [
      first,
      {
        reason: "Superseded on 2026-09-11 by the locked authority.",
        contracts: {
          MandateVerifier: { address: "0x00000000000000000000000000000000009fd229", hederaId: "0.0.10474281" },
          MandateVerifierAdapter: { address: "0x00000000000000000000000000000000009fd22b", hederaId: "0.0.10474283" },
        },
      },
    ];
    const ctx = makeContext(inputs, world);
    const row = find(await checkContracts(ctx), /superseded contracts$/);
    assert.equal(row.status, "skip");
    assert.equal(row.title, "8 superseded contracts");
    assert.match(row.detail, /2 redeploys/);
    assert.ok(row.detail.includes("0.0.10474283"));
    const tokens = (await checkCashLeg(ctx)).filter((r) => r.title.startsWith("superseded cash token"));
    assert.equal(tokens.length, 1, "only a generation that had a cash token lists one");
    assert.equal(tokens[0]!.status, "skip");
  });

  it("holds ATS infrastructure to existence only, and skips the note on Sourcify with a reason", async () => {
    const { ctx } = setup();
    const rows = await checkContracts(ctx);
    assert.equal(find(rows, "ATS Factory").status, "pass");
    assert.equal(find(rows, /ATS note .* on Sourcify/).status, "skip");
  });

  it("reports a deliberately wrong address as ✗", async () => {
    const { inputs, world } = setup();
    inputs.record.contracts.MandateVerifier!.address = "0x000000000000000000000000000000000000dEaD";
    const rows = await checkContracts(makeContext(inputs, world));
    const row = find(rows, "MandateVerifier");
    assert.equal(row.status, "fail");
    assert.match(row.detail, /is not on the mirror node/);
  });

  it("fails a contract created before the event window", async () => {
    const { inputs, world, ctx } = setup();
    world.mirror.contracts.get(inputs.record.contracts.LoadLine!.address.toLowerCase()).created_timestamp = BEFORE_WINDOW;
    const row = find(await checkContracts(ctx), "LoadLine");
    assert.equal(row.status, "fail");
    assert.match(row.detail, /before the event window/);
  });

  it("fails a deleted contract, a mismatched id, a missing Sourcify match and a foreign deploy tx", async () => {
    const { inputs, world, ctx } = setup();
    const c = inputs.record.contracts;
    world.mirror.contracts.get(c.BerthMarket!.address.toLowerCase()).deleted = true;
    world.mirror.contracts.get(c.CouponScheduler!.address.toLowerCase()).contract_id = "0.0.1";
    world.verified.delete(c.CoverageOracle!.address.toLowerCase());
    world.mirror.results.get(c.MandateVerifierAdapter!.deployTx!.toLowerCase()).created_contract_ids = ["0.0.2"];
    const rows = await checkContracts(ctx);
    assert.match(find(rows, "BerthMarket").detail, /deleted/);
    assert.match(find(rows, "CouponScheduler").detail, /the mirror node calls it 0\.0\.1/);
    assert.match(find(rows, "CoverageOracle").detail, /Sourcify: not verified/);
    assert.match(find(rows, "MandateVerifierAdapter").detail, /did not create/);
    assert.equal(failures(rows).length, 4);
  });
});

describe("2 · the hero denial", () => {
  it("decodes the real revert to AccountIsBlocked(the blocked subject)", async () => {
    const { inputs, ctx } = setup();
    const rows = await checkDenial(ctx);
    assert.deepEqual(failures(rows), []);
    assert.match(find(rows, "revert names the blocked counterparty").detail, new RegExp(inputs.record.denial_artifact!.blockedCounterparty, "i"));
  });

  it("reports a planted transaction that succeeded as ✗", async () => {
    const { inputs, world, ctx } = setup();
    const planted = inputs.record.ats!.lifecycle!.find((s) => s.step.startsWith("transferByPartition"))!.tx;
    inputs.record.denial_artifact!.tx = planted;
    world.mirror.results.get(planted.toLowerCase()).error_message = "0x";
    const rows = await checkDenial(ctx);
    assert.equal(find(rows, "refused on-chain").status, "fail");
    assert.equal(find(rows, "revert names the blocked counterparty").status, "fail");
  });

  it("fails a revert that names someone else, or uses another error", async () => {
    const { inputs, world, ctx } = setup();
    const result = world.mirror.results.get(inputs.record.denial_artifact!.tx.toLowerCase());
    result.error_message = `0x796c1f0d${"0".repeat(24)}${"12".repeat(20)}`;
    assert.match(find(await checkDenial(ctx), "revert names the blocked counterparty").detail, /the record's blocked counterparty is/);
    result.error_message = `0xa4dedaeb`;
    assert.match(find(await checkDenial(ctx), "revert names the blocked counterparty").detail, /is not AccountIsBlocked/);
  });

  it("fails a denial that did not come from the issued note", async () => {
    const { inputs, world, ctx } = setup();
    world.mirror.results.get(inputs.record.denial_artifact!.tx.toLowerCase()).to = "0x000000000000000000000000000000000000beef";
    assert.equal(find(await checkDenial(ctx), "refused by the PLIM-A note itself").status, "fail");
  });

  it("identifies the error by selector: 0x796c1f0d is the one-argument form", () => {
    assert.equal(ACCOUNT_IS_BLOCKED, "AccountIsBlocked(address)");
    const decoded = decodeAccountIsBlocked(`0x796c1f0d${"0".repeat(24)}5da97170646574339edc856f5c04b99668e27f38`);
    assert.deepEqual(decoded, { ok: true, account: "0x5da97170646574339edc856f5c04b99668e27f38" });
  });
});

describe("3 · the ATS note", () => {
  it("reads the buyer from the record's own transfer and matches every balance", async () => {
    const { ctx } = setup();
    const rows = await checkAts(ctx);
    assert.deepEqual(failures(rows), []);
    assert.match(find(rows, "buyer holds 1000.00").detail, new RegExp(BUYER, "i"));
    assert.equal(find(rows, "the blocked counterparty received nothing").status, "pass");
  });

  it("fails a balance that differs from the record", async () => {
    const { inputs, world, ctx } = setup();
    for (const [key, value] of world.mirror.calls) {
      if (key.includes(inputs.record.deployer.slice(2).toLowerCase())) world.mirror.calls.set(key, value.replace(/dbba0$/, "dbba1"));
    }
    assert.match(find(await checkAts(ctx), /^issuer holds 9000\.00/).detail, /the record says 9000\.00/);
  });

  it("fails when anyone beyond issuer and buyer holds notes", async () => {
    const { world, ctx } = setup();
    for (const [key, value] of world.mirror.calls) if (value.endsWith("f4240")) world.mirror.calls.set(key, value.replace(/f4240$/, "f4241"));
    assert.equal(find(await checkAts(ctx), "nobody else holds any").status, "fail");
  });

  it("fails when the blocked counterparty holds notes after all", async () => {
    const { inputs, world, ctx } = setup();
    const blocked = inputs.record.denial_artifact!.blockedCounterparty.slice(2).toLowerCase();
    for (const [key] of world.mirror.calls) if (key.endsWith(blocked)) world.mirror.calls.set(key, `0x${"0".repeat(63)}1`);
    assert.equal(find(await checkAts(ctx), "the blocked counterparty received nothing").status, "fail");
  });

  it("skips the balances when the record states none", async () => {
    const { inputs, world } = setup();
    for (const step of inputs.record.ats!.lifecycle!) delete step.result;
    assert.equal(find(await checkAts(makeContext(inputs, world)), "balances match the record").status, "skip");
  });

  it("parses the record's statement of the result", () => {
    assert.deepEqual(parseStatedBalances("issuer 9000.00, buyer 1000.00"), { issuer: "9000.00", buyer: "1000.00" });
    assert.equal(parseStatedBalances("done"), null);
  });
});

describe("4 · the HTS cash leg", () => {
  it("passes a freeze key naming the controller with no admin key", async () => {
    const { ctx } = setup();
    const rows = await checkCashLeg(ctx);
    assert.deepEqual(failures(rows), []);
    assert.match(find(rows, "freeze key is the controller's contract key").detail, /contract key naming 0\.0\.\d+/);
    assert.equal(find(rows, /^superseded cash token/).status, "skip", "the replaced token is history, not a failure");
  });

  it("fails an admin key", async () => {
    const { inputs, world, ctx } = setup();
    world.mirror.tokens.get(inputs.record.cash_leg!.hederaId).admin_key = { _type: "ED25519", key: "aa" };
    assert.equal(find(await checkCashLeg(ctx), "no admin key").status, "fail");
  });

  it("fails a freeze key that is a plain key, or names another contract, or is missing", async () => {
    const { inputs, world, ctx } = setup();
    const token = world.mirror.tokens.get(inputs.record.cash_leg!.hederaId);
    token.freeze_key = { _type: "ECDSA_SECP256K1", key: "02".padEnd(66, "a") };
    assert.match(find(await checkCashLeg(ctx), "freeze key is the controller's contract key").detail, /not a contract key/);
    token.freeze_key = { _type: "ProtobufEncoded", key: encodeContractKey(1234n) };
    assert.match(find(await checkCashLeg(ctx), "freeze key is the controller's contract key").detail, /names 0\.0\.1234/);
    token.freeze_key = null;
    assert.match(find(await checkCashLeg(ctx), "freeze key is the controller's contract key").detail, /inert/);
  });

  it("fails an EVM address that does not match the token id", async () => {
    const { inputs, world } = setup();
    inputs.record.cash_leg!.evmAddress = "0x0000000000000000000000000000000000000001";
    assert.equal(find(await checkCashLeg(makeContext(inputs, world)), "token id and EVM address agree").status, "fail");
  });
});

describe("6 · the pull request", () => {
  it("passes an open pull request and names what it changes", async () => {
    const { ctx } = setup();
    const [row] = await checkGithub(ctx);
    assert.equal(row!.status, "pass");
    assert.match(row!.detail, /by RaYYeR220 into dev/);
  });

  it("passes a merged one under its true name, and fails a closed one", async () => {
    const { world, inputs } = setup();
    if (world.github === "unreachable") throw new Error("unexpected");
    world.github.body.merged_at = "2026-09-12T00:00:00Z";
    assert.match((await checkGithub(makeContext(inputs, world)))[0]!.title, /is merged$/);
    world.github.body.merged_at = null;
    world.github.body.state = "closed";
    assert.equal((await checkGithub(makeContext(inputs, world)))[0]!.status, "fail");
  });

  it("skips, with the reset time, when the unauthenticated limit is used up", async () => {
    const { world, inputs } = setup();
    world.github = { status: 403, body: {}, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1789200000" } };
    const [row] = await checkGithub(makeContext(inputs, world));
    assert.equal(row!.status, "skip");
    assert.match(row!.detail, /60 requests an hour is used up until \d\d:\d\d UTC/);
  });

  it("fails a pull request that does not exist, and skips when GitHub cannot be reached", async () => {
    const { world, inputs } = setup();
    world.github = { status: 404, body: {} };
    assert.equal((await checkGithub(makeContext(inputs, world)))[0]!.status, "fail");
    world.github = "unreachable";
    assert.equal((await checkGithub(makeContext(inputs, world)))[0]!.status, "skip");
  });
});

describe("7 · the Substreams package", () => {
  it("reports an unpublished package as skipped, not failed", async () => {
    const { ctx } = setup();
    const [row] = await checkSubstreams(ctx);
    assert.equal(row!.status, "skip");
    assert.match(row!.detail, /^not yet published/);
    const yaml = parseSubstreamsPackage(readFileSync(ctx.inputs.substreams!.manifestPath, "utf8"))!;
    assert.equal(row!.title, `${yaml.name} ${yaml.version} on substreams.dev`, "name and version come from substreams.yaml");
  });

  it("says the package file is missing from the checkout, rather than blaming the manifest", async () => {
    const { inputs, world } = setup();
    inputs.substreams = null;
    inputs.substreamsManifest = join(inputs.repoRoot, "packages", "substreams", "not-here.yaml");
    const [row] = await checkSubstreams(makeContext(inputs, world));
    assert.equal(row!.status, "skip");
    assert.match(row!.detail, /not-here[.]yaml is not in this checkout/);
  });

  it("passes once it is published, and skips when the registry is unreachable", async () => {
    const { world, inputs } = setup();
    world.substreams = 200;
    assert.equal((await checkSubstreams(makeContext(inputs, world)))[0]!.status, "pass");
    world.substreams = "unreachable";
    assert.equal((await checkSubstreams(makeContext(inputs, world)))[0]!.status, "skip");
  });
});
