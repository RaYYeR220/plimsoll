import {
  at,
  chamfered,
  face,
  line,
  onWallX,
  onWallY,
  path,
  shift,
  sides,
  slices,
  splitAt,
  type Plan,
  type Pt,
  type Seen,
} from '@/lib/iso';
import styles from './Strata.module.css';

export type Stage = 'hidden' | 'active' | 'rest';

/* The room: a floor slab and two walls, cut away at a fixed height. */
const F = 520;
const T = 22;
const HW = 250;
const FC = 60;
const SLAB = 26;
const FLOOR: Plan = [
  [-T, -T],
  [F, -T],
  [F, F - FC],
  [F - FC, F],
  [-T, F],
];
const FLOOR_SEEN: Seen = [
  [1, 2, 'half'],
  [2, 3, 'cut'],
  [3, 4, 'dark'],
];

/* The survey: rules across the floor, and the positions found on it. */
const RULES = [65, 130, 195, 260, 325, 390, 455];
const MARKS: Plan = [
  [78, 96],
  [440, 118],
  [104, 412],
  [262, 470],
  [446, 350],
  [52, 250],
  [304, 50],
];

/* The plates and the plane: eleven plates of backing against ten issued. */
const AT = 165;
const SIZE = 190;
const CUT = 30;
const STACK = shift(chamfered(SIZE, SIZE, CUT), AT, AT);
const PLATE = 11;
const PITCH = 13.6;
const BACKING = 11 * PITCH;
const ISSUED = 10 * PITCH;
const OVER = 34;
const PLANE = shift(chamfered(SIZE + 2 * OVER, SIZE + 2 * OVER, CUT + OVER * 0.6), AT - OVER, AT - OVER);
const HANGER = 46;

/* The door, and the lock the plane is held from. */
const DOOR = { y0: 300, y1: 420, h: 190, c: 24 };
const HOLD = PLANE[6];
const LOCK = { y: HOLD[1], z: 100, r: 22, c: 8 };

export const VIEW = { x: -490, y: -300, w: 980, h: 830 } as const;

/** Where each part's name sits, and the point on the drawing its leader starts from. */
export const LABELS: ReadonlyArray<{ part: number; text: string; x: number; y: number; align: 'start' | 'end'; from: Pt }> = [
  { part: 0, text: 'The Graph', x: -340, y: 452, align: 'end', from: at(200, F, -SLAB / 2) },
  { part: 1, text: 'Hedera', x: 330, y: 250, align: 'start', from: at(AT + SIZE, AT + CUT, 70) },
  { part: 2, text: 'Ledger', x: -312, y: -112, align: 'end', from: at(0, LOCK.y, LOCK.z + LOCK.r) },
];

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

const doorShape = (o: number): Pt[] => [
  [DOOR.y0 - o, 0],
  [DOOR.y0 - o, DOOR.h - DOOR.c + o * 0.4],
  [DOOR.y0 + DOOR.c - o * 0.4, DOOR.h + o],
  [DOOR.y1 - DOOR.c + o * 0.4, DOOR.h + o],
  [DOOR.y1 + o, DOOR.h - DOOR.c + o * 0.4],
  [DOOR.y1 + o, 0],
];

const LOCK_PLATE: Pt[] = chamfered(2 * LOCK.r, 2 * LOCK.r, LOCK.c).map(([y, z]) => [
  LOCK.y - LOCK.r + y,
  LOCK.z - LOCK.r + z,
]);

function Plate({ z0, z1 }: { z0: number; z1: number }) {
  return (
    <g>
      {sides(STACK, z0, z1).map((s) => (
        <path key={s.tone} d={s.d} className={styles[`p-${s.tone}`]} />
      ))}
      <path d={face(STACK, z1)} className={z1 - z0 < PLATE - 0.01 ? styles['p-cut'] : styles['p-top']} />
    </g>
  );
}

type Props = { progress: readonly number[]; stages: readonly Stage[] };

export function StrataFigure({ progress, stages }: Props) {
  const [survey = 0, issue = 0, lock = 0] = progress;
  const stackTop = BACKING * clamp01(issue / 0.55);
  const planeUp = issue > 0.55;
  const planeZ = ISSUED * clamp01((issue - 0.55) / 0.45);
  const { below, above } = splitAt(slices(stackTop, PITCH, PLATE), planeUp ? planeZ : Infinity);
  const boltEnd = DOOR.y0 + 6 - 24 * clamp01(lock / 0.6);
  const rodZ = planeZ + HANGER;

  return (
    <svg
      className={styles.drawing}
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <pattern id="strata-cut" width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0V7" stroke="var(--face-half)" strokeWidth={1} />
        </pattern>
      </defs>

      {/* the floor slab */}
      <g className={styles.arch}>
        {sides(FLOOR, -SLAB, 0, FLOOR_SEEN).map((s) => (
          <path key={s.tone} d={s.d} className={styles[`a-${s.tone}`]} />
        ))}
        <path d={face(FLOOR, 0)} className={styles['a-floor']} />
      </g>

      {/* the walls, cut away; the section is hatched */}
      <g className={styles.arch}>
        <path d={onWallY(0, [[0, 0], [F, 0], [F, HW], [0, HW]])} className={styles['a-dark']} />
        <path d={onWallX(F, [[-T, 0], [0, 0], [0, HW], [-T, HW]])} className={styles['a-half']} />
        <path d={face([[-T, -T], [F, -T], [F, 0], [-T, 0]], HW)} className={styles['a-section']} />
        <path d={onWallX(0, [[0, 0], [F, 0], [F, HW], [0, HW]])} className={styles['a-half']} />
        <path d={onWallY(F, [[-T, 0], [0, 0], [0, HW], [-T, HW]])} className={styles['a-dark']} />
        <path d={face([[-T, 0], [0, 0], [0, F], [-T, F]], HW)} className={styles['a-section']} />
      </g>

      {/* The Graph: the survey of the floor */}
      <g className={styles.part} data-stage={stages[0]}>
        {RULES.map((v, i) => {
          const t = clamp01((survey - i * 0.035) / 0.5);
          if (t === 0) return null;
          return (
            <path
              key={v}
              d={line(at(v, 0, 0), at(v, F * t, 0)) + line(at(0, v, 0), at(F * t, v, 0))}
              className={styles.rule}
            />
          );
        })}
        {MARKS.map(([x, y], i) =>
          survey >= 0.35 + i * 0.08 ? (
            <path
              key={`${x}-${y}`}
              d={
                line(at(x - 10, y, 0), at(x + 10, y, 0)) +
                line(at(x, y - 10, 0), at(x, y + 10, 0)) +
                line(at(x, y, 0), at(x, y, 22))
              }
              className={styles.mark}
            />
          ) : null,
        )}
      </g>

      {/* Ledger: the door and its lock */}
      <g className={styles.part} data-stage={stages[2]}>
        <path d={onWallX(0, doorShape(10))} className={styles.frame} />
        <path d={onWallX(0, doorShape(0))} className={styles.door} />
        <path
          d={onWallX(0, [
            [boltEnd, LOCK.z - 4],
            [LOCK.y - LOCK.r, LOCK.z - 4],
            [LOCK.y - LOCK.r, LOCK.z + 4],
            [boltEnd, LOCK.z + 4],
          ])}
          className={styles.bolt}
        />
        <path d={onWallX(0, LOCK_PLATE)} className={styles.lock} />
        <path d={line(at(0, LOCK.y, LOCK.z - 8), at(0, LOCK.y, LOCK.z + 6))} className={styles.keyhole} />
      </g>

      {/* Hedera: the plates, and the plane set at what has been issued */}
      <g className={styles.part} data-stage={stages[1]}>
        {below.map(([z0, z1]) => (
          <Plate key={`b${z0.toFixed(1)}`} z0={z0} z1={z1} />
        ))}
        {planeUp && (
          <>
            <path d={face(PLANE, planeZ)} className={styles.plane} />
            {[0, 1, 6, 7].map((i) => (
              <path
                key={i}
                d={line(at(PLANE[i][0], PLANE[i][1], planeZ), at(PLANE[i][0], PLANE[i][1], planeZ + HANGER))}
                className={styles.hanger}
              />
            ))}
          </>
        )}
        {above.map(([z0, z1]) => (
          <Plate key={`a${z0.toFixed(1)}`} z0={z0} z1={z1} />
        ))}
      </g>

      {/* the line is held from the lock: nobody moves it without the key */}
      {stages[2] !== 'hidden' && (
        <g className={styles.part} data-stage={stages[2]}>
          <path
            d={path([at(HOLD[0], HOLD[1], rodZ), at(0, HOLD[1], rodZ), at(0, HOLD[1], LOCK.z + LOCK.r)], false)}
            className={styles.rod}
          />
        </g>
      )}

      {LABELS.map((l) => (
        <g key={l.text} className={styles.part} data-stage={stages[l.part]}>
          <path d={line(l.from, [l.x + (l.align === 'end' ? 8 : -8), l.y])} className={styles.leader} />
        </g>
      ))}
    </svg>
  );
}
