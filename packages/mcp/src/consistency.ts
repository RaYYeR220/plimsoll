import { toScaled } from "./fixed.js";
import type { VaultBlockJson } from "./types.js";

/**
 * The package's `ratesConsistent`, plus one case it misses. When a vault
 * reports totalAssets of 0 against outstanding shares, its price is 0 and the
 * package's premium/discount divide by zero, come out empty, and pass the
 * band check. Recorded live on 0x4f95…: deposits at a rate near 1 into a
 * vault priced at 0. A zero price next to any event rate is as inconsistent
 * as it gets.
 */
export function ratesConsistentOf(vb: VaultBlockJson): boolean {
  if (!vb.ratesConsistent) return false;
  const price = toScaled(vb.statePrice);
  return !(price === 0n && Boolean(vb.entryRate || vb.exitRate));
}
