import type { BlockOutputJson, ObservedBlock, PositionJson, VaultBlockJson } from "./types.js";
import { ratesConsistentOf } from "./consistency.js";

export interface RateMark {
  readonly rate: string;
  readonly block: ObservedBlock;
}

export interface VaultObservation {
  readonly vb: VaultBlockJson;
  readonly block: ObservedBlock;
  /** Entry and exit are kept apart and carried forward separately: a block with only withdrawals must not erase the last entry rate. */
  readonly lastEntry: RateMark | null;
  readonly lastExit: RateMark | null;
}

export interface SeriesPoint {
  readonly block: string;
  readonly blockHash: string;
  readonly timestamp: number;
  readonly statePrice: string | null;
  readonly entryRate: string | null;
  readonly exitRate: string | null;
  readonly tvlUsd: string | null;
  readonly totalAssetsNorm: string | null;
  readonly netAssetsNorm: string | null;
  readonly netSharesNorm: string | null;
  readonly depositCount: number;
  readonly withdrawCount: number;
  readonly ratesConsistent: boolean;
}

export interface NoteReading {
  readonly block: ObservedBlock;
  readonly positions: readonly PositionJson[];
}

export interface Head extends ObservedBlock {
  readonly finalBlockHeight: bigint | null;
}

type Revert = () => void;

/**
 * Everything one network's stream has taught us, plus a journal that can undo
 * any block not yet final. With final-only streaming the journal stays empty.
 * At the head, a reorg arrives as an undo signal, and the state rolls back to
 * exactly what it was at the last valid block, so no later answer rests on an
 * orphaned block.
 */
export class FeedState {
  head: Head | null = null;
  cursor: string | null = null;
  /** First block this state has applied; series requests older than this go to a range request. */
  firstBlock: bigint | null = null;
  readonly vaults = new Map<string, VaultObservation>();
  readonly series = new Map<string, SeriesPoint[]>();
  readonly notes = new Map<string, NoteReading>();
  private journal: { block: bigint; reverts: Revert[] }[] = [];

  constructor(readonly maxPoints: number) {}

  applyBlock(block: ObservedBlock, finalBlockHeight: bigint | null, cursor: string, out: BlockOutputJson | undefined): void {
    const reverts: Revert[] = [];
    const prevHead = this.head;
    const prevCursor = this.cursor;
    reverts.push(() => {
      this.head = prevHead;
      this.cursor = prevCursor;
    });
    if (this.firstBlock === null) {
      this.firstBlock = block.number;
      reverts.push(() => {
        this.firstBlock = null;
      });
    }

    for (const vb of out?.vaults ?? []) {
      const key = vb.vault.toLowerCase();
      const prev = this.vaults.get(key);
      const obs: VaultObservation = {
        vb,
        block,
        lastEntry: vb.entryRate ? { rate: vb.entryRate, block } : (prev?.lastEntry ?? null),
        lastExit: vb.exitRate ? { rate: vb.exitRate, block } : (prev?.lastExit ?? null),
      };
      this.vaults.set(key, obs);
      reverts.push(() => (prev ? this.vaults.set(key, prev) : this.vaults.delete(key)));

      let points = this.series.get(key);
      if (!points) {
        points = [];
        this.series.set(key, points);
      }
      const arr = points;
      arr.push(pointOf(vb, block));
      // Trimming is not journalled: undo only has to remove what this block
      // added, and a point trimmed off the far end is history, not state.
      if (arr.length > this.maxPoints) arr.splice(0, arr.length - this.maxPoints);
      reverts.push(() => {
        arr.pop();
      });
    }

    if (out?.positionsRead) {
      const byNote = new Map<string, PositionJson[]>();
      for (const p of out.positions ?? []) {
        const k = (p.note ?? "").toLowerCase();
        const list = byNote.get(k) ?? [];
        list.push(p);
        byNote.set(k, list);
      }
      for (const [note, positions] of byNote) {
        const prev = this.notes.get(note);
        this.notes.set(note, { block, positions });
        reverts.push(() => (prev ? this.notes.set(note, prev) : this.notes.delete(note)));
      }
    }

    this.head = { ...block, finalBlockHeight };
    this.cursor = cursor;
    this.journal.push({ block: block.number, reverts });
    if (finalBlockHeight !== null) this.journal = this.journal.filter((j) => j.block > finalBlockHeight);
  }

  /** Roll back every block above `lastValid`, newest first. */
  undoTo(lastValid: bigint, cursor: string): number {
    let undone = 0;
    while (this.journal.length && this.journal[this.journal.length - 1]!.block > lastValid) {
      const entry = this.journal.pop()!;
      for (const r of entry.reverts.reverse()) r();
      undone++;
    }
    this.cursor = cursor;
    return undone;
  }
}

function pointOf(vb: VaultBlockJson, block: ObservedBlock): SeriesPoint {
  return {
    block: block.number.toString(),
    blockHash: block.hash,
    timestamp: block.timestamp,
    statePrice: vb.stateOk ? (vb.statePrice ?? null) : null,
    entryRate: vb.entryRate ?? null,
    exitRate: vb.exitRate ?? null,
    tvlUsd: vb.tvlUsd ?? null,
    totalAssetsNorm: vb.stateOk ? (vb.totalAssetsNorm ?? null) : null,
    netAssetsNorm: vb.netAssetsNorm ?? null,
    netSharesNorm: vb.netSharesNorm ?? null,
    depositCount: vb.depositCount ?? 0,
    withdrawCount: vb.withdrawCount ?? 0,
    ratesConsistent: ratesConsistentOf(vb),
  };
}

export function observedOf(number: bigint, hash: string, timestamp: number): ObservedBlock {
  return { number, hash: hash.startsWith("0x") ? hash : `0x${hash}`, timestamp };
}
