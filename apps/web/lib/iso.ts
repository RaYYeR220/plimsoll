/**
 * The isometric projection every drawing of the strongroom shares.
 *
 * x runs right-and-down the screen, y runs left-and-down, z runs straight up. z maps to
 * screen-vertical at a scale of one, so a vertical distance on screen is a true height in
 * the room — which is what lets a plain vertical rule beside the stack work as a gauge.
 */

export const K = Math.cos(Math.PI / 6);

export type Pt = readonly [number, number];
export type Plan = ReadonlyArray<Pt>;
export type Tone = 'half' | 'cut' | 'dark';
export type Seen = ReadonlyArray<readonly [from: number, to: number, tone: Tone]>;
export type Slice = readonly [z0: number, z1: number];

export const sx = (x: number, y: number): number => (x - y) * K;
export const sy = (x: number, y: number, z: number): number => (x + y) / 2 - z;
export const at = (x: number, y: number, z: number): Pt => [sx(x, y), sy(x, y, z)];

const r1 = (v: number) => Math.round(v * 10) / 10;

export function path(points: ReadonlyArray<Pt>, closed = true): string {
  return 'M' + points.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L') + (closed ? 'Z' : '');
}

export const line = (a: Pt, b: Pt): string => `M${r1(a[0])} ${r1(a[1])}L${r1(b[0])} ${r1(b[1])}`;

/** A chamfered rectangle in plan: a 45° cut at every corner, never a radius. */
export function chamfered(w: number, d: number, c: number): Plan {
  return [
    [c, 0],
    [w - c, 0],
    [w, c],
    [w, d - c],
    [w - c, d],
    [c, d],
    [0, d - c],
    [0, c],
  ];
}

export const shift = (plan: Plan, dx: number, dy: number): Plan =>
  plan.map(([x, y]) => [x + dx, y + dy] as const);

/** The horizontal face of a plan at height z. */
export const face = (plan: Plan, z: number): string => path(plan.map(([x, y]) => at(x, y, z)));

/** A face lying in the wall x = const, from (y, z) points. */
export const onWallX = (x: number, yz: ReadonlyArray<Pt>): string =>
  path(yz.map(([y, z]) => at(x, y, z)));

/** A face lying in the wall y = const, from (x, z) points. */
export const onWallY = (y: number, xz: ReadonlyArray<Pt>): string =>
  path(xz.map(([x, z]) => at(x, y, z)));

/** The sides of a chamfered prism the viewer can see: the +x side, the front cut, the +y side. */
export const SEEN_CHAMFERED: Seen = [
  [2, 3, 'half'],
  [3, 4, 'cut'],
  [4, 5, 'dark'],
];

export function sides(plan: Plan, z0: number, z1: number, seen: Seen = SEEN_CHAMFERED) {
  return seen.map(([a, b, tone]) => {
    const [ax, ay] = plan[a];
    const [bx, by] = plan[b];
    return { tone, d: path([at(ax, ay, z0), at(bx, by, z0), at(bx, by, z1), at(ax, ay, z1)]) };
  });
}

/**
 * Cut a stack of the given height into plates. The top plate is cut short, so the stack
 * ends at exactly `height` unless that falls in the gap between two plates.
 */
export function slices(height: number, pitch: number, thickness: number): Slice[] {
  const out: Slice[] = [];
  for (let i = 0; i * pitch < height - 0.5; i++) {
    const z0 = i * pitch;
    out.push([z0, Math.min(z0 + thickness, height)]);
  }
  return out;
}

/** Split plates at height z, so whatever sits at z can be drawn between the two halves. */
export function splitAt(plates: ReadonlyArray<Slice>, z: number) {
  const below: Slice[] = [];
  const above: Slice[] = [];
  for (const [z0, z1] of plates) {
    if (z1 <= z) below.push([z0, z1]);
    else if (z0 >= z) above.push([z0, z1]);
    else {
      below.push([z0, z]);
      above.push([z, z1]);
    }
  }
  return { below, above };
}
