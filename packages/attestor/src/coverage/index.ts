export * from "./types.js";
export {
  FixtureCoverageSource,
  UnknownNote,
  type FixtureNote,
  type FixtureSourceOptions,
} from "./fixture.js";
export { LiveCoverageSource, BASE_USDC, obligationTerms, type LiveSourceOptions } from "./live.js";
export * from "./live-errors.js";
export * from "./rpc.js";
export * from "./notes-file.js";
export * from "./pricing.js";
export * from "./witness.js";
// `noteIdOf` is exported under a distinct name here: the package root names one
// too, and re-exporting both through a star would be ambiguous.
export {
  COVERAGE_ORACLE_ABI,
  LOAD_LINE_ABI,
  MirrorLiabilityReader,
  NOTE_ABI,
  ROLE_ISSUER,
  noteIdOf as marketNoteId,
  type LiabilityReader,
  type LiabilityReading,
  type MirrorReaderOptions,
  type NoteRegistry,
} from "./hedera.js";

import type { CoverageSource } from "./types.js";
import { FixtureCoverageSource } from "./fixture.js";
import { LiveCoverageSource } from "./live.js";

export type CoverageSourceKind = "fixture" | "live";

/**
 * Chooses the source. Defaults to fixtures. Selecting `live` reads real chains
 * when `LIVE_NOTES_FILE` is set (see `LiveCoverageSource.fromEnv`), and
 * otherwise gets a service that refuses every request, which is the honest
 * behaviour rather than a broken one.
 */
export function createCoverageSource(kind: CoverageSourceKind, endpoint?: string): CoverageSource {
  return kind === "live" ? LiveCoverageSource.fromEnv(process.env, endpoint) : new FixtureCoverageSource();
}
