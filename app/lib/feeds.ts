// Per-asset price feeds and the derived "underlying" series the TWAP model needs.
//
// Verified against live data: the Chainlink value Polymarket RTDS publishes
// (topic crypto_prices_chainlink) at a window's start equals the official
// openPrice exactly, so that stream IS the 60s TWAP stream markets settle on.
// A TWAP stream is an average, so the model cannot use it as the instantaneous
// price. Instead we sample exchange ticks once per second and shift them by a
// basis so their trailing 60s mean equals the latest stream value. The shifted
// series is the best available estimate of the underlying Chainlink spot.

import { mean } from "./num";
import { blendVolatility, ewmaTickVolatility, garmanKlassVolatility, type Candle, type PriceTick } from "./pricing";
import type { SpotSource } from "./signal";

export type AssetFeed = {
  asset: string;
  /** Chainlink TWAP-stream prints (about 1 Hz). */
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
  /** Latest stream value minus the trailing exchange mean, in bp of price. */
  basisBps: number | null;
  exchangeSpot: number | null;
  exchangeSpotTimestamp: number | null;
  sigmaPerSqrtSecond: number | null;
  sigmaSource: string;
  /** 1 s tick returns behind the volatility estimate (warm-up indicator). */
  volSamples: number;
};

export const FEED_RETENTION_MS = 30 * 60 * 1000;

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
  // Chainlink prints are nominally 1 Hz but gaps of ~9 s were observed live; the stream is an average, so a few seconds of age barely moves it.
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
    const window = sampled.filter((tick) => tick.timestamp > freshStream.timestamp - lookback * 1000 && tick.timestamp <= freshStream.timestamp);
    if (window.length >= lookback * 0.75) {
      const basis = freshStream.price - mean(window.map((tick) => tick.price));
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
