import type { VerifyChargeFn } from "./attestor.js";
import type { Endpoints } from "./http.js";
import type { DeploymentRecord, Inputs, Manifest } from "./inputs.js";
import type { MirrorApi } from "./mirror.js";

/** What every check receives. Swapping these is how the tests run offline. */
export interface Context {
  inputs: Inputs;
  record: DeploymentRecord;
  manifest: Manifest;
  mirror: MirrorApi;
  /** Throttled fetch for the non-mirror services. */
  http: typeof fetch;
  endpoints: Endpoints;
  /** Null when the attestor could not be loaded; the reason is in verifyChargeError. */
  verifyCharge: VerifyChargeFn | null;
  verifyChargeError?: string;
  windowStart: number;
  explorer: string;
}
