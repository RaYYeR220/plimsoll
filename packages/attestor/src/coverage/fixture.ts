import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../canonical.js";
import {
  type CoverageSnapshot,
  type CoverageSource,
  type SourceSetDescriptor,
  type VaultPosition,
  SourcesDisagree,
  SourceUnavailable,
  VaultSetDrift,
  VaultUnresolved,
} from "./types.js";
import { LiabilityUnresolved } from "./live-errors.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Fixture file shape. Amounts are decimal strings so they survive JSON exactly. */
export interface FixtureNote {
  noteId: string;
  /**
   * The vault-set hash the note is registered with on the oracle. Older
   * taxonomy fixtures predate the field and fall back to the hash of their own
   * nominated set, which is what the registry would hold for them.
   */
  registeredVaultSetHash?: string;
  /**
   * The note's load line in basis points, standing in for `LoadLine.lineOf`.
   * A fixture without one models a note whose line could not be read, which is
   * an evidence refusal — never a fallback to a configured default.
   */
  thresholdBps?: number;
  holder: string;
  nominatedVaults: string[];
  notesOutstanding: string;
  parPerNote: string;
  unitDecimals: number;
  asOfBlock: string;
  /** Fixed unix seconds, or a negative value meaning that many seconds before now. */
  observedAt: number;
  sourceSet: SourceSetDescriptor;
  positions: Array<{
    vault: string;
    shares: string;
    declaredShares?: string;
    /** Absent models a vault whose convertToAssets call did not resolve. */
    assets?: string | null;
    assetDecimals: number;
    blockNumber: string;
    /** A second endpoint reading, present only to model disagreement. */
    secondaryAssets?: string;
  }>;
}

export interface FixtureSourceOptions {
  /** Injected clock, so staleness cases are deterministic under test. */
  now?: () => number;
  /** Tolerance used when a fixture carries a second endpoint reading. */
  crossSourceToleranceBps?: number;
}

/**
 * Deterministic coverage source backed by checked-in JSON.
 *
 * This is what runs in the offline demo and in every test. It is not a
 * simplification of the live source: it implements the same contract, including
 * every failure mode, which is why the refusal paths can be exercised without a
 * chain. Its id is `fixture`, and that id is written into every anchored record
 * it produces, so a reading it invented can never be mistaken for a live one.
 * See MOCKS.md.
 */
export class FixtureCoverageSource implements CoverageSource {
  readonly id = "fixture";
  private readonly notes: Map<string, FixtureNote>;
  private readonly now: () => number;
  private readonly toleranceBps: number;

  constructor(options: FixtureSourceOptions = {}, notes?: FixtureNote[]) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.toleranceBps = options.crossSourceToleranceBps ?? 10;
    const loaded = notes ?? loadFixtures();
    this.notes = new Map(loaded.map((n) => [n.noteId.toUpperCase(), n]));
  }

  /** Note ids this source knows about, for the demo and for tests. */
  knownNotes(): string[] {
    return [...this.notes.keys()].sort();
  }

  async positionsFor(noteId: string, atBlock?: bigint): Promise<CoverageSnapshot> {
    const note = this.notes.get(noteId.toUpperCase());
    if (!note) {
      // An unknown note is not a refusal: there is no asset to make a finding
      // about, and no evidence of ours that failed. The server turns this into
      // a 404 rather than a signed verdict.
      throw new UnknownNote(noteId);
    }
    if (note.sourceSet.kind === "unreachable") {
      throw new SourceUnavailable(`fixture models an unreachable source for ${note.noteId}`, {
        dataset: note.sourceSet.dataset,
      });
    }

    if (note.thresholdBps === undefined) {
      // The denominator side is never defaulted. Without a line there is nothing
      // to measure against, and inventing one would decide a charge.
      throw new LiabilityUnresolved(`${note.noteId}: no load line could be read`, {
        market: note.noteId,
      });
    }

    const nominated = [...note.nominatedVaults].map(lower).sort();
    const observed = note.positions.map((p) => lower(p.vault)).sort();
    if (!sameSet(nominated, observed)) throw new VaultSetDrift(nominated, observed);

    const positions: VaultPosition[] = note.positions.map((p) => {
      if (p.assets === undefined || p.assets === null) {
        throw new VaultUnresolved(lower(p.vault), `convertToAssets did not resolve for ${p.vault}`);
      }
      const assets = BigInt(p.assets);
      if (p.secondaryAssets !== undefined) {
        const secondary = BigInt(p.secondaryAssets);
        if (!withinTolerance(assets, secondary, this.toleranceBps)) {
          throw new SourcesDisagree(lower(p.vault), p.assets, p.secondaryAssets, this.toleranceBps);
        }
      }
      const shares = BigInt(p.shares);
      return {
        vault: lower(p.vault),
        shares,
        declaredShares: p.declaredShares === undefined ? shares : BigInt(p.declaredShares),
        assets,
        assetDecimals: p.assetDecimals,
        blockNumber: BigInt(p.blockNumber),
      };
    });

    return {
      noteId: note.noteId,
      registeredVaultSetHash: note.registeredVaultSetHash ?? canonicalHash(nominated),
      thresholdBps: note.thresholdBps,
      holder: lower(note.holder),
      nominatedVaults: nominated,
      // Sorted so the vault-set hash never depends on fixture file ordering.
      positions: [...positions].sort((a, b) => (a.vault < b.vault ? -1 : a.vault > b.vault ? 1 : 0)),
      notesOutstanding: BigInt(note.notesOutstanding),
      parPerNote: BigInt(note.parPerNote),
      unitDecimals: note.unitDecimals,
      asOfBlock: atBlock ?? BigInt(note.asOfBlock),
      observedAt: note.observedAt < 0 ? this.now() + note.observedAt : note.observedAt,
      sourceSet: note.sourceSet,
    };
  }
}

/** Thrown for a note the source has never heard of. Not a refusal. */
export class UnknownNote extends Error {
  readonly noteId: string;
  constructor(noteId: string) {
    super(`unknown note: ${noteId}`);
    this.name = "UnknownNote";
    this.noteId = noteId;
  }
}

function loadFixtures(): FixtureNote[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as FixtureNote);
}

function lower(address: string): string {
  return address.toLowerCase();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function withinTolerance(left: bigint, right: bigint, toleranceBps: number): boolean {
  if (left === right) return true;
  const base = left > right ? left : right;
  if (base === 0n) return false;
  const delta = left > right ? left - right : right - left;
  return (delta * 10_000n) / base <= BigInt(toleranceBps);
}
