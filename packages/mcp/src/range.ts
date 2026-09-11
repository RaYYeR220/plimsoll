import type { Config, NetworkName } from "./config.js";
import type { StreamSlots } from "./feed.js";
import { classify, openStream } from "./feed.js";
import type { Provenance } from "./provenance.js";
import { isoOf } from "./provenance.js";
import type { EvidenceRefusal } from "./refusals.js";
import { evidenceRefusal } from "./refusals.js";
import type { ConfiguredPackage, LoadedPackage } from "./spkg.js";
import { configure } from "./spkg.js";
import { FeedState } from "./state.js";
import type { RangeResult, RangeRunner } from "./tools.js";

/**
 * Series older than the live buffer are fetched with a bounded, final-only
 * Substreams request over exactly the requested blocks. Such a request takes
 * one of the token's few stream slots. If none frees up within a short wait,
 * the answer is a typed refusal, not a queue that hangs the caller, and never
 * a quiet fallback to some other data source.
 */
export class LiveRangeRunner implements RangeRunner {
  private readonly cache = new Map<NetworkName, Promise<ConfiguredPackage>>();

  constructor(
    private readonly o: {
      readonly config: Config;
      readonly loaded: LoadedPackage;
      readonly token: string | undefined;
      readonly slots: StreamSlots;
      readonly log?: (line: string) => void;
    },
  ) {}

  private configured(network: NetworkName): Promise<ConfiguredPackage> {
    let c = this.cache.get(network);
    if (!c) {
      c = configure(this.o.loaded, network, "map_vault_blocks");
      this.cache.set(network, c);
    }
    return c;
  }

  async vaultSeries(network: NetworkName, vault: string, fromBlock: bigint, toBlock: bigint): Promise<RangeResult | EvidenceRefusal> {
    const spec = this.o.config.networks[network];
    let configured: ConfiguredPackage;
    try {
      configured = await this.configured(network);
    } catch (error) {
      return evidenceRefusal("source_unavailable", this.provenance(network, null, null), {
        cause: "package_has_no_such_network",
        hint: (error as Error).message,
      });
    }
    const prov = (last: { block: string; blockHash: string; timestamp: number } | null) => this.provenance(network, configured, last);
    if (!this.o.token) return evidenceRefusal("source_unavailable", prov(null), { cause: "no_token" });

    const release = await this.o.slots.tryAcquire(this.o.config.slotWaitMs);
    if (!release) {
      return evidenceRefusal("source_unavailable", prov(null), {
        cause: "stream_capacity",
        hint: "every Graph Market stream slot for this token is in use; retry shortly",
      });
    }
    const state = new FeedState(Number.MAX_SAFE_INTEGER);
    const timeout = AbortSignal.timeout(this.o.config.rangeTimeoutMs);
    try {
      this.o.log?.(`[range:${network}] ${vault} ${fromBlock}..${toBlock}`);
      await openStream({
        spec,
        configured,
        token: this.o.token,
        finalBlocksOnly: true,
        startBlock: fromBlock,
        stopBlock: toBlock + 1n,
        signal: timeout,
        onBlock: (block, finalHeight, cursor, out) => {
          // Only this vault's rows are kept, so memory tracks the answer rather than the chain.
          const vaults = out?.vaults?.filter((v) => v.vault.toLowerCase() === vault);
          state.applyBlock(block, finalHeight, cursor, vaults?.length ? { ...out, vaults } : undefined);
        },
      });
    } catch (error) {
      const kind = timeout.aborted ? "range_timeout" : classify(error).kind;
      return evidenceRefusal("source_unavailable", prov(null), { cause: kind });
    } finally {
      release();
    }
    const points = state.series.get(vault) ?? [];
    const last = points[points.length - 1] ?? null;
    return { points, provenance: prov(last) };
  }

  private provenance(
    network: NetworkName,
    configured: ConfiguredPackage | null,
    last: { block: string; blockHash: string; timestamp: number } | null,
  ): Provenance {
    const spec = this.o.config.networks[network];
    return {
      provider: "The Graph Market",
      transport: "substreams",
      endpoint: spec.endpoint,
      network,
      package: { name: this.o.loaded.name, version: this.o.loaded.version, sha256: this.o.loaded.sha256 },
      module: { name: "map_vault_blocks", hash: configured?.moduleHash ?? "unconfigured" },
      finalBlocksOnly: true,
      block: last ? { number: last.block, hash: last.blockHash, timestamp: isoOf(last.timestamp), final: true } : null,
      head: null,
      builtAt: new Date().toISOString(),
    };
  }
}
