export * from "./types.js";
export {
  FixtureCoverageSource,
  UnknownNote,
  type FixtureNote,
  type FixtureSourceOptions,
} from "./fixture.js";
export { LiveCoverageSource } from "./live.js";

import type { CoverageSource } from "./types.js";
import { FixtureCoverageSource } from "./fixture.js";
import { LiveCoverageSource } from "./live.js";

export type CoverageSourceKind = "fixture" | "live";

/**
 * Chooses the source. Defaults to fixtures because that is what actually works
 * today. Selecting `live` gets a service that refuses every request, which is
 * the honest behaviour rather than a broken one.
 */
export function createCoverageSource(kind: CoverageSourceKind, endpoint?: string): CoverageSource {
  return kind === "live" ? new LiveCoverageSource(endpoint) : new FixtureCoverageSource();
}
