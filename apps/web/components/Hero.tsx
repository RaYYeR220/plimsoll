'use client';

import { DEMO, useCoverage } from '@/lib/coverage';
import { Strongroom } from './Strongroom';
import styles from './Hero.module.css';

export function Hero({ repoHref }: { repoHref: string }) {
  const { reading, refused, adjustable, set, glideTo } = useCoverage();

  return (
    <section className={styles.hero} data-lamp={refused ? 'arc' : 'brass'} aria-labelledby="claim">
      <header className={styles.head}>
        <p className={styles.mark}>Plimsoll</p>
        <a className={styles.source} href={repoHref}>
          Source code
        </a>
      </header>

      <div className={styles.claim}>
        <h1 id="claim">You cannot issue more than the room holds.</h1>
        <p className={styles.deck}>
          Each plate is an <span className="nowrap">ERC-4626</span> vault position behind the note, counted on-chain
          rather than declared. The plane is what has been issued against them. When the plates fall below it, the
          network refuses to move the money.
        </p>
      </div>

      <div className={styles.room}>
        <Strongroom reading={reading} refused={refused} adjustable={adjustable} onChange={set} />
      </div>

      <div className={styles.act}>
        {adjustable && (
          <button
            type="button"
            className="plate-button"
            onClick={() => glideTo(refused ? DEMO.start : DEMO.drawDown)}
          >
            {refused ? 'Restore the backing' : 'Draw down the backing'}
          </button>
        )}
        <p className={styles.hint}>
          {refused
            ? 'Nothing dismisses this. It clears when the backing is back above the line.'
            : 'Or drag the gauge beside the stack.'}
        </p>
      </div>
    </section>
  );
}
