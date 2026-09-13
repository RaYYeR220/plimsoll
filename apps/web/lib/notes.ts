/**
 * The two notes, assembled from the records the other packages already keep.
 *
 * Server-side only: the deployment records are read here and the pages hand the client
 * components plain objects, so none of these files reach the browser.
 *
 * Sources, in order of authority:
 *  - packages/substreams/notes.json          the note definitions (market, chain, vault set)
 *  - packages/contracts/deployments/*.json   what is deployed, issued and wired on Hedera
 *  - packages/backing/backing-plan.json      the Base vaults each note is backed by, and the plan
 */

import type { CoverageState, Obligation } from './coverage-state';

export interface LifecycleStep {
  readonly step: string;
  readonly tx: string;
  readonly href: string;
  readonly result: string;
}

export interface VaultLeg {
  readonly key: string;
  readonly name: string;
  readonly protocol: string;
  readonly address: string;
  readonly asset: string;
  /** The planned deposit in the vault's asset, or "rest" for what the funding left over. */
  readonly planned: number | 'rest';
  /** Bounds on a "rest" leg, from the plan. */
  readonly min?: number;
  readonly max?: number;
  /** What the position was worth when the vaults were read, in USDC to six places. */
  readonly funded: string | null;
  readonly href: string;
}

/** A reading of the holder's positions on Base. A reading, not an attestation. */
export interface PositionReading {
  readonly chain: string;
  readonly block: number;
  /** ISO-8601 UTC timestamp of that block. */
  readonly readAt: string;
  readonly totalUsdc: string;
  readonly totalUsd: number;
}

export interface NoteRecord {
  readonly market: string;
  readonly name: string;
  readonly isin: string;
  readonly hederaId: string;
  readonly address: string;
  readonly href: string;
  readonly noteId: string;
  readonly obligation: Obligation;
  readonly thresholdBps: number;
  /** The device-approved mandate that set the threshold. */
  readonly thresholdMandate: { readonly tx: string; readonly href: string } | null;
  readonly negativeControl: boolean;
  /** Nominated vaults from the notes file. Empty until the set is final. */
  readonly nominatedVaults: readonly string[];
  readonly vaultSetSettled: boolean;
  /**
   * What CoverageOracle says about the note, read from chain on `readOn`. This is the
   * seam the live feed replaces: until it is wired, the app shows this reading and
   * says when it was taken.
   */
  readonly oracle: { readonly verdict: string; readonly reason: string; readOn: string };
  /** The same reading, as the state the screens draw. */
  readonly recorded: CoverageState;
  /** Records on the audit topic that name this note. */
  readonly recordSeqs: readonly number[];
  /** The last attestation CoverageOracle accepted for this note, fresh or not. */
  readonly lastAttestation?: {
    readonly tx: string;
    readonly href: string;
    readonly acceptedAt: string;
    readonly coverageBps: number;
    readonly thresholdBps: number;
    /** What LoadLine.status read while it was fresh. */
    readonly loadLine: string;
    readonly asOfBlock: number;
    readonly expiresAt: string;
    readonly record: number;
  };
  /** The Base vaults backing this note, with what each held when last read. */
  readonly plan: readonly VaultLeg[];
  /**
   * The holder's positions for this note, read from the vaults. Also what a negative
   * control shows in a demonstration, so it never borrows a figure that would clear it.
   */
  readonly positions: PositionReading | null;
  /** What the plan does when tested on a fork: the case for the line, in measured steps. */
  readonly scenario?: ReadonlyArray<{
    readonly label: string;
    readonly coverage: string;
    readonly clear: boolean;
    readonly detail: string;
  }>;
  readonly lifecycle: readonly LifecycleStep[];
  readonly listing: { readonly status: string; readonly why: string };
  readonly note: string;
}
