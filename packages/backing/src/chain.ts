import {
  createPublicClient,
  custom,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { DEFAULT_RPC, GAS_PRICE_ORACLE } from "./config.js";

export const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

export const WETH_ABI = parseAbi(["function deposit() payable", "function withdraw(uint256 amount)"]);

export const VAULT_ABI = parseAbi([
  "function asset() view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
]);

export const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);

const FEE_ORACLE_ABI = parseAbi(["function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)"]);

const RATE_LIMITED = /rate limit|too many requests|429|limit exceeded/i;

/**
 * A read client that waits and retries when a public endpoint says it is being
 * called too often. Only reads go through it; transactions are sent elsewhere
 * and are never retried blindly.
 */
export function publicClientFor(rpc = DEFAULT_RPC): PublicClient {
  const inner = http(rpc, { retryCount: 0 })({ chain: base });
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await inner.request({ method, params } as never);
        } catch (error) {
          const e = error as { message?: string; details?: string };
          const limited = RATE_LIMITED.test(`${e.message ?? ""} ${e.details ?? ""}`);
          if (!limited || attempt >= 6) throw error;
          await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
        }
      }
    },
  });
  return createPublicClient({ chain: base, transport }) as PublicClient;
}

export interface Pinned {
  readonly number: bigint;
  readonly hash: Hex;
  readonly timestamp: number;
}

/** One block, chosen once. Every read in a command is made against its hash. */
export async function pin(client: PublicClient, confirmations = 2n): Promise<Pinned> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const block = await client.getBlock({ blockNumber: head - confirmations });
  return { number: block.number, hash: block.hash, timestamp: Number(block.timestamp) };
}

/** `eth_call` at an EIP-1898 block hash, refusing a non-canonical block. */
export async function readAt<T>(
  client: PublicClient,
  at: Pinned,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const raw = (await client.request({
    method: "eth_call",
    params: [{ to: address, data }, { blockHash: at.hash, requireCanonical: true } as never],
  })) as Hex;
  if (raw === "0x") throw new Error(`${functionName} on ${address} returned no data`);
  return decodeFunctionResult({ abi, functionName, data: raw } as never) as T;
}

/** An upper bound on the L1 data fee of a transaction of roughly this size. */
export async function l1FeeUpperBound(client: PublicClient, unsignedTxSize: number): Promise<bigint> {
  return client.readContract({
    address: GAS_PRICE_ORACLE,
    abi: FEE_ORACLE_ABI,
    functionName: "getL1FeeUpperBound",
    args: [BigInt(unsignedTxSize)],
  });
}
