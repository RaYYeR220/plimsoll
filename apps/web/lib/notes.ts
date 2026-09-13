/**
 * The two notes, assembled from the records the other packages already keep.
 *
 * Server-side only: the deployment records are read here and the pages hand the client
 * components plain objects, so none of these files reach the browser.
 *
 * Sources, in order of authority:
 *  - packages/substreams/notes.json          the note definitions (market, chain, vault set)
 *  - packages/contracts/deployments/*.json   what is deployed, issued and wired on Hedera
 *  - packages/backing/src/config.ts          the Base vault plan (TypeScript, mirrored in
 *                                            site.config.ts until it is emitted as JSON)
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
  /** Planned deposit in the vault's asset. The deposits are not recorded as made. */
  readonly planned: number | 'rest';
  readonly href: string;
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
  /** The Base vaults the backing plan names for this note. */
  readonly plan: readonly VaultLeg[];
  /**
   * What the plan puts behind this note, in dollars. Planned, not deposited, and used
   * only so a negative control can show its real character instead of a derived figure.
   */
  readonly plannedBackingUsd?: number;
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
