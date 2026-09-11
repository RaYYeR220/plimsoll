#!/usr/bin/env node
// The vault-set hash a note must be registered with, computed by the attestor's own code.
//
//   node script/vault-set-hash.mjs 0xVaultA 0xVaultB ...
//
// CoverageOracle never computes this value; it only compares the hash it was registered with
// against the hash each attestation commits to. So there must be exactly one definition, and it
// lives in packages/attestor: canonicalHash over the lowercase, sorted address list (canonical.ts,
// as used at attest.ts when building evidence). Anything else - a keccak of an ABI encoding, a
// hash of a descriptive string - registers a set no attestation can ever match, and the note reads
// Unproven/VaultSetChanged forever. Build the attestor first: npm --prefix ../attestor run build.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { canonicalHash } = await import(
  pathToFileURL(join(here, "..", "..", "attestor", "dist", "src", "canonical.js")).href
);

const vaults = process.argv.slice(2);
if (vaults.length === 0 || vaults.some((v) => !/^0x[0-9a-fA-F]{40}$/.test(v))) {
  console.error("usage: node script/vault-set-hash.mjs <vault address> [<vault address> ...]");
  process.exit(2);
}

const normalised = [...new Set(vaults.map((v) => v.toLowerCase()))].sort();
console.log(`vaults        ${normalised.join(" ")}`);
console.log(`VAULT_SET_HASH=${canonicalHash(normalised)}`);
