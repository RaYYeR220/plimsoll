'use client';

import {
  coverageBps,
  describeState,
  formatAmount,
  formatBps,
  formatUsd,
  hasFigure,
  notesOutstanding,
  obligationValue,
  parPerNote,
  reasonCode,
  type CoverageState,
  type Obligation,
} from '@/lib/coverage-state';
import styles from './app.module.css';

/**
 * The one place a coverage figure is allowed to be printed.
 *
 * A percentage never stands on its own: $1.00 against $1,000,000 and nothing at all both
 * round to 0.00%, and they are different findings. So the amounts are always beside it, and
 * an evidence refusal shows no figure at all — only what the note owes, which is a fact
 * about the note rather than a reading of its backing.
 */
export function CoverageReadout({
  state,
  obligation,
  size = 'panel',
}: {
  state: CoverageState;
  obligation: Obligation;
  size?: 'panel' | 'card';
}) {
  const owed = obligationValue(obligation);
  const { word, detail } = describeState(state);
  const code = reasonCode(state);
  const figure = hasFigure(state);
  const bps = figure ? coverageBps(state.backingUsd, obligation) : null;

  return (
    <div className={styles.readout} data-size={size}>
      <p className={styles.readoutWord}>{figure ? formatBps(bps ?? 0) : 'No figure'}</p>
      <dl className={styles.readoutAmounts}>
        <div>
          <dt>Attributable backing</dt>
          <dd>{figure ? formatUsd(state.backingUsd) : 'Not attested'}</dd>
        </div>
        <div>
          <dt>Outstanding</dt>
          <dd>{formatUsd(owed)}</dd>
        </div>
      </dl>
      <p className={styles.readoutLine}>
        {formatAmount(notesOutstanding(obligation))} notes at {formatUsd(parPerNote(obligation))}, read from the note
      </p>
      <p className={styles.readoutDetail}>
        <span className={styles.readoutState} data-family={state.family}>
          {word}
        </span>
        {detail}
      </p>
      {code && <p className={styles.readoutCode}>{code}</p>}
    </div>
  );
}
