import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalHash, vaultSetHash } from "../src/canonical.js";

// Computed by running packages/attestor's own canonicalHash (dist/src/canonical.js)
// and pinned here and in packages/substreams/scripts/check_notes.py.
const VECTORS: [string[], string][] = [
  [["0x2222222222222222222222222222222222222222", "0x1111111111111111111111111111111111111111"], "0x6b1424f15091427569834af02fc76da685fd016c97b58eee5a51ad244c437b7e"],
  [[], "0x4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
  [["0x4626aa11c0ffee0000000000000000000000a001", "0x4626bb22d1a5e10000000000000000000000b002"], "0x8cb16b9aa2a77c153459f3c453a4eb4bab65ee25fc09bceebf85fd63add9843a"],
  [["0x9d39a5de30e57443bff2a8307a4256c8797a3497", "0x56a76b428244a50513ec81e225a293d128fd581d"], "0x9101c3fddbe5dd0d7e6f770395b2c48f1f9bb895a0f3f4dcf2e8c8531783b448"],
];

test("vaultSetHash matches the attestor's pinned vectors", () => {
  for (const [vaults, expected] of VECTORS) assert.equal(vaultSetHash(vaults), expected, JSON.stringify(vaults));
});

test("vaultSetHash is order- and case-insensitive on input, like a sorted lowercase commitment", () => {
  const [vaults, expected] = VECTORS[0]!;
  assert.equal(vaultSetHash([...vaults].reverse().map((v) => v.toUpperCase().replace("0X", "0x"))), expected);
});

test("canonicalHash agrees with the attestor's implementation, called live", async () => {
  const attestor = (await import(new URL("../../../attestor/dist/src/canonical.js", import.meta.url).href)) as { canonicalHash: (v: unknown) => string };
  const samples: unknown[] = [[], ["0xabc"], { b: 1, a: [2, { d: 3n, c: "x" }] }, [...VECTORS[3]![0]].sort()];
  for (const s of samples) assert.equal(canonicalHash(s), attestor.canonicalHash(s));
});
