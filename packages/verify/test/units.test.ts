import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeRevert, formatRevert, loadErrorAbi } from "../src/errors.js";
import { createThrottledFetch, publicEndpoints } from "../src/http.js";
import { InputError, loadInputs, parseSubstreamsPackage } from "../src/inputs.js";
import { toMirrorTransactionId } from "../src/mirror.js";
import { decodeContractKey, describeMirrorKey, encodeContractKey } from "../src/protobufKey.js";
import { realInputs } from "./fakes.js";

describe("contract keys", () => {
  it("decodes the cash token's freeze key to CashLegController", () => {
    assert.deepEqual(decodeContractKey("0a0518afa6ff04"), { kind: "contract", id: "0.0.10474287" });
  });

  it("decodes the key the record quotes for the superseded controller", () => {
    assert.equal(decodeContractKey("0a0518acf6fd04")?.id, "0.0.10451756");
  });

  it("round-trips both contract-key forms", () => {
    assert.deepEqual(decodeContractKey(encodeContractKey(10474287n)), { kind: "contract", id: "0.0.10474287" });
    assert.deepEqual(decodeContractKey(encodeContractKey(42n, 8)), { kind: "delegatable-contract", id: "0.0.42" });
  });

  it("refuses keys that are not contract keys", () => {
    const ed25519 = `1220${"11".repeat(32)}`;
    assert.equal(decodeContractKey(ed25519), null);
    assert.equal(decodeContractKey(""), null);
    assert.equal(decodeContractKey("0a0518afa6ff"), null, "truncated");
    assert.equal(decodeContractKey("0a0518afa6ff0400"), null, "trailing bytes");
  });

  it("treats a plain ECDSA key as present but not a contract key", () => {
    const described = describeMirrorKey({ _type: "ECDSA_SECP256K1", key: "02".padEnd(66, "a") });
    assert.equal(described.present, true);
    assert.equal(described.contract, null);
    assert.equal(describeMirrorKey(null).present, false);
  });
});

describe("the polite fetch", () => {
  it("spaces requests to one host without delaying another", async () => {
    // A fixed clock and a recording sleep put the schedule itself under test.
    // Measured wall-clock gaps shrink whenever a loaded machine starts the
    // first request late, even though every slot was scheduled correctly.
    const waits: number[] = [];
    const fetcher = createThrottledFetch({
      intervalsMs: { "a.test": 60, "b.test": 0 },
      now: () => 1_000,
      sleep: async (ms) => void waits.push(ms),
      baseFetch: (async () => new Response("{}")) as typeof fetch,
    });
    await Promise.all([
      fetcher("http://a.test/1"),
      fetcher("http://a.test/2"),
      fetcher("http://a.test/3"),
      fetcher("http://b.test/1"),
    ]);
    assert.deepEqual(waits.sort((x, y) => x - y), [60, 120], "a.test is spaced 60 ms apart; b.test waits for nothing");
    assert.equal(fetcher.requests(), 4);
  });

  it("backs off on 429, honouring Retry-After", async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetcher = createThrottledFetch({
      defaultIntervalMs: 0,
      sleep: async (ms) => void waits.push(ms),
      baseFetch: (async () =>
        ++calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : new Response("ok")) as typeof fetch,
    });
    const response = await fetcher("http://x.test/");
    assert.equal(response.status, 200);
    assert.ok(waits.includes(2000), `waited ${waits}`);
    assert.equal(fetcher.requests(), 2);
  });

  it("gives up after its retries and returns the last answer", async () => {
    const fetcher = createThrottledFetch({
      defaultIntervalMs: 0,
      retries: 2,
      sleep: async () => {},
      baseFetch: (async () => new Response("", { status: 503 })) as typeof fetch,
    });
    assert.equal((await fetcher("http://x.test/")).status, 503);
    assert.equal(fetcher.requests(), 3);
  });

  it("never retries an answer, only a failure to get one", async () => {
    const fetcher = createThrottledFetch({
      defaultIntervalMs: 0,
      sleep: async () => {},
      baseFetch: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    assert.equal((await fetcher("http://x.test/")).status, 404);
    assert.equal(fetcher.requests(), 1);
  });

  it("retries a dropped connection", async () => {
    let calls = 0;
    const fetcher = createThrottledFetch({
      defaultIntervalMs: 0,
      sleep: async () => {},
      baseFetch: (async () => {
        if (++calls < 3) throw new TypeError("fetch failed");
        return new Response("ok");
      }) as typeof fetch,
    });
    assert.equal((await fetcher("http://x.test/")).status, 200);
  });

  it("takes the mirror node from the record and strips the API path", () => {
    assert.equal(publicEndpoints("https://testnet.mirrornode.hedera.com/api/v1/").mirror, "https://testnet.mirrornode.hedera.com");
  });
});

describe("inputs", () => {
  it("reads the real deployment record, manifest and device proof", () => {
    const inputs = loadInputs();
    assert.ok(inputs.record.contracts.MandateVerifier, "the record names a MandateVerifier");
    assert.equal(inputs.windowStart, Date.parse("2026-09-04T16:00:00Z") / 1000, "12:00 ET on 4 September is 16:00 UTC");
    assert.ok(inputs.deviceProof, "the record's device_proof pointer resolves");
    // A checkout may not carry the substreams package; the verifier then says so.
    if (inputs.substreamsManifest && existsSync(inputs.substreamsManifest)) {
      assert.equal(inputs.substreams?.name, "plimsoll_erc4626");
      assert.match(inputs.substreams?.version ?? "", /^v[0-9]+[.][0-9]+[.][0-9]+$/, "read from substreams.yaml");
    } else {
      assert.equal(inputs.substreams, null);
    }
  });

  it("owns no address or id that belongs to the deployment record", () => {
    // Read, never hardcode: the manifest must not shadow anything the live record says.
    const inputs = loadInputs();
    const manifestText = readFileSync(inputs.manifestPath, "utf8").toLowerCase();
    const recordIds = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === "string" && (/^0x[0-9a-f]{40}$/i.test(value) || /^0\.0\.\d{5,}$/.test(value))) {
        recordIds.add(value.toLowerCase());
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(collect);
      }
    };
    collect(inputs.record);
    const shadowed = [...recordIds].filter((id) => manifestText.includes(id));
    assert.deepEqual(shadowed, [], "the manifest repeats values from the record");
  });

  it("parses a substreams.yaml package block", () => {
    assert.deepEqual(parseSubstreamsPackage("specVersion: v0.1.0\npackage:\n  name: demo_pkg\n  version: v1.2.3\n\nnetwork: x\n"), {
      name: "demo_pkg",
      version: "v1.2.3",
    });
    assert.equal(parseSubstreamsPackage("package:\n  name: only_a_name\n"), null);
  });

  it("refuses to run without a deployment record", () => {
    assert.throws(() => loadInputs({ recordPath: "does/not/exist.json" }), InputError);
  });

  it("converts a transaction id to the mirror-node form", () => {
    assert.equal(toMirrorTransactionId("0.0.7162784@1789121899.540907773"), "0.0.7162784-1789121899-540907773");
  });
});

describe("custom errors, read from the Solidity sources", () => {
  const inputs = realInputs();
  const abi = loadErrorAbi(inputs.contractsSource);

  it("decodes the wrong-key resume as WrongAuthority naming the device", () => {
    const step = inputs.deviceProof!.steps.find((s) => s.call === "LoadLine.resume" && s.revertData)!;
    const decoded = decodeRevert(abi, step.revertData);
    assert.equal(decoded?.name, "WrongAuthority");
    assert.equal(String(decoded?.args[1]).toLowerCase(), inputs.deviceProof!.device.address.toLowerCase());
  });

  it("decodes the mismatched threshold as MandateValueMismatch(note, 9000, 9500)", () => {
    const step = inputs.deviceProof!.steps.find((s) => s.call === "LoadLine.setThreshold" && s.revertData)!;
    const decoded = decodeRevert(abi, step.revertData)!;
    assert.equal(decoded.name, "MandateValueMismatch");
    const [subject, written, mandated] = decoded.args as [string, bigint, number];
    assert.equal(subject, (inputs.record as { note_under_management?: { noteId?: string } }).note_under_management?.noteId);
    assert.equal(Number(written), 9000);
    assert.equal(Number(mandated), 9500);
    assert.match(formatRevert(decoded), /^MandateValueMismatch\(0x3760…253c, 9000, 9500\)$/);
  });

  it("returns nothing rather than guessing for bytes it cannot decode", () => {
    assert.equal(decodeRevert(abi, "0xdeadbeef"), null);
    assert.equal(decodeRevert(abi, "0x"), null);
  });
});
