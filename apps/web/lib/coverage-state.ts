/**
 * How a note can stand, and how each state is allowed to be shown.
 *
 * Three kinds of refusal, kept apart everywhere:
 *
 *  - asset family   — a finding about the note. `short` and `no-positions` both carry a
 *                     figure, because the figure is the finding.
 *  - evidence family— a statement about our own proof. It never carries a figure, whether
 *                     the true position is high or low.
 *  - compliance     — the ATS note refusing a blacklisted counterparty. Not a coverage
 *                     state at all, and never rendered as one.
 *
 * Coverage is reported in basis points, so anything under 0.005% floors to zero: a note
 * holding $15 against $1,000,000 prints the same "0.00%" as a note holding nothing. The
 * two are completely different findings, so `CoverageReadout` renders the amounts in full
 * and treats the percentage as the summary. Nothing in the app prints a ratio alone.
 */

export type AssetFamily = 'covered' | 'short' | 'no-positions';
export type EvidenceReason =
  | 'no-reading-yet'
  | 'no-attestation'
  | 'attestation-expired'
  | 'data-stale'
  | 'vault-unresolved'
  | 'sources-disagree';

/** What the note owes, read from its own chain: supply × nominal value. Never configured. */
export interface Obligation {
  /** Base units of `totalSupply()`. */
  readonly units: number;
  /** `decimals()`. */
  readonly decimals: number;
  /** `getNominalValue()`. */
  readonly nominalValue: number;
  /** `getNominalValueDecimals()`. */
  readonly nominalValueDecimals: number;
  readonly currency: string;
}

export type CoverageState =
  | { readonly family: AssetFamily; readonly backingUsd: number }
  | { readonly family: 'evidence'; readonly reason: EvidenceReason };

export const isRefusal = (state: CoverageState): boolean => state.family !== 'covered';

/** An evidence refusal has no figure. Asking for one is a bug, so the type forbids it. */
export const hasFigure = (state: CoverageState): state is { family: AssetFamily; backingUsd: number } =>
  state.family !== 'evidence';

/** Notes outstanding, as a decimal count. */
export const notesOutstanding = (o: Obligation): number => o.units / 10 ** o.decimals;

/** Par value of one note. */
export const parPerNote = (o: Obligation): number => o.nominalValue / 10 ** o.nominalValueDecimals;

/** What the note owes in full: supply × nominal. The denominator of every ratio. */
export const obligationValue = (o: Obligation): number => notesOutstanding(o) * parPerNote(o);

/** Basis points of coverage, floored the way the feed floors them. */
export const coverageBps = (backingUsd: number, o: Obligation): number => {
  const owed = obligationValue(o);
  if (owed <= 0) return 0;
  return Math.round((backingUsd / owed) * 10_000);
};

export const LINE_BPS = 10_000;

/** Which asset-family state a reading lands in, once the vaults have been read. */
export function assetStateFor(backingUsd: number, o: Obligation): CoverageState {
  if (backingUsd <= 0) return { family: 'no-positions', backingUsd: 0 };
  return { family: coverageBps(backingUsd, o) >= LINE_BPS ? 'covered' : 'short', backingUsd };
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatUsd = (value: number): string => usd.format(value);
export const formatAmount = (value: number): string => plain.format(value);
export const formatBps = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/** The one-line summary of a state, in the app's own words. */
export function describeState(state: CoverageState): { word: string; detail: string } {
  switch (state.family) {
    case 'covered':
      return { word: 'Covered', detail: 'Backing at or above the line.' };
    case 'short':
      return { word: 'Short', detail: 'A finding about the note: the position is real and it is under the line.' };
    case 'no-positions':
      return {
        word: 'No positions',
        detail: 'A finding about the note: the vaults are registered and the holder holds nothing in them.',
      };
    case 'evidence':
      return { word: 'Unproven', detail: EVIDENCE_DETAIL[state.reason] };
  }
}

export const EVIDENCE_DETAIL: Record<EvidenceReason, string> = {
  'no-reading-yet': 'No position reading yet. The vault set changed, and the first live reading has not landed.',
  'no-attestation': 'The oracle holds no attestation for this note, so there is nothing to read a figure from.',
  'attestation-expired': 'The last attestation has expired. An expired attestation is not evidence, so there is no figure.',
  'data-stale': 'The last reading is older than the freshness bound, so it is no longer evidence.',
  'vault-unresolved': 'A vault in the set returned no usable reading.',
  'sources-disagree': 'Two independent endpoints disagreed about the same position.',
};

/** The reason code the service would sign for this state. */
export function reasonCode(state: CoverageState): string | null {
  switch (state.family) {
    case 'covered':
      return null;
    case 'short':
      return 'coverage_below_floor';
    case 'no-positions':
      return 'no_attributable_positions';
    case 'evidence':
      // The two oracle reasons are shown under the oracle's own names, because that is
      // what a reader will find on chain; the rest are the attestation service's codes.
      if (state.reason === 'no-attestation') return 'NoAttestation';
      if (state.reason === 'attestation-expired') return 'AttestationExpired';
      return state.reason === 'no-reading-yet' ? 'source_unavailable' : state.reason.replace(/-/g, '_');
  }
}
