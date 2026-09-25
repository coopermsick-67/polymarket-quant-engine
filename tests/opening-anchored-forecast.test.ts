import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPolymarketPriceTicks,
  buildLiveMarket,
  chartFairProbability,
  type CandleHistory,
  type MarketCandle,
  type MarketDefinition,
  type PolymarketPriceTick,
} from "../app/lib/polymarket-data";

const NOW = Date.now();

const candles = (seconds: 300 | 900, direction: 1 | -1, bars = 40): MarketCandle[] => {
  const endOfCurrentBar = Math.floor(NOW / (seconds * 1000)) * seconds * 1000;
  let previous = 100;
  return Array.from({ length: bars }, (_, index) => {
    const close = previous * Math.exp(direction * 0.001 + (index % 2 ? 0.0002 : -0.0002));
    const candle = {
      timestamp: endOfCurrentBar - (bars - index) * seconds * 1000,
      open: previous,
      close,
      high: Math.max(previous, close) * 1.0003,
      low: Math.min(previous, close) * 0.9997,
      volume: 10,
    };
    previous = close;
    return candle;
  });
};

const definition = (duration: "5m" | "15m"): MarketDefinition => {
  const length = duration === "5m" ? 300_000 : 900_000;
  const startTime = NOW - length / 2;
  return {
    id: `btc-${duration}`,
    conditionId: null,
    slug: `btc-updown-${duration}`,
    question: `BTC Up or Down ${duration}`,
    asset: "BTC",
    duration,
    startTime,
    startTimeVerified: true,
    endTime: startTime + length,
    reference: null,
    referenceSource: "MISSING",
    priceFeed: "CHAINLINK_SPOT",
    upTokenId: `${duration}-up`,
    downTokenId: `${duration}-down`,
    sourceUrl: "",
  };
};

const tick = (timestamp: number, price: number): PolymarketPriceTick => ({
  asset: "BTC",
  priceFeed: "CHAINLINK_SPOT",
  timestamp,
  price,
});

test("opening forecast uses its own duration's completed candles", () => {
  const fiveMinuteUp = chartFairProbability(100, 100, 300, "5m", candles(300, 1), NOW);
  const fiveMinuteDown = chartFairProbability(100, 100, 300, "5m", candles(300, -1), NOW);
  const fifteenMinuteUp = chartFairProbability(100, 100, 900, "15m", candles(900, 1), NOW);
  const fifteenMinuteDown = chartFairProbability(100, 100, 900, "15m", candles(900, -1), NOW);

  assert.ok(fiveMinuteUp !== null && fiveMinuteUp > 0.5);
  assert.ok(fiveMinuteDown !== null && fiveMinuteDown < 0.5);
  assert.ok(fifteenMinuteUp !== null && fifteenMinuteUp > 0.5);
  assert.ok(fifteenMinuteDown !== null && fifteenMinuteDown < 0.5);
  assert.notEqual(fiveMinuteUp, fifteenMinuteDown, "the 5m and 15m histories are evaluated independently");
});

test("live oracle updates move the forecast while the opening Price to Beat stays locked", () => {
  const history: CandleHistory = {
    fiveMinute: candles(300, 1),
    fifteenMinute: candles(900, -1),
    updatedAt: NOW,
  };
  const marketDefinition = definition("5m");
  const marketNow = buildLiveMarket(marketDefinition, new Map(), new Map(), null, NOW, history);
  const first = applyPolymarketPriceTicks(marketNow, [
    tick(marketDefinition.startTime!, 100),
    tick(NOW, 100.01),
  ], NOW);
  const moved = applyPolymarketPriceTicks(first, [
    tick(marketDefinition.startTime!, 101),
    tick(NOW + 1_000, 100.03),
  ], NOW + 1_000);

  assert.equal(first.reference, 100);
  assert.equal(first.referenceUpdatedAt, marketDefinition.startTime);
  assert.equal(moved.reference, 100, "a later tick at the opening timestamp cannot replace the locked value");
  assert.equal(moved.referenceUpdatedAt, marketDefinition.startTime);
  assert.ok(first.fairUp !== null && moved.fairUp !== null && moved.fairUp > first.fairUp);
  assert.equal(moved.spot, 100.03);
});

test("forecast stays unavailable without the exact opening reference or enough completed history", () => {
  assert.equal(chartFairProbability(null, 100, 300, "5m", candles(300, 1), NOW), null);
  assert.equal(chartFairProbability(100, 100, 300, "5m", candles(300, 1, 10), NOW), null);
});
