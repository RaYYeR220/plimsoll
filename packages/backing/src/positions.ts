import type { Address, PublicClient } from "viem";
import { ERC20_ABI, FEED_ABI, VAULT_ABI, pin, readAt, type Pinned } from "./chain.js";
import { ETH_USD_FEED, TOKENS, VAULTS, type VaultSpec } from "./config.js";

export interface Wallet {
  readonly eth: bigint;
  readonly usdc: bigint;
  readonly weth: bigint;
}

export interface Position {
  readonly vault: VaultSpec;
  readonly shares: bigint;
  /** `convertToAssets(shares)`, in the vault's asset. */
  readonly assets: bigint;
  /** What redeeming all shares would return right now. */
  readonly redeemable: bigint;
  /** Value in micro-USD. USDC at par, WETH at the Chainlink price of the same block. */
  readonly usdMicro: bigint;
}

export interface EthUsd {
  readonly answer: bigint;
  readonly decimals: number;
  readonly updatedAt: number;
}

export interface Holdings {
  readonly block: Pinned;
  readonly holder: Address;
  readonly wallet: Wallet;
  readonly ethUsd: EthUsd;
  readonly positions: readonly Position[];
}

/**
 * Everything `status` shows, read at one block. Reads go one after another:
 * public endpoints throttle bursts, and a status line is not worth a retry storm.
 */
export async function readHoldings(client: PublicClient, holder: Address, at?: Pinned): Promise<Holdings> {
  const block = at ?? (await pin(client));
  const eth = await client.getBalance({ address: holder, blockNumber: block.number });
  const usdc = await readAt<bigint>(client, block, TOKENS.USDC.address, ERC20_ABI, "balanceOf", [holder]);
  const weth = await readAt<bigint>(client, block, TOKENS.WETH.address, ERC20_ABI, "balanceOf", [holder]);
  const round = await readAt<readonly [bigint, bigint, bigint, bigint, bigint]>(
    client,
    block,
    ETH_USD_FEED,
    FEED_ABI,
    "latestRoundData",
  );
  const feedDecimals = await readAt<number>(client, block, ETH_USD_FEED, FEED_ABI, "decimals");
  const ethUsd = { answer: round[1], decimals: Number(feedDecimals), updatedAt: Number(round[3]) };

  const positions: Position[] = [];
  for (const vault of VAULTS) {
    const shares = await readAt<bigint>(client, block, vault.address, VAULT_ABI, "balanceOf", [holder]);
    const assets = await readAt<bigint>(client, block, vault.address, VAULT_ABI, "convertToAssets", [shares]);
    const redeemable = await readAt<bigint>(client, block, vault.address, VAULT_ABI, "previewRedeem", [shares]);
    positions.push({ vault, shares, assets, redeemable, usdMicro: usdMicro(vault.asset, assets, ethUsd) });
  }
  return { block, holder, wallet: { eth, usdc, weth }, ethUsd, positions };
}

/** Rounded down, like the attestor: a valuation never errs in the issuer's favour. */
export function usdMicro(asset: "USDC" | "WETH", amount: bigint, ethUsd: EthUsd): bigint {
  if (asset === "USDC") return amount;
  return (amount * ethUsd.answer * 1_000_000n) / 10n ** BigInt(TOKENS.WETH.decimals + ethUsd.decimals);
}

/** Coverage in basis points, floored. */
export function coverageBps(backingMicro: bigint, obligationMicro: bigint): number {
  if (obligationMicro <= 0n) throw new Error("obligation must be positive");
  return Number((backingMicro * 10_000n) / obligationMicro);
}
