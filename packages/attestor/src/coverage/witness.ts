import { parseAbi } from "viem";
import { SourceStale } from "./live-errors.js";
import { blockByHash, callAt, headNumber, JsonRpcError, type JsonRpc, type PinnedBlock } from "./rpc.js";
import { SourcesDisagree, SourceUnavailable, VaultUnresolved, type CoverageSourceError } from "./types.js";

/**
 * ============================ SEAM ============================
 * A second, independent reading of the same positions.
 *
 * The live source values positions itself with pinned `eth_call`s. A witness
 * answers the same question from somewhere else: another RPC provider today
 * (`RpcPositionWitness`), and the Substreams `map_positions` output next, which
 * reads through The Graph's pipeline and shares nothing with our RPC path.
 *
 * Disagreement beyond tolerance is an evidence refusal with no number. So is a
 * witness that cannot answer, or that lags too far behind: a configured
 * cross-check that did not happen is not a cross-check that passed.
 * ==============================================================
 */

export const VAULT_ABI = parseAbi([
  "function asset() view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

export const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

/** One position as one source saw it. */
export interface PositionReading {
  readonly vault: string;
  readonly shares: bigint;
  readonly assets: bigint;
  /** Block the reading describes. A witness may answer from an earlier block. */
  readonly blockNumber: bigint;
}

export interface WitnessQuery {
  readonly noteId: string;
  readonly chainId: number;
  readonly holder: string;
  readonly vaults: readonly string[];
  readonly block: PinnedBlock;
}

export interface PositionWitness {
  readonly id: string;
  /** Published name of where the witness reads from. Never a credential. */
  readonly endpoint: string;
  /**
   * Highest block this witness can answer for. When present, the source pins to
   * a block every witness has reached, so both sides describe the same state.
   */
  head?(): Promise<bigint>;
  /** Latest reading at or below `query.block` for every vault in the query. */
  positionsAt(query: WitnessQuery): Promise<PositionReading[]>;
}

/**
 * A revert or an empty return is a fact about the vault. A node we could not
 * reach is a fact about us. They refuse under different reasons.
 */
export function classifyCallFailure(error: unknown, vault: string, what: string): CoverageSourceError {
  if (error instanceof JsonRpcError && error.kind === "transport") {
    return new SourceUnavailable(error.message, { endpoint: error.endpoint, vault, call: what });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VaultUnresolved(vault, `${what} on ${vault} did not give a usable reading: ${message}`);
}

export async function vaultCall<T>(
  rpc: JsonRpc,
  block: PinnedBlock,
  vault: string,
  functionName: "asset" | "balanceOf" | "convertToAssets",
  args: readonly unknown[] = [],
): Promise<T> {
  try {
    return await callAt<T>(rpc, block, { address: vault, abi: VAULT_ABI, functionName, args });
  } catch (error) {
    throw classifyCallFailure(error, vault, functionName);
  }
}

/** `balanceOf(holder)` and `convertToAssets` of that balance, per vault, at one block. */
export async function readPositions(
  rpc: JsonRpc,
  block: PinnedBlock,
  holder: string,
  vaults: readonly string[],
): Promise<PositionReading[]> {
  return Promise.all(
    vaults.map(async (vault) => {
      const shares = await vaultCall<bigint>(rpc, block, vault, "balanceOf", [holder]);
      const assets = await vaultCall<bigint>(rpc, block, vault, "convertToAssets", [shares]);
      return { vault, shares, assets, blockNumber: block.number };
    }),
  );
}

/**
 * The same calls, at the same block hash, through a different provider. If the
 * provider does not know the block, it cannot corroborate anything about it.
 */
export class RpcPositionWitness implements PositionWitness {
  readonly id: string;
  readonly endpoint: string;
  private readonly rpc: JsonRpc;

  constructor(rpc: JsonRpc) {
    this.rpc = rpc;
    this.id = `eth_call@${rpc.label}`;
    this.endpoint = rpc.label;
  }

  head(): Promise<bigint> {
    return headNumber(this.rpc);
  }

  async positionsAt(query: WitnessQuery): Promise<PositionReading[]> {
    const seen = await blockByHash(this.rpc, query.block.hash);
    if (!seen || seen.number !== query.block.number) {
      throw new SourcesDisagree(
        `block ${query.block.number}`,
        query.block.hash,
        seen ? `${seen.hash} at ${seen.number}` : `unknown to ${this.id}`,
        0,
      );
    }
    return readPositions(this.rpc, query.block, query.holder, query.vaults);
  }
}

export interface CrossCheckOptions {
  /** Largest allowed difference in `assets`, in basis points of the larger reading. */
  toleranceBps: number;
  /** A witness reading more than this many blocks older than the pin is stale. */
  maxLagBlocks: bigint;
}

/**
 * Share balances must agree exactly: they only move when the holder moves them,
 * and a witness that missed a move is describing a different position. Values
 * may differ within tolerance, because a witness answering from a slightly
 * earlier block sees a slightly different share price.
 */
export function crossCheck(
  primary: readonly PositionReading[],
  witness: readonly PositionReading[],
  witnessId: string,
  options: CrossCheckOptions,
): void {
  const byVault = new Map(witness.map((r) => [r.vault.toLowerCase(), r]));
  for (const p of primary) {
    const w = byVault.get(p.vault.toLowerCase());
    if (!w) {
      throw new SourcesDisagree(p.vault, `${p.shares} shares`, `no reading from ${witnessId}`, options.toleranceBps);
    }
    if (w.blockNumber > p.blockNumber) {
      throw new SourcesDisagree(p.vault, `block ${p.blockNumber}`, `block ${w.blockNumber} from ${witnessId}`, 0);
    }
    const lag = p.blockNumber - w.blockNumber;
    if (lag > options.maxLagBlocks) {
      throw new SourceStale(`${witnessId} last read ${p.vault} ${lag} blocks before the pinned block`, {
        vault: p.vault,
        witness: witnessId,
        lagBlocks: lag.toString(),
        toleranceBlocks: options.maxLagBlocks.toString(),
      });
    }
    if (w.shares !== p.shares) {
      throw new SourcesDisagree(p.vault, p.shares.toString(), w.shares.toString(), 0);
    }
    if (!withinBps(p.assets, w.assets, options.toleranceBps)) {
      throw new SourcesDisagree(p.vault, p.assets.toString(), w.assets.toString(), options.toleranceBps);
    }
  }
}

export function withinBps(left: bigint, right: bigint, toleranceBps: number): boolean {
  if (left === right) return true;
  const base = left > right ? left : right;
  if (base === 0n) return false;
  const delta = left > right ? left - right : right - left;
  return (delta * 10_000n) / base <= BigInt(toleranceBps);
}
