'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePrefersReducedMotion } from '@/lib/coverage';
import type { DeviceLinks } from '@/site.config';
import { LABELS, StrataFigure, VIEW, type Stage } from './StrataFigure';
import styles from './Strata.module.css';

type Props = { device: DeviceLinks | null; proofDoc: string };

function DeviceSequence({ device, proofDoc }: Props) {
  if (device) {
    return (
      <>
        {' '}
        See <a href={device.halt}>the halt</a>, <a href={device.refusedResume}>the refused resume</a> and{' '}
        <a href={device.resume}>the resume</a> on HashScan.
      </>
    );
  }
  return (
    <>
      {' '}
      The transactions are listed in <a href={proofDoc}>PROOF.md</a>.
    </>
  );
}

const chaptersFor = (links: Props): ReadonlyArray<{ id: string; title: string; body: ReactNode }> => [
  {
    id: 'survey',
    title: 'The survey',
    body: (
      <>
        <p>
          The Graph surveys the floor. A Substreams package reads every <span className="nowrap">ERC-4626</span>{' '}
          deposit and withdrawal on Ethereum and works out what each vault actually holds, block by block: its share
          price, its entry and exit rates kept apart, its total assets. A contract that emits vault-shaped events but
          cannot name its underlying asset is thrown out, not counted.
        </p>
        <p className={styles.aside}>
          It runs Pinax’s <span className="nowrap">ERC-4626</span> extractor unchanged, so their module cache is
          reused rather than recomputed, and its output follows the Messari yield-aggregator schema.
        </p>
      </>
    ),
  },
  {
    id: 'line',
    title: 'The plates and the line',
    body: (
      <>
        <p>
          Hedera holds the plates and the plane above them. The note is a real bond, PLIM-A, issued through Hedera’s
          Asset Tokenization Studio. Its market asks the note before it books a trade, so it never books one the note
          would refuse, and coupons are paid by Hedera’s own scheduler rather than a keeper.
        </p>
        <p>
          The cash that pays those coupons is a native Hedera token. Its freeze key belongs to the circuit breaker and
          it has no admin key, so that can never be changed. When coverage falls below the line, the network itself
          freezes the payer, and a frozen payer still cannot pay with our servers switched off.
        </p>
      </>
    ),
  },
  {
    id: 'lock',
    title: 'The lock on the door',
    body: (
      <>
        <p>
          Ledger holds the key to the line. Halting a market, reopening it or moving the line takes a mandate that a
          person reads on a Ledger device in plain words: the action, the market, the coverage, the new line. Decline
          it and the device answers 6985 and no signature exists, so there is nothing for the contract to accept and
          nothing to retry.
        </p>
        <p className={styles.aside}>
          On Hedera testnet the device approved a halt, then declined the resume. A resume signed with any other key
          was reverted, and the market stayed halted until the device approved it. The device is Ledger’s emulator
          running the real Ethereum app on a private seed.
          <DeviceSequence {...links} />
        </p>
      </>
    ),
  },
];

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

type View = { progress: number[]; active: number };

export function Strata({ device, proofDoc }: Props) {
  const reduced = usePrefersReducedMotion();
  const content = useMemo(() => chaptersFor({ device, proofDoc }), [device, proofDoc]);
  const chapters = useRef<Array<HTMLElement | null>>([]);
  const [view, setView] = useState<View>({ progress: [0, 0, 0], active: -1 });

  /* The drawing is bound to the reader's position in the text, and to nothing else. */
  useEffect(() => {
    let frame = 0;
    const wide = window.matchMedia('(min-width: 900px)');
    const measure = () => {
      frame = 0;
      const anchor = window.innerHeight * (wide.matches ? 0.55 : 0.74);
      const progress = chapters.current.map((el) => {
        if (!el) return 0;
        const r = el.getBoundingClientRect();
        const p = clamp01((anchor - r.top) / Math.max(1, r.height * 0.7));
        return reduced ? (p > 0 ? 1 : 0) : Math.round(p * 1000) / 1000;
      });
      const active = progress.reduce((last, p, i) => (p > 0 ? i : last), -1);
      setView((prev) =>
        prev.active === active && prev.progress.every((p, i) => p === progress[i]) ? prev : { progress, active },
      );
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', request, { passive: true });
    window.addEventListener('resize', request);
    return () => {
      window.removeEventListener('scroll', request);
      window.removeEventListener('resize', request);
      cancelAnimationFrame(frame);
    };
  }, [reduced]);

  const stages: Stage[] = content.map((_, i) =>
    i < view.active ? 'rest' : i === view.active ? 'active' : 'hidden',
  );

  return (
    <section className={styles.strata} id="how" aria-labelledby="how-title">
      <h2 className={styles.heading} id="how-title">
        From the floor up
      </h2>

      <div className={styles.figure} aria-hidden="true">
        <div className={styles.canvas}>
          <StrataFigure progress={view.progress} stages={stages} />
          {LABELS.map((l) => (
            <span
              key={l.text}
              className={styles.label}
              data-align={l.align}
              data-stage={stages[l.part]}
              style={{ left: `${((l.x - VIEW.x) / VIEW.w) * 100}%`, top: `${((l.y - VIEW.y) / VIEW.h) * 100}%` }}
            >
              {l.text}
            </span>
          ))}
        </div>
      </div>

      <div className={styles.chapters}>
        {content.map((c, i) => (
          <article
            key={c.id}
            ref={(el) => {
              chapters.current[i] = el;
            }}
            className={styles.chapter}
            data-active={i === view.active}
            aria-labelledby={`${c.id}-title`}
          >
            <h3 id={`${c.id}-title`}>{c.title}</h3>
            {c.body}
          </article>
        ))}
      </div>
    </section>
  );
}
