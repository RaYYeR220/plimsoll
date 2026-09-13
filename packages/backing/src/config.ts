import type { Address } from "viem";

/**
 * Everything this package acts on, in one place.
 *
 * Addresses were checked on Base at a pinned block before they were written
 * here (see the README): each vault's `asset()`, its preview functions, and a
 * deposit followed by an immediate full redeem on a fork.
 */

export const BASE_CHAIN_ID = 8453;
export const DEFAULT_RPC = "https://mainnet.base.org";
export const BASESCAN = "https://basescan.org";

/**
 * The issuer's address. It is the Hedera operator's ECDSA key, so the note's
 * on-chain issuer on Hedera and the holder of its backing on Base are the same
 * address, and a signer that derives to anything else is refused.
 */
export const HOLDER: Address = "0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a";

export interface TokenSpec {
  readonly symbol: "USDC" | "WETH";
  readonly address: Address;
  readonly decimals: number;
  /**
   * Storage slots of the `balanceOf` and `allowance` mappings. Used only to
   * simulate a deposit before the approval or the funds exist; never to send.
   */
  readonly balanceSlot: bigint;
  readonly allowanceSlot: bigint;
}

export const TOKENS: Record<TokenSpec["symbol"], TokenSpec> = {
  // Native USDC (FiatTokenV2_2): balanceAndBlacklistStates at 9, allowed at 10.
  USDC: {
    symbol: "USDC",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    balanceSlot: 9n,
    allowanceSlot: 10n,
  },
  // WETH9 predeploy: balanceOf at 3, allowance at 4.
  WETH: {
    symbol: "WETH",
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    balanceSlot: 3n,
    allowanceSlot: 4n,
  },
};

/** Chainlink ETH/USD on Base: `description()` "ETH / USD", 8 decimals. */
export const ETH_USD_FEED: Address = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

/** OP-stack fee oracle, for the L1 data part of each transaction's cost. */
export const GAS_PRICE_ORACLE: Address = "0x420000000000000000000000000000000000000F";

export type Market = "PLIM-B" | "PLIM-A";

export interface VaultSpec {
  readonly key: string;
  readonly name: string;
  readonly protocol: string;
  readonly address: Address;
  readonly asset: TokenSpec["symbol"];
  readonly market: Market;
}

export const VAULTS: readonly VaultSpec[] = [
  {
    key: "morpho",
    name: "Gauntlet USDC Prime",
    protocol: "Morpho (MetaMorpho)",
    address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
    asset: "USDC",
    market: "PLIM-B",
  },
  {
    key: "aave",
    name: "Wrapped Aave Base USDC",
    protocol: "Aave v3 static aToken",
    address: "0xC768c589647798a6EE01A91FdE98EF2ed046DBD6",
    asset: "USDC",
    market: "PLIM-B",
  },
  {
    key: "spark",
    name: "Spark USDC Vault (sUSDC)",
    protocol: "Spark (PSM3)",
    address: "0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858",
    asset: "USDC",
    market: "PLIM-B",
  },
  {
    key: "fluid",
    name: "Fluid USD Coin (fUSDC)",
    protocol: "Fluid",
    address: "0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169",
    asset: "USDC",
    market: "PLIM-A",
  },
];

/**
 * Kept for the WETH leg, which is ready here but not yet in the evidence.
 * Moonwell Flagship ETH (`0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1`) passes
 * every check and its price feed is wired in the attestor's `pricing.ts`, but
 * the evidence schema has nowhere to record how WETH was restated in dollars,
 * and a position recorded without that reads as one WETH to the dollar. It is
 * out until the schema carries the price.
 */
export const WETH_VAULT_ON_HOLD = "0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1";

export function vaultByKey(key: string): VaultSpec {
  const vault = VAULTS.find((v) => v.key === key);
  if (!vault) throw new Error(`unknown vault "${key}"; expected one of ${VAULTS.map((v) => v.key).join(", ")}`);
  return vault;
}

/**
 * How the funds are split.
 *
 * PLIM-B's obligation is about $10. The named position (`morpho`) is large
 * enough that redeeming it alone takes coverage well under the line, while
 * either of the other two can go without the note falling below it. The last
 * leg takes what is left, capped so that property survives a larger balance.
 */
export interface DepositLeg {
  readonly vault: string;
  /** Decimal amount in the vault's asset, or "rest" for what remains. */
  readonly amount: string;
  readonly min?: string;
  readonly max?: string;
}

export const PLAN: Record<Market, readonly DepositLeg[]> = {
  "PLIM-B": [
    { vault: "morpho", amount: "8" },
    { vault: "aave", amount: "3" },
    { vault: "spark", amount: "rest", min: "0.5", max: "4" },
  ],
  // The negative control: a real dollar against a $1,000,000 note.
  "PLIM-A": [{ vault: "fluid", amount: "1" }],
};

/**
 * The control's dollar is set aside before PLIM-B's legs are sized, so the
 * note that has to clear a line is never funded out of the control's money.
 */
export const CONTROL_FIRST: readonly Market[] = ["PLIM-A", "PLIM-B"];

/** What the holder is expected to be funded with, used only to simulate before it arrives. */
export const PLANNED_FUNDING_USDC = "15";

/** The position redeemed on camera. */
export const NAMED_POSITION = "morpho";

/** ETH kept back for gas after wrapping PLIM-A's leg. */
export const ETH_GAS_RESERVE = "0.0002";

/**
 * PLIM-B's figures if its chain cannot be reached. Shown as PLANNED wherever
 * they are used, and they match what the note reported on 2026-09-12. The
 * attestor never uses them: it refuses instead.
 */
export const PLANNED_LIABILITIES: Partial<Record<Market, { notes: string; parUsd: string; thresholdBps: number }>> = {
  "PLIM-B": { notes: "10", parUsd: "1", thresholdBps: 10_000 },
};

export interface RegistryRef {
  readonly chain: string;
  readonly chainId: number;
  readonly mirror: string;
  readonly note: string;
  readonly loadLine: string;
  readonly coverageOracle: string;
}

/**
 * Where each note's own figures live. The notes file is authoritative once it
 * carries a registry for a market; this is the fallback so `status` reads the
 * chain rather than a plan in the meantime.
 */
const HEDERA_TESTNET = {
  chain: "hedera-testnet",
  chainId: 296,
  mirror: "https://testnet.mirrornode.hedera.com/api/v1",
  loadLine: "0xf867b6f41b21e9d72f327f867ae898620d022c80",
  coverageOracle: "0xce13de224ed918d7b8b2717492849e0a82648ca3",
} as const;

export const REGISTRY: Record<Market, RegistryRef> = {
  "PLIM-B": { ...HEDERA_TESTNET, note: "0xcf759c717e805413aaa7d067db7bd7a93969def2" },
  "PLIM-A": { ...HEDERA_TESTNET, note: "0xe2bf359650fbacc7d4801336f8c1fe7061ad6387" },
};
