'use client';

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { at, chamfered, face, line, path, shift, sides, slices, splitAt, sx, sy, type Slice } from '@/lib/iso';
import { LOAD_LINE, RANGE, formatCoverage, type CoverageReading } from '@/lib/coverage';
import styles from './Strongroom.module.css';

/* Geometry, in viewBox units. Twenty plates make par; the plane is cut once, at that height. */
const SIDE = 272;
const CUT = 42;
const PLATE = 14.2;
const PITCH = 16.6;
const AT_PAR = 20;
const LINE_Z = AT_PAR * PITCH * LOAD_LINE;
const OVERHANG = 62;
const HANGER = 34;

const STACK = chamfered(SIDE, SIDE, CUT);
const PLANE = shift(
  chamfered(SIDE + 2 * OVERHANG, SIDE + 2 * OVERHANG, CUT + OVERHANG * 0.6),
  -OVERHANG,
  -OVERHANG,
);

const VIEW = { x: -300, y: -560, w: 860, h: 860 } as const;

/* The gauge: a true-height rule standing beside the stack's right-hand arris. */
const ARRIS_X = sx(SIDE, CUT);
const FLOOR_Y = sy(SIDE, CUT, 0);
const RULE_X = 320;
const yOf = (z: number) => FLOOR_Y - z;
const zOf = (coverage: number) => (coverage / LOAD_LINE) * LINE_Z;
const HIT = {
  x0: RULE_X - 30,
  x1: VIEW.x + VIEW.w,
  y0: yOf(zOf(RANGE.max)) - 40,
  y1: yOf(zOf(RANGE.min)) + 40,
} as const;
const STAMP_FOOT = -418;

const pctX = (x: number) => ((x - VIEW.x) / VIEW.w) * 100;
const pctY = (y: number) => ((y - VIEW.y) / VIEW.h) * 100;

const STEP = 0.005;
const PAGE = 0.05;

/* The floor is ruled at a quarter of the plate's side, so the stack stands on the grid. */
const FLOOR_GRID = (() => {
  const s = SIDE / 4;
  const lo = -6 * s;
  const hi = 10 * s;
  let d = '';
  for (let i = -6; i <= 10; i++) {
    const v = i * s;
    d += line(at(v, lo, 0), at(v, hi, 0));
    d += line(at(lo, v, 0), at(hi, v, 0));
  }
  return d;
})();
const FLOOR_CENTRE = at(SIDE / 2, SIDE / 2, 0);

const TICKS = Array.from({ length: 13 }, (_, k) => {
  const y = yOf(zOf(k / 10));
  return `M${RULE_X - (k % 5 === 0 ? 11 : 6)} ${y}H${RULE_X}`;
}).join('');

function Plate({ z0, z1 }: { z0: number; z1: number }) {
  const whole = z1 - z0 >= PLATE - 0.01;
  return (
    <g>
      {sides(STACK, z0, z1).map((s) => (
        <path key={s.tone} d={s.d} fill={`var(--face-${s.tone})`} stroke="var(--ground)" strokeWidth={0.75} />
      ))}
      <path
        d={face(STACK, z1)}
        fill={whole ? 'var(--face-lit)' : 'var(--face-half)'}
        stroke="var(--arris)"
        strokeOpacity={0.55}
        strokeWidth={0.6}
      />
    </g>
  );
}

function head(y: number) {
  return path([
    [RULE_X - 4, y - 4],
    [RULE_X + 7, y - 4],
    [RULE_X + 7, y + 1],
    [RULE_X + 4, y + 4],
    [RULE_X - 7, y + 4],
    [RULE_X - 7, y - 1],
  ]);
}

type Props = {
  reading: CoverageReading;
  refused: boolean;
  adjustable: boolean;
  onChange: (coverage: number) => void;
};

export function Strongroom({ reading, refused, adjustable, onChange }: Props) {
  const value = reading.value;
  const height = value === null ? 0 : zOf(value);
  const plates = slices(height, PITCH, PLATE);
  const { below, above } = splitAt(plates, LINE_Z);
  const top = plates.length ? plates[plates.length - 1][1] : 0;
  const drag = useRef<{ y: number; from: number; scale: number } | null>(null);

  const gap = LINE_Z - top;
  const yTop = yOf(height);
  const yLine = yOf(LINE_Z);

  const valueText =
    value === null
      ? 'No reading'
      : `${formatCoverage(value)} of notes outstanding, ${refused ? 'over-issued, transfers refused' : 'above the line'}`;

  function fromGauge(el: HTMLElement, clientY: number) {
    const r = el.getBoundingClientRect();
    const y = HIT.y0 + ((clientY - r.top) / r.height) * (HIT.y1 - HIT.y0);
    return ((FLOOR_Y - y) / LINE_Z) * LOAD_LINE;
  }

  function onGaugeDown(e: PointerEvent<HTMLDivElement>) {
    if (!adjustable) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(fromGauge(e.currentTarget, e.clientY));
  }

  function onGaugeMove(e: PointerEvent<HTMLDivElement>) {
    if (!adjustable || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    onChange(fromGauge(e.currentTarget, e.clientY));
  }

  function onGaugeKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!adjustable || value === null) return;
    const next: Record<string, number> = {
      ArrowUp: value + STEP,
      ArrowRight: value + STEP,
      ArrowDown: value - STEP,
      ArrowLeft: value - STEP,
      PageUp: value + PAGE,
      PageDown: value - PAGE,
      Home: RANGE.min,
      End: RANGE.max,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    onChange(next[e.key]);
  }

  /* With a mouse, the stack itself can be lifted or lowered. Touch scrolls the page instead. */
  function onStackDown(e: PointerEvent<SVGRectElement>) {
    if (!adjustable || e.pointerType !== 'mouse' || value === null) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    drag.current = { y: e.clientY, from: value, scale: VIEW.h / svg.getBoundingClientRect().height };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onStackMove(e: PointerEvent<SVGRectElement>) {
    const d = drag.current;
    if (!d) return;
    onChange(d.from + (((d.y - e.clientY) * d.scale) / LINE_Z) * LOAD_LINE);
  }

  function endStack() {
    drag.current = null;
  }

  const drawPlates = (list: Slice[], key: string) =>
    list.map(([z0, z1]) => <Plate key={`${key}${z0.toFixed(1)}`} z0={z0} z1={z1} />);

  return (
    <div className={styles.room} data-adjustable={adjustable}>
      <svg
        className={styles.drawing}
        viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient
            id="room-floor"
            gradientUnits="userSpaceOnUse"
            cx={FLOOR_CENTRE[0]}
            cy={FLOOR_CENTRE[1]}
            r={640}
          >
            <stop offset="0" style={{ stopColor: 'var(--rule)' }} />
            <stop offset="0.55" style={{ stopColor: 'var(--rule)', stopOpacity: 0.75 }} />
            <stop offset="1" style={{ stopColor: 'var(--rule)', stopOpacity: 0 }} />
          </radialGradient>
          <pattern id="room-void" width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={8} height={8} fill="var(--alarm)" fillOpacity={0.07} />
            <path d="M0 0V8" stroke="var(--alarm)" strokeWidth={1.25} />
          </pattern>
        </defs>

        <path className={styles.floor} d={FLOOR_GRID} stroke="url(#room-floor)" strokeWidth={1} fill="none" />

        {drawPlates(below, 'b')}

        {/* The over-issued volume: notes outstanding with nothing under them. */}
        {refused && gap > 0.5 && (
          <g>
            {sides(STACK, top, LINE_Z).map((s) => (
              <path key={s.tone} d={s.d} fill="url(#room-void)" stroke="var(--alarm)" strokeWidth={1.25} />
            ))}
            <path d={face(STACK, LINE_Z)} fill="none" stroke="var(--alarm)" strokeWidth={1.25} />
          </g>
        )}

        {/* The line: a datum plane cut at notes outstanding, never re-cut by the issuer. */}
        <path
          d={face(PLANE, LINE_Z)}
          fill="var(--lamp)"
          fillOpacity={0.1}
          stroke="var(--lamp)"
          strokeWidth={1.5}
          strokeDasharray={refused ? undefined : '9 6'}
        />
        {[0, 1, 6, 7].map((i) => {
          const [x, y] = PLANE[i];
          return (
            <path
              key={i}
              d={line(at(x, y, LINE_Z), at(x, y, LINE_Z + HANGER))}
              stroke="var(--lamp)"
              strokeOpacity={0.5}
              strokeWidth={1}
            />
          );
        })}
        {drawPlates(above, 'a')}

        {/* The gauge. Extension lines carry the floor, the plane and the stack's top across to the rule. */}
        <path d={`M${RULE_X} ${yOf(0)}V${yOf(zOf(RANGE.max)) - 14}`} stroke="var(--text-3)" strokeWidth={1} />
        <path d={TICKS} stroke="var(--text-3)" strokeWidth={1} />
        <path d={`M${ARRIS_X + 8} ${yOf(0)}H${RULE_X - 13}`} stroke="var(--text-3)" strokeWidth={1} />
        <path
          d={`M${ARRIS_X + 6} ${yLine}H${RULE_X - 16}`}
          stroke="var(--lamp)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <path d={`M${RULE_X - 2} ${yLine}L${RULE_X - 15} ${yLine - 6}V${yLine + 6}Z`} fill="var(--lamp)" />
        {value !== null && (
          <>
            <path d={`M${ARRIS_X + 8} ${yTop}H${RULE_X + 12}`} stroke="var(--text)" strokeWidth={1.25} />
            <path d={head(yTop)} fill="var(--text)" />
          </>
        )}

        {refused && (
          <g>
            <path d={`M${RULE_X} ${yLine}V${STAMP_FOOT}`} stroke="var(--alarm)" strokeWidth={1.25} />
            {value !== null && (
              <>
                <path d={`M${RULE_X} ${yTop}V${yLine}`} stroke="var(--alarm)" strokeWidth={3} />
                {yTop - yLine > 22 && (
                  <path
                    d={`M${RULE_X - 5} ${yLine + 9}H${RULE_X + 5}L${RULE_X} ${yLine}ZM${RULE_X - 5} ${yTop - 9}H${RULE_X + 5}L${RULE_X} ${yTop}Z`}
                    fill="var(--alarm)"
                  />
                )}
              </>
            )}
          </g>
        )}

        <rect
          className={styles.grab}
          x={sx(0, SIDE - CUT) - 4}
          y={sy(CUT, 0, Math.max(height, LINE_Z)) - 12}
          width={2 * sx(SIDE, CUT) + 8}
          height={sy(SIDE - CUT, SIDE, 0) - sy(CUT, 0, Math.max(height, LINE_Z)) + 18}
          fill="transparent"
          onPointerDown={onStackDown}
          onPointerMove={onStackMove}
          onPointerUp={endStack}
          onPointerCancel={endStack}
        />
      </svg>

      <div
        className={styles.gauge}
        data-focus-ring=""
        role="slider"
        tabIndex={adjustable ? 0 : -1}
        aria-label="Backing, as a share of notes outstanding"
        aria-valuemin={RANGE.min * 100}
        aria-valuemax={RANGE.max * 100}
        aria-valuenow={value === null ? undefined : Number((value * 100).toFixed(2))}
        aria-valuetext={valueText}
        aria-disabled={!adjustable || undefined}
        style={{
          left: `${pctX(HIT.x0)}%`,
          top: `${pctY(HIT.y0)}%`,
          width: `${pctX(HIT.x1) - pctX(HIT.x0)}%`,
          height: `${pctY(HIT.y1) - pctY(HIT.y0)}%`,
        }}
        onPointerDown={onGaugeDown}
        onPointerMove={onGaugeMove}
        onKeyDown={onGaugeKey}
      />

      <p className={styles.readout} style={{ left: `${pctX(RULE_X + 20)}%`, top: `${pctY(yTop)}%` }} aria-hidden="true">
        <span className={styles.figure}>{value === null ? 'No reading' : formatCoverage(value)}</span>
        <span className={styles.source}>
          {reading.source === 'demo' ? 'Coverage, demonstration' : reading.label}
        </span>
      </p>

      <div
        className={styles.stamp}
        style={{ right: `${100 - pctX(RULE_X + 14)}%`, bottom: `${100 - pctY(STAMP_FOOT)}%` }}
        aria-live="polite"
      >
        {refused && (
          <>
            <p className={styles.word}>Over-issued</p>
            <p className={styles.reason}>
              <span className="nowrap">Transfers refused at consensus</span> ·{' '}
              <span className="nowrap">coverage_below_load_line</span>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
