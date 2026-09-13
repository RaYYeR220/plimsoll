import { CoverageSourceError } from "./types.js";

/**
 * Failures specific to reading real chains. Each maps onto an existing
 * evidence-family reason, so nothing downstream of the source has to learn a
 * new code and none of them can ever carry a ratio.
 */

/** The chain state we would value is older than we are willing to sign over. */
export class SourceStale extends CoverageSourceError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("data_stale", message, detail);
  }
}

/**
 * A fact the denominator depends on could not be read, or read as something
 * that cannot be used: no load line, no single issuer, a par in a currency we
 * cannot put next to a dollar. The liability side is never defaulted.
 */
export class LiabilityUnresolved extends CoverageSourceError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("source_unavailable", message, detail);
  }
}

/**
 * The vault list we were given does not hash to the set the note is registered
 * with, so any number computed from it would be about the wrong assets.
 */
export class VaultSetMismatch extends CoverageSourceError {
  constructor(market: string, registered: string, computed: string, where: string) {
    super("vault_set_drift", `${market}: the vault list does not hash to the set registered in ${where}`, {
      market,
      registered,
      computed,
      where,
    });
  }
}

/**
 * The same position is nominated as backing for two notes of one holder.
 *
 * A position can back one note. Counting it twice would let one deposit clear
 * two load lines, which is the overloading the product exists to stop, so the
 * vault set is treated as not being the set the issuer is entitled to.
 */
export class VaultPledgedElsewhere extends CoverageSourceError {
  constructor(vault: string, otherNote: string, holder: string) {
    super("vault_set_drift", `${vault} is also nominated by ${otherNote} for the same holder`, {
      vault,
      otherNote,
      holder,
    });
  }
}
