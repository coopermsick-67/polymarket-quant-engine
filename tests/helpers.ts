import { DEFAULT_FEE_SCHEDULE } from "../app/lib/pricing";
import type { MarketSnapshot } from "../app/lib/signal";

/** A well-formed 5m BTC snapshot; override any field per test. */
export const makeSnapshot = (
  overrides: Partial<MarketSnapshot> & { secondsLeft?: number; distanceBps?: number; upAsk?: number; downAsk?: number } = {},
): MarketSnapshot => {
  const now = 1_790_000_000_000;
  const secondsLeft = overrides.secondsLeft ?? 120;
  const endTime = now + secondsLeft * 1000;
  const reference = 100_000;
  const spot = reference * (1 + (overrides.distanceBps ?? 0) / 10_000);
  const ticks = Array.from({ length: 300 }, (_, index) => ({ timestamp: now - (299 - index) * 1000, price: spot }));
  const upAsk = overrides.upAsk ?? 0.52;
  const downAsk = overrides.downAsk ?? 0.5;
  const { secondsLeft: _s, distanceBps: _d, upAsk: _u, downAsk: _a, ...rest } = overrides;
  void _s;
  void _d;
  void _u;
  void _a;
  return {
    marketId: "m1",
    asset: "BTC",
    duration: "5m",
    startTime: endTime - 300_000,
    endTime,
    now,
    reference,
    referenceSource: "CHAINLINK",
    spot,
    spotTimestamp: now - 200,
    spotSource: "ANCHORED",
    basisBps: 1,
    ticks,
    sigmaPerSqrtSecond: 0.0001, // ~7.7bp per minute
    settlementLookbackSeconds: 0,
    feeSchedule: DEFAULT_FEE_SCHEDULE,
    tickSize: 0.01,
    minOrderSize: 5,
    up: { bids: [{ price: Math.max(0.01, upAsk - 0.01), size: 5000 }], asks: [{ price: upAsk, size: 5000 }], timestamp: now - 500 },
    down: { bids: [{ price: Math.max(0.01, downAsk - 0.01), size: 5000 }], asks: [{ price: downAsk, size: 5000 }], timestamp: now - 500 },
    ...rest,
  };
};
