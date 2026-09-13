import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { attest, type Verdict } from "../src/attest.js";
import { canonicalHash } from "../src/canonical.js";
import {
  JsonRpcError,
  LiveCoverageSource,
  RpcPositionWitness,
  UnknownNote,
  httpJsonRpc,
  obligationTerms,
  parseNotesFile,
  restate,
  type JsonRpc,
  type LiabilityReader,
  type LiabilityReading,
  type LiveNoteDefinition,
  type LiveSourceOptions,
  type NoteRegistry,
} from "../src/coverage/index.js";
import { noteIdOf } from "../src/coverage/hedera.js";
import { TEST_ATTESTOR_ADDRESS } from "./helpers.js";

/**
 * The live source against a chain that exists only in this file.
 *
 * The fake node answers the handful of calls the source makes, from a table,
 * and fails the test if any `eth_call` is not pinned by block hash. The note's
 * own figures come from a stub reader. Everything that can go wrong on a real
 * chain is staged here once, so each refusal path is exercised without a network.
 */

/**
 * A stand-in signer. These tests are about which verdict the source produces
 * and what it publishes, not about signatures, and this keeps them independent
 * of how the signer is constructed.
 */
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
const NOW = 1_789_150_000;

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";
const FEED = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";
const HOLDER = "0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a";
const STRANGER = "0x00000000000000000000000000000000000b0b01";
const MORPHO = "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61";
const AAVE = "0xc768c589647798a6ee01a91fde98ef2ed046dbd6";
const SPARK = "0x3128a0f7f0ea68e7b7c9b00afa7e41045828e858";
const FLUID = "0xf42f5795d9ac7e9d757db633d693cd548cfd9169";
const MOONWELL = "0xa0e430870c4604ccfc7b38ca7845b1ff653d0ff1";

const PLIM_B_VAULTS = [MORPHO, AAVE, SPARK].sort();
const PLIM_A_VAULTS = [FLUID];

const ABI = parseAbi([
  "function asset() view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

interface FakeVault {
  asset: string;
  /** The holder's share balance and what it is worth. */
  shares: bigint;
  assets: bigint;
  reverts?: boolean;
}

interface FakeChain {
  head?: bigint;
  headTimestamp?: number;
  vaults: Record<string, FakeVault>;
  price?: { answer: bigint; updatedAt: number };
  chainId?: number;
  label?: string;
  /** Two hex chars mixed into every block hash, so chains can disagree about hashes. */
  salt?: string;
}

type Fake = JsonRpc & { calls: Array<{ method: string; params: readonly unknown[] }> };

function fakeNode(chain: FakeChain): Fake {
  const head = chain.head ?? 1_000n;
  const salt = chain.salt ?? "aa";
  const label = chain.label ?? "fake-base";
  const hashOf = (n: bigint) => `0x${salt}${n.toString(16).padStart(62, "0")}`;
  const numberOf = (hash: string) => (hash.slice(2, 4) === salt ? BigInt(`0x${hash.slice(4)}`) : null);
  const blockOf = (n: bigint) =>
    n > head || n < 0n
      ? null
      : {
          number: `0x${n.toString(16)}`,
          hash: hashOf(n),
          timestamp: `0x${((chain.headTimestamp ?? NOW) - Number(head - n) * 2).toString(16)}`,
        };
  const calls: Fake["calls"] = [];
  const result = (functionName: string, value: unknown) =>
    encodeFunctionResult({ abi: ABI, functionName, result: value } as never);

  return {
    label,
    calls,
    async request<T>(method: string, params: readonly unknown[]): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case "eth_chainId":
          return `0x${(chain.chainId ?? 8453).toString(16)}` as T;
        case "eth_blockNumber":
          return `0x${head.toString(16)}` as T;
        case "eth_getBlockByNumber":
          return blockOf(BigInt(params[0] as string)) as T;
        case "eth_getBlockByHash": {
          const n = numberOf(params[0] as string);
          return (n === null ? null : blockOf(n)) as T;
        }
        case "eth_call": {
          const [tx, at] = params as [{ to: string; data: Hex }, { blockHash?: string; requireCanonical?: boolean }];
          assert.ok(at && typeof at === "object" && at.blockHash, "every eth_call must be pinned by block hash");
          assert.equal(at.requireCanonical, true, "and must require the block to be canonical");
          if (numberOf(at.blockHash) === null) throw new JsonRpcError(label, "rpc", "unknown block", -32000);
          const { functionName, args } = decodeFunctionData({ abi: ABI, data: tx.data });
          const to = tx.to.toLowerCase();
          const vault = chain.vaults[to];
          if (vault) {
            if (vault.reverts) throw new JsonRpcError(label, "rpc", "execution reverted", 3);
            if (functionName === "asset") return result("asset", vault.asset) as T;
            if (functionName === "balanceOf") {
              return result("balanceOf", (args![0] as string).toLowerCase() === HOLDER ? vault.shares : 0n) as T;
            }
            if (functionName === "convertToAssets") {
              const shares = args![0] as bigint;
              return result("convertToAssets", vault.shares === 0n ? 0n : (shares * vault.assets) / vault.shares) as T;
            }
          }
          if (to === USDC && functionName === "decimals") return result("decimals", 6) as T;
          if (to === WETH && functionName === "decimals") return result("decimals", 18) as T;
          if (to === FEED && chain.price) {
            if (functionName === "description") return result("description", "ETH / USD") as T;
            if (functionName === "decimals") return result("decimals", 8) as T;
            if (functionName === "latestRoundData") {
              return result("latestRoundData", [1n, chain.price.answer, 0n, BigInt(chain.price.updatedAt), 1n]) as T;
            }
          }
          return "0x" as T;
        }
        default:
          throw new Error(`fake node does not implement ${method}`);
      }
    },
  };
}

const REGISTRY: NoteRegistry = {
  chain: "hedera-testnet",
  chainId: 296,
  mirror: "https://mirror.invalid/api/v1",
  note: "0xcf759c717e805413aaa7d067db7bd7a93969def2",
  loadLine: "0xf867b6f41b21e9d72f327f867ae898620d022c80",
  coverageOracle: "0xce13de224ed918d7b8b2717492849e0a82648ca3",
};

function note(market: string, vaults: string[], extra: Partial<LiveNoteDefinition> = {}): LiveNoteDefinition {
  return {
    noteId: noteIdOf(market),
    market,
    network: "base",
    chainId: 8453,
    vaults: [...vaults].sort(),
    vaultSetHash: null,
    negativeControl: false,
    status: "final",
    registry: REGISTRY,
    ...extra,
  };
}

/** PLIM-B: 10.00 notes at 1.00 USD, a 100.00% line. PLIM-A: 10,000.00 at 100.00, 95.00%. */
function reading(market: string, over: Partial<LiabilityReading> = {}): LiabilityReading {
  const control = market === "PLIM-A";
  return {
    chain: "hedera-testnet",
    chainId: 296,
    endpoint: "mirror.invalid",
    block: "40000000",
    blockHash: "0xhedera",
    observedAt: NOW - 5,
    market,
    noteId: noteIdOf(market),
    note: REGISTRY.note,
    totalSupply: control ? "1000000" : "1000",
    noteDecimals: 2,
    nominalValue: control ? "10000" : "100",
    nominalValueDecimals: 2,
    currency: "USD",
    issuer: HOLDER,
    loadLine: REGISTRY.loadLine,
    thresholdBps: control ? 9500 : 10_000,
    coverageOracle: REGISTRY.coverageOracle ?? null,
    registeredVaultSetHash: canonicalHash(control ? PLIM_A_VAULTS : PLIM_B_VAULTS),
    ...over,
  };
}

function reader(over: (market: string) => Partial<LiabilityReading> = () => ({})): LiabilityReader {
  return { read: async (market) => reading(market, over(market)) };
}

/** The planned split: 8 + 3 + 3 USDC against $10, and the control's dollar. */
const FUNDED: Record<string, FakeVault> = {
  [MORPHO]: { asset: USDC, shares: 7_200_000_000_000_000_000n, assets: 8_000_000n },
  [AAVE]: { asset: USDC, shares: 2_600_000n, assets: 3_000_000n },
  [SPARK]: { asset: USDC, shares: 2_700_000_000_000_000_000n, assets: 3_000_000n },
  [FLUID]: { asset: USDC, shares: 880_000n, assets: 1_000_000n },
  // Only used to prove a non-unit asset is refused rather than summed.
  [MOONWELL]: { asset: WETH, shares: 390_000_000_000_000n, assets: 400_000_000_000_000n },
};
const PRICE = { answer: 253_703_000_000n, updatedAt: NOW - 100 };

function source(options: Partial<LiveSourceOptions> & { chain?: Partial<FakeChain> } = {}): {
  source: LiveCoverageSource;
  node: Fake;
} {
  const node = fakeNode({ vaults: FUNDED, price: PRICE, ...options.chain });
  const src = new LiveCoverageSource({
    notes: [note("PLIM-B", PLIM_B_VAULTS), note("PLIM-A", PLIM_A_VAULTS, { negativeControl: true })],
    rpc: node,
    liabilities: reader(),
    now: () => NOW,
    ...options,
  });
  return { source: src, node };
}

async function verdictFor(market: string, src: LiveCoverageSource): Promise<Verdict> {
  return attest(market, { source: src, signer, now: () => NOW });
}

describe("live source: valuing real positions against the note's own figures", () => {
  it("attests the funded split and publishes every read it used", async () => {
    const { source: src } = source();
    const verdict = await verdictFor("PLIM-B", src);
    assert.equal(verdict.decision, "attested");
    assert.equal(verdict.coverageBps, 14_000);

    const evidence = verdict.evidence!;
    assert.equal(evidence.holder, HOLDER, "the holder is the note's issuer, as read from its chain");
    assert.equal(evidence.notesOutstanding, "10");
    assert.equal(evidence.parPerNote, "1000000");
    assert.equal(evidence.obligation, "10000000");
    assert.equal(evidence.asOfBlock, "998", "two blocks behind the head");
    assert.equal(evidence.sourceSet.kind, "eth_call");
    assert.match(evidence.sourceSet.dataset, /^eip155:8453:0x[0-9a-f]{64}$/);
    // What the attestation commits to is the set the oracle holds, and what we
    // read hashes to the same thing.
    assert.equal(evidence.vaultSetHash, canonicalHash(PLIM_B_VAULTS));
    assert.equal(evidence.observedVaultSetHash, canonicalHash(PLIM_B_VAULTS));
  });

  it("names every source of the denominator in the evidence", async () => {
    const { source: src } = source();
    const snapshot = await src.positionsFor("PLIM-B");
    const endpoints = snapshot.sourceSet.endpoints;
    assert.equal(endpoints[0], "fake-base");
    assert.ok(endpoints.some((e) => e.includes("hedera-testnet:mirror.invalid@block 40000000")));
    assert.ok(
      endpoints.some((e) => e.includes("totalSupply=1000/1e2") && e.includes("par=100/1e2 USD") && e.includes(`issuer=${HOLDER}`)),
      endpoints.join(" | "),
    );
    assert.ok(endpoints.some((e) => e.includes("threshold=10000bps")), endpoints.join(" | "));
  });

  it("pins every read to one block hash and never says latest", async () => {
    const { source: src, node } = source();
    await src.positionsFor("PLIM-B");
    const pins = new Set(
      node.calls.filter((c) => c.method === "eth_call").map((c) => (c.params[1] as { blockHash: string }).blockHash),
    );
    assert.equal(pins.size, 1);
    const tags = node.calls.flatMap((c) => c.params).filter((p) => p === "latest");
    assert.deepEqual(tags, []);
  });

  it("finds the note by market or by its on-chain id, and 404s an unknown one", async () => {
    const { source: src } = source();
    assert.equal((await src.positionsFor(noteIdOf("PLIM-B"))).noteId, "PLIM-B");
    assert.equal((await src.positionsFor("plim-b")).noteId, "PLIM-B");
    await assert.rejects(() => src.positionsFor("PLIM-Z"), UnknownNote);
  });

  it("redeeming the named position is a finding about the asset, with its ratio", async () => {
    const { source: src } = source({
      chain: { vaults: { ...FUNDED, [MORPHO]: { asset: USDC, shares: 0n, assets: 0n } } },
    });
    const verdict = await verdictFor("PLIM-B", src);
    assert.equal(verdict.decision, "refused");
    if (verdict.decision !== "refused") return;
    assert.equal(verdict.family, "asset");
    assert.equal(verdict.reason, "coverage_below_floor");
    assert.equal(verdict.coverageKnown, true);
    assert.equal(verdict.coverageBps, 6_000);
  });

  it("refuses the negative control on its own real, tiny ratio", async () => {
    const { source: src } = source();
    const verdict = await verdictFor("PLIM-A", src);
    assert.equal(verdict.decision, "refused");
    if (verdict.decision !== "refused") return;
    assert.equal(verdict.family, "asset", "a real dollar is a finding, not a failure of evidence");
    assert.equal(verdict.reason, "coverage_below_floor");
    assert.equal(verdict.coverageKnown, true);
    // $1 against $1,000,000 is 0.0001%, which floors to 0 bps.
    assert.equal(verdict.coverageBps, 0);
    assert.equal(verdict.evidence!.obligation, "1000000000000");
  });
});

describe("live source: every failure is an evidence refusal with no number", () => {
  async function evidenceRefusal(src: LiveCoverageSource, market = "PLIM-B") {
    const verdict = await verdictFor(market, src);
    assert.equal(verdict.decision, "refused");
    if (verdict.decision !== "refused") throw new Error("unreachable");
    assert.equal(verdict.family, "evidence");
    assert.equal(verdict.coverageBps, null);
    assert.equal(verdict.evidence, null);
    return verdict;
  }

  it("refuses a pinned block that is too old", async () => {
    const { source: src } = source({ chain: { vaults: FUNDED, headTimestamp: NOW - 600 } });
    assert.equal((await evidenceRefusal(src)).reason, "data_stale");
  });

  it("refuses when a witness disagrees about the value", async () => {
    const off = { ...FUNDED, [AAVE]: { asset: USDC, shares: 2_600_000n, assets: 3_040_000n } };
    const { source: src } = source({ witnesses: [new RpcPositionWitness(fakeNode({ vaults: off, label: "witness" }))] });
    const verdict = await evidenceRefusal(src);
    assert.equal(verdict.reason, "sources_disagree");
    assert.equal(verdict.detail.vault, AAVE);
  });

  it("refuses when a witness disagrees about the shares, however small the gap", async () => {
    const off = { ...FUNDED, [SPARK]: { asset: USDC, shares: 2_700_000_000_000_000_001n, assets: 3_000_000n } };
    const { source: src } = source({ witnesses: [new RpcPositionWitness(fakeNode({ vaults: off, label: "witness" }))] });
    assert.equal((await evidenceRefusal(src)).reason, "sources_disagree");
  });

  it("refuses when a witness does not know the block that was pinned", async () => {
    const { source: src } = source({
      witnesses: [new RpcPositionWitness(fakeNode({ vaults: FUNDED, label: "witness", salt: "bb" }))],
    });
    assert.equal((await evidenceRefusal(src)).reason, "sources_disagree");
  });

  it("refuses when a witness has fallen too far behind", async () => {
    const { source: src } = source({
      witnesses: [new RpcPositionWitness(fakeNode({ vaults: FUNDED, label: "witness", head: 500n }))],
    });
    assert.equal((await evidenceRefusal(src)).reason, "data_stale");
  });

  it("refuses a vault whose asset is not the note's unit, rather than summing it one-for-one", async () => {
    const notes = [note("PLIM-B", [MORPHO, AAVE, SPARK, MOONWELL])];
    const { source: src } = source({
      notes,
      liabilities: reader(() => ({ registeredVaultSetHash: canonicalHash([MORPHO, AAVE, SPARK, MOONWELL].sort()) })),
    });
    const verdict = await evidenceRefusal(src);
    assert.equal(verdict.reason, "vault_unresolved");
    assert.equal(verdict.detail.vault, MOONWELL);
  });

  it("tells a reverting vault apart from a node that would not answer", async () => {
    const reverting = source({ chain: { vaults: { ...FUNDED, [AAVE]: { ...FUNDED[AAVE]!, reverts: true } } } });
    assert.equal((await evidenceRefusal(reverting.source)).reason, "vault_unresolved");

    const limited = httpJsonRpc("http://rate-limited.invalid", {
      retries: 1,
      retryDelayMs: 1,
      fetch: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32016, message: "over rate limit" } })),
    });
    const unreachable = new LiveCoverageSource({
      notes: [note("PLIM-B", PLIM_B_VAULTS)],
      rpc: limited,
      liabilities: reader(),
      now: () => NOW,
    });
    assert.equal((await evidenceRefusal(unreachable)).reason, "source_unavailable");
  });

  it("refuses when the note's figures cannot be read", async () => {
    const broken: LiabilityReader = {
      read: async () => {
        throw new Error("mirror unreachable");
      },
    };
    const { source: src } = source({ liabilities: broken });
    assert.equal((await evidenceRefusal(src)).reason, "source_unavailable");
  });

  it("refuses a note the oracle has no registration for, rather than inventing a commitment", async () => {
    const { source: src } = source({ liabilities: reader(() => ({ registeredVaultSetHash: null })) });
    assert.equal((await evidenceRefusal(src)).reason, "source_unavailable");
  });

  it("refuses a vault list that does not hash to the set registered on chain", async () => {
    const { source: src } = source({ liabilities: reader(() => ({ registeredVaultSetHash: `0x${"ab".repeat(32)}` })) });
    const verdict = await evidenceRefusal(src);
    assert.equal(verdict.reason, "vault_set_drift");
    assert.equal(verdict.detail.where, "CoverageOracle");
  });

  it("refuses a position that another note of the same holder also nominates", async () => {
    const shared = [FLUID, ...PLIM_B_VAULTS].sort();
    const notes = [note("PLIM-B", PLIM_B_VAULTS), note("PLIM-A", shared)];
    const hashes = (m: string) => ({ registeredVaultSetHash: canonicalHash(m === "PLIM-A" ? shared : PLIM_B_VAULTS) });
    const sameHolder = source({ notes, liabilities: reader(hashes) });
    const verdict = await evidenceRefusal(sameHolder.source);
    assert.equal(verdict.reason, "vault_set_drift");
    assert.equal(verdict.detail.otherNote, "PLIM-A");

    // A different issuer holds different positions in the same vault.
    const otherHolder = source({
      notes,
      liabilities: reader((m) => ({ ...hashes(m), ...(m === "PLIM-A" ? { issuer: STRANGER } : {}) })),
    });
    assert.equal((await verdictFor("PLIM-B", otherHolder.source)).decision, "attested");
  });

  it("refuses an endpoint on the wrong chain", async () => {
    const { source: src } = source({ chain: { vaults: FUNDED, chainId: 1 } });
    assert.equal((await evidenceRefusal(src)).reason, "source_unavailable");
  });
});

describe("live source: witnesses and pinning", () => {
  it("accepts a witness that agrees within tolerance and names it in the evidence", async () => {
    const close = { ...FUNDED, [AAVE]: { asset: USDC, shares: 2_600_000n, assets: 3_001_500n } };
    const { source: src } = source({ witnesses: [new RpcPositionWitness(fakeNode({ vaults: close, label: "witness" }))] });
    const verdict = await verdictFor("PLIM-B", src);
    assert.equal(verdict.decision, "attested");
    assert.deepEqual(verdict.evidence!.sourceSet.endpoints.slice(0, 2), ["fake-base", "witness"]);
  });

  it("pins to the newest block every witness has reached", async () => {
    const { source: src } = source({
      witnesses: [new RpcPositionWitness(fakeNode({ vaults: FUNDED, label: "witness", head: 990n }))],
    });
    assert.equal((await src.positionsFor("PLIM-B")).asOfBlock, 990n);
  });
});

describe("live source: the liability arithmetic and the notes file", () => {
  it("states outstanding supply in whole notes when it can and base units when it must", () => {
    assert.deepEqual(obligationTerms(reading("PLIM-B"), 6), { notesOutstanding: 10n, parPerNote: 1_000_000n });
    assert.deepEqual(obligationTerms(reading("PLIM-A"), 6), { notesOutstanding: 10_000n, parPerNote: 100_000_000n });
    // 10.05 notes: counted as 1,005 hundredths at 0.01 USD each, still exactly $10.05.
    assert.deepEqual(obligationTerms(reading("PLIM-B", { totalSupply: "1005" }), 6), {
      notesOutstanding: 1_005n,
      parPerNote: 10_000n,
    });
  });

  it("converts a non-unit amount at a feed's decimals, rounding down", () => {
    // Ready for a WETH leg: 0.0004 WETH at 2537.03 USD is 1.014812 USDC.
    assert.equal(restate(400_000_000_000_000n, 18, 253_703_000_000n, 8, 6), 1_014_812n);
  });

  it("parses the shared notes file and rejects a key that is not the market's hash", () => {
    const parsed = parseNotesFile({
      version: 2,
      notes: {
        [noteIdOf("PLIM-B")]: {
          market: "PLIM-B",
          network: "base",
          chainId: 8453,
          vaults: [SPARK, MORPHO, AAVE],
          negativeControl: false,
          status: "final",
          registry: {
            chain: "hedera-testnet",
            chainId: 296,
            mirror: REGISTRY.mirror,
            note: REGISTRY.note,
            loadLine: REGISTRY.loadLine,
            coverageOracle: REGISTRY.coverageOracle,
          },
        },
      },
    });
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0]!.vaults, PLIM_B_VAULTS);
    assert.throws(() =>
      parseNotesFile({ version: 2, notes: { [noteIdOf("PLIM-A")]: { market: "PLIM-B", chainId: 8453, vaults: [] } } }),
    );
  });

  it("an unconfigured source refuses as it always has", async () => {
    const verdict = await verdictFor("PLIM-B", new LiveCoverageSource());
    assert.equal(verdict.decision, "refused");
    assert.equal(verdict.decision === "refused" && verdict.reason, "source_unavailable");
  });
});
