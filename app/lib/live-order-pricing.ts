import { sdkMarketBuyShares } from "./live-order-sizing";
import type { BookLevel, MarketFeeSchedule } from "./polymarket-data";

export type LiveBuyQuote = {
  minimumShares: number;
  requestedShares: number;
  limitPrice: number;
  amountUsd: number;
  worstTotalCostUsd: number;
  modelCeiling: number;
};

export type LiveSellQuote = { shares: number; limitPrice: number };

const decimalsFor = (tickSize: number) => Math.max(0, (String(tickSize).split(".")[1] ?? "").length);
const roundToTick = (price: number, tickSize: number, mode: "down" | "up") => {
  const ticks = mode === "down" ? Math.floor((price + 1e-10) / tickSize) : Math.ceil((price - 1e-10) / tickSize);
  return Number((ticks * tickSize).toFixed(decimalsFor(tickSize)));
};

/** Per-share taker fee: the market's CLOB schedule when known, the configured flat rate otherwise. */
export const takerFeePerShare = (price: number, schedule: MarketFeeSchedule | undefined, fallbackRate: number): number => {
  const bounded = Math.min(1, Math.max(0, price));
  if (schedule && schedule.source === "CLOB") {
    return schedule.feesEnabled ? schedule.rate * Math.pow(bounded * (1 - bounded), schedule.exponent) : 0;
  }
  const curve = schedule?.feesEnabled ? schedule.rate * Math.pow(bounded * (1 - bounded), schedule.exponent) : 0;
  return Math.max(curve, bounded * Math.max(0, fallbackRate));
};

/**
 * Highest tick price whose all-in cost (price plus latency buffer plus taker
 * fee) still leaves `minEdge` below the model's fair probability.
 */
export const modelPriceCeiling = (input: {
  fairProbability: number; minEdge: number; tickSize: number; slippageBps: number;
  feeSchedule: MarketFeeSchedule | undefined; fallbackFeeRate: number;
}): number | null => {
  const { fairProbability, minEdge, tickSize } = input;
  if (!Number.isFinite(fairProbability) || !(tickSize > 0)) return null;
  const buffer = 1 + Math.max(0, input.slippageBps) / 10_000;
  for (let price = roundToTick(Math.min(1 - tickSize, fairProbability), tickSize, "down"); price >= tickSize - 1e-12;
    price = Number((price - tickSize).toFixed(decimalsFor(tickSize)))) {
    const allIn = price * buffer + takerFeePerShare(price, input.feeSchedule, input.fallbackFeeRate);
    if (allIn <= fairProbability - minEdge + 1e-12) return price;
  }
  return null;
};

/**
 * Price the venue-minimum BUY. The limit is the price needed to fill the
 * minimum share count at visible depth plus a small tick tolerance for the
 * book moving before the order arrives, and never above the model ceiling. A
 * limit pinned exactly at the best ask only fills when nobody faster has
 * taken it, which selects the worst fills.
 */
export const quoteMinimumShareBuy = (input: {
  asks: readonly BookLevel[];
  venueMinimumShares: number | null;
  floorShares: number;
  tickSize: string;
  fairProbability: number;
  minEdge: number;
  slippageBps: number;
  toleranceTicks: number;
  feeSchedule: MarketFeeSchedule | undefined;
  fallbackFeeRate: number;
}): LiveBuyQuote | null => {
  const tick = Number(input.tickSize);
  if (!(tick > 0) || input.venueMinimumShares === null || !Number.isFinite(input.venueMinimumShares) || input.venueMinimumShares <= 0) return null;
  const asks = input.asks.filter((level) => level.price > 0 && level.price < 1 && level.size > 0).sort((left, right) => left.price - right.price);
  if (!asks.length) return null;
  const minimumShares = Math.max(input.floorShares, input.venueMinimumShares);
  let cumulative = 0;
  let priceForMinimum: number | null = null;
  for (const level of asks) {
    cumulative += level.size;
    if (cumulative + 1e-8 >= minimumShares) { priceForMinimum = level.price; break; }
  }
  if (priceForMinimum === null) return null;
  const modelCeiling = modelPriceCeiling({ fairProbability: input.fairProbability, minEdge: input.minEdge, tickSize: tick,
    slippageBps: input.slippageBps, feeSchedule: input.feeSchedule, fallbackFeeRate: input.fallbackFeeRate });
  if (modelCeiling === null) return null;
  const tolerance = Math.max(0, Math.floor(input.toleranceTicks)) * tick;
  const limitPrice = roundToTick(Math.min(modelCeiling, priceForMinimum + tolerance, 1 - tick), tick, "down");
  if (limitPrice + 1e-10 < priceForMinimum) return null;
  const executableShares = asks.filter((level) => level.price <= limitPrice + tick * 1e-6).reduce((sum, level) => sum + level.size, 0);
  const amountUsd = Math.max(1, Math.ceil((minimumShares * limitPrice - 1e-9) * 100) / 100);
  const requestedShares = sdkMarketBuyShares(amountUsd, limitPrice, input.tickSize);
  if (requestedShares + 1e-8 < minimumShares || executableShares + 1e-8 < requestedShares) return null;
  const worstFeePerShare = asks.filter((level) => level.price <= limitPrice + tick * 1e-6)
    .reduce((worst, level) => Math.max(worst, takerFeePerShare(level.price, input.feeSchedule, input.fallbackFeeRate)), 0);
  const worstTotalCostUsd = Math.ceil((amountUsd + requestedShares * worstFeePerShare + 1e-9) * 100) / 100;
  return { minimumShares, requestedShares, limitPrice, amountUsd, worstTotalCostUsd, modelCeiling };
};

/** Minimum acceptable SELL price: the best bid less a small tick tolerance, rounded onto the tick grid. */
export const quoteSell = (input: {
  bids: readonly BookLevel[]; shares: number; tickSize: string; toleranceTicks: number; minimumShares: number;
}): LiveSellQuote | null => {
  const tick = Number(input.tickSize);
  const bids = input.bids.filter((level) => level.price > 0 && level.price < 1 && level.size > 0).sort((left, right) => right.price - left.price);
  if (!(tick > 0) || !bids.length || !(input.shares > 0)) return null;
  const limitPrice = roundToTick(Math.max(tick, bids[0].price - Math.max(0, Math.floor(input.toleranceTicks)) * tick), tick, "up");
  const depth = bids.filter((level) => level.price + 1e-10 >= limitPrice).reduce((sum, level) => sum + level.size, 0);
  const shares = Math.floor(Math.min(input.shares, depth) * 100 + 1e-8) / 100;
  if (shares + 1e-8 < input.minimumShares) return null;
  return { shares, limitPrice };
};
