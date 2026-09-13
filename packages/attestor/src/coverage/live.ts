import { canonicalHash } from "../canonical.js";
import { DEFAULT_POLICY } from "../policy.js";
import { UnknownNote } from "./fixture.js";
import { MirrorLiabilityReader, type LiabilityReader } from "./hedera.js";
import { LiabilityUnresolved, SourceStale, VaultPledgedElsewhere, VaultSetMismatch } from "./live-errors.js";
import { loadNotesFile, type LiveNoteDefinition } from "./notes-file.js";
import { BASE_PRICE_FEEDS, type PriceFeed } from "./pricing.js";
import { callAt, headNumber, httpJsonRpc, pinBlock, type JsonRpc, type PinnedBlock } from "./rpc.js";
import {
  type CoverageSnapshot,
  type CoverageSource,
  type VaultPosition,
  CoverageSourceError,
  SourceUnavailable,
  VaultUnresolved,
} from "./types.js";
import {
  ERC20_ABI,
  RpcPositionWitness,
  classifyCallFailure,
  crossCheck,
  readPositions,
  vaultCall,
  type PositionReading,
  type PositionWitness,
} from "./witness.js";
import type { LiabilityReading } from "./hedera.js";

/**
 * ============================ SEAM ============================
 * Coverage from real chains.
 *
 * The numerator is the holder's ERC-4626 positions on the backing chain, read
 * with `eth_call` pinned to one block hash. The denominator is the note itself
 * on Hedera: `totalSupply`, `getNominalValue`, the sole `ROLE_ISSUER` member as
 * the holder, and the LoadLine threshold, all read at one Hedera block. The
 * notes file contributes only the vault list and where those contracts live.
 *
 * Every figure that goes into the ratio is read, and every read is named in the
 * snapshot's source set, which is published as part of the evidence. Any read
 * that fails, disagrees with a witness, or is too old is an evidence refusal.
 * Nothing is defaulted, cached or carried over.
 *
 * Constructed without options, the source is unconfigured and refuses every
 * request, which is how the service behaves when no notes file is set.
 * ==============================================================
 */

/** Native USDC on Base: the unit every Base-backed note is measured in. */
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export interface LiveSourceOptions {
  notes: readonly LiveNoteDefinition[];
  /** Primary endpoint on the backing chain. It pins the block and values the positions. */
  rpc: JsonRpc;
  /** Independent readings of the same positions. Disagreement refuses. */
  witnesses?: readonly PositionWitness[];
  liabilities?: LiabilityReader;
  unitAsset?: string;
  unitDecimals?: number;
  priceFeeds?: readonly PriceFeed[];
  /** Blocks to stay behind the head, so a block about to be reorganised is never signed over. */
  confirmations?: number;
  /** The pinned block may be at most this old by the local clock. */
  maxBlockAgeSeconds?: number;
  toleranceBps?: number;
  maxWitnessLagBlocks?: number;
  now?: () => number;
}

interface Config {
  notes: readonly LiveNoteDefinition[];
  rpc: JsonRpc;
  witnesses: readonly PositionWitness[];
  liabilities: LiabilityReader;
  unitAsset: string;
  unitDecimals: number;
  feeds: Map<string, PriceFeed>;
  confirmations: number;
  maxBlockAgeSeconds: number;
  toleranceBps: number;
  maxWitnessLagBlocks: bigint;
  now: () => number;
}

export class LiveCoverageSource implements CoverageSource {
  readonly id = "live";
  private readonly config: Config | null;
  private readonly endpoint: string | undefined;
  private chainId: Promise<number> | null = null;

  /**
   * @param options - Full configuration. A string or nothing yields an
   *   unconfigured source that refuses every call; the string is only recorded.
   */
  constructor(options?: LiveSourceOptions | string) {
    if (options === undefined || typeof options === "string") {
      this.config = null;
      this.endpoint = options;
      return;
    }
    this.endpoint = options.rpc.label;
    this.config = {
      notes: options.notes,
      rpc: options.rpc,
      witnesses: options.witnesses ?? [],
      liabilities: options.liabilities ?? new MirrorLiabilityReader(),
      unitAsset: (options.unitAsset ?? BASE_USDC).toLowerCase(),
      unitDecimals: options.unitDecimals ?? 6,
      feeds: new Map((options.priceFeeds ?? BASE_PRICE_FEEDS).map((f) => [f.asset.toLowerCase(), f])),
      confirmations: options.confirmations ?? 2,
      maxBlockAgeSeconds: options.maxBlockAgeSeconds ?? 120,
      toleranceBps: options.toleranceBps ?? DEFAULT_POLICY.crossSourceToleranceBps,
      maxWitnessLagBlocks: BigInt(options.maxWitnessLagBlocks ?? 300),
      now: options.now ?? (() => Math.floor(Date.now() / 1000)),
    };
  }

  /**
   * Configures from the environment. With no `LIVE_NOTES_FILE` the source is
   * unconfigured and refuses, exactly as before a notes file existed.
   *
   * - `LIVE_NOTES_FILE`: path to the shared notes file.
   * - `BASE_RPC_URL`: primary endpoint (default `https://mainnet.base.org`).
   * - `BASE_WITNESS_RPC_URLS`: comma-separated independent endpoints.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, endpoint?: string): LiveCoverageSource {
    const notesPath = (env.LIVE_NOTES_FILE ?? "").trim();
    if (!notesPath) return new LiveCoverageSource(endpoint);
    const witnesses = (env.BASE_WITNESS_RPC_URLS ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => new RpcPositionWitness(httpJsonRpc(u)));
    return new LiveCoverageSource({
      notes: loadNotesFile(notesPath),
      rpc: httpJsonRpc((env.BASE_RPC_URL ?? "https://mainnet.base.org").trim()),
      witnesses,
    });
  }

  /** Markets this source can value. */
  knownNotes(): string[] {
    return this.config ? this.config.notes.map((n) => n.market) : [];
  }

  async positionsFor(noteId: string, atBlock?: bigint): Promise<CoverageSnapshot> {
    const config = this.config;
    if (!config) {
      throw new SourceUnavailable("the live coverage source is not configured; it never guesses", {
        noteId,
        atBlock: atBlock === undefined ? null : atBlock.toString(),
        endpoint: this.endpoint ?? null,
        seam: "src/coverage/live.ts",
      });
    }
    const wanted = noteId.trim().toLowerCase();
    const note = config.notes.find((n) => n.market.toLowerCase() === wanted || n.noteId === wanted);
    // Not a refusal: there is no asset to make a finding about.
    if (!note) throw new UnknownNote(noteId);

    try {
      return await this.value(config, note, atBlock);
    } catch (error) {
      if (error instanceof CoverageSourceError || error instanceof UnknownNote) throw error;
      // Whatever went wrong, it went wrong on our side of the evidence. It is
      // reported as such, never converted into a number.
      throw new SourceUnavailable(`live valuation of ${note.market} failed: ${(error as Error).message}`, {
        market: note.market,
      });
    }
  }

  private async value(c: Config, note: LiveNoteDefinition, atBlock?: bigint): Promise<CoverageSnapshot> {
    if (!note.registry) {
      throw new LiabilityUnresolved(`${note.market} names no registry, so its liabilities cannot be read`, {
        market: note.market,
      });
    }
    const chainId = await this.chainIdOf(c);
    if (chainId !== note.chainId) {
      throw new SourceUnavailable(`${c.rpc.label} serves chain ${chainId}; ${note.market} is backed on ${note.chainId}`, {
        market: note.market,
      });
    }

    const liabilities = await this.liabilitiesOf(c, note);
    const vaults = [...note.vaults].sort();
    const observedVaultSetHash = canonicalHash(vaults);

    // The attestation commits to the set the oracle holds, so we must know it.
    const registered = liabilities.registeredVaultSetHash;
    if (registered === null) {
      throw new LiabilityUnresolved(`${note.market}: no CoverageOracle registration to commit to`, {
        market: note.market,
        coverageOracle: note.registry.coverageOracle ?? null,
      });
    }
    if (note.vaultSetHash !== null && note.vaultSetHash !== observedVaultSetHash) {
      throw new VaultSetMismatch(note.market, note.vaultSetHash, observedVaultSetHash, "the notes file");
    }
    if (registered !== observedVaultSetHash) {
      throw new VaultSetMismatch(note.market, registered, observedVaultSetHash, "CoverageOracle");
    }

    const holder = liabilities.issuer.toLowerCase();
    await this.requireExclusive(c, note, holder);

    const block = await this.pin(c, atBlock);
    const readings = await readPositions(c.rpc, block, holder, vaults);
    const positions = await this.valuePositions(c, block, readings);

    for (const witness of c.witnesses) {
      let theirs: PositionReading[];
      try {
        theirs = await witness.positionsAt({ noteId: note.noteId, chainId, holder, vaults, block });
      } catch (error) {
        if (error instanceof CoverageSourceError) throw error;
        throw new SourceUnavailable(`witness ${witness.id} could not answer: ${(error as Error).message}`, {
          witness: witness.id,
        });
      }
      crossCheck(readings, theirs, witness.id, {
        toleranceBps: c.toleranceBps,
        maxLagBlocks: c.maxWitnessLagBlocks,
      });
    }

    const { notesOutstanding, parPerNote } = obligationTerms(liabilities, c.unitDecimals);
    return {
      noteId: note.market,
      registeredVaultSetHash: registered,
      // Read from LoadLine on Hedera, alongside the rest of the liability side.
      thresholdBps: liabilities.thresholdBps,
      holder,
      nominatedVaults: vaults,
      positions: [...positions].sort((a, b) => (a.vault < b.vault ? -1 : a.vault > b.vault ? 1 : 0)),
      notesOutstanding,
      parPerNote,
      unitDecimals: c.unitDecimals,
      asOfBlock: block.number,
      // The older of the two chains' observations: a verdict is only as fresh
      // as the stalest thing it depends on.
      observedAt: Math.min(block.timestamp, liabilities.observedAt),
      sourceSet: {
        kind: "eth_call",
        dataset: `eip155:${chainId}:${block.hash}`,
        // Every endpoint that contributed, and every figure the denominator
        // came from, so the evidence names its own sources.
        endpoints: [c.rpc.label, ...c.witnesses.map((w) => w.endpoint), ...liabilityProvenance(liabilities)],
      },
    };
  }

  private chainIdOf(c: Config): Promise<number> {
    if (!this.chainId) {
      this.chainId = c.rpc.request<string>("eth_chainId", []).then((hex) => Number(BigInt(hex)));
      // A failed lookup must not be remembered as the answer.
      this.chainId.catch(() => {
        this.chainId = null;
      });
    }
    return this.chainId;
  }

  private async liabilitiesOf(c: Config, note: LiveNoteDefinition): Promise<LiabilityReading> {
    try {
      return await c.liabilities.read(note.market, note.registry!);
    } catch (error) {
      if (error instanceof CoverageSourceError) throw error;
      throw new LiabilityUnresolved(`liabilities of ${note.market} could not be read: ${(error as Error).message}`, {
        market: note.market,
      });
    }
  }

  /**
   * A position backs one note. If another note of the same holder nominates a
   * vault this note also nominates, neither can count it. A note whose holder
   * cannot be read is not presumed to be someone else.
   */
  private async requireExclusive(c: Config, note: LiveNoteDefinition, holder: string): Promise<void> {
    const mine = new Set(note.vaults);
    for (const other of c.notes) {
      if (other.noteId === note.noteId) continue;
      const shared = other.vaults.find((v) => mine.has(v));
      if (!shared) continue;
      if (!other.registry) {
        throw new LiabilityUnresolved(`${other.market} also nominates ${shared} and its holder cannot be read`, {
          vault: shared,
          otherNote: other.market,
        });
      }
      const theirs = await this.liabilitiesOf(c, other);
      if (theirs.issuer.toLowerCase() === holder) throw new VaultPledgedElsewhere(shared, other.market, holder);
    }
  }

  /**
   * The block every read is pinned to. When witnesses can say how far they
   * have got, the pin is the newest block all of them have reached.
   */
  private async pin(c: Config, atBlock?: bigint): Promise<PinnedBlock> {
    const heads = await Promise.all(
      c.witnesses.filter((w) => w.head).map(async (w) => ({ id: w.id, head: await w.head!() })),
    );
    if (atBlock !== undefined) {
      const behind = heads.find((h) => h.head < atBlock);
      if (behind) {
        throw new SourceStale(`${behind.id} has not reached block ${atBlock}`, {
          witness: behind.id,
          witnessHead: behind.head.toString(),
        });
      }
      return pinBlock(c.rpc, atBlock);
    }

    const head = await headNumber(c.rpc);
    let target = head - BigInt(c.confirmations);
    for (const h of heads) {
      if (head - h.head > c.maxWitnessLagBlocks) {
        throw new SourceStale(`${h.id} is ${head - h.head} blocks behind ${c.rpc.label}`, {
          witness: h.id,
          lagBlocks: (head - h.head).toString(),
          toleranceBlocks: c.maxWitnessLagBlocks.toString(),
        });
      }
      if (h.head < target) target = h.head;
    }
    const block = await pinBlock(c.rpc, target);
    const age = c.now() - block.timestamp;
    if (age > c.maxBlockAgeSeconds) {
      throw new SourceStale(`block ${block.number} is ${age}s old`, {
        block: block.number.toString(),
        ageSeconds: age,
        toleranceSeconds: c.maxBlockAgeSeconds,
      });
    }
    return block;
  }

  /**
   * Reads each vault's asset and checks it is the unit the note is denominated
   * in.
   *
   * A vault holding anything else is refused rather than summed. The evidence
   * records an amount and its decimals and has nowhere to say what price turned
   * that amount into dollars, so summing a non-dollar asset would publish a
   * figure that reads as one-for-one. `pricing.ts` has the conversion and the
   * feed ready for when the evidence can carry it.
   */
  private async valuePositions(
    c: Config,
    block: PinnedBlock,
    readings: readonly PositionReading[],
  ): Promise<VaultPosition[]> {
    const assets = await Promise.all(
      readings.map(async (r) => (await vaultCall<string>(c.rpc, block, r.vault, "asset")).toLowerCase()),
    );
    for (const [i, asset] of assets.entries()) {
      if (asset !== c.unitAsset) {
        const priced = c.feeds.has(asset) ? ", which has a price feed but no place in the evidence to record it" : "";
        const vault = readings[i]!.vault;
        throw new VaultUnresolved(vault, `${vault} holds ${asset}, not the note's unit ${c.unitAsset}${priced}`);
      }
    }

    // One reading per distinct asset, not one per vault. Three vaults over the
    // same unit asked the same question three times, which is both wasteful and
    // the quickest way to be throttled by a public endpoint.
    const decimals = new Map<string, number>();
    for (const asset of new Set(assets)) {
      try {
        decimals.set(
          asset,
          Number(await callAt<number>(c.rpc, block, { address: asset, abi: ERC20_ABI, functionName: "decimals" })),
        );
      } catch (error) {
        throw classifyCallFailure(error, readings[assets.indexOf(asset)]!.vault, `decimals() of its asset ${asset}`);
      }
    }

    return readings.map((r, i) => ({
      vault: r.vault,
      shares: r.shares,
      // Nothing is declared in live mode: the issuer nominates vaults, and
      // the balance that counts is the one the chain reports.
      declaredShares: r.shares,
      assets: r.assets,
      assetDecimals: decimals.get(assets[i]!)!,
      blockNumber: block.number,
    }));
  }
}

/** The denominator's reads, named so the evidence carries where each came from. */
export function liabilityProvenance(l: LiabilityReading): string[] {
  return [
    `${l.chain}:${l.endpoint}@block ${l.block}`,
    `note ${l.note} totalSupply=${l.totalSupply}/1e${l.noteDecimals} par=${l.nominalValue}/1e${l.nominalValueDecimals} ${l.currency} issuer=${l.issuer}`,
    `loadLine ${l.loadLine} threshold=${l.thresholdBps}bps`,
  ];
}

/**
 * Restates the note's own figures as the snapshot's `notesOutstanding` and
 * `parPerNote`, exactly. Whole notes when the supply is whole, the note's base
 * unit otherwise. If neither is exact, that is a refusal, not a rounding.
 */
export function obligationTerms(
  liabilities: LiabilityReading,
  unitDecimals: number,
): { notesOutstanding: bigint; parPerNote: bigint } {
  const supply = BigInt(liabilities.totalSupply);
  const noteScale = 10n ** BigInt(liabilities.noteDecimals);
  if (liabilities.nominalValueDecimals > unitDecimals) {
    throw new LiabilityUnresolved(
      `${liabilities.market}: par has ${liabilities.nominalValueDecimals} decimals, finer than the unit's ${unitDecimals}`,
      { market: liabilities.market },
    );
  }
  const parPerWholeNote = BigInt(liabilities.nominalValue) * 10n ** BigInt(unitDecimals - liabilities.nominalValueDecimals);
  if (supply % noteScale === 0n) return { notesOutstanding: supply / noteScale, parPerNote: parPerWholeNote };
  if (parPerWholeNote % noteScale !== 0n) {
    throw new LiabilityUnresolved(`${liabilities.market}: par cannot be stated per base unit without rounding`, {
      market: liabilities.market,
    });
  }
  return { notesOutstanding: supply, parPerNote: parPerWholeNote / noteScale };
}
