import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPolymarketPriceTicks,
  averageObservedPrice,
  candleDynamicsPerSecond,
  setPolymarketClockOffsetForTesting,
  twapSettlementProbability,
  type LiveMarket,
  type PolymarketPriceTick,
} from "../app/lib/polymarket-data";
import { trendCandles } from "./market-fixture";

setPolymarketClockOffsetForTesting(0);
const NOW = Math.floor(Date.now() / 1000) * 1000;
const normalCdf = (value: number) => 0.5 * (1 + erf(value / Math.SQRT2));
// Abramowitz-Stegun 7.1.26, independent of the engine's own implementation.
function erf(x: number) {
  const sign = Math.sign(x);
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

test("with more than 60 s left the TWAP forecast uses variance sigma^2 (tau - 40) around current spot", () => {
  const sigma = 0.0002;
  const p = twapSettlementProbability({ reference: 100, spot: 100.1, spotHistory: [], endTime: NOW + 200_000, now: NOW, sigmaPerSecond: sigma });
  const expected = normalCdf(Math.log(100.1 / 100) / (sigma * Math.sqrt(200 - 40)));
  assert.ok(p !== null && Math.abs(p - expected) < 2e-3, `p ${p} expected ${expected}`);
  assert.ok(Math.abs(twapSettlementProbability({ reference: 100, spot: 100, spotHistory: [], endTime: NOW + 200_000, now: NOW, sigmaPerSecond: sigma })! - 0.5) < 1e-6);
});

test("the two TWAP forecast branches agree at the 60-second boundary", () => {
  const sigma = 0.0003;
  const history = Array.from({ length: 5 }, (_, index) => ({ timestamp: NOW - 4_000 + index * 1000, price: 100.05 }));
  const before = twapSettlementProbability({ reference: 100, spot: 100.05, spotHistory: history, endTime: NOW + 60_010, now: NOW, sigmaPerSecond: sigma });
  const after = twapSettlementProbability({ reference: 100, spot: 100.05, spotHistory: history, endTime: NOW + 59_990, now: NOW, sigmaPerSecond: sigma });
  assert.ok(before !== null && after !== null && Math.abs(before - after) < 0.01, `${before} vs ${after}`);
});

test("inside the averaging window the observed part of the TWAP is locked in", () => {
  const sigma = 0.0003;
  // 50 s of the window already averaged 100.2; spot has just fallen to the reference.
  const history = Array.from({ length: 51 }, (_, index) => ({ timestamp: NOW - 50_000 + index * 1000, price: index === 50 ? 100 : 100.2 }));
  const p = twapSettlementProbability({ reference: 100, spot: 100, spotHistory: history, endTime: NOW + 10_000, now: NOW, sigmaPerSecond: sigma });
  assert.ok(p !== null && p > 0.95, `already-observed average above the reference should dominate, got ${p}`);
  const naive = twapSettlementProbability({ reference: 100, spot: 100, spotHistory: [], endTime: NOW + 70_000, now: NOW, sigmaPerSecond: sigma });
  assert.ok(naive !== null && Math.abs(naive - 0.5) < 1e-6);
});

test("without enough observed coverage inside the window no probability is claimed", () => {
  const sparse = [{ timestamp: NOW - 5_000, price: 100.2 }];
  assert.equal(twapSettlementProbability({ reference: 100, spot: 100, spotHistory: sparse, endTime: NOW + 10_000, now: NOW, sigmaPerSecond: 0.0003 }), null);
  assert.equal(averageObservedPrice([{ timestamp: NOW - 10_000, price: 1 }, { timestamp: NOW - 7_000, price: 1 }, { timestamp: NOW - 5_000, price: 3 }, { timestamp: NOW - 2_000, price: 3 }], NOW - 10_000, NOW), 2);
});

test("TWAP markets forecast from Chainlink spot, not from the lagging TWAP", () => {
  const start = NOW - 150_000;
  const market: LiveMarket = {
    id: "m1", conditionId: null, slug: "btc-updown-5m", question: "q", asset: "BTC", duration: "5m", startTime: start, startTimeVerified: true,
    endTime: start + 300_000, reference: null, referenceSource: "MISSING", priceFeed: "TWAP_60", upTokenId: "up", downTokenId: "down", sourceUrl: "",
    remaining: 150, countdownEndsAt: start + 300_000, spot: null, spotSource: "MISSING", spotUpdatedAt: null, referenceUpdatedAt: null, referenceVerified: false,
    upBook: null, downBook: null, upBid: null, upAsk: null, downBid: null, downAsk: null, fairUp: null, edgeUp: null, edgeDown: null, spread: null,
    liquidity: 0, imbalance: null, momentum: null, distance: null, regime: "", sourceTimestamp: NOW,
    chart5m: trendCandles(NOW, 300, 1), chart15m: trendCandles(NOW, 900, 1), chartUpdatedAt: NOW,
  };
  const ticks: PolymarketPriceTick[] = [
    { asset: "BTC", priceFeed: "TWAP_60", timestamp: start, price: 100 },
    // The TWAP still trails below the reference while spot has already jumped above it.
    { asset: "BTC", priceFeed: "TWAP_60", timestamp: NOW - 1000, price: 99.97 },
    { asset: "BTC", priceFeed: "CHAINLINK_SPOT", timestamp: NOW - 1000, price: 100.15 },
  ];
  const applied = applyPolymarketPriceTicks(market, ticks, NOW);
  assert.equal(applied.reference, 100);
  assert.equal(applied.settlementPrice, 99.97);
  assert.equal(applied.spot, 100.15);
  assert.ok(applied.fairUp !== null && applied.fairUp > 0.5, `forecast should follow spot above the reference, got ${applied.fairUp}`);
});

test("a feed gap inside the averaging window is not counted as observed (audit M8)", () => {
  // Ticks every second for the first 30 s of the 50 s already elapsed, then 20 s of silence.
  const history = Array.from({ length: 31 }, (_, index) => ({ timestamp: NOW - 50_000 + index * 1000, price: 100.2 }));
  assert.equal(averageObservedPrice(history, NOW - 50_000, NOW), null, "30 s of real coverage out of 50 s is below the 80% floor");
  assert.equal(twapSettlementProbability({ reference: 100, spot: 100.2, spotHistory: history, endTime: NOW + 10_000, now: NOW, sigmaPerSecond: 0.0003 }), null);
  const complete = Array.from({ length: 51 }, (_, index) => ({ timestamp: NOW - 50_000 + index * 1000, price: 100.2 }));
  assert.ok(Math.abs(averageObservedPrice(complete, NOW - 50_000, NOW)! - 100.2) < 1e-9);
});

/** 5m candles: `volatileBars` of 0.4% swings, then `calmBars` of 0.05% swings, ending before NOW. */
const regimeCandles = (volatileBars: number, calmBars: number) => {
  let close = 100;
  const total = volatileBars + calmBars;
  return Array.from({ length: total }, (_, index) => {
    const size = index < volatileBars ? 0.004 : 0.0005;
    close *= Math.exp(index % 2 ? size : -size);
    return { timestamp: NOW - (total - index + 1) * 300_000, open: close, close, high: close, low: close, volume: 1 };
  });
};

test("volatility follows the last half hour, so a calm spell after a volatile morning is priced as calm", () => {
  const calm = candleDynamicsPerSecond(regimeCandles(60, 24), "5m", NOW)!;
  const volatile = candleDynamicsPerSecond(regimeCandles(60, 0), "5m", NOW)!;
  // Two hours of 0.05% moves after five hours of 0.4% moves: the old max(20, 80-bar)
  // estimate stayed near 0.36% per bar; the 30-minute EWMA falls to about 0.11%, the
  // volatile spell keeping 1/16 of the weight after four half-lives.
  assert.ok(calm.sigmaPerSecond * Math.sqrt(300) < 0.0015, `calm per-bar sigma ${calm.sigmaPerSecond * Math.sqrt(300)}`);
  assert.ok(volatile.sigmaPerSecond * Math.sqrt(300) > 0.0035);
});

test("a 15m market takes its volatility from 5m candles when they are supplied", () => {
  const fifteen = regimeCandles(40, 0).map((candle, index, all) => ({ ...candle, timestamp: NOW - (all.length - index + 1) * 900_000 }));
  const coarse = candleDynamicsPerSecond(fifteen, "15m", NOW)!;
  const fine = candleDynamicsPerSecond(fifteen, "15m", NOW, regimeCandles(60, 24))!;
  assert.ok(fine.sigmaPerSecond < coarse.sigmaPerSecond / 1.5);
});
