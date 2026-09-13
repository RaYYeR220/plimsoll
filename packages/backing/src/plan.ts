import { NAMED_POSITION, PLAN, TOKENS, vaultByKey, type Market, type VaultSpec } from "./config.js";
import { decimalToUnits, formatDecimal } from "./liabilities.js";

export interface Leg {
  readonly vault: VaultSpec;
  readonly amount: bigint;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/**
 * Turns a market's plan into amounts against what the wallet actually holds.
 *
 * Fixed legs take their amount; the "rest" leg takes what is left, capped at
 * its maximum so the named position stays decisive. Anything above the cap is
 * left in the wallet and reported, never spread across the other legs.
 */
export function resolveLegs(
  market: Market,
  available: bigint,
  /**
   * Legs that already hold a position. They are left as they are and only the
   * rest are sized, so a plan interrupted part way — a transaction that
   * reverted, a connection that dropped — is finished by running it again.
   */
  funded: ReadonlySet<string> = new Set(),
): { legs: Leg[]; idle: bigint } {
  const plan = PLAN[market].filter((l) => !funded.has(l.vault));
  if (plan.length === 0) return { legs: [], idle: available };
  const asset = vaultByKey(plan[0]!.vault).asset;
  const decimals = TOKENS[asset].decimals;
  const fixed = plan
    .filter((l) => l.amount !== "rest")
    .reduce((sum, l) => sum + decimalToUnits(l.amount, decimals), 0n);
  if (available < fixed) {
    throw new PlanError(
      `${market} needs at least ${formatDecimal(fixed, decimals)} ${asset}; the wallet holds ${formatDecimal(available, decimals)}`,
    );
  }

  let idle = available - fixed;
  const legs = plan.map((leg) => {
    const vault = vaultByKey(leg.vault);
    if (leg.amount !== "rest") return { vault, amount: decimalToUnits(leg.amount, decimals) };
    const max = leg.max === undefined ? idle : decimalToUnits(leg.max, decimals);
    const min = leg.min === undefined ? 1n : decimalToUnits(leg.min, decimals);
    const amount = idle < max ? idle : max;
    if (amount < min) {
      throw new PlanError(
        `${market}: only ${formatDecimal(amount, decimals)} ${asset} left for ${vault.key}, below its minimum of ${leg.min}`,
      );
    }
    idle -= amount;
    return { vault, amount };
  });
  return { legs, idle };
}

/** Planned total for a market when every leg is at its nominal size ("rest" at its maximum). */
export function plannedTotal(market: Market): bigint {
  const plan = PLAN[market];
  const decimals = TOKENS[vaultByKey(plan[0]!.vault).asset].decimals;
  return plan.reduce((sum, l) => sum + decimalToUnits(l.amount === "rest" ? (l.max ?? "0") : l.amount, decimals), 0n);
}

/**
 * The three states the demo moves through, for a funded split and an
 * obligation, all in micro-USD. Used to check a split before any money moves.
 */
export function scenarios(
  legs: readonly Leg[],
  obligationMicro: bigint,
  named = NAMED_POSITION,
): { funded: number; withoutNamed: number; withoutEachOther: Record<string, number>; redeposited: number } {
  const total = legs.reduce((sum, l) => sum + l.amount, 0n);
  const namedLeg = legs.find((l) => l.vault.key === named);
  if (!namedLeg) throw new PlanError(`the named position ${named} is not in this split`);
  const bps = (value: bigint) => Number((value * 10_000n) / obligationMicro);
  const withoutEachOther: Record<string, number> = {};
  for (const l of legs) if (l.vault.key !== named) withoutEachOther[l.vault.key] = bps(total - l.amount);
  return { funded: bps(total), withoutNamed: bps(total - namedLeg.amount), withoutEachOther, redeposited: bps(total) };
}
