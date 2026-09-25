import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPolymarketPriceTicks,
  averageObservedPrice,
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
  assert.equal(averageObservedPrice([{ timestamp: NOW - 10_000, price: 1 }, { timestamp: NOW - 5_000, price: 3 }], NOW - 10_000, NOW), 2);
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
