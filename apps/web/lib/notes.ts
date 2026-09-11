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

import type { Obligation } from './coverage-state';

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
  /** Nominated vaults from the notes file. Empty while the set is still being settled. */
  readonly nominatedVaults: readonly string[];
  readonly vaultSetSettled: boolean;
  /** The Base vaults the backing plan names for this note. */
  readonly plan: readonly VaultLeg[];
  readonly lifecycle: readonly LifecycleStep[];
  readonly listing: { readonly status: string; readonly why: string };
  readonly note: string;
}
