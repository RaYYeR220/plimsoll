'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { CoverageState } from '@/lib/coverage-state';

/**
 * Nothing this provider produces is a reading. Each note's recorded state is a dated read
 * of the chain, and the visitor can walk the other states to see what the screens do.
 * Every figure that comes from here is labelled demonstration wherever it is shown, and a
 * live feed in the page would replace exactly this one hook.
 */

export type DemoKey = 'recorded' | 'covered' | 'short' | 'no-positions' | 'evidence';

export const DEMO_OPTIONS: ReadonlyArray<{ key: DemoKey; label: string }> = [
  { key: 'recorded', label: 'As recorded' },
  { key: 'covered', label: 'Covered' },
  { key: 'short', label: 'Short' },
  { key: 'no-positions', label: 'No positions' },
  { key: 'evidence', label: 'Unproven' },
];

type Ctx = {
  demo: DemoKey;
  setDemo: (key: DemoKey) => void;
  /** True once a refusal has been shown: it latches until a covering state replaces it. */
  latched: boolean;
};

const DemoContext = createContext<Ctx | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  const [demo, setDemoState] = useState<DemoKey>('recorded');
  const [latched, setLatched] = useState(false);

  const setDemo = useCallback((key: DemoKey) => {
    setDemoState(key);
    // A refusal latches. It is never dismissed — only a covering reading clears it.
    setLatched((was) => (key === 'covered' ? false : was || key !== 'recorded'));
  }, []);

  const value = useMemo(() => ({ demo, setDemo, latched }), [demo, setDemo, latched]);
  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): Ctx {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo must be used inside DemoProvider');
  return ctx;
}

/**
 * The state a screen should draw: the note's recorded state, or the demonstration the
 * visitor selected. `backingUsd` for a demonstration is derived from the note's own
 * obligation so the amounts stay consistent with the note being shown.
 *
 * A negative control is exempt. It exists to fail, so it never borrows a demonstration
 * that would show it clearing: it shows its own backing against what it owes, which is
 * where a 0.00% that is not an empty wallet comes from.
 */
export function stateForDemo(
  demo: DemoKey,
  recorded: CoverageState,
  obligationUsd: number,
  control?: { negativeControl: boolean; fundedBackingUsd?: number },
): CoverageState {
  if (demo === 'recorded') return recorded;
  if (control?.negativeControl) {
    const backing = control.fundedBackingUsd ?? 0;
    return backing > 0 ? { family: 'short', backingUsd: backing } : { family: 'no-positions', backingUsd: 0 };
  }
  switch (demo) {
    case 'covered':
      return { family: 'covered', backingUsd: obligationUsd * 1.5 };
    case 'short':
      return { family: 'short', backingUsd: obligationUsd * 0.87 };
    case 'no-positions':
      return { family: 'no-positions', backingUsd: 0 };
    case 'evidence':
      return { family: 'evidence', reason: 'no-reading-yet' };
  }
}
