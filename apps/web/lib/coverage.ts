'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/** The line sits where backing equals notes outstanding at par. */
export const LOAD_LINE = 1;

/** How far a visitor can move the demonstration backing. */
export const RANGE = { min: 0.6, max: 1.2 } as const;

export const DEMO = { start: 1.08, drawDown: 0.87 } as const;

export type CoverageReading =
  | { source: 'demo'; value: number }
  | { source: 'live'; value: number | null; label: string };

/**
 * Where a live coverage figure plugs in. Pass a feed to useCoverage and the room follows it
 * instead of the visitor, labelled with whatever the feed says it is. The landing passes
 * none, so everything it shows is a demonstration and says so.
 */
export interface CoverageFeed {
  subscribe(onReading: (value: number | null, label: string) => void): () => void;
}

/**
 * Refused while the reading is below the line, and while there is no reading at all:
 * missing evidence never counts as cover. Only a reading at or above the line clears it.
 * There is no timer and nothing to dismiss.
 */
export function isRefused(value: number | null): boolean {
  return value === null || !Number.isFinite(value) || value < LOAD_LINE;
}

export const clampCoverage = (v: number): number => Math.min(RANGE.max, Math.max(RANGE.min, v));

export const formatCoverage = (v: number): string => `${(v * 100).toFixed(2)}%`;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

const REDUCED = '(prefers-reduced-motion: reduce)';

function subscribeReduced(onChange: () => void) {
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/** A refusal is addressable: #coverage=87.00 opens the room at that reading. */
const HASH = /^#coverage=(\d{1,3}(?:\.\d{1,4})?)$/;

export function useCoverage(feed?: CoverageFeed) {
  const reducedMotion = usePrefersReducedMotion();
  const [demo, setDemo] = useState<number>(DEMO.start);
  const [live, setLive] = useState<{ value: number | null; label: string } | null>(null);
  const current = useRef<number>(DEMO.start);
  const glide = useRef<number | null>(null);
  const touched = useRef(false);

  const write = useCallback((v: number) => {
    current.current = v;
    setDemo(v);
  }, []);

  const stop = useCallback(() => {
    if (glide.current !== null) cancelAnimationFrame(glide.current);
    glide.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (!feed) return;
    return feed.subscribe((value, label) => setLive({ value, label }));
  }, [feed]);

  useEffect(() => {
    if (feed) return;
    const match = HASH.exec(window.location.hash);
    if (match) write(clampCoverage(Number(match[1]) / 100));
  }, [feed, write]);

  useEffect(() => {
    if (feed || !touched.current) return;
    const timer = window.setTimeout(() => {
      window.history.replaceState(null, '', `#coverage=${(demo * 100).toFixed(2)}`);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [demo, feed]);

  /** Move the backing to a value directly, as a drag or a key press does. */
  const set = useCallback(
    (v: number) => {
      if (feed) return;
      stop();
      touched.current = true;
      write(clampCoverage(v));
    },
    [feed, stop, write],
  );

  /** Move the backing to a value over time. Every frame is a real reading of the stack. */
  const glideTo = useCallback(
    (target: number) => {
      if (feed) return;
      stop();
      touched.current = true;
      const from = current.current;
      const to = clampCoverage(target);
      if (reducedMotion || from === to) {
        write(to);
        return;
      }
      const duration = 500 + Math.abs(to - from) * 2800;
      let start: number | null = null;
      const step = (now: number) => {
        start ??= now;
        // a frame timestamp can predate the one it is measured against, so clamp both ends
        const t = clamp01((now - start) / duration);
        const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
        write(from + (to - from) * eased);
        glide.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      glide.current = requestAnimationFrame(step);
    },
    [feed, reducedMotion, stop, write],
  );

  const reading: CoverageReading = feed
    ? { source: 'live', value: live?.value ?? null, label: live?.label ?? 'Waiting for a reading' }
    : { source: 'demo', value: demo };

  return { reading, refused: isRefused(reading.value), adjustable: !feed, set, glideTo };
}
