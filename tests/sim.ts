// Synthetic market generator for replay tests. Paths are zero-drift GBM at
// 1-second resolution; settlement compares the price at the end with the price
// at the start, matching what the official open/close prices show live.

import { probabilityUp, settlementDistribution, DEFAULT_FEE_SCHEDULE } from "../app/lib/pricing";
import type { MarketSnapshot, Side } from "../app/lib/signal";

export const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const gaussian = (random: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());

export type BookStyle = "fair" | "stale-point";

/**
 * fair:        quotes the true probability +/- 1c (no edge after fees).
 * stale-point: quotes the same model on a price 20 s old, the kind of book a
 *              faster, better-anchored engine should beat.
 */
export const simulateMarkets = (options: { markets: number; seed: number; style: BookStyle; sigma?: number; step?: number }) => {
  const random = seeded(options.seed);
  const sigma = options.sigma ?? 0.0001;
  const step = options.step ?? 2;
  const snapshots: MarketSnapshot[] = [];
  const outcomes = new Map<string, Side>();
  const t0 = 1_790_000_000_000;
  for (let market = 0; market < options.markets; market += 1) {
    const start = t0 + market * 300_000;
    const end = start + 300_000;
    // Underlying path from 60 s before start (for the opening TWAP) to the end.
    const prices: number[] = [];
    let price = 100_000;
    for (let second = -60; second <= 300; second += 1) {
      price *= Math.exp(sigma * gaussian(random));
      prices.push(price);
    }
    const at = (second: number) => prices[second + 60];
    const reference = at(0);
    const outcome: Side = at(300) >= reference ? "UP" : "DOWN";
    const marketId = `sim-${options.seed}-${market}`;
    outcomes.set(marketId, outcome);
    for (let second = step; second < 300; second += step) {
      const now = start + second * 1000;
      const ticks = Array.from({ length: 70 }, (_, index) => second - 69 + index)
        .filter((s) => s >= -60)
        .map((s) => ({ timestamp: start + s * 1000, price: at(s) }));
      const spot = at(second);
      const truth = probabilityUp(
        settlementDistribution({ spot, now, endTime: end, sigmaPerSqrtSecond: sigma, spec: { lookbackSeconds: 0 }, ticks }),
        reference,
      );
      let quoted = truth;
      if (options.style === "stale-point") {
        const lagged = at(Math.max(-60, second - 20));
        quoted = probabilityUp(
          settlementDistribution({ spot: lagged, now: now - 20_000, endTime: end, sigmaPerSqrtSecond: sigma, spec: { lookbackSeconds: 0 } }),
          reference,
        );
      }
      const mid = Math.min(0.98, Math.max(0.02, quoted));
      const upAsk = Math.min(0.99, Math.round((mid + 0.01) * 100) / 100);
      const upBid = Math.max(0.01, Math.round((mid - 0.01) * 100) / 100);
      snapshots.push({
        marketId,
        asset: "BTC",
        duration: "5m",
        startTime: start,
        endTime: end,
        now,
        reference,
        referenceSource: "CHAINLINK",
        spot,
        spotTimestamp: now,
        spotSource: "ANCHORED",
        basisBps: 0,
        ticks,
        sigmaPerSqrtSecond: sigma,
        settlementLookbackSeconds: 0,
        feeSchedule: DEFAULT_FEE_SCHEDULE,
        tickSize: 0.01,
        minOrderSize: 5,
        up: { bids: [{ price: upBid, size: 2_000 }], asks: [{ price: upAsk, size: 2_000 }], timestamp: now },
        down: { bids: [{ price: Math.max(0.01, 1 - upAsk), size: 2_000 }], asks: [{ price: Math.min(0.99, 1 - upBid), size: 2_000 }], timestamp: now },
      });
    }
  }
  return { snapshots, outcomes };
};
