'use client';

import { at, chamfered, face, line, shift, sides, slices, splitAt } from '@/lib/iso';
import { coverageBps, hasFigure, type CoverageState, type Obligation } from '@/lib/coverage-state';
import styles from './app.module.css';

/**
 * One note's room: plates are the backing that was read, the plane is what the note owes.
 *
 * Three drawings, because there are three findings:
 *  - a stack under a plane        — a reading, high or short
 *  - an empty floor under a plane — a reading of nothing, which is a finding about the note
 *  - a fogged room with no stack  — no reading at all, which is a statement about our proof
 *
 * A position too small to fill a plate is drawn as a hairline on the floor rather than as
 * nothing, so "almost none" never looks like "none".
 */

const SIDE = 190;
const CUT = 30;
const PLATE = 10.5;
const PITCH = 12.4;
const AT_PAR = 12;
const LINE_Z = AT_PAR * PITCH;
const OVERHANG = 40;
const HANGER = 26;

const STACK = chamfered(SIDE, SIDE, CUT);
const PLANE = shift(chamfered(SIDE + 2 * OVERHANG, SIDE + 2 * OVERHANG, CUT + OVERHANG * 0.6), -OVERHANG, -OVERHANG);
const VIEW = { x: -250, y: -300, w: 500, h: 430 } as const;

const FLOOR = (() => {
  const s = SIDE / 3;
  let d = '';
  for (let i = -3; i <= 6; i++) {
    const v = i * s;
    d += line(at(v, -3 * s, 0), at(v, 6 * s, 0));
    d += line(at(-3 * s, v, 0), at(6 * s, v, 0));
  }
  return d;
})();

export function RoomFigure({ state, obligation }: { state: CoverageState; obligation: Obligation }) {
  const figure = hasFigure(state);
  const ratio = figure ? coverageBps(state.backingUsd, obligation) / 10_000 : 0;
  const height = Math.max(0, ratio) * LINE_Z;
  const traceOnly = figure && state.backingUsd > 0 && height < 1.2;
  const plates = slices(traceOnly ? 0 : height, PITCH, PLATE);
  const { below, above } = splitAt(plates, LINE_Z);
  const top = plates.length ? plates[plates.length - 1][1] : 0;
  const family = state.family === 'evidence' ? 'evidence' : state.family === 'covered' ? 'covered' : 'asset';

  return (
    <svg
      className={styles.room}
      data-family={family}
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <pattern id="room-hatch" width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0V7" stroke="var(--lamp)" strokeWidth={1} />
        </pattern>
      </defs>

      <path className={styles.roomFloor} d={FLOOR} />

      {below.map(([z0, z1]) => (
        <Plate key={`b${z0.toFixed(1)}`} z0={z0} z1={z1} />
      ))}

      {/* a position too small to draw as a plate still exists, and says so */}
      {traceOnly && <path className={styles.roomTrace} d={face(STACK, 0.8)} />}

      {/* the shortfall: what has been issued with nothing under it */}
      {figure && top < LINE_Z && state.family !== 'covered' && (
        <g className={styles.roomVoid}>
          {sides(STACK, top, LINE_Z).map((s) => (
            <path key={s.tone} d={s.d} fill="url(#room-hatch)" />
          ))}
        </g>
      )}

      {/* no reading at all: the room is fogged, and no level is implied anywhere */}
      {!figure && (
        <g className={styles.roomFog}>
          {sides(STACK, 0, LINE_Z).map((s) => (
            <path key={s.tone} d={s.d} />
          ))}
          <path d={face(STACK, LINE_Z)} />
        </g>
      )}

      <path className={styles.roomPlane} d={face(PLANE, LINE_Z)} />
      {[0, 1, 6, 7].map((i) => {
        const [x, y] = PLANE[i];
        return <path key={i} className={styles.roomHanger} d={line(at(x, y, LINE_Z), at(x, y, LINE_Z + HANGER))} />;
      })}

      {above.map(([z0, z1]) => (
        <Plate key={`a${z0.toFixed(1)}`} z0={z0} z1={z1} />
      ))}
    </svg>
  );
}

function Plate({ z0, z1 }: { z0: number; z1: number }) {
  return (
    <g>
      {sides(STACK, z0, z1).map((s) => (
        <path key={s.tone} d={s.d} className={styles[`face-${s.tone}`]} />
      ))}
      <path d={face(STACK, z1)} className={z1 - z0 < PLATE - 0.01 ? styles['face-part'] : styles['face-top']} />
    </g>
  );
}
