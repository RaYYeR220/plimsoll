import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HCS_MESSAGE_LIMIT, buildAnchorRecord, byteLength } from "../src/anchor.js";
import { attest } from "../src/attest.js";
import { FixtureCoverageSource, type FixtureNote } from "../src/coverage/index.js";
import { createAttestorSigner } from "../src/eip712.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { canonicalHash, canonicalJson } from "../src/canonical.js";
import { createUaid, base58Encode, canonicalAgentJson, agentIdHash } from "../src/hcs14.js";
import { TEST_ATTESTOR_KEY } from "./helpers.js";

const signer = createAttestorSigner(TEST_ATTESTOR_KEY);
const source = new FixtureCoverageSource();

describe("HCS anchoring stays inside one consensus message", () => {
  it("keeps every fixture verdict under 1024 bytes", async () => {
    for (const noteId of source.knownNotes()) {
      const verdict = await attest(noteId, { source, signer });
      const record = buildAnchorRecord({
        requestId: "0123456789abcdef",
        verdict,
        charge: verdict.decision === "attested" ? { transactionId: "0.0.7162784@1788800815.386309402" } : null,
        maxPositions: DEFAULT_POLICY.maxAnchoredPositions,
      });
      const size = byteLength(record);
      assert.ok(
        size <= HCS_MESSAGE_LIMIT,
        `${noteId} anchors to ${size} bytes, over the ${HCS_MESSAGE_LIMIT} byte limit; ` +
          `the SDK would chunk it into separate mirror messages`,
      );
    }
  });

  it("carries the full recomputable input set for an attestation", async () => {
    const verdict = await attest("NOTE-ALPHA", { source, signer });
    const record = buildAnchorRecord({
      requestId: "0123456789abcdef",
      verdict,
      charge: { transactionId: "0.0.7162784@1788800815.386309402" },
    });

    assert.equal(record.full, 1, "positions must be inline for a two-vault note");
    assert.equal(record.pos!.length, 2);
    for (const [vault, assets, shares, decimals] of record.pos!) {
      assert.match(vault, /^[0-9a-f]{40}$/, "the vault address must be complete");
      assert.match(assets, /^\d+$/, "the raw convertToAssets reading must be present");
      assert.match(shares, /^\d+$/, "the share balance must be present");
      assert.ok(decimals > 0);
    }
    assert.equal(record.blk, "21480311");
    assert.equal(record.floor, 10000);
    assert.equal(record.bps, 13000);
    assert.equal(record.pol, DEFAULT_POLICY.id);
    assert.equal(record.ss, "fixture:plimsoll-vault-flows-v0.3.1");
    assert.equal(record.chg, true);
    assert.equal(record.tx, "0.0.7162784@1788800815.386309402");
    assert.equal(record.srch, verdict.sourceHash, "the full source hash, not a prefix");
    assert.equal(record.sig, verdict.signature, "the full signature, so the record self-authenticates");
  });

  it("records a refusal as an explicit non-charge", async () => {
    const verdict = await attest("NOTE-BRAVO", { source, signer });
    const record = buildAnchorRecord({ requestId: "0123456789abcdef", verdict, charge: null });

    assert.equal(record.d, "refused");
    assert.equal(record.fam, "asset");
    assert.equal(record.rsn, "coverage_below_floor");
    assert.equal(record.known, true);
    assert.equal(record.chg, false);
    assert.equal(record.tx, undefined, "no charge means no transaction id in the record");
  });

  it("marks an evidence refusal as carrying no ratio", async () => {
    const verdict = await attest("NOTE-INDIA", { source, signer });
    const record = buildAnchorRecord({ requestId: "0123456789abcdef", verdict, charge: null });
    assert.equal(record.fam, "evidence");
    assert.equal(record.known, false);
    assert.equal(record.bps, 0);
  });

  it("degrades to a digest rather than chunking when a note has too many legs", async () => {
    const many: FixtureNote = {
      noteId: "NOTE-MANY",
      holder: "0x00000000000000000000000000000000006f1a55",
      nominatedVaults: [],
      notesOutstanding: "100000",
      parPerNote: "1000000",
      unitDecimals: 6,
      asOfBlock: "42",
      observedAt: -5,
      sourceSet: { kind: "fixture", dataset: "many", endpoints: [] },
      positions: [],
    };
    for (let i = 0; i < 12; i++) {
      const vault = `0x4626${i.toString(16).padStart(2, "0")}${"cd".repeat(17)}`;
      many.nominatedVaults.push(vault);
      many.positions.push({
        vault,
        shares: "10000000000",
        assets: "11000000000",
        assetDecimals: 6,
        blockNumber: "42",
      });
    }

    const verdict = await attest("NOTE-MANY", {
      source: new FixtureCoverageSource({}, [many]),
      signer,
    });
    const record = buildAnchorRecord({
      requestId: "0123456789abcdef",
      verdict,
      charge: null,
      maxPositions: DEFAULT_POLICY.maxAnchoredPositions,
    });

    assert.equal(record.full, 0, "the record must declare that positions are not inline");
    assert.equal(record.pos, undefined);
    assert.ok(byteLength(record) <= HCS_MESSAGE_LIMIT);
    assert.equal(record.srch, verdict.sourceHash, "the evidence is still committed to by hash");
  });
});

describe("canonical encoding", () => {
  it("orders keys so two parties hash the same bytes", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ a: 2, b: 1 }), '{"a":2,"b":1}');
    assert.equal(canonicalHash({ b: 1, a: 2 }), canonicalHash({ a: 2, b: 1 }));
  });

  it("keeps array order, because a vault set is ordered before it gets here", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  it("renders bigints exactly rather than through Number", () => {
    const huge = 123456789012345678901234567890n;
    assert.equal(canonicalJson({ v: huge }), '{"v":"123456789012345678901234567890"}');
  });
});

describe("HCS-14 identifiers", () => {
  it("hashes skills first, then the remaining keys in order", () => {
    const json = canonicalAgentJson({
      registry: "Plimsoll",
      name: "Plimsoll Coverage Attestor",
      version: "0.1.0",
      protocol: "X402",
      nativeId: "hedera:testnet:0.0.10448897",
      skills: [17, 0],
    });
    assert.ok(json.startsWith('{"skills":[0,17]'), "skills come first and are sorted ascending");
    assert.match(json, /"protocol":"x402"/, "protocol is lowercased");
    assert.match(json, /"registry":"plimsoll"/, "registry is lowercased");
    // The exact bytes are asserted so a third party can reproduce our digest.
    assert.equal(
      json,
      '{"skills":[0,17],"name":"Plimsoll Coverage Attestor","nativeId":"hedera:testnet:0.0.10448897",' +
        '"protocol":"x402","registry":"plimsoll","version":"0.1.0"}',
    );
  });

  it("produces a deterministic base58 SHA-384 with no truncation", () => {
    const agent = {
      registry: "plimsoll",
      name: "Plimsoll Coverage Attestor",
      version: "0.1.0",
      protocol: "x402",
      nativeId: "hedera:testnet:0.0.10448897",
      skills: [0],
    };
    const first = agentIdHash(agent);
    assert.equal(first, agentIdHash({ ...agent, skills: [0] }));
    // 48 bytes of SHA-384 base58-encode to 64-66 characters.
    assert.ok(first.length >= 64 && first.length <= 66, `unexpected length ${first.length}`);
    assert.match(first, /^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("changes the identifier when any input field changes", () => {
    const base = {
      registry: "plimsoll",
      name: "Plimsoll Coverage Attestor",
      version: "0.1.0",
      protocol: "x402",
      nativeId: "hedera:testnet:0.0.10448897",
      skills: [0],
    };
    assert.notEqual(agentIdHash(base), agentIdHash({ ...base, version: "0.1.1" }));
    assert.notEqual(agentIdHash(base), agentIdHash({ ...base, skills: [0, 1] }));
  });

  it("formats the UAID with parameters in the normative order", () => {
    const uaid = createUaid({
      registry: "plimsoll",
      name: "Plimsoll Coverage Attestor",
      version: "0.1.0",
      protocol: "x402",
      nativeId: "hedera:testnet:0.0.10448897",
      skills: [0],
    });
    const [scheme, method, rest] = uaid.split(":", 3);
    assert.equal(scheme, "uaid");
    assert.equal(method, "aid");
    assert.ok(rest);
    const params = uaid.split(";").slice(1).map((p) => p.split("=")[0]);
    assert.deepEqual(params, ["uid", "registry", "proto", "nativeId"]);
  });

  it("encodes base58 with leading zeros preserved", () => {
    assert.equal(base58Encode(new Uint8Array([0, 0, 1])), "112");
    assert.equal(base58Encode(new Uint8Array([0])), "1");
    assert.equal(base58Encode(new Uint8Array([57])), "z");
    assert.equal(base58Encode(new Uint8Array([58])), "21");
  });
});
