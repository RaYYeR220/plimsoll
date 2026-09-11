/**
 * Decimal strings from the package are exact (integer arithmetic at 18
 * fractional digits). Derived statistics stay in bigint for as long as they
 * can, so a comparison such as "entry rate at or above price" is not decided
 * by float noise.
 */
export const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

export function toScaled(s: string | null | undefined): bigint | null {
  if (s === null || s === undefined || s.trim() === "") return null;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) return null;
  const frac = (m[3] ?? "").slice(0, SCALE).padEnd(SCALE, "0");
  const v = BigInt((m[2] || "0") + frac);
  return m[1] === "-" ? -v : v;
}

/** (a − b) / b in basis points, as a number with 6 decimal places of precision. */
export function diffBps(a: bigint, b: bigint): number | null {
  if (b === 0n) return null;
  return Number(((a - b) * 10_000n * 1_000_000n) / b) / 1_000_000;
}

export function ratio(a: bigint, b: bigint): number | null {
  if (b === 0n) return null;
  return Number((a * ONE) / b) / Number(ONE);
}
