import { parseAbi } from "viem";
import { SourceStale } from "./live-errors.js";
import { callAt, type JsonRpc, type PinnedBlock } from "./rpc.js";
import { SourceUnavailable } from "./types.js";

/**
 * Restating a non-unit asset in the unit.
 *
 * The unit (USDC) is never priced: a dollar note measured in dollars needs no
 * oracle. Anything else must have a feed listed here, read at the same block as
 * the position it prices. An asset with no feed is not valued at all.
 */
export interface PriceFeed {
  /** The asset this feed prices, lowercase. */
  readonly asset: string;
  readonly feed: string;
  /** What the feed must call itself; a mismatch means the address is wrong. */
  readonly description: string;
  /** Older than this relative to the pinned block and the price is refused. */
  readonly maxAgeSeconds: number;
}

/**
 * Base mainnet. Chainlink ETH/USD, checked on-chain: `description()` is
 * "ETH / USD" and `decimals()` is 8. An hour is several missed heartbeats.
 */
export const BASE_PRICE_FEEDS: readonly PriceFeed[] = [
  {
    asset: "0x4200000000000000000000000000000000000006",
    feed: "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70",
    description: "ETH / USD",
    maxAgeSeconds: 3600,
  },
];

const FEED_ABI = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export interface PriceReading {
  readonly feed: string;
  readonly description: string;
  readonly answer: bigint;
  readonly decimals: number;
  readonly updatedAt: number;
}

export async function readPrice(rpc: JsonRpc, block: PinnedBlock, feed: PriceFeed): Promise<PriceReading> {
  const [description, decimals, round] = await Promise.all([
    callAt<string>(rpc, block, { address: feed.feed, abi: FEED_ABI, functionName: "description" }),
    callAt<number>(rpc, block, { address: feed.feed, abi: FEED_ABI, functionName: "decimals" }),
    callAt<readonly [bigint, bigint, bigint, bigint, bigint]>(rpc, block, {
      address: feed.feed,
      abi: FEED_ABI,
      functionName: "latestRoundData",
    }),
  ]);
  if (description !== feed.description) {
    throw new SourceUnavailable(`price feed ${feed.feed} calls itself "${description}", expected "${feed.description}"`, {
      feed: feed.feed,
    });
  }
  const answer = round[1];
  const updatedAt = Number(round[3]);
  if (answer <= 0n) {
    throw new SourceUnavailable(`price feed ${feed.feed} answered ${answer}`, { feed: feed.feed });
  }
  const age = block.timestamp - updatedAt;
  if (age > feed.maxAgeSeconds) {
    throw new SourceStale(`price feed ${feed.feed} last updated ${age}s before the pinned block`, {
      feed: feed.feed,
      ageSeconds: age,
      toleranceSeconds: feed.maxAgeSeconds,
    });
  }
  return { feed: feed.feed, description, answer, decimals: Number(decimals), updatedAt };
}

/**
 * `assets` at `assetDecimals`, times a price at `priceDecimals`, restated at
 * `unitDecimals`. One division, at the end, rounding down: like every other
 * conversion in the service, it errs against the issuer.
 */
export function restate(
  assets: bigint,
  assetDecimals: number,
  answer: bigint,
  priceDecimals: number,
  unitDecimals: number,
): bigint {
  return (assets * answer * 10n ** BigInt(unitDecimals)) / 10n ** BigInt(assetDecimals + priceDecimals);
}
