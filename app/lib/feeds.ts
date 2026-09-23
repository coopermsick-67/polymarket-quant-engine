// Per-asset price feeds and the derived underlying series the settlement model needs.
//
// Verified live (2026-09-23): the Chainlink price Polymarket RTDS publishes
// (topic crypto_prices_chainlink) equals the official open/close prices to
// 0.00bp at window boundaries, and it tracks the instantaneous exchange price
// with about 1 s of lag (residual sd 0.5bp for BTC against the point price vs
// 1.35bp against a 60 s average). So it is a spot stream, and we anchor exchange
// ticks to it with a basis: basis = median over the last minute of
// stream(t) - exchange(t - lag). exchange_now + basis then estimates where the
// settlement stream will print about one second from now.

import { blendVolatility, ewmaTickVolatility, garmanKlassVolatility, type Candle, type PriceTick } from "./pricing";
import type { SpotSource } from "./signal";

export type AssetFeed = {
  asset: string;
  /** Chainlink settlement-stream prints (about 1 Hz). */
  stream: PriceTick[];
  /** Primary exchange prints for the underlying (Coinbase ticker). */
  exchange: PriceTick[];
  /** Fallback exchange prints (Binance via Polymarket RTDS). */
  exchangeAlt: PriceTick[];
};

export const emptyFeed = (asset: string): AssetFeed => ({ asset, stream: [], exchange: [], exchangeAlt: [] });

export type DerivedFeed = {
  asset: string;
  spot: number | null;
  spotTimestamp: number | null;
  spotSource: SpotSource;
  /** Basis-adjusted 1 Hz underlying series. */
  ticks: PriceTick[];
  settlementValue: number | null;
  settlementTimestamp: number | null;
  /** Median stream-minus-lagged-exchange gap over the last minute, in bp of price. */
  basisBps: number | null;
  exchangeSpot: number | null;
  exchangeSpotTimestamp: number | null;
  sigmaPerSqrtSecond: number | null;
  sigmaSource: string;
  /** 1 s tick returns behind the volatility estimate (warm-up indicator). */
  volSamples: number;
};

export const FEED_RETENTION_MS = 30 * 60 * 1000;
/** Measured lag of the Chainlink stream behind exchange prints. */
export const STREAM_LAG_MS = 1_000;

/** Append a tick, keep order, drop duplicates and ticks older than the retention window. */
export const appendTick = (ticks: PriceTick[], tick: PriceTick, retentionMs = FEED_RETENTION_MS): PriceTick[] => {
  if (!(tick.price > 0) || !Number.isFinite(tick.timestamp)) return ticks;
  const last = ticks[ticks.length - 1];
  if (last && tick.timestamp < last.timestamp) {
    const merged = [...ticks.filter((existing) => existing.timestamp !== tick.timestamp), tick].sort((left, right) => left.timestamp - right.timestamp);
    return merged.filter((existing) => existing.timestamp >= tick.timestamp - retentionMs);
  }
  const next = last && last.timestamp === tick.timestamp ? [...ticks.slice(0, -1), tick] : [...ticks, tick];
  const cutoff = tick.timestamp - retentionMs;
  let start = 0;
  while (start < next.length && next[start].timestamp < cutoff) start += 1;
  return start ? next.slice(start) : next;
};

/**
 * In-place append for hot paths (the controller owns these arrays). Ticks closer
 * than `minSpacingMs` replace the previous one; stale ticks are trimmed in batches.
 */
export const pushTick = (ticks: PriceTick[], tick: PriceTick, retentionMs = FEED_RETENTION_MS, minSpacingMs = 250): PriceTick[] => {
  if (!(tick.price > 0) || !Number.isFinite(tick.timestamp)) return ticks;
  const last = ticks[ticks.length - 1];
  if (last && tick.timestamp < last.timestamp) return appendTick(ticks, tick, retentionMs);
  if (last && tick.timestamp - last.timestamp < minSpacingMs) ticks[ticks.length - 1] = tick;
  else ticks.push(tick);
  const cutoff = tick.timestamp - retentionMs;
  if (ticks.length > 64 && ticks[63].timestamp < cutoff) {
    let start = 0;
    while (start < ticks.length && ticks[start].timestamp < cutoff) start += 1;
    ticks.splice(0, start);
  }
  return ticks;
};

/** Last-value-carried-forward samples at each whole second in (from, to]. */
export const resampleSeconds = (ticks: PriceTick[], from: number, to: number, maxCarryMs = 10_000): PriceTick[] => {
  const out: PriceTick[] = [];
  let index = 0;
  let last: PriceTick | null = null;
  for (let t = Math.floor(from / 1000) * 1000 + 1000; t <= to; t += 1000) {
    while (index < ticks.length && ticks[index].timestamp <= t) {
      last = ticks[index];
      index += 1;
    }
    if (last && t - last.timestamp <= maxCarryMs) out.push({ timestamp: t, price: last.price });
  }
  return out;
};

/** The stream value printed exactly at `timestamp` (the official price to beat), if we recorded it. */
export const streamValueAt = (stream: PriceTick[], timestamp: number, toleranceMs = 500): number | null => {
  let best: PriceTick | null = null;
  for (const tick of stream) {
    if (Math.abs(tick.timestamp - timestamp) <= toleranceMs && (!best || Math.abs(tick.timestamp - timestamp) < Math.abs(best.timestamp - timestamp)))
      best = tick;
  }
  return best?.price ?? null;
};

export const deriveFeed = (
  feed: AssetFeed,
  now: number,
  options: { lookbackSeconds?: number; candles?: Candle[] | null; maxAgeMs?: number } = {},
): DerivedFeed => {
  const lookback = Math.max(1, options.lookbackSeconds ?? 60);
  const maxAge = options.maxAgeMs ?? 10_000;
  const lastStream = feed.stream[feed.stream.length - 1] ?? null;
  // Use whichever exchange source covered the last minute better; Coinbase wins ties.
  const coverage = (ticks: PriceTick[]) =>
    ticks.length && now - ticks[ticks.length - 1].timestamp <= maxAge ? resampleSeconds(ticks, now - lookback * 1000, now).length : -1;
  const exchangeTicks = coverage(feed.exchangeAlt) > coverage(feed.exchange) ? feed.exchangeAlt : feed.exchange;
  const lastExchange = exchangeTicks[exchangeTicks.length - 1] ?? null;
  // Chainlink prints are nominally 1 Hz but gaps of ~9 s were observed live; the basis is slow-moving, so a stale stream only delays anchoring.
  const streamMaxAge = Math.max(maxAge, 15_000);
  const freshStream = lastStream && now - lastStream.timestamp <= streamMaxAge ? lastStream : null;
  const freshExchange = lastExchange && now - lastExchange.timestamp <= maxAge ? lastExchange : null;
  const sampled = resampleSeconds(exchangeTicks, now - 20 * 60 * 1000, now);
  const tickVol = ewmaTickVolatility(sampled, 300, 60);
  const candleSigma = options.candles ? garmanKlassVolatility(options.candles, 300, now, 24) : null;
  const vol = blendVolatility(tickVol, candleSigma);
  const base = {
    asset: feed.asset,
    settlementValue: lastStream?.price ?? null,
    settlementTimestamp: lastStream?.timestamp ?? null,
    exchangeSpot: lastExchange?.price ?? null,
    exchangeSpotTimestamp: lastExchange?.timestamp ?? null,
    sigmaPerSqrtSecond: vol?.sigmaPerSqrtSecond ?? null,
    sigmaSource: vol?.source ?? "NONE",
    volSamples: vol?.tickReturns ?? 0,
  };

  if (freshStream && freshExchange) {
    const exchangeAt = new Map(sampled.map((tick) => [tick.timestamp, tick.price]));
    const gaps = feed.stream
      .filter((tick) => tick.timestamp > freshStream.timestamp - lookback * 1000 && tick.timestamp <= freshStream.timestamp)
      .flatMap((tick) => {
        const lagged = exchangeAt.get(Math.round((tick.timestamp - STREAM_LAG_MS) / 1000) * 1000);
        return lagged === undefined ? [] : [tick.price - lagged];
      })
      .sort((left, right) => left - right);
    if (gaps.length >= Math.min(20, lookback * 0.3)) {
      const basis = gaps[Math.floor(gaps.length / 2)];
      const ticks = sampled.map((tick) => ({ timestamp: tick.timestamp, price: tick.price + basis }));
      return {
        ...base,
        spot: freshExchange.price + basis,
        // The instantaneous level comes from the exchange tick; the stream only sets the basis.
        spotTimestamp: freshExchange.timestamp,
        spotSource: "ANCHORED",
        ticks,
        basisBps: (basis / freshStream.price) * 10_000,
      };
    }
  }
  if (freshExchange) {
    return { ...base, spot: freshExchange.price, spotTimestamp: freshExchange.timestamp, spotSource: "EXCHANGE", ticks: sampled, basisBps: null };
  }
  if (freshStream) {
    // Degraded: only the averaged stream. Treat it as the underlying level.
    const streamSampled = resampleSeconds(feed.stream, now - 5 * 60 * 1000, now);
    return { ...base, spot: freshStream.price, spotTimestamp: freshStream.timestamp, spotSource: "STREAM", ticks: streamSampled, basisBps: null };
  }
  return { ...base, spot: null, spotTimestamp: null, spotSource: "MISSING", ticks: [], basisBps: null };
};
