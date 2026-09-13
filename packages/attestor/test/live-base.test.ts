import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attest } from "../src/attest.js";
import { canonicalHash } from "../src/canonical.js";
import {
  LiveCoverageSource,
  MirrorLiabilityReader,
  RpcPositionWitness,
  VAULT_ABI,
  callAt,
  httpJsonRpc,
  pinBlock,
  type JsonRpc,
  type LiabilityReader,
  type LiabilityReading,
  type LiveNoteDefinition,
  type NoteRegistry,
  type PinnedBlock,
} from "../src/coverage/index.js";
import { noteIdOf } from "../src/coverage/hedera.js";
import { TEST_ATTESTOR_ADDRESS, skipMessage } from "./helpers.js";

/**
 * The live source against Base mainnet and Hedera testnet, read-only.
 *
 * The issuer's own address is not funded yet, so the positions valued here
 * belong to public holders of the same vaults. Their liabilities are stubbed
 * with that holder as issuer; everything on the Base side is real, pinned to a
 * block hash and corroborated by a second provider. The last two tests read the
 * real PLIM-A from Hedera.
 *
 * Public holders move their money. If one of them exits, pick another holder
 * of that vault and update the table; the assertion is only that the position
 * exists at the pinned block.
 */

const enabled = (process.env.LIVE_BASE ?? "").trim() === "1";
const skip = enabled ? false : skipMessage("Base and Hedera reads", ["LIVE_BASE=1"]);

// Two independent providers that both serve pinned historical reads without
// throttling a handful of calls. publicnode answers 403 to archive reads, and
// the sequencer's own endpoint rate-limits bursts, so neither is the default
// here; both were checked against the same pinned block before being chosen.
const BASE_RPC = process.env.BASE_RPC_URL?.trim() || "https://base.gateway.tenderly.co";
const WITNESS_RPC = process.env.BASE_WITNESS_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io";

const MORPHO = "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61";
const AAVE = "0xc768c589647798a6ee01a91fde98ef2ed046dbd6";
const SPARK = "0x3128a0f7f0ea68e7b7c9b00afa7e41045828e858";
const MOONWELL = "0xa0e430870c4604ccfc7b38ca7845b1ff653d0ff1";

/**
 * Candidate public holders per vault. Positions move, so the holder actually
 * used is whichever of these still holds the vault at the pinned block; if none
 * does, the test says so rather than asserting against an empty position.
 */
const PUBLIC_HOLDERS: Array<[string, string[]]> = [
  [MORPHO, ["0x4b1ab1e528354dc9730902256f6af83d2d6d935b", "0x93904eec579e5bf7a57c2dd4afbea0f1c3e6a1d1"]],
  [AAVE, ["0xba1333333333a1ba1108e8412f11850a5c319ba9", "0x47034ffbfa6e55888d544b5592220f580882cbf8"]],
  [SPARK, ["0x9f82c67738a440cebab48c6206714500e8bc0b91", "0xce80a38c46519420616822761761719e94e2a328"]],
];

/** The first candidate with a balance at `block`, or null if none has one. */
async function holderOf(rpc: JsonRpc, block: PinnedBlock, vault: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const shares = await callAt<bigint>(rpc, block, {
      address: vault,
      abi: VAULT_ABI,
      functionName: "balanceOf",
      args: [candidate],
    });
    if (shares > 0n) return candidate;
  }
  return null;
}
const WETH_HOLDER = "0x9516e74e57cbdbe4059558cf53cfd9903ad6ac94";

const HEDERA: NoteRegistry = {
  chain: "hedera-testnet",
  chainId: 296,
  mirror: "https://testnet.mirrornode.hedera.com/api/v1",
  note: "0xe2bf359650fbacc7d4801336f8c1fe7061ad6387",
  loadLine: "0xf867b6f41b21e9d72f327f867ae898620d022c80",
  coverageOracle: "0xce13de224ed918d7b8b2717492849e0a82648ca3",
};

/** A stand-in signer: these tests are about the readings, not the signature. */
const signer = {
  address: TEST_ATTESTOR_ADDRESS as `0x${string}`,
  domain: {
    name: "Plimsoll CoverageOracle",
    version: "1",
    chainId: 296,
    verifyingContract: "0x0000000000000000000000000000000000c0ffee" as `0x${string}`,
  },
  signAttestation: async () => `0x${"11".repeat(65)}` as `0x${string}`,
  signRefusal: async () => `0x${"11".repeat(65)}` as `0x${string}`,
};

function testNote(market: string, vaults: string[]): LiveNoteDefinition {
  return {
    noteId: noteIdOf(market),
    market,
    network: "base",
    chainId: 8453,
    vaults: [...vaults].sort(),
    vaultSetHash: null,
    negativeControl: false,
    status: "test",
    registry: HEDERA,
  };
}

/** Liabilities with a chosen issuer: $1 against a 100% line, read at "now". */
function stubbed(issuer: string, over: Partial<LiabilityReading> = {}): LiabilityReader {
  return {
    read: async (market) => ({
      chain: "hedera-testnet",
      chainId: 296,
      endpoint: "stub",
      block: "0",
      blockHash: "0x",
      observedAt: Math.floor(Date.now() / 1000),
      market,
      noteId: noteIdOf(market),
      note: HEDERA.note,
      totalSupply: "100",
      noteDecimals: 2,
      nominalValue: "100",
      nominalValueDecimals: 2,
      currency: "USD",
      issuer,
      loadLine: HEDERA.loadLine,
      thresholdBps: 10_000,
      coverageOracle: HEDERA.coverageOracle ?? null,
      // The set the test note nominates; a note with no registration to commit
      // to is refused, which is the subject of its own test elsewhere.
      registeredVaultSetHash: canonicalHash([MORPHO, AAVE, SPARK].sort()),
      ...over,
    }),
  };
}

describe("live: Base mainnet positions of public holders", () => {
  for (const [vault, candidates] of PUBLIC_HOLDERS) {
    it(`values a public holder of ${vault}, pinned and corroborated`, { skip }, async (t) => {
      const rpc = httpJsonRpc(BASE_RPC);
      const at = await pinBlock(rpc, (await rpc.request<string>("eth_blockNumber", []).then(BigInt)) - 3n);
      const holder = await holderOf(rpc, at, vault, candidates);
      if (!holder) {
        t.skip(`none of ${candidates.join(", ")} holds ${vault} at block ${at.number}; pick another holder`);
        return;
      }

      const src = new LiveCoverageSource({
        notes: [testNote("PLIMSOLL-TEST", [MORPHO, AAVE, SPARK])],
        rpc,
        witnesses: [new RpcPositionWitness(httpJsonRpc(WITNESS_RPC))],
        liabilities: stubbed(holder),
      });
      const snapshot = await src.positionsFor("PLIMSOLL-TEST");
      const position = snapshot.positions.find((p) => p.vault === vault)!;
      t.diagnostic(
        `${holder} at block ${snapshot.asOfBlock} (${snapshot.sourceSet.dataset}): ${position.shares} shares = ${position.assets} USDC units`,
      );
      assert.ok(position.shares > 0n, `${holder} should hold ${vault} at block ${snapshot.asOfBlock}`);
      assert.ok(position.assets > 0n);
      assert.equal(position.assetDecimals, 6);
      assert.deepEqual(snapshot.sourceSet.endpoints.slice(0, 2), [new URL(BASE_RPC).host, new URL(WITNESS_RPC).host]);

      const verdict = await attest("PLIMSOLL-TEST", { source: src, signer });
      assert.equal(verdict.decision, "attested", JSON.stringify(verdict.decision === "refused" ? verdict.detail : {}));
    });
  }

  it("refuses a real WETH vault rather than summing it one-for-one against dollars", { skip }, async (t) => {
    const src = new LiveCoverageSource({
      notes: [testNote("PLIMSOLL-TEST-ETH", [MOONWELL])],
      rpc: httpJsonRpc(BASE_RPC),
      liabilities: stubbed(WETH_HOLDER, { registeredVaultSetHash: canonicalHash([MOONWELL]) }),
    });
    // Moonwell Flagship ETH is a sound vault holding a real position; what is
    // missing is a place in the evidence to record how WETH became dollars.
    await assert.rejects(
      () => src.positionsFor("PLIMSOLL-TEST-ETH"),
      (error: Error) => {
        t.diagnostic(`refused: ${error.message}`);
        return /not the note's unit/.test(error.message);
      },
    );
  });
});

describe("live: the note's figures from Hedera testnet", () => {
  it("reads PLIM-A's supply, par, issuer and line at one mirror-node block", { skip }, async (t) => {
    const r = await new MirrorLiabilityReader().read("PLIM-A", HEDERA);
    t.diagnostic(
      `Hedera block ${r.block}: supply ${r.totalSupply}/10^${r.noteDecimals}, par ${r.nominalValue}/10^${r.nominalValueDecimals} ${r.currency}, issuer ${r.issuer}, line ${r.thresholdBps} bps, registered set ${r.registeredVaultSetHash}`,
    );
    assert.equal(r.noteId, noteIdOf("PLIM-A"));
    assert.equal(r.currency, "USD");
    assert.match(r.issuer, /^0x[0-9a-f]{40}$/);
    assert.ok(r.thresholdBps > 0);
    assert.match(r.registeredVaultSetHash ?? "", /^0x[0-9a-f]{64}$/);
  });

  it("adjudicates the real PLIM-A end to end, and it refuses", { skip }, async (t) => {
    const src = new LiveCoverageSource({
      notes: [testNote("PLIM-A", [MOONWELL])],
      rpc: httpJsonRpc(BASE_RPC),
    });
    const verdict = await attest("PLIM-A", { source: src, signer });
    t.diagnostic(`PLIM-A: ${verdict.decision}${verdict.decision === "refused" ? ` ${verdict.family}/${verdict.reason}` : ""}`);
    // Until CoverageOracle holds PLIM-A's new vault set this is vault_set_drift;
    // after it, an asset refusal. It is never an attestation.
    assert.equal(verdict.decision, "refused");
  });
});
