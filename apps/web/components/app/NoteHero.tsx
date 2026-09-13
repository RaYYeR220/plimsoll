'use client';

import { obligationValue, type CoverageState, type Obligation } from '@/lib/coverage-state';
import { stateForDemo, useDemo } from './DemoState';
import { CoverageReadout } from './CoverageReadout';
import { RoomFigure } from './RoomFigure';
import styles from './app.module.css';
import hero from './NoteHero.module.css';

/**
 * The note's room, at the size the screen is built around. What it draws is either the
 * note's recorded state or the demonstration the visitor picked; either way the readout
 * beside it carries the amounts, never a bare percentage.
 */
export function NoteHero({
  obligation,
  recorded,
  demonstrated,
  negativeControl = false,
  plannedBackingUsd,
}: {
  obligation: Obligation;
  recorded: CoverageState;
  /** What the recorded state is, in words, for the line under the readout. */
  demonstrated: string;
  negativeControl?: boolean;
  plannedBackingUsd?: number;
}) {
  const { demo } = useDemo();
  const state = stateForDemo(demo, recorded, obligationValue(obligation), { negativeControl, plannedBackingUsd });
  const family = state.family === 'evidence' ? 'evidence' : state.family === 'covered' ? 'covered' : 'asset';
  const showing =
    demo === 'recorded'
      ? demonstrated
      : negativeControl
        ? 'The negative control does not follow the demonstration. This is its planned backing against what it owes: it cannot clear, and that is the point of keeping it on the floor.'
        : 'A demonstration state, not a reading of this note.';

  return (
    <section className={`${styles.panel} ${hero.hero}`} data-family={family} aria-label="Coverage">
      <div className={hero.figure}>
        <RoomFigure state={state} obligation={obligation} />
      </div>
      <div className={hero.side}>
        <CoverageReadout state={state} obligation={obligation} />
        <p className={hero.source}>{showing}</p>
      </div>
    </section>
  );
}
