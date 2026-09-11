'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { DEMO_OPTIONS, DemoProvider, useDemo } from './DemoState';
import styles from './app.module.css';

export interface ShellLink {
  readonly href: string;
  readonly label: string;
}

/** The rail and the band under it persist across every app screen. */
export function AppShell({
  links,
  topic,
  children,
}: {
  links: readonly ShellLink[];
  topic: { id: string; href: string };
  children: ReactNode;
}) {
  return (
    <DemoProvider>
      <div className={styles.shell}>
        <Rail links={links} />
        <Band topic={topic} />
        <main className={styles.main}>{children}</main>
      </div>
    </DemoProvider>
  );
}

function Rail({ links }: { links: readonly ShellLink[] }) {
  const path = usePathname();
  return (
    <header className={styles.rail}>
      <Link className={styles.brand} href="/">
        Plimsoll
        <span>Strongroom</span>
      </Link>
      <nav className={styles.nav} aria-label="App">
        {links.map((l) => (
          <Link key={l.href} href={l.href} aria-current={path === l.href ? 'page' : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

function Band({ topic }: { topic: { id: string; href: string } }) {
  const { demo, setDemo, latched } = useDemo();
  return (
    <div className={styles.band}>
      <div className={styles.bandFacts}>
        <span>
          <small>Network</small>Hedera testnet
        </span>
        <span>
          <small>Audit topic</small>
          <a href={topic.href}>{topic.id}</a>
        </span>
        <span>
          <small>Coverage feed</small>Not wired yet
        </span>
      </div>
      <fieldset className={styles.demo}>
        <legend>Demonstration</legend>
        {DEMO_OPTIONS.map((o) => (
          <label key={o.key} data-selected={demo === o.key}>
            <input
              type="radio"
              name="demo-state"
              value={o.key}
              checked={demo === o.key}
              onChange={() => setDemo(o.key)}
            />
            {o.label}
          </label>
        ))}
        <p className={styles.demoNote}>
          {latched
            ? 'A refusal holds until a covering reading replaces it. Nothing here dismisses one.'
            : 'No live reading exists yet. Walk the states to see what each one does.'}
        </p>
      </fieldset>
    </div>
  );
}
