import { type CoverageSnapshot, type CoverageSource, SourceUnavailable } from "./types.js";

/**
 * ============================ SEAM ============================
 * Placeholder for the Substreams-backed source over ERC-4626 vault flows.
 *
 * It is deliberately not a partial implementation. Half-wired data would be
 * worse than none: a source that returned a plausible number from an incomplete
 * index would make the service emit a signed attestation nobody can reproduce,
 * which is the exact failure this product exists to prevent. Until the pipeline
 * is wired, every call refuses.
 * ==============================================================
 */
export class LiveCoverageSource implements CoverageSource {
  readonly id = "substreams";
  private readonly endpoint: string | undefined;

  constructor(endpoint?: string) {
    this.endpoint = endpoint;
  }

  async positionsFor(noteId: string, atBlock?: bigint): Promise<CoverageSnapshot> {
    throw new SourceUnavailable(
      "the Substreams coverage pipeline is not wired yet; this source never guesses",
      {
        noteId,
        atBlock: atBlock === undefined ? null : atBlock.toString(),
        endpoint: this.endpoint ?? null,
        seam: "src/coverage/live.ts",
      },
    );
  }
}
