import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { coverageBpsOf, normalise } from "../src/attestor.js";
import type { ChainReader, NoteFacts } from "../src/chain.js";
import { vaultSetHash } from "../src/canonical.js";
import type { Config, NetworkName } from "../src/config.js";
import { loadConfig, PACKAGE_ROOT } from "../src/config.js";
import type { FeedError, FeedHandle, FeedStatus } from "../src/feed.js";
import type { NoteEntry, NotesFile } from "../src/notes.js";
import type { LoadedPackage } from "../src/spkg.js";
import { FeedState, observedOf } from "../src/state.js";
import type { RangeRunner, ToolDeps } from "../src/tools.js";
import type { BlockOutputJson, PositionJson } from "../src/types.js";

export interface Recording {
  about: string;
  recordedAt: string;
  network: NetworkName;
  endpoint: string;
  finalBlocksOnly: boolean;
  package: { name: string; version: string; sha256: string };
  module: { name: string; hash: string };
  head: { number: string; hash: string; timestamp: number; finalBlockHeight: string } | null;
  blocks: { block: { number: string; hash: string; timestamp: number }; finalBlockHeight: string; output?: BlockOutputJson }[];
}

export function loadRecording(network: NetworkName): Recording {
  return JSON.parse(readFileSync(resolve(PACKAGE_ROOT, `test/fixtures/recorded-${network}.json`), "utf8")) as Recording;
}

export class ReplayFeed implements FeedHandle {
  readonly state = new FeedState(10_000);
  status: FeedStatus = "live";
  lastError: FeedError | null = null;
  constructor(
    readonly spec: Config["networks"][NetworkName],
    readonly outputModule: string,
    readonly moduleHash: string,
  ) {}
}

/** Replays a recording into a feed exactly as the live stream would have applied it. */
export function replay(rec: Recording, config: Config): ReplayFeed {
  const feed = new ReplayFeed(config.networks[rec.network], rec.module.name, rec.module.hash);
  for (const b of rec.blocks) {
    feed.state.applyBlock(observedOf(BigInt(b.block.number), b.block.hash, b.block.timestamp), BigInt(b.finalBlockHeight), `cursor-${b.block.number}`, b.output);
  }
  if (rec.head) {
    feed.state.applyBlock(observedOf(BigInt(rec.head.number), rec.head.hash, rec.head.timestamp), BigInt(rec.head.finalBlockHeight), "cursor-head", undefined);
  }
  return feed;
}

export function loadedFrom(rec: Recording): LoadedPackage {
  return { path: "recorded", bytes: new Uint8Array(), sha256: rec.package.sha256, name: rec.package.name, version: rec.package.version, defaultNetwork: "mainnet", networks: ["mainnet", "base"] };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ PORT: "0", ATTESTOR_URL: "http://attestor.test" }), maxStalenessSeconds: 900, ...overrides };
}

export function notesFile(entries: NoteEntry[]): NotesFile {
  return { path: "<test>", notes: new Map(entries.map((e) => [e.noteId, e])) };
}

export const REGISTRY = {
  chain: "hedera-testnet",
  chainId: 296,
  rpc: "http://registry.test",
  coverageOracle: "0xce13de224ed918d7b8b2717492849e0a82648ca3",
  loadLine: "0xf867b6f41b21e9d72f327f867ae898620d022c80",
  note: "0xe2bf359650fbacc7d4801336f8c1fe7061ad6387",
};

export const HOLDER = "0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a";

export function note(noteId: string, vaults: string[], extra: Partial<NoteEntry> = {}): NoteEntry {
  return { noteId, market: "PLIM-TEST", network: "base", chainId: 8453, vaults, negativeControl: false, status: "placeholder", registry: REGISTRY, ...extra };
}

/**
 * A stand-in for the note registry chain. Its figures are placeholders chosen
 * per test; only the stream side of these tests replays real data.
 */
export class FakeChain implements ChainReader {
  constructor(private readonly facts: (noteId: string) => Partial<NoteFacts> | Error) {}
  async issuerOf(): Promise<string | null> {
    return HOLDER;
  }
  async noteFacts(noteId: string): Promise<NoteFacts> {
    const f = this.facts(noteId);
    if (f instanceof Error) throw f;
    return {
      block: 40_000_000n,
      registered: true,
      onchainVaultSetHash: vaultSetHash([]),
      holder: HOLDER,
      issuerCount: 1,
      totalSupply: 1_000_000n,
      noteDecimals: 2,
      nominal: 10_000n,
      nominalDecimals: 2,
      currency: "USD",
      thresholdBps: 9_500,
      lineConfigured: true,
      reads: [
        { chain: "hedera-testnet", chainId: 296, rpc: REGISTRY.rpc, contract: REGISTRY.note, method: "totalSupply()", block: "40000000", kind: "quantity", value: "1000000" },
        { chain: "hedera-testnet", chainId: 296, rpc: REGISTRY.rpc, contract: REGISTRY.coverageOracle, method: "CoverageOracle.noteOf(noteId).vaultSetHash", block: "40000000", kind: "identity", value: vaultSetHash([]) },
      ],
      ...f,
    };
  }
}

export function deps(opts: {
  feeds: Map<NetworkName, FeedHandle>;
  now: number;
  loaded: LoadedPackage;
  notes?: NotesFile;
  chain?: ChainReader;
  holders?: Map<string, string>;
  config?: Config;
  range?: RangeRunner | null;
}): ToolDeps {
  return {
    config: opts.config ?? testConfig(),
    loaded: opts.loaded,
    feeds: opts.feeds,
    notes: () => opts.notes ?? notesFile([]),
    chain: opts.chain ?? new FakeChain(() => ({})),
    streamedHolders: opts.holders ?? new Map(),
    coverage: { normalise, coverageBpsOf },
    range: opts.range ?? null,
    now: () => opts.now,
    slots: { capacity: 2, inUse: 0 },
  };
}

/** Synthetic position readings for placeholder notes, clearly not from the stream. */
export function positionsBlock(noteId: string, vault: string, assets: string, shares: string, over: Partial<PositionJson> = {}): BlockOutputJson {
  return {
    positionsRead: true,
    positions: [
      {
        note: noteId,
        holder: HOLDER,
        vault,
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        assetDecimals: 6,
        shareDecimals: 18,
        shares,
        assets,
        assetPriceUsd: "1",
        ok: true,
        verification: "VERIFICATION_CONFIRMED",
        ratesConsistent: true,
        lastFlowBlock: "1",
        ...over,
      },
    ],
    vaults: [],
  };
}

const FIGURE_KEY = /coverage|bps|price|rate|balance|shares|assets|tvl|value|obligation|attributable|supply|amount|nominal|par$|threshold|floor|ratio/i;
const NUMERIC = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Every key/value in `v` that would read as a figure: a numeric value under a figure-sounding key. */
export function figuresIn(v: unknown, path = ""): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) v.forEach((x, i) => out.push(...figuresIn(x, `${path}[${i}]`)));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      const scalarFigure = (typeof x === "number" || (typeof x === "string" && NUMERIC.test(x))) && FIGURE_KEY.test(k);
      if (scalarFigure) out.push(p);
      out.push(...figuresIn(x, p));
    }
  }
  return out;
}

export function assertProvenance(p: unknown): void {
  const prov = p as Record<string, any>;
  if (!prov) throw new Error("no provenance");
  const must = (cond: boolean, what: string) => {
    if (!cond) throw new Error(`provenance missing ${what}: ${JSON.stringify(prov)}`);
  };
  must(prov.provider === "The Graph Market", "provider");
  must(/^[0-9a-f]{64}$/.test(prov.package?.sha256 ?? ""), "package.sha256");
  must(typeof prov.package?.name === "string" && typeof prov.package?.version === "string", "package name/version");
  must(typeof prov.module?.name === "string" && prov.module.name.length > 0, "module.name");
  must(typeof prov.builtAt === "string" && !Number.isNaN(Date.parse(prov.builtAt)), "builtAt");
  must("block" in prov && "head" in prov, "block/head keys");
}
