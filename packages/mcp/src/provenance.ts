/**
 * Where an answer came from, precisely enough for a stranger to re-fetch it:
 * the exact package bytes (sha256), the module whose output was read (its
 * content hash, which is also the provider's cache key), the endpoint, and the
 * block the answer rests on, next to the head the stream had reached. An
 * agent acting on a number needs all of it. A refusal carries the same block,
 * so it is clear which data was found wanting.
 */
export interface BlockRef {
  readonly number: string;
  readonly hash: string;
  readonly timestamp: string;
}

export interface HeadRef extends BlockRef {
  readonly lagSeconds: number;
  readonly finalBlockHeight: string | null;
}

/** One read against the note registry chain. `value` is omitted on evidence refusals for quantity reads. */
export interface ChainRead {
  readonly chain: string;
  readonly chainId: number;
  readonly rpc: string;
  readonly contract: string;
  readonly method: string;
  readonly block: string;
  readonly kind: "quantity" | "identity";
  readonly value?: string;
}

export interface Provenance {
  readonly provider: "The Graph Market";
  readonly transport: "substreams";
  readonly endpoint: string | null;
  readonly network: string | null;
  readonly package: { readonly name: string; readonly version: string; readonly sha256: string };
  readonly module: { readonly name: string; readonly hash: string };
  readonly finalBlocksOnly: boolean | null;
  /** The block this answer rests on. Null when nothing was observed. */
  readonly block: (BlockRef & { readonly final: boolean | null }) | null;
  readonly head: HeadRef | null;
  readonly builtAt: string;
  readonly reads?: readonly ChainRead[];
}

export function isoOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** Quantity values are dropped so that an evidence refusal quotes no figure, even in its provenance. */
export function withoutQuantities(p: Provenance): Provenance {
  if (!p.reads) return p;
  return {
    ...p,
    reads: p.reads.map((r) => (r.kind === "quantity" ? stripValue(r) : r)),
  };
}

function stripValue(r: ChainRead): ChainRead {
  const { value: _drop, ...rest } = r;
  return rest;
}
