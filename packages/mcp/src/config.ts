import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type NetworkName = "mainnet" | "base";
export const NETWORKS: readonly NetworkName[] = ["mainnet", "base"];

export interface NetworkSpec {
  readonly name: NetworkName;
  readonly chainId: number;
  readonly endpoint: string;
  readonly blockSeconds: number;
  /**
   * Whether the long-lived feed takes only final blocks. Final-only never
   * sees a reorg, so nothing it serves can be rolled back later. It pays for
   * that in lag, which is why it is chosen per network below.
   */
  readonly finalBlocksOnly: boolean;
  /** The stream head older than this makes every answer `data_stale`. */
  readonly headMaxLagSeconds: number;
}

export interface Config {
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly packagePath: string;
  readonly outputModule: string;
  readonly notesFile: string;
  readonly attestorUrl: string;
  readonly feedNetworks: readonly NetworkName[];
  /** The Graph Market's per-token concurrent stream cap, shared by feeds and range requests. */
  readonly streamSlots: number;
  readonly slotWaitMs: number;
  readonly networks: Readonly<Record<NetworkName, NetworkSpec>>;
  /** Oldest observation served as current. Defaults to the attestor policy's value. */
  readonly maxStalenessSeconds: number;
  readonly seriesBufferPoints: number;
  readonly rangeMaxBlocks: number;
  readonly rangeTimeoutMs: number;
  readonly startBlocksBack: number;
}

const here = dirname(fileURLToPath(import.meta.url));
/** packages/mcp, whether running from src (tests via tsx) or dist/src. */
export const PACKAGE_ROOT = resolve(here, here.includes(`${"dist"}`) ? "../.." : "..");

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a non-negative number: ${v}`);
  return n;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === "") return fallback;
  return /^(1|true|yes)$/i.test(v.trim());
}

/**
 * Measured on 2026-09-11 against The Graph Market with this package:
 *   mainnet: head − finalBlockHeight ≈ 67 blocks ≈ 13.4 min
 *   base:    head − finalBlockHeight ≈ 168 blocks ≈ 5.6 min
 * Base carries the note backing, so it runs final-only: worst case a position
 * reading is 5.6 min of finality lag plus the 100 s map_positions cadence,
 * which stays under the 15 min staleness policy. Mainnet final-only would sit
 * at 13 min of lag before any vault has even been touched, so mainnet serves
 * the head and every answer declares that it is not final.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = num(env.PORT, 4030);
  const feedNetworks = (env.FEED_NETWORKS ?? "base")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as NetworkName[];
  for (const n of feedNetworks) if (!NETWORKS.includes(n)) throw new Error(`unknown network in FEED_NETWORKS: ${n}`);

  const baseFinal = bool(env.BASE_FINAL_BLOCKS_ONLY, true);
  const mainnetFinal = bool(env.MAINNET_FINAL_BLOCKS_ONLY, false);
  return {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    packagePath: resolve(PACKAGE_ROOT, env.SUBSTREAMS_PACKAGE ?? "../substreams/plimsoll-erc4626-v0.2.0.spkg"),
    outputModule: env.SUBSTREAMS_MODULE ?? "map_positions",
    notesFile: resolve(PACKAGE_ROOT, env.NOTES_FILE ?? "../substreams/notes.json"),
    attestorUrl: (env.ATTESTOR_URL ?? "http://localhost:4021").replace(/\/$/, ""),
    feedNetworks,
    streamSlots: num(env.STREAM_SLOTS, 2),
    slotWaitMs: num(env.STREAM_SLOT_WAIT_MS, 3_000),
    networks: {
      mainnet: {
        name: "mainnet",
        chainId: 1,
        endpoint: env.MAINNET_ENDPOINT ?? "https://mainnet.eth.streamingfast.io",
        blockSeconds: 12,
        finalBlocksOnly: mainnetFinal,
        headMaxLagSeconds: num(env.MAINNET_HEAD_MAX_LAG_SECONDS, mainnetFinal ? 1_200 : 180),
      },
      base: {
        name: "base",
        chainId: 8453,
        endpoint: env.BASE_ENDPOINT ?? "https://base-mainnet.streamingfast.io",
        blockSeconds: 2,
        finalBlocksOnly: baseFinal,
        headMaxLagSeconds: num(env.BASE_HEAD_MAX_LAG_SECONDS, baseFinal ? 600 : 120),
      },
    },
    maxStalenessSeconds: num(env.MAX_STALENESS_SECONDS, 900),
    seriesBufferPoints: num(env.SERIES_BUFFER_POINTS, 2_000),
    rangeMaxBlocks: num(env.RANGE_MAX_BLOCKS, 5_000),
    rangeTimeoutMs: num(env.RANGE_TIMEOUT_MS, 120_000),
    startBlocksBack: num(env.START_BLOCKS_BACK, 300),
  };
}

/**
 * The token is read from the environment, or from a dotenv-style file named
 * by SUBSTREAMS_ENV_FILE so a secret kept outside the repo never has to be
 * copied into it. It is never logged or echoed.
 */
export function readToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.SUBSTREAMS_API_TOKEN?.trim();
  if (direct) return direct;
  const file = env.SUBSTREAMS_ENV_FILE;
  if (!file || !existsSync(file)) return undefined;
  const m = readFileSync(file, "utf8").match(/^SUBSTREAMS_API_TOKEN=(.*)$/m);
  return m?.[1]?.trim().replace(/^["']|["']$/g, "") || undefined;
}
