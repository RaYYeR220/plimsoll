/**
 * The package's output as protobuf JSON. proto3 JSON omits default values, so
 * every field is optional here and a missing boolean means false: an absent
 * `ratesConsistent` is a vault whose rates are NOT consistent, never an
 * unknown to be read charitably.
 */
export interface VaultBlockJson {
  readonly vault: string;
  readonly asset?: string;
  readonly assetSymbol?: string;
  readonly shareSymbol?: string;
  readonly verification?: string;
  readonly shareDecimals?: number;
  readonly assetDecimals?: number;
  readonly blockNumber?: string;
  readonly blockHash?: string;
  readonly timestamp?: string;
  readonly depositAssets?: string;
  readonly depositShares?: string;
  readonly withdrawAssets?: string;
  readonly withdrawShares?: string;
  readonly depositCount?: number;
  readonly withdrawCount?: number;
  readonly depositAssetsNorm?: string;
  readonly withdrawAssetsNorm?: string;
  readonly netAssetsNorm?: string;
  readonly netSharesNorm?: string;
  readonly entryRate?: string;
  readonly exitRate?: string;
  readonly feeSpreadBps?: string;
  readonly entryPremiumPct?: string;
  readonly exitDiscountPct?: string;
  readonly ratesConsistent?: boolean;
  readonly stateOk?: boolean;
  readonly totalAssets?: string;
  readonly totalSupply?: string;
  readonly totalAssetsNorm?: string;
  readonly totalSupplyNorm?: string;
  readonly statePrice?: string;
  readonly maxDeposit?: string;
  readonly assetPriceUsd?: string;
  readonly tvlUsd?: string;
}

export interface PositionJson {
  readonly note?: string;
  readonly holder?: string;
  readonly vault?: string;
  readonly asset?: string;
  readonly assetDecimals?: number;
  readonly shareDecimals?: number;
  readonly shares?: string;
  readonly assets?: string;
  readonly assetsNorm?: string;
  readonly assetPriceUsd?: string;
  readonly valueUsd?: string;
  readonly priceBlock?: string;
  readonly ok?: boolean;
  readonly verification?: string;
  readonly ratesConsistent?: boolean;
  readonly lastFlowBlock?: string;
}

/** Positions (map_positions) or VaultBlocks (map_vault_blocks); the latter simply has no positions. */
export interface BlockOutputJson {
  readonly blockNumber?: string;
  readonly blockHash?: string;
  readonly timestamp?: string;
  readonly positionsRead?: boolean;
  readonly positions?: readonly PositionJson[];
  readonly vaults?: readonly VaultBlockJson[];
}

export interface ObservedBlock {
  readonly number: bigint;
  readonly hash: string;
  /** Unix seconds. */
  readonly timestamp: number;
}
