import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkHcs, shapeProblems } from "../src/checks/hcs.js";
import { loadInputs } from "../src/inputs.js";
import { checkLedger } from "../src/checks/ledger.js";
import type { CheckResult } from "../src/result.js";
import {
  SELLER,
  buildWorld,
  encodeTopicMessage,
  find,
  makeContext,
  paymentTransaction,
  realInputs,
  stubVerifyCharge,
} from "./fakes.js";

const failures = (rows: CheckResult[]) => rows.filter((r) => r.status === "fail");

function setup() {
  const inputs = realInputs();
  const world = buildWorld(inputs);
  return { inputs, world, ctx: makeContext(inputs, world) };
}

function sequences(inputs: ReturnType<typeof realInputs>) {
  const records = inputs.manifest.hcs.records;
  return {
    attested: records.find((r) => r.expect === "attested")!,
    asset: records.find((r) => r.expect === "asset-refusal")!,
    evidence: records.find((r) => r.expect === "evidence-refusal")!,
  };
}

describe("5 · x402 records on HCS", () => {
  it("passes the three canonical records, their verdicts, the payment and both absences", async () => {
    const { inputs, ctx } = setup();
    const rows = await checkHcs(ctx);
    assert.deepEqual(failures(rows), []);
    assert.equal(rows.length, 9, "shape, verdict and money for each of three records");
    const { attested, asset, evidence } = sequences(inputs);
    assert.match(find(rows, `#${attested.sequence} payment settled on the ledger`).detail, new RegExp(`→ ${SELLER}`));
    assert.match(find(rows, `#${asset.sequence} no transfer was made for it`).detail, /that an attestation does not claim/);
    assert.equal(find(rows, `#${evidence.sequence} no transfer was made for it`).status, "pass");
  });

  it("reports a planted payment as ✗, on the record and on the ledger", async () => {
    const { inputs, world } = setup();
    const { attested } = sequences(inputs);
    attested.payment = "0.0.7162784@1700000000.000000001";
    const rows = await checkHcs(makeContext(inputs, world));
    assert.match(find(rows, `#${attested.sequence} attestation`).detail, /the manifest names 0\.0\.7162784@1700000000/);
    assert.match(find(rows, `#${attested.sequence} payment settled on the ledger`).detail, /is not on the mirror node/);
  });

  it("fails a payment that is not one account paying another", async () => {
    const { inputs, world, ctx } = setup();
    const { attested } = sequences(inputs);
    const tx = world.mirror.transactions.values().next().value!;
    tx.transfers.push({ account: "0.0.5555555", amount: 1 });
    assert.match(find(await checkHcs(ctx), `#${attested.sequence} payment settled on the ledger`).detail, /not a single transfer/);
  });

  it("convicts a refusal when a credit in its window is claimed by no attestation", async () => {
    const { inputs, world, ctx } = setup();
    const { asset } = sequences(inputs);
    world.mirror.transfers.push(paymentTransaction("0.0.7162784@1789121910.000000001", "1789121913.000000000"));
    const row = find(await checkHcs(ctx), `#${asset.sequence} no transfer was made for it`);
    assert.equal(row.status, "fail");
    assert.match(row.detail, /no anchored attestation claims/);
  });

  it("fails an evidence refusal that publishes a figure, even a zero", async () => {
    const { inputs, world, ctx } = setup();
    const { evidence } = sequences(inputs);
    const message = world.mirror.topic.get(evidence.sequence)!;
    const record = JSON.parse(Buffer.from(message.message, "base64").toString("utf8"));
    world.mirror.topic.set(evidence.sequence, encodeTopicMessage(evidence.sequence, message.consensus_timestamp, { ...record, bps: 0 }));
    assert.match(find(await checkHcs(ctx), `#${evidence.sequence} evidence refusal`).detail, /publishes bps/);
  });

  it("fails a record that declares the retired v1 format", () => {
    const { inputs } = setup();
    const { asset } = sequences(inputs);
    const problems = shapeProblems({ p: "plimsoll/coverage", v: 1, d: "refused", fam: "asset", rsn: asset.reason, known: true, bps: 8700, chg: false }, asset);
    assert.ok(problems.some((p) => /declares v1/.test(p)));
  });

  it("hands verify-charge the published evidence a record names, resolved from the manifest", async () => {
    const { inputs, world } = setup();
    const { attested } = sequences(inputs);
    attested.evidence = "../../../attestor/evidence/hcs-25.json";
    const handed: Array<string | undefined> = [];
    const stub = stubVerifyCharge(inputs);
    const capturing: typeof stub = async (args) => {
      handed.push(args.evidence);
      return stub(args);
    };
    await checkHcs(makeContext(inputs, world, { verifyCharge: capturing }));
    assert.ok(handed.includes(resolve(dirname(inputs.manifestPath), attested.evidence)));
    assert.equal(handed.filter((path) => path !== undefined).length, 1, "only the record that names evidence is given any");
  });

  it("names only evidence files that exist in this checkout", () => {
    // A manifest pointing at a file the repository does not carry would turn a
    // verifiable record into an unverifiable one on a stranger's machine.
    const live = loadInputs();
    for (const record of live.manifest.hcs.records) {
      if (!record.evidence) continue;
      const path = resolve(dirname(live.manifestPath), record.evidence);
      assert.ok(existsSync(path), `#${record.sequence} names ${record.evidence}, which is not at ${path}`);
    }
  });

  it("fails when verify-charge finds a discrepancy, and when it cannot be loaded", async () => {
    const { inputs, world } = setup();
    const { asset } = sequences(inputs);
    const discrepant = makeContext(inputs, world, { verifyCharge: stubVerifyCharge(inputs, { [asset.sequence]: "DISCREPANCY" }) });
    assert.equal(find(await checkHcs(discrepant), `#${asset.sequence} verify-charge`).status, "fail");
    const missing = makeContext(inputs, world, { verifyCharge: null, verifyChargeError: "not built" });
    assert.match(find(await checkHcs(missing), `#${asset.sequence} verify-charge`).detail, /not built/);
  });

  it("skips the absence checks, with the reason, when no paid attestation names the seller", async () => {
    const { inputs, world } = setup();
    inputs.manifest.hcs.records = inputs.manifest.hcs.records.filter((r) => r.expect !== "attested");
    const rows = await checkHcs(makeContext(inputs, world));
    for (const row of rows.filter((r) => /no transfer was made/.test(r.title))) {
      assert.equal(row.status, "skip");
      assert.match(row.detail, /names the seller/);
    }
  });
});

describe("8 · the Ledger sequence", () => {
  it("verifies the real device signatures offline and every transaction against the proof", async () => {
    const { ctx } = setup();
    const rows = await checkLedger(ctx);
    assert.deepEqual(failures(rows), []);
    assert.equal(find(rows, "HALT approved on the device").status, "pass");
    assert.match(find(rows, "RESUME approved on the device").detail, /recovers to the device/);
    assert.match(find(rows, "LoadLine.resume reverted").detail, /^WrongAuthority\(/);
    assert.match(find(rows, "LoadLine.setThreshold reverted").detail, /^MandateValueMismatch\(0x3760…253c, 9000, 9500\)/);
  });

  it("proves the approved number is the number written", async () => {
    const { ctx } = setup();
    const row = find(await checkLedger(ctx), "only the approved threshold can be written");
    assert.equal(row.status, "pass");
    assert.match(row.detail, /90\.00% written against a 95\.00% mandate reverted MandateValueMismatch; the approved 95\.00% went through/);
  });

  it("skips a device refusal and the direct-spend entries the proof does not have yet", async () => {
    const { ctx } = setup();
    const rows = await checkLedger(ctx);
    assert.equal(find(rows, "RESUME refused on the device").status, "skip");
    assert.equal(find(rows, "a mandate spent directly at the verifier reverts").status, "skip");
    assert.equal(find(rows, "a mandate spent directly at the adapter reverts").status, "skip");
  });

  it("checks direct-spend entries once they exist: a revert passes, a success fails", async () => {
    const { inputs, world } = setup();
    const verifierTx = `0x${"aa".repeat(32)}`;
    const adapterTx = `0x${"bb".repeat(32)}`;
    inputs.deviceProof!.steps.push(
      { label: "direct to verifier", call: "MandateVerifier.consume", tx: verifierTx, mirror: "CONTRACT_REVERT_EXECUTED", revertData: "0x8c1b0f86", error: "NotGatekeeper" },
      { label: "direct to adapter", call: "MandateVerifierAdapter.authorize", tx: adapterTx, mirror: "CONTRACT_REVERT_EXECUTED", revertData: "0x" },
    );
    world.mirror.results.set(verifierTx, { result: "CONTRACT_REVERT_EXECUTED", to: inputs.record.contracts.MandateVerifier!.address.toLowerCase(), error_message: "0x8c1b0f86" });
    world.mirror.results.set(adapterTx, { result: "SUCCESS", to: inputs.record.contracts.MandateVerifierAdapter!.address.toLowerCase(), error_message: "0x" });
    const rows = await checkLedger(makeContext(inputs, world));
    assert.ok(!rows.some((r) => /spent directly at the verifier/.test(r.title)), "no skip once the entry exists");
    const adapter = find(rows, "MandateVerifierAdapter.authorize reverted");
    assert.equal(adapter.status, "fail");
    assert.match(adapter.detail, /must revert/);
  });

  it("fails a proof made for a different verifier", async () => {
    const { inputs, world } = setup();
    inputs.deviceProof!.verifier = "0x000000000000000000000000000000000000dEaD";
    assert.match(find(await checkLedger(makeContext(inputs, world)), "proof is for the deployed verifier and load line").detail, /predates the current deployment/);
  });

  it("fails a tampered signature", async () => {
    const { inputs, world } = setup();
    const halt = inputs.deviceProof!.steps.find((s) => s.action === "HALT")!;
    halt.mandateText = halt.mandateText!.replace("COVERAGE: 91.00%", "COVERAGE: 99.00%");
    assert.match(find(await checkLedger(makeContext(inputs, world)), "HALT approved on the device").detail, /not the device/);
  });

  it("fails a transaction that ended otherwise than the proof says, or hit another contract", async () => {
    const { inputs, world, ctx } = setup();
    const halt = inputs.deviceProof!.steps.find((s) => s.call === "LoadLine.halt")!;
    world.mirror.results.get(halt.tx!.toLowerCase()).result = "CONTRACT_REVERT_EXECUTED";
    assert.match(find(await checkLedger(ctx), "LoadLine.halt accepted").detail, /the proof says SUCCESS/);
    world.mirror.results.get(halt.tx!.toLowerCase()).result = "SUCCESS";
    world.mirror.results.get(halt.tx!.toLowerCase()).to = "0x000000000000000000000000000000000000beef";
    assert.match(find(await checkLedger(ctx), "LoadLine.halt accepted").detail, /not the deployed LoadLine/);
  });

  it("fails a proof whose adapter is not the deployed one", async () => {
    const { inputs, world } = setup();
    (inputs.deviceProof as { adapter?: string }).adapter = "0x000000000000000000000000000000000000dEaD";
    const row = find(await checkLedger(makeContext(inputs, world)), "proof is for the deployed verifier and load line");
    assert.equal(row.status, "fail");
    assert.match(row.detail, /adapter 0x0+dead/i);
  });

  it("fails a step the proof says went somewhere other than the deployed contract", async () => {
    const { inputs, world } = setup();
    const halt = inputs.deviceProof!.steps.find((s) => s.call === "LoadLine.halt")! as { to?: string };
    halt.to = "0x000000000000000000000000000000000000bEEF";
    assert.match(find(await checkLedger(makeContext(inputs, world)), "LoadLine.halt accepted").detail, /the proof says it went to/);
  });

  it("skips entirely when the record points at no device proof", async () => {
    const { inputs, world } = setup();
    delete inputs.record.device_proof;
    const rows = await checkLedger(makeContext(inputs, world));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "skip");
  });
});
