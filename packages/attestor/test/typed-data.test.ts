import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import { encodeFunctionData, keccak256, parseAbi, toHex, type Hex } from "viem";
import {
  ATTESTATION_TYPEHASH,
  ATTESTATION_TYPE_STRING,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  attestationDigest,
  attestorDomain,
  noteIdOf,
  type AttestationMessage,
} from "../src/eip712.js";

/**
 * The cross-check that should have existed from the start.
 *
 * Two implementations of the same digest were written by hand and never
 * compared, so they disagreed in five ways at once and nothing failed until
 * somebody tried to submit. Here the Solidity side gets the last word three
 * times over: the type string must still be in the contract's source, the
 * typehash is recomputed by `cast` rather than by the same library that signs,
 * and the digest itself is asked of the deployed contract.
 */

/**
 * Walk up for the repo rather than counting directories.
 *
 * This file runs from `dist/test/` once compiled and from `test/` in an editor,
 * so any fixed number of `..` segments is right in exactly one of the two. The
 * first version counted three and silently looked for `packages/packages`,
 * which failed as "not in this checkout" — a test that reports the contract is
 * missing when it is really the path that is wrong is worse than no test.
 */
function findUp(relative: string): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/**
 * `cast keccak`, without a shell.
 *
 * The type string contains spaces and parentheses, and a shell splits it into
 * several arguments, so cast would hash something else and the comparison would
 * fail for the wrong reason. Foundry installs into `~/.foundry/bin`, which is
 * often not on the PATH a test runner inherits, so that is tried as well.
 */
function castKeccak(input: string): string | null {
  const candidates = [
    "cast",
    join(homedir(), ".foundry", "bin", "cast.exe"),
    join(homedir(), ".foundry", "bin", "cast"),
  ];
  for (const bin of candidates) {
    try {
      return execFileSync(bin, ["keccak", input], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // Not here; try the next place.
    }
  }
  return null;
}

const ORACLE_SOURCE = findUp(join("packages", "contracts", "src", "CoverageOracle.sol"));
const RECORD = findUp(join("packages", "contracts", "deployments", "hedera-testnet.json"));

const ORACLE_ABI = parseAbi([
  "function hashAttestation((bytes32 noteId,uint64 coverageBps,uint64 asOfBlock,bytes32 vaultSetHash,bytes32 sourceHash,uint64 expiry,uint64 nonce) attestation) view returns (bytes32)",
  "function domainSeparator() view returns (bytes32)",
  "function ATTESTATION_TYPEHASH() view returns (bytes32)",
]);

interface Deployment {
  chainId: number;
  oracle: Hex;
  rpc: string;
}

function deployment(): Deployment | null {
  if (!RECORD) return null;
  const record = JSON.parse(readFileSync(RECORD, "utf8"));
  const oracle = record.contracts?.CoverageOracle?.address;
  return oracle ? { chainId: record.network.chainId, oracle, rpc: record.network.jsonRpc } : null;
}

/** A spread that exercises both ends of every field, not just plausible values. */
function fixtures(): AttestationMessage[] {
  const max = 2n ** 64n - 1n;
  return [
    {
      noteId: noteIdOf("PLIM-B"),
      coverageBps: 13_000n,
      asOfBlock: 21_480_311n,
      vaultSetHash: `0x${"11".repeat(32)}`,
      sourceHash: `0x${"22".repeat(32)}`,
      expiry: 1_789_200_000n,
      nonce: 1n,
    },
    {
      noteId: `0x${"00".repeat(32)}`,
      coverageBps: 0n,
      asOfBlock: 0n,
      vaultSetHash: `0x${"00".repeat(32)}`,
      sourceHash: `0x${"00".repeat(32)}`,
      expiry: 0n,
      nonce: 0n,
    },
    {
      noteId: `0x${"ff".repeat(32)}`,
      coverageBps: max,
      asOfBlock: max,
      vaultSetHash: `0x${"ff".repeat(32)}`,
      sourceHash: `0x${"ff".repeat(32)}`,
      expiry: max,
      nonce: max,
    },
  ];
}

let live: Deployment | null = null;
let online = false;

before(async () => {
  live = deployment();
  if (!live) return;
  online = await fetch(live.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(8000),
  })
    .then((response) => response.ok)
    .catch(() => false);
});

async function call(data: Hex): Promise<Hex> {
  const response = await fetch(live!.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: live!.oracle, data }, "latest"] }),
  });
  const body = (await response.json()) as { result?: Hex; error?: { message: string } };
  if (!body.result) throw new Error(body.error?.message ?? "eth_call failed");
  return body.result;
}

describe("the attestation type belongs to the contract", () => {
  it("is still in CoverageOracle.sol, verbatim", () => {
    assert.ok(ORACLE_SOURCE, "packages/contracts/src/CoverageOracle.sol is not in this checkout");
    const source = readFileSync(ORACLE_SOURCE, "utf8");
    assert.ok(
      source.includes(ATTESTATION_TYPE_STRING),
      "the contract's ATTESTATION_TYPEHASH string has changed; this service must follow it, not the other way round",
    );
  });

  it("hashes to the same typehash under cast as under viem", (t) => {
    const fromCast = castKeccak(ATTESTATION_TYPE_STRING);
    if (fromCast === null) {
      return t.skip("SKIPPED: foundry's cast was not found, so only viem computed the typehash");
    }
    assert.equal(fromCast.toLowerCase(), ATTESTATION_TYPEHASH.toLowerCase());
  });

  it("derives note ids the way the record says the market code does", () => {
    assert.equal(noteIdOf("PLIM-A"), "0x376011be372685b3e6d566a7ba172f8b8968ac7a6d56d23e67046e2fd24d253c");
    assert.equal(noteIdOf("PLIM-B"), "0xb51023289ff2160bbde35658811ef0a869f6e250819060253e6135bc9aaa2f48");
  });
});

describe("the deployed oracle agrees with this service", () => {
  it("reports the same typehash", async (t) => {
    if (!live || !online) return t.skip("SKIPPED: no deployment record, or the JSON-RPC relay is unreachable");
    const onChain = await call(encodeFunctionData({ abi: ORACLE_ABI, functionName: "ATTESTATION_TYPEHASH" }));
    assert.equal(onChain.toLowerCase(), ATTESTATION_TYPEHASH.toLowerCase());
  });

  it("builds the same domain separator", async (t) => {
    if (!live || !online) return t.skip("SKIPPED: no deployment record, or the JSON-RPC relay is unreachable");
    const onChain = await call(encodeFunctionData({ abi: ORACLE_ABI, functionName: "domainSeparator" }));
    // Rebuilt here from the domain this service signs under, rather than read
    // from viem's internals, so a wrong name or a missing verifyingContract shows up.
    const ours = keccak256(
      `0x${[
        keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")).slice(2),
        keccak256(toHex(DOMAIN_NAME)).slice(2),
        keccak256(toHex(DOMAIN_VERSION)).slice(2),
        live.chainId.toString(16).padStart(64, "0"),
        live.oracle.toLowerCase().slice(2).padStart(64, "0"),
      ].join("")}`,
    );
    assert.equal(ours.toLowerCase(), onChain.toLowerCase());
  });

  it("produces the same digest as hashAttestation, across the range of every field", async (t) => {
    if (!live || !online) return t.skip("SKIPPED: no deployment record, or the JSON-RPC relay is unreachable");
    const domain = attestorDomain({ chainId: live.chainId, verifyingContract: live.oracle });
    for (const message of fixtures()) {
      const onChain = await call(
        encodeFunctionData({ abi: ORACLE_ABI, functionName: "hashAttestation", args: [message] }),
      );
      assert.equal(
        attestationDigest(domain, message).toLowerCase(),
        onChain.toLowerCase(),
        `digest differs for note ${message.noteId} at ${message.coverageBps} bps`,
      );
    }
  });
});
