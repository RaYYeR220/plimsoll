'use client';

import Link from 'next/link';
import { obligationValue, type CoverageState, type Obligation } from '@/lib/coverage-state';
import { stateForDemo, useDemo } from './DemoState';
import { CoverageReadout } from './CoverageReadout';
import { RoomFigure } from './RoomFigure';
import styles from './app.module.css';
import card from './NoteCard.module.css';

export interface CardNote {
  readonly market: string;
  readonly name: string;
  readonly slug: string;
  readonly obligation: Obligation;
  readonly negativeControl: boolean;
  readonly plannedBackingUsd?: number;
  readonly recorded: CoverageState;
  readonly hederaId: string;
  readonly href: string;
}

export function NoteCard({ note }: { note: CardNote }) {
  const { demo } = useDemo();
  const state = stateForDemo(demo, note.recorded, obligationValue(note.obligation), {
    negativeControl: note.negativeControl,
    plannedBackingUsd: note.plannedBackingUsd,
  });
  const family = state.family === 'evidence' ? 'evidence' : state.family === 'covered' ? 'covered' : 'asset';

  return (
    <article className={`${styles.panel} ${card.card}`} data-family={family}>
      <header className={card.head}>
        <div>
          <h2>{note.market}</h2>
          <p className={card.name}>{note.name}</p>
        </div>
        {note.negativeControl && <span className={card.control}>Negative control</span>}
      </header>

      <div className={card.figure}>
        <RoomFigure state={state} obligation={note.obligation} />
      </div>

      <div className={card.body}>
        <CoverageReadout state={state} obligation={note.obligation} size="card" />
      </div>

      <footer className={card.foot}>
        <a href={note.href}>{note.hederaId}</a>
        <Link className={card.open} href={`/app/note/${note.slug}`}>
          Open the note
        </Link>
      </footer>
    </article>
  );
}
