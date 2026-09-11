import type { ChainReader, NoteFacts } from "./chain.js";
import { ChainReadError } from "./chain.js";
import { vaultSetHash } from "./canonical.js";
import type { Config, NetworkName } from "./config.js";
import { NETWORKS } from "./config.js";
import type { FeedHandle } from "./feed.js";
import { ratesConsistentOf } from "./consistency.js";
import { diffBps, toScaled } from "./fixed.js";
import type { NotesFile } from "./notes.js";
import { overlappingVaults } from "./notes.js";
import type { ChainRead, Provenance } from "./provenance.js";
import { isoOf, withoutQuantities } from "./provenance.js";
import type { EvidenceRefusal, Refusal } from "./refusals.js";
import { assetRefusal, evidenceRefusal } from "./refusals.js";
import type { LoadedPackage } from "./spkg.js";
import type { SeriesPoint } from "./state.js";
import type { ObservedBlock } from "./types.js";

export interface RangeResult {
  readonly points: readonly SeriesPoint[];
  readonly provenance: Provenance;
}

/** A bounded one-off Substreams request, for series that reach back past the in-memory buffer. */
export interface RangeRunner {
  vaultSeries(network: NetworkName, vault: string, fromBlock: bigint, toBlock: bigint): Promise<RangeResult | EvidenceRefusal>;
}

export interface CoverageArithmetic {
  normalise(amount: bigint, from: number, to: number): bigint;
  coverageBpsOf(attributable: bigint, obligation: bigint): number;
}

export interface ToolDeps {
  readonly config: Config;
  readonly loaded: LoadedPackage;
  readonly feeds: ReadonlyMap<NetworkName, FeedHandle>;
  readonly notes: () => NotesFile;
  readonly chain: ChainReader;
  /** The holder each note's map_positions params were built with at stream start. */
  readonly streamedHolders: ReadonlyMap<string, string>;
  readonly coverage: CoverageArithmetic;
  readonly range: RangeRunner | null;
  readonly now: () => number;
  readonly slots?: { readonly capacity: number; readonly inUse: number };
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

// See consistency.ts for the one case the package's own flag misses.
const ratesConsistent = ratesConsistentOf;

// ---------------------------------------------------------------------------
// provenance and feed gating

export function provenanceOf(
  deps: ToolDeps,
  network: NetworkName | null,
  block: ObservedBlock | null,
  reads?: readonly ChainRead[],
): Provenance {
  const feed = network ? deps.feeds.get(network) : undefined;
  const spec = network ? deps.config.networks[network] : null;
  const head = feed?.state.head ?? null;
  const nowS = deps.now() / 1000;
  const finalHeight = head?.finalBlockHeight ?? null;
  return {
    provider: "The Graph Market",
    transport: "substreams",
    endpoint: spec?.endpoint ?? null,
    network,
    package: { name: deps.loaded.name, version: deps.loaded.version, sha256: deps.loaded.sha256 },
    module: { name: feed?.outputModule ?? deps.config.outputModule, hash: feed?.moduleHash ?? "not-streaming" },
    finalBlocksOnly: spec?.finalBlocksOnly ?? null,
    block: block
      ? {
          number: block.number.toString(),
          hash: block.hash,
          timestamp: isoOf(block.timestamp),
          final: spec?.finalBlocksOnly ? true : finalHeight !== null ? block.number <= finalHeight : null,
        }
      : null,
    head: head
      ? {
          number: head.number.toString(),
          hash: head.hash,
          timestamp: isoOf(head.timestamp),
          lagSeconds: Math.max(0, Math.round(nowS - head.timestamp)),
          finalBlockHeight: finalHeight === null ? null : finalHeight.toString(),
        }
      : null,
    builtAt: new Date(deps.now()).toISOString(),
    ...(reads ? { reads } : {}),
  };
}

type Gate = { readonly feed: FeedHandle } | EvidenceRefusal;

/**
 * Every figure-bearing answer passes through here first. A feed that is not
 * connected, still warming up, or whose head has fallen behind yields a
 * refusal instead of the last good number. An interface can live with a stale
 * number; an agent that acts on one cannot.
 */
export function gateFeed(deps: ToolDeps, network: NetworkName): Gate {
  const feed = deps.feeds.get(network);
  if (!feed) {
    return evidenceRefusal("source_unavailable", provenanceOf(deps, network, null), {
      network,
      cause: "network_not_streamed",
      hint: `this server streams: ${[...deps.feeds.keys()].join(", ") || "nothing"}`,
    });
  }
  const head = feed.state.head;
  if (!head) {
    return evidenceRefusal("source_unavailable", provenanceOf(deps, network, null), {
      network,
      status: feed.status,
      cause: feed.lastError?.kind ?? (feed.status === "warming" ? "warming_up" : "no_data_yet"),
    });
  }
  const lag = deps.now() / 1000 - head.timestamp;
  if (lag > feed.spec.headMaxLagSeconds) {
    return evidenceRefusal("data_stale", provenanceOf(deps, network, null), {
      network,
      stale: "stream_head",
      status: feed.status,
      ...(feed.lastError ? { cause: feed.lastError.kind } : {}),
    });
  }
  return { feed };
}

function isRefusalGate(g: Gate): g is EvidenceRefusal {
  return (g as EvidenceRefusal).result === "refused";
}

function parseNetwork(n: unknown): NetworkName | null {
  return typeof n === "string" && (NETWORKS as readonly string[]).includes(n) ? (n as NetworkName) : null;
}

export class InputError extends Error {}

// ---------------------------------------------------------------------------
// vault_backing

export interface VaultBackingArgs {
  readonly network: string;
  readonly vault: string;
}

export function vaultBacking(deps: ToolDeps, args: VaultBackingArgs): Record<string, unknown> | Refusal {
  const network = parseNetwork(args.network);
  const vault = String(args.vault ?? "").toLowerCase();
  if (!network) throw new InputError(`network must be one of ${NETWORKS.join(", ")}`);
  if (!ADDRESS.test(vault)) throw new InputError("vault must be a 0x-prefixed 20-byte address");

  const gate = gateFeed(deps, network);
  if (isRefusalGate(gate)) return gate;
  const obs = gate.feed.state.vaults.get(vault);
  if (!obs) {
    return evidenceRefusal("vault_unresolved", provenanceOf(deps, network, null), {
      vault,
      cause: "no_conforming_flow_observed",
      hint: "the package emits a vault once it has passed the asset() probe and had a Deposit or Withdraw since the stream's start",
    });
  }
  const vb = obs.vb;
  const prov = provenanceOf(deps, network, obs.block);
  if (vb.verification === "VERIFICATION_REJECTED") {
    return evidenceRefusal("vault_unresolved", prov, { vault, cause: "asset_probe_rejected" });
  }
  if (!vb.stateOk) {
    return evidenceRefusal("vault_unresolved", prov, { vault, cause: "total_assets_or_supply_reverted" });
  }
  if (!ratesConsistent(vb)) {
    return evidenceRefusal("vault_unresolved", prov, {
      vault,
      cause: "event_rates_inconsistent_with_vault_price",
      hint: "Deposit/Withdraw amounts do not match this contract's own totalAssets/totalSupply; its events do not follow ERC-4626 accounting",
    });
  }
  if (deps.now() / 1000 - obs.block.timestamp > deps.config.maxStalenessSeconds) {
    return evidenceRefusal("data_stale", prov, {
      vault,
      stale: "vault_observation",
      policy: `maxStalenessSeconds=${deps.config.maxStalenessSeconds}`,
    });
  }

  return {
    result: "backing",
    network,
    vault,
    asset: { address: vb.asset ?? null, symbol: vb.assetSymbol ?? null, decimals: vb.assetDecimals ?? 0 },
    share: { symbol: vb.shareSymbol ?? null, decimals: vb.shareDecimals ?? 0 },
    totalAssets: { raw: vb.totalAssets ?? "0", normalised: vb.totalAssetsNorm ?? "0" },
    totalSupply: { raw: vb.totalSupply ?? "0", normalised: vb.totalSupplyNorm ?? "0" },
    sharePrice: vb.statePrice ?? null,
    sharePriceBasis: "totalAssets / totalSupply at the end of the observed block, decimals normalised",
    entryRate: obs.lastEntry ? { rate: obs.lastEntry.rate, block: obs.lastEntry.block.number.toString() } : null,
    exitRate: obs.lastExit ? { rate: obs.lastExit.rate, block: obs.lastExit.block.number.toString() } : null,
    ratesNote:
      "entry and exit are never blended: Deposit.assets is gross of entry fees and Withdraw.assets is net of exit fees, so entry >= price >= exit on a conforming vault",
    tvlUsd: vb.tvlUsd ?? null,
    assetPriceUsd: vb.assetPriceUsd ?? null,
    maxDeposit: vb.maxDeposit ?? null,
    verification: vb.verification ?? "VERIFICATION_UNSPECIFIED",
    ratesConsistent: true,
    provenance: prov,
  };
}

// ---------------------------------------------------------------------------
// vault_share_price_series

export interface SeriesArgs {
  readonly network: string;
  readonly vault: string;
  readonly fromBlock?: number | string;
  readonly toBlock?: number | string;
}

function asBlock(v: number | string | undefined, name: string): bigint | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new InputError(`${name} must be a block number`);
  return BigInt(s);
}

export async function vaultSharePriceSeries(deps: ToolDeps, args: SeriesArgs): Promise<Record<string, unknown> | Refusal> {
  const network = parseNetwork(args.network);
  const vault = String(args.vault ?? "").toLowerCase();
  if (!network) throw new InputError(`network must be one of ${NETWORKS.join(", ")}`);
  if (!ADDRESS.test(vault)) throw new InputError("vault must be a 0x-prefixed 20-byte address");
  const from = asBlock(args.fromBlock, "fromBlock");
  const to = asBlock(args.toBlock, "toBlock");
  if (from !== undefined && to !== undefined && to < from) throw new InputError("toBlock is before fromBlock");

  const feed = deps.feeds.get(network);
  const buffered = feed?.state.firstBlock ?? null;
  const inBuffer = feed && buffered !== null && (from === undefined || from >= buffered);

  let points: readonly SeriesPoint[];
  let prov: Provenance;
  let source: "stream_buffer" | "range_request";
  if (inBuffer) {
    // "Up to now" is a claim about the present, so the head has to be fresh
    // for it. An explicit toBlock at or below the head is history and can be
    // served as such.
    if (to === undefined || (feed.state.head && to > feed.state.head.number)) {
      const gate = gateFeed(deps, network);
      if (isRefusalGate(gate)) return gate;
    }
    const all = feed.state.series.get(vault) ?? [];
    points = all.filter((p) => (from === undefined || BigInt(p.block) >= from) && (to === undefined || BigInt(p.block) <= to));
    const last = points[points.length - 1];
    prov = provenanceOf(deps, network, last ? { number: BigInt(last.block), hash: last.blockHash, timestamp: last.timestamp } : null);
    source = "stream_buffer";
  } else {
    if (from === undefined || to === undefined) {
      throw new InputError("a range older than the live buffer needs both fromBlock and toBlock");
    }
    if (to - from + 1n > BigInt(deps.config.rangeMaxBlocks)) {
      throw new InputError(`range too large: at most ${deps.config.rangeMaxBlocks} blocks per request`);
    }
    if (!deps.range) {
      return evidenceRefusal("source_unavailable", provenanceOf(deps, network, null), { cause: "range_requests_disabled" });
    }
    const r = await deps.range.vaultSeries(network, vault, from, to);
    if ((r as Refusal).result === "refused") return r as EvidenceRefusal;
    ({ points, provenance: prov } = r as RangeResult);
    source = "range_request";
  }

  return {
    result: "series",
    network,
    vault,
    source,
    range: { fromBlock: from?.toString() ?? buffered?.toString() ?? null, toBlock: to?.toString() ?? feed?.state.head?.number.toString() ?? null },
    points,
    stats: seriesStats(points),
    provenance: prov,
  };
}

const YEAR_SECONDS = 31_557_600;

export function seriesStats(points: readonly SeriesPoint[]): Record<string, unknown> {
  const priced = points.filter((p) => p.statePrice !== null && p.ratesConsistent);
  const first = priced[0];
  const last = priced[priced.length - 1];
  let changeBps: number | null = null;
  let annualisedSimplePct: number | null = null;
  let annualisedCompoundPct: number | null = null;
  let elapsedSeconds: number | null = null;
  if (first && last && first !== last) {
    const a = toScaled(first.statePrice)!;
    const b = toScaled(last.statePrice)!;
    changeBps = diffBps(b, a);
    elapsedSeconds = last.timestamp - first.timestamp;
    if (changeBps !== null && elapsedSeconds > 0) {
      annualisedSimplePct = (changeBps / 100) * (YEAR_SECONDS / elapsedSeconds);
      annualisedCompoundPct = (Math.pow(1 + changeBps / 10_000, YEAR_SECONDS / elapsedSeconds) - 1) * 100;
    }
  }

  // EIP-4626 rounds against the user: a deposit never buys a share below the
  // vault's price and a withdrawal never redeems above it. A 1e-9 relative
  // tolerance absorbs interest accrued later in the same block.
  let entryChecked = 0;
  let entryHeld = 0;
  let exitChecked = 0;
  let exitHeld = 0;
  const spreads: number[] = [];
  for (const p of points) {
    const price = toScaled(p.statePrice);
    const entry = toScaled(p.entryRate);
    const exit = toScaled(p.exitRate);
    if (price !== null && entry !== null) {
      entryChecked++;
      if (entry * 1_000_000_000n >= price * 999_999_999n) entryHeld++;
    }
    if (price !== null && exit !== null) {
      exitChecked++;
      if (exit * 1_000_000_000n <= price * 1_000_000_001n) exitHeld++;
    }
    if (entry !== null && exit !== null) {
      const s = diffBps(entry, exit);
      if (s !== null) spreads.push(s);
    }
  }
  const sorted = [...spreads].sort((x, y) => x - y);
  return {
    points: points.length,
    pricedPoints: priced.length,
    inconsistentPoints: points.filter((p) => !p.ratesConsistent).length,
    firstPrice: first?.statePrice ?? null,
    lastPrice: last?.statePrice ?? null,
    changeBps,
    elapsedSeconds,
    annualisedSimplePct,
    annualisedCompoundPct,
    annualisedNote: "price growth only; extrapolated from the observed window and not a forecast",
    entryExitSpreadBps: sorted.length
      ? { samples: sorted.length, median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] }
      : null,
    eip4626Ordering: {
      entryAtOrAbovePrice: `${entryHeld}/${entryChecked}`,
      exitAtOrBelowPrice: `${exitHeld}/${exitChecked}`,
      held: entryHeld === entryChecked && exitHeld === exitChecked,
    },
  };
}

// ---------------------------------------------------------------------------
// note_coverage

export interface NoteCoverageArgs {
  readonly noteId: string;
}

function attestationPointer(deps: ToolDeps, noteId: string): Record<string, unknown> {
  return {
    signedAttestation: `${deps.config.attestorUrl}/attest?noteId=${noteId}`,
    method: "GET",
    payment:
      "x402 v2, scheme exact, 0.001 HBAR on hedera:testnet. The 402 challenge arrives in the PAYMENT-REQUIRED header; pay with PAYMENT-SIGNATURE. Refusals (HTTP 422 asset, 424 evidence) settle nothing and cost nothing.",
    note: "this answer is unsigned evidence for an agent's own reasoning; a figure another party must rely on should come from the attestor, which signs it and anchors it on HCS",
  };
}

function evidence(
  reason: EvidenceRefusal["reason"],
  prov: Provenance,
  detail: Record<string, string | boolean | readonly string[]>,
  deps: ToolDeps,
  noteId: string,
): EvidenceRefusal & { attestation: Record<string, unknown> } {
  return { ...evidenceRefusal(reason, withoutQuantities(prov), detail), attestation: attestationPointer(deps, noteId) };
}

export async function noteCoverage(deps: ToolDeps, args: NoteCoverageArgs): Promise<Record<string, unknown> | Refusal> {
  const noteId = String(args.noteId ?? "").toLowerCase();
  if (!BYTES32.test(noteId)) throw new InputError("noteId must be the note's bytes32 id (keccak256 of its market code)");
  const entry = deps.notes().notes.get(noteId);
  if (!entry) {
    return { result: "unknown_note", noteId, known: [...deps.notes().notes.keys()], provenance: provenanceOf(deps, null, null) };
  }
  const network = entry.network;
  const base = (reads?: readonly ChainRead[], block: ObservedBlock | null = null) => provenanceOf(deps, network, block, reads);

  if (!entry.registry) {
    return evidence("source_unavailable", base(), { noteId, cause: "no_registry_configured" }, deps, noteId);
  }

  let facts: NoteFacts;
  try {
    facts = await deps.chain.noteFacts(noteId, entry.registry);
  } catch (error) {
    const e = error as ChainReadError;
    return evidence(
      "source_unavailable",
      base(),
      { noteId, cause: "registry_read_failed", read: e.method ?? "unknown", contract: e.contract ?? "unknown" },
      deps,
      noteId,
    );
  }
  const reads = facts.reads;
  if (!facts.registered) {
    return { result: "unknown_note", noteId, cause: "not registered in CoverageOracle", provenance: base(reads) };
  }
  if (facts.holder === null) {
    return evidence("source_unavailable", base(reads), { noteId, cause: "issuer_ambiguous", hint: "the note's ISSUER_ROLE must have exactly one member" }, deps, noteId);
  }

  const localHash = vaultSetHash(entry.vaults);
  if (localHash !== facts.onchainVaultSetHash) {
    return evidence(
      "vault_set_drift",
      base(reads),
      { noteId, notesFileVaultSetHash: localHash, onchainVaultSetHash: facts.onchainVaultSetHash, vaults: [...entry.vaults] },
      deps,
      noteId,
    );
  }
  const holderOf = (id: string) => (id === noteId ? facts.holder! : deps.streamedHolders.get(id));
  const overlaps = overlappingVaults(deps.notes(), noteId, holderOf);
  if (overlaps.length) {
    return evidence(
      "vault_set_drift",
      base(reads),
      { noteId, cause: "vault_backs_another_note", otherNotes: overlaps.map((o) => o.otherNote), vaults: overlaps.flatMap((o) => o.vaults) },
      deps,
      noteId,
    );
  }
  if (!facts.lineConfigured) {
    return evidence("source_unavailable", base(reads), { noteId, cause: "load_line_unset" }, deps, noteId);
  }
  if (facts.currency !== "USD") {
    return evidence("vault_unresolved", base(reads), { noteId, cause: "note_currency_not_usd", currency: facts.currency }, deps, noteId);
  }

  const gate = gateFeed(deps, network);
  if (isRefusalGate(gate)) return { ...gate, provenance: withoutQuantities(base(reads)), attestation: attestationPointer(deps, noteId) };
  const streamed = deps.streamedHolders.get(noteId);
  if (streamed !== facts.holder) {
    return evidence(
      "source_unavailable",
      base(reads),
      { noteId, cause: streamed ? "issuer_changed_since_stream_start" : "note_not_in_stream_params", hint: "restart the server so map_positions follows the current issuer" },
      deps,
      noteId,
    );
  }
  const reading = gate.feed.state.notes.get(noteId);
  if (!reading) {
    return evidence("source_unavailable", base(reads), { noteId, cause: "no_position_reading_yet" }, deps, noteId);
  }
  const prov = base(reads, reading.block);
  if (deps.now() / 1000 - reading.block.timestamp > deps.config.maxStalenessSeconds) {
    return evidence("data_stale", prov, { noteId, stale: "position_reading", policy: `maxStalenessSeconds=${deps.config.maxStalenessSeconds}` }, deps, noteId);
  }
  const seen = [...new Set(reading.positions.map((p) => (p.vault ?? "").toLowerCase()))].sort();
  if (seen.join(",") !== [...entry.vaults].sort().join(",")) {
    return evidence("vault_set_drift", prov, { noteId, cause: "stream_reads_a_different_vault_set", streamed: seen, nominated: [...entry.vaults] }, deps, noteId);
  }
  for (const p of reading.positions) {
    const vault = (p.vault ?? "").toLowerCase();
    if (p.holder?.toLowerCase() !== facts.holder) {
      return evidence("source_unavailable", prov, { noteId, vault, cause: "position_read_for_another_holder" }, deps, noteId);
    }
    if (!p.ok) return evidence("vault_unresolved", prov, { noteId, vault, cause: "balanceOf_or_convertToAssets_reverted" }, deps, noteId);
    if (p.verification === "VERIFICATION_REJECTED") {
      return evidence("vault_unresolved", prov, { noteId, vault, cause: "asset_probe_rejected" }, deps, noteId);
    }
    if (p.lastFlowBlock && p.lastFlowBlock !== "0" && !p.ratesConsistent) {
      return evidence("vault_unresolved", prov, { noteId, vault, cause: "event_rates_inconsistent_with_vault_price" }, deps, noteId);
    }
    if (p.assetPriceUsd !== "1") {
      return evidence("vault_unresolved", prov, { noteId, vault, cause: "underlying_not_a_usd_stablecoin_at_peg" }, deps, noteId);
    }
  }

  // Obligation = supply × par, exact, carried at supply decimals + par
  // decimals so no truncation touches the liability side. Vault assets are
  // brought to the same decimals with the attestor's own normalise(), which
  // truncates against the issuer.
  const unitDecimals = facts.noteDecimals + facts.nominalDecimals;
  const obligation = facts.totalSupply * facts.nominal;
  if (obligation <= 0n) {
    return evidence("source_unavailable", prov, { noteId, cause: "no_outstanding_obligation" }, deps, noteId);
  }
  const positions = reading.positions.map((p) => {
    const assets = BigInt(p.assets ?? "0");
    const decimals = p.assetDecimals ?? 0;
    return {
      vault: (p.vault ?? "").toLowerCase(),
      asset: p.asset ?? null,
      shares: p.shares ?? "0",
      assets: assets.toString(),
      assetDecimals: decimals,
      normalisedAssets: deps.coverage.normalise(assets, decimals, unitDecimals).toString(),
      valueUsd: p.valueUsd ?? null,
    };
  });
  const attributable = positions.reduce((s, p) => s + BigInt(p.normalisedAssets), 0n);
  const coverageBps = deps.coverage.coverageBpsOf(attributable, obligation);
  const figures = {
    noteId,
    market: entry.market,
    holder: facts.holder,
    unitDecimals,
    obligation: obligation.toString(),
    attributable: attributable.toString(),
    positions,
    negativeControl: entry.negativeControl,
  };
  const held = positions.some((p) => BigInt(p.shares) > 0n);
  if (!held) {
    return { ...assetRefusal("no_attributable_positions", 0, facts.thresholdBps, prov, figures), attestation: attestationPointer(deps, noteId) };
  }
  if (coverageBps < facts.thresholdBps) {
    return { ...assetRefusal("coverage_below_floor", coverageBps, facts.thresholdBps, prov, figures), attestation: attestationPointer(deps, noteId) };
  }
  return {
    result: "covered",
    coverageBps,
    thresholdBps: facts.thresholdBps,
    ...figures,
    // A negative control that clears is a defect in the pipeline, not good news.
    ...(entry.negativeControl ? { controlViolated: true } : {}),
    provenance: prov,
    attestation: attestationPointer(deps, noteId),
  };
}

// ---------------------------------------------------------------------------
// feed_status

export function feedStatus(deps: ToolDeps): Record<string, unknown> {
  const networks: Record<string, unknown> = {};
  for (const n of NETWORKS) {
    const feed = deps.feeds.get(n);
    networks[n] = feed
      ? {
          streaming: true,
          status: feed.status,
          lastError: feed.lastError,
          finalBlocksOnly: feed.spec.finalBlocksOnly,
          headMaxLagSeconds: feed.spec.headMaxLagSeconds,
          vaultsTracked: feed.state.vaults.size,
          notesWithReadings: [...feed.state.notes.keys()],
          bufferedFromBlock: feed.state.firstBlock?.toString() ?? null,
          provenance: provenanceOf(deps, n, null),
        }
      : { streaming: false };
  }
  return {
    result: "status",
    maxStalenessSeconds: deps.config.maxStalenessSeconds,
    streamSlots: deps.slots ? { capacity: deps.slots.capacity, inUse: deps.slots.inUse } : null,
    networks,
  };
}
