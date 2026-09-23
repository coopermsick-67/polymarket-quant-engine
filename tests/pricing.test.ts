import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adjustBuyAmountForFees } from "@polymarket/clob-client-v2";
import {
  blendVolatility,
  conservativeSideProbability,
  DEFAULT_FEE_SCHEDULE,
  ewmaTickVolatility,
  fairValue,
  garmanKlassVolatility,
  probabilityUp,
  settlementDistribution,
  shrinkToMarket,
  takerFeePerShare,
} from "../app/lib/pricing";
import { normalCdf, roundToTick, wilsonInterval } from "../app/lib/num";

const close = (actual: number, expected: number, tolerance: number, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} ± ${tolerance}, got ${actual}`);

// Deterministic RNG so the Monte Carlo checks are reproducible.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const gaussian = (random: () => number) => {
  const u = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
};

describe("fee curve", () => {
  it("matches the official client formula (rate * (p(1-p))^exponent per share)", () => {
    for (const price of [0.05, 0.3, 0.5, 0.72, 0.95]) {
      const shares = 100;
      const amount = shares * price;
      // adjustBuyAmountForFees shrinks the amount only when the balance cannot cover the fee;
      // with balance == amount the reduction equals exactly the platform fee.
      const adjusted = adjustBuyAmountForFees(amount, price, amount, DEFAULT_FEE_SCHEDULE.rate, DEFAULT_FEE_SCHEDULE.exponent, 0, 0);
      close(amount - adjusted, shares * takerFeePerShare(price), 1e-9, `price ${price}`);
    }
  });

  it("peaks at 50 cents (3.5% of notional under rate 0.07, exponent 1)", () => {
    close(takerFeePerShare(0.5), 0.0175, 1e-12);
    close(takerFeePerShare(0.5) / 0.5, 0.035, 1e-12);
    assert.ok(takerFeePerShare(0.95) < takerFeePerShare(0.5));
    assert.equal(takerFeePerShare(0), 0);
    assert.equal(takerFeePerShare(1), 0);
  });
});

describe("TWAP settlement distribution", () => {
  const sigma = 0.0005 / Math.sqrt(60); // ~5bp per minute
  const spot = 100_000;

  it("uses Var = sigma^2 (tau - 2L/3) before the window opens", () => {
    const d = settlementDistribution({ spot, now: 0, endTime: 300_000, sigmaPerSqrtSecond: sigma, spec: { lookbackSeconds: 60 } });
    close(d.sd, spot * sigma * Math.sqrt(300 - 40), 1e-6);
    close(d.mean, spot, 1e-9);
  });

  it("uses Var = sigma^2 tau^3 / (3 L^2) inside the window and averages the observed part", () => {
    const endTime = 300_000;
    const now = endTime - 30_000;
    const ticks = Array.from({ length: 30 }, (_, index) => ({ timestamp: endTime - 60_000 + (index + 1) * 1000, price: spot + 50 }));
    const d = settlementDistribution({ spot, now, endTime, sigmaPerSqrtSecond: sigma, spec: { lookbackSeconds: 60 }, ticks });
    close(d.sd, spot * sigma * Math.sqrt(30 ** 3 / (3 * 60 ** 2)), 1e-6);
    close(d.mean, 0.5 * (spot + 50) + 0.5 * spot, 1e-9);
    close(d.observedCoverage, 1, 1e-9);
  });

  it("matches a Monte Carlo of the discretely sampled TWAP", () => {
    const random = rng(42);
    const tau = 40;
    const lookback = 60;
    const perSecond = 0.0004;
    const reference = spot * (1 + 0.0002);
    const paths = 40_000;
    let above = 0;
    for (let path = 0; path < paths; path += 1) {
      let x = spot;
      let sum = (lookback - tau) * spot; // observed part flat at spot
      for (let second = 1; second <= tau; second += 1) {
        x *= Math.exp(perSecond * gaussian(random));
        sum += x;
      }
      if (sum / lookback >= reference) above += 1;
    }
    const ticks = Array.from({ length: lookback - tau }, (_, index) => ({ timestamp: 300_000 - lookback * 1000 + (index + 1) * 1000, price: spot }));
    const d = settlementDistribution({
      spot,
      now: 300_000 - tau * 1000,
      endTime: 300_000,
      sigmaPerSqrtSecond: perSecond,
      spec: { lookbackSeconds: lookback },
      ticks,
    });
    close(probabilityUp(d, reference), above / paths, 0.015, "TWAP P(UP)");
  });

  it("an averaged settlement window is far more certain than a point settlement late in the window (math check)", () => {
    const reference = spot;
    const current = spot * 1.0002; // 2bp above the price to beat, 30s left
    const endTime = 300_000;
    const now = endTime - 30_000;
    const ticks = Array.from({ length: 30 }, (_, index) => ({ timestamp: endTime - 60_000 + (index + 1) * 1000, price: current }));
    const twap = probabilityUp(
      settlementDistribution({ spot: current, now, endTime, sigmaPerSqrtSecond: sigma, spec: { lookbackSeconds: 60 }, ticks }),
      reference,
    );
    const point = probabilityUp(settlementDistribution({ spot: current, now, endTime, sigmaPerSqrtSecond: sigma, spec: { lookbackSeconds: 0 } }), reference);
    assert.ok(twap > point + 0.1, `twap ${twap} should exceed point ${point} by >10pt`);
  });

  it("resolves ties to Up and handles zero variance", () => {
    const d = settlementDistribution({
      spot,
      now: 300_000,
      endTime: 300_000,
      sigmaPerSqrtSecond: sigma,
      spec: { lookbackSeconds: 60 },
      ticks: [{ timestamp: 280_000, price: spot }],
    });
    assert.equal(probabilityUp(d, spot), 1);
    assert.equal(probabilityUp({ ...d, mean: spot - 1 }, spot), 0);
  });
});

describe("robust band and shrinkage", () => {
  it("conservative side probability is the worst case across the vol band", () => {
    const fair = fairValue({
      reference: 100,
      spot: 100.05,
      now: 0,
      endTime: 120_000,
      sigmaPerSqrtSecond: 0.0001,
      spec: { lookbackSeconds: 60 },
      volUncertainty: 0.3,
    });
    assert.ok(conservativeSideProbability(fair, "UP") <= fair.pUp);
    assert.ok(conservativeSideProbability(fair, "DOWN") <= 1 - fair.pUp);
  });

  it("shrinks toward the market in log-odds", () => {
    close(shrinkToMarket(0.9, 0.5, 0.5), 0.75, 0.01);
    assert.equal(shrinkToMarket(0.9, null, 0.5), 0.9);
    close(shrinkToMarket(0.9, 0.5, 1), 0.9, 1e-9);
  });
});

describe("volatility", () => {
  it("EWMA tick vol recovers a known per-second sigma", () => {
    const random = rng(7);
    const sigma = 0.0002;
    let price = 50_000;
    const ticks = Array.from({ length: 1200 }, (_, index) => {
      price *= Math.exp(sigma * gaussian(random));
      return { timestamp: index * 1000, price };
    });
    const estimate = ewmaTickVolatility(ticks, 600, 60);
    assert.ok(estimate);
    close(estimate.sigma, sigma, sigma * 0.12);
  });

  it("Garman-Klass needs completed candles and returns per-sqrt-second vol", () => {
    const candles = Array.from({ length: 30 }, (_, index) => ({ timestamp: index * 300_000, open: 100, high: 100.2, low: 99.8, close: 100.05, volume: 1 }));
    const sigma = garmanKlassVolatility(candles, 300, 31 * 300_000, 24);
    assert.ok(sigma !== null && sigma > 0);
    assert.equal(garmanKlassVolatility(candles.slice(0, 5), 300, 31 * 300_000, 24), null);
  });

  it("blends toward ticks as the sample grows", () => {
    const small = blendVolatility({ sigma: 2e-4, returns: 30 }, 1e-4)!;
    const large = blendVolatility({ sigma: 2e-4, returns: 3000 }, 1e-4)!;
    assert.ok(large.sigmaPerSqrtSecond > small.sigmaPerSqrtSecond);
    assert.equal(blendVolatility(null, null), null);
  });
});

describe("numeric helpers", () => {
  it("normalCdf is accurate", () => {
    close(normalCdf(0), 0.5, 1e-7);
    close(normalCdf(1.96), 0.975, 1e-4);
    close(normalCdf(-1.96), 0.025, 1e-4);
  });
  it("roundToTick never drifts", () => {
    assert.equal(roundToTick(0.537, 0.01, "down"), 0.53);
    assert.equal(roundToTick(0.531, 0.01, "up"), 0.54);
    assert.equal(roundToTick(0.53, 0.01, "down"), 0.53);
    assert.equal(roundToTick(0.1234, 0.001, "down"), 0.123);
  });
  it("wilson interval brackets the estimate", () => {
    const [low, high] = wilsonInterval(55, 100)!;
    assert.ok(low < 0.55 && high > 0.55 && low > 0.44 && high < 0.66);
    assert.equal(wilsonInterval(0, 0), null);
  });
});
