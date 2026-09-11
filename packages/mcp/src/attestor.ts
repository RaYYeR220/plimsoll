/**
 * Coverage arithmetic is imported from the attestor, not re-implemented, so a
 * figure this server quotes and a figure the attestor signs cannot drift. The
 * import is a runtime path into packages/attestor/dist (read-only; build the
 * attestor first). It is not a package dependency, because an npm link would
 * write into the attestor's tree.
 *
 * attest.js pulls in only node:crypto and the attestor's own pure modules, so
 * this does not start a server or load wallet code.
 */
import { pathToFileURL } from "node:url";
import type * as AttestModule from "../../attestor/dist/src/attest.js";
import type * as PolicyModule from "../../attestor/dist/src/policy.js";

const base = process.env.ATTESTOR_DIST
  ? pathToFileURL(process.env.ATTESTOR_DIST.replace(/[\\/]?$/, "/")).href
  : new URL("../../../attestor/dist/src/", import.meta.url).href;

let attest: typeof AttestModule;
let policy: typeof PolicyModule;
try {
  attest = (await import(new URL("attest.js", base).href)) as typeof AttestModule;
  policy = (await import(new URL("policy.js", base).href)) as typeof PolicyModule;
} catch (error) {
  throw new Error(
    `cannot load the attestor's coverage arithmetic from ${base} — run \`npm run build\` in packages/attestor, or set ATTESTOR_DIST. (${(error as Error).message})`,
  );
}

export const normalise = attest.normalise;
export const coverageBpsOf = attest.coverageBpsOf;
export const ATTESTOR_POLICY = policy.DEFAULT_POLICY;
export const attestorPolicyHash = policy.policyHash;
