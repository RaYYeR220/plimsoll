import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadVerifyCharge, type VerifyChargeFn } from "../src/attestor.js";
import { checkContracts } from "../src/checks/contracts.js";
import { checkDenial } from "../src/checks/denial.js";
import { checkHcs } from "../src/checks/hcs.js";
import type { Context } from "../src/context.js";
import { PUBLIC_INTERVALS_MS, createThrottledFetch, publicEndpoints } from "../src/http.js";
import { HttpMirror } from "../src/mirror.js";
import { type CheckResult, tally } from "../src/result.js";
import { runSections } from "../src/run.js";
import { loadInputs } from "../src/inputs.js";
import { find } from "./fakes.js";

/** The live suite checks the record as it is now, not the frozen fixture the unit tests use. */
const liveInputs = () => structuredClone(loadInputs());

/**
 * Against the real public endpoints. Nothing here needs a credential; it needs
 * only a network, and says so loudly when there is none.
 */

const originalFetch = globalThis.fetch;
let online = false;
let verifyCharge: VerifyChargeFn | null = null;

before(async () => {
  const inputs = liveInputs();
  const mirror = publicEndpoints(inputs.record.network.mirror).mirror;
  online = await originalFetch(`${mirror}/api/v1/network/nodes?limit=1`, { signal: AbortSignal.timeout(8000) })
    .then((response) => response.ok)
    .catch(() => false);
  verifyCharge = await loadVerifyCharge().catch(() => null);
});

after(() => {
  globalThis.fetch = originalFetch;
});

function liveContext(inputs = liveInputs()): Context {
  const http = createThrottledFetch({ intervalsMs: PUBLIC_INTERVALS_MS });
  globalThis.fetch = http;
  const endpoints = publicEndpoints(inputs.record.network.mirror);
  return {
    inputs,
    record: inputs.record,
    manifest: inputs.manifest,
    mirror: new HttpMirror(endpoints.mirror, http),
    http,
    endpoints,
    verifyCharge,
    verifyChargeError: verifyCharge ? undefined : "the attestor's verify-charge is not built",
    windowStart: inputs.windowStart,
    explorer: inputs.record.network.explorer,
  };
}

const offline = () => (online ? false : "SKIPPED: the public mirror node is unreachable from here");

describe("live negative control: wrong answers must come back ✗", () => {
  it("reports a deliberately wrong contract address as ✗", { skip: false }, async (t) => {
    if (offline()) return t.skip(String(offline()));
    const inputs = liveInputs();
    inputs.record.contracts = {
      MandateVerifier: { ...inputs.record.contracts.MandateVerifier!, address: "0x000000000000000000000000000000000000dEaD" },
    };
    delete inputs.record.ats;
    delete inputs.record.superseded;
    const row = find(await checkContracts(liveContext(inputs)), "MandateVerifier");
    assert.equal(row.status, "fail");
    assert.match(row.detail, /is not on the mirror node/);
  });

  it("reports a planted denial transaction that actually succeeded as ✗", async (t) => {
    if (offline()) return t.skip(String(offline()));
    const inputs = liveInputs();
    inputs.record.denial_artifact!.tx = inputs.record.ats!.lifecycle!.find((s) => s.step.startsWith("transferByPartition"))!.tx;
    const rows = await checkDenial(liveContext(inputs));
    assert.equal(find(rows, "refused on-chain").status, "fail");
    assert.match(find(rows, "refused on-chain").detail, /ended SUCCESS/);
  });

  it("reports a planted payment id as ✗", async (t) => {
    if (offline()) return t.skip(String(offline()));
    const inputs = liveInputs();
    const attested = inputs.manifest.hcs.records.find((r) => r.expect === "attested")!;
    attested.payment = "0.0.7162784@1700000000.000000001";
    inputs.manifest.hcs.records = [attested];
    const rows = await checkHcs(liveContext(inputs));
    assert.equal(find(rows, `#${attested.sequence} payment settled on the ledger`).status, "fail");
    assert.equal(find(rows, `#${attested.sequence} attestation`).status, "fail");
  });
});

describe("live: the real deployment", () => {
  it("verifies with no ✗", async (t) => {
    if (offline()) return t.skip(String(offline()));
    const ctx = liveContext();
    const sections = [];
    for await (const section of runSections(ctx)) sections.push(section);
    const failed: CheckResult[] = sections.flatMap((s) => s.results).filter((r) => r.status === "fail");
    const counts = tally(sections);
    t.diagnostic(`${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`);
    assert.deepEqual(failed.map((r) => `${r.title}: ${r.detail}`), []);
  });
});
