import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
// Types only, from the attestor's built declarations. Nothing of the attestor's
// source is compiled into this package; at run time the built module is loaded
// from where it lives.
import type { Args, VerificationResult } from "../../attestor/dist/bin/verify-charge.js";

/**
 * The attestor's own verify-charge, reused rather than reimplemented.
 *
 * Duplicating the x402 verification here would create a second opinion about
 * the same records that could drift from the first. Loading the attestor's
 * built module means there is one verifier for those claims, and this package
 * only decides which records to hand it.
 */
export type VerifyChargeFn = (args: Args) => Promise<VerificationResult>;
export type { Args as VerifyChargeArgs, VerificationResult as ChargeVerification };

/** `dist/src/attestor.js` → `packages/attestor/dist`. */
const ATTESTOR_DIST = fileURLToPath(new URL("../../../attestor/dist/", import.meta.url));

export async function loadVerifyCharge(): Promise<VerifyChargeFn> {
  const entry = join(ATTESTOR_DIST, "bin", "verify-charge.js");
  if (!existsSync(entry)) {
    throw new Error(
      `the attestor's verify-charge is not built (${entry}); run this through \`npm run verify\`, which builds it`,
    );
  }
  const module = (await import(pathToFileURL(entry).href)) as { verifyCharge?: VerifyChargeFn };
  if (typeof module.verifyCharge !== "function") {
    throw new Error(`${entry} does not export verifyCharge`);
  }
  return module.verifyCharge;
}
