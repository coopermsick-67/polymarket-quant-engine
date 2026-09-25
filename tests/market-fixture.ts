import type { LiveMarket, MarketCandle, OrderBook } from "../app/lib/polymarket-data";

/** Completed candles ending just before `now` with a steady, slightly noisy trend. */
export const trendCandles = (now: number, barSeconds: number, direction: 1 | -1, bars = 40): MarketCandle[] => {
  const lastClose = Math.floor(now / (barSeconds * 1000)) * barSeconds * 1000;
  let previous = 100;
  return Array.from({ length: bars }, (_, index) => {
    const timestamp = lastClose - (bars - index) * barSeconds * 1000;
    const close = previous * (1 + direction * 0.0012 + (index % 2 ? 0.0004 : -0.0004));
    const candle = { timestamp, open: previous, close, high: Math.max(previous, close) * 1.0003, low: Math.min(previous, close) * 0.9997, volume: 10 };
    previous = close;
    return candle;
  });
};

export const book = (tokenId: string, bid: number, ask: number, timestamp: number, size = 5000): OrderBook => ({
  tokenId, bids: [{ price: bid, size }], asks: [{ price: ask, size }], timestamp, minOrderSize: 5, hash: null,
});

const r2 = (value: number) => Number(value.toFixed(2));

/** A fresh 5m TWAP market with the raw model and books set explicitly; `now` is server time. */
export const marketWith = (now: number, rawFairUp: number, upBid: number, upAsk: number, options: { remaining?: number; bookTimestamp?: number } = {}): LiveMarket => {
  const remaining = options.remaining ?? 150;
  const trend: 1 | -1 = rawFairUp >= 0.5 ? 1 : -1;
  const downBid = r2(1 - upAsk);
  const downAsk = r2(1 - upBid);
  const bookAt = options.bookTimestamp ?? now;
  const spotHistory = Array.from({ length: 40 }, (_, index) => ({ timestamp: now - (39 - index) * 750, price: 100 * (1 + trend * 0.00005 * index + (index % 2 ? 0.00001 : 0)) }));
  return {
    id: "m1", conditionId: null, slug: "btc-updown-5m", question: "BTC up or down?", asset: "BTC", duration: "5m",
    startTime: now - (300 - remaining) * 1000, startTimeVerified: true, endTime: now + remaining * 1000, reference: 100, referenceSource: "POLYMARKET", priceFeed: "TWAP_60",
    upTokenId: "up", downTokenId: "down", sourceUrl: "",
    feeSchedule: { rate: 0.07, exponent: 1, feesEnabled: true, source: "CLOB" },
    remaining, countdownEndsAt: now + remaining * 1000, spot: 100.1, spotSource: "POLYMARKET", spotUpdatedAt: now,
    referenceUpdatedAt: now - (300 - remaining) * 1000, referenceVerified: true,
    upBook: book("up", upBid, upAsk, bookAt), downBook: book("down", downBid, downAsk, bookAt),
    upBid, upAsk, downBid, downAsk, fairUp: rawFairUp, edgeUp: null, edgeDown: null,
    spread: upAsk - upBid, liquidity: 10_000, imbalance: 0, momentum: null, distance: 0.001, regime: "UP MOMENTUM",
    sourceTimestamp: now, chart5m: trendCandles(now, 300, trend), chart15m: trendCandles(now, 900, trend), chartUpdatedAt: now,
    spotHistory,
  };
};
