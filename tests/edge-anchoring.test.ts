import assert from "node:assert/strict";
import test from "node:test";
import { computeLedgerMetrics, ACTIVE_MODEL_VERSION, type MarketDecisionRow } from "../app/lib/decision-ledger";
import { analyzeMarketSignal, createPaperAccount, marketDataFreshnessIssue, marketStreamingDataFreshnessIssue, MAX_MODEL_MARKET_GAP } from "../app/lib/engines";
import { evaluatePaperMarket } from "../app/lib/paper-bankroll";
import {
  anchoredFairUp,
  anchorProbability,
  isVerifiedMarketStartTime,
  marketImpliedProbabilityUp,
  MODEL_LOGIT_WEIGHT,
  sideFairProbability,
  type LiveMarket,
  type MarketCandle,
} from "../app/lib/polymarket-data";

const NOW = Date.now();
const FEE_RATE = 0.07;
const costs = { feeRate: 0, slippageBps: 0 };
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Completed candles ending just before NOW with a steady, slightly noisy trend. */
const trendCandles = (barSeconds: number, direction: 1 | -1, bars = 40): MarketCandle[] => {
  const lastClose = Math.floor(NOW / (barSeconds * 1000)) * barSeconds * 1000;
  let previous = 100;
  return Array.from({ length: bars }, (_, index) => {
    const timestamp = lastClose - (bars - index) * barSeconds * 1000;
    const close = previous * (1 + direction * 0.0012 + (index % 2 ? 0.0004 : -0.0004));
    const candle = { timestamp, open: previous, close, high: Math.max(previous, close) * 1.0003, low: Math.min(previous, close) * 0.9997, volume: 10 };
    previous = close;
    return candle;
  });
};

const book = (tokenId: string, bid: number, ask: number) => ({
  tokenId, bids: [{ price: bid, size: 5000 }], asks: [{ price: ask, size: 5000 }], timestamp: NOW, minOrderSize: 5, hash: null,
});

/** A fresh 5m market 150 s into its window, with the raw model and books set explicitly. */
const marketWith = (rawFairUp: number, upBid: number, upAsk: number, trend: 1 | -1 = 1): LiveMarket => {
  const downBid = Number((1 - upAsk).toFixed(2));
  const downAsk = Number((1 - upBid).toFixed(2));
  return {
    id: "m1", conditionId: null, slug: "btc-updown-5m", question: "BTC up or down?", asset: "BTC", duration: "5m",
    startTime: NOW - 150_000, startTimeVerified: true, endTime: NOW + 150_000, reference: 100, referenceSource: "POLYMARKET", priceFeed: "TWAP_60",
    upTokenId: "up", downTokenId: "down", sourceUrl: "",
    feeSchedule: { rate: FEE_RATE, exponent: 1, feesEnabled: true, source: "CLOB" },
    remaining: 150, countdownEndsAt: NOW + 150_000, spot: 100.1, spotSource: "POLYMARKET", spotUpdatedAt: NOW,
    referenceUpdatedAt: NOW - 150_000, referenceVerified: true,
    upBook: book("up", upBid, upAsk), downBook: book("down", downBid, downAsk),
    upBid, upAsk, downBid, downAsk, fairUp: rawFairUp, edgeUp: null, edgeDown: null,
    spread: upAsk - upBid, liquidity: 10_000, imbalance: 0, momentum: null, distance: 0.001, regime: "UP MOMENTUM",
    sourceTimestamp: NOW, chart5m: trendCandles(300, trend), chart15m: trendCandles(900, trend), chartUpdatedAt: NOW,
  };
};

const costPerShare = (price: number) => price + FEE_RATE * price * (1 - price);

test("anchoring pools model and market in log-odds and is symmetric between UP and DOWN", () => {
  assert.equal(anchorProbability(0.9, 0.3, 0), 0.30000000000000004);
  assert.ok(Math.abs(anchorProbability(0.9, 0.3, 1) - 0.9) < 1e-12);
  const expected = sigmoid(MODEL_LOGIT_WEIGHT * logit(0.7) + (1 - MODEL_LOGIT_WEIGHT) * logit(0.5));
  assert.ok(Math.abs(anchorProbability(0.7, 0.5) - expected) < 1e-12);
  assert.ok(Math.abs(anchorProbability(0.7, 0.4) - (1 - anchorProbability(0.3, 0.6))) < 1e-12);
});

test("oracle freshness requires the exact Polymarket opening tick and a current feed tick", () => {
  const market = marketWith(0.7, 0.49, 0.51);
  assert.equal(marketDataFreshnessIssue(market, NOW), null);
  const missingOpening = { ...market, reference: null, referenceSource: "MISSING" as const, referenceUpdatedAt: null, referenceVerified: false };
  assert.equal(marketStreamingDataFreshnessIssue(missingOpening, NOW), null);
  assert.match(marketDataFreshnessIssue(missingOpening, NOW) ?? "", /exact Polymarket opening/i);
  assert.match(marketDataFreshnessIssue({ ...market, spotUpdatedAt: NOW - 10_001 }, NOW) ?? "", /oracle data is stale/i);
  assert.match(marketDataFreshnessIssue({ ...market, referenceUpdatedAt: market.startTime! + 1 }, NOW) ?? "", /exact Polymarket opening/i);
  assert.match(marketDataFreshnessIssue({ ...market, referenceSource: "COINBASE ESTIMATE" }, NOW) ?? "", /exact Polymarket opening/i);
  assert.match(marketDataFreshnessIssue({ ...market, priceFeed: "UNSUPPORTED" }, NOW) ?? "", /unsupported price-resolution feed/i);
});

test("market start verification rejects timestamps near but outside the interval boundary", () => {
  const end = NOW + 300_000;
  const expectedStart = end - 300_000;
  assert.equal(isVerifiedMarketStartTime(expectedStart, end, "5m"), true);
  assert.equal(isVerifiedMarketStartTime(expectedStart + 1_000, end, "5m"), true);
  assert.equal(isVerifiedMarketStartTime(expectedStart + 1_001, end, "5m"), false);
  assert.equal(isVerifiedMarketStartTime(null, end, "5m"), false);
});

test("an unchanged market snapshot becomes stale against wall-clock time", () => {
  const market = marketWith(0.99, 0.8, 0.82);
  const signal = analyzeMarketSignal(market, costs, 25, 0.04, NOW + 10_001);
  assert.equal(signal.action, "PASS");
  assert.match(signal.reason, /oracle data is stale/i);
});

test("MICRO bankrolls use the separate 5m live-oracle micro-trend strategy", () => {
  const spotHistory = [100.5, 100.44, 100.39, 100.31, 100.28, 100.2, 100.12, 100.04, 99.94, 99.8]
    .map((price, index) => ({ timestamp: NOW - 9_000 + index * 1_000, price }));
  const market = { ...marketWith(0.949, 0.699, 0.7), spot: 99.8, distance: -0.002, spotHistory };
  const opportunity = evaluatePaperMarket({
    market,
    markets: new Map([[market.id, market]]),
    account: createPaperAccount(20, NOW),
    costs,
    liquidationEquityUsd: 20,
    maxTradeUsd: 5,
    minNetEdge: 0.04,
    now: NOW,
  });
  assert.equal(opportunity.approved, false);
  assert.equal(opportunity.signal.action, "PASS");
  assert.match(opportunity.reason, /MICRO strategy requires a strong, aligned live oracle micro-trend/i);
});

test("market-implied probability averages both books and needs a two-sided quote", () => {
  assert.ok(Math.abs(marketImpliedProbabilityUp({ upBid: 0.49, upAsk: 0.51, downBid: 0.47, downAsk: 0.49 })! - 0.51) < 1e-12);
  assert.ok(Math.abs(marketImpliedProbabilityUp({ upBid: null, upAsk: 0.51, downBid: 0.39, downAsk: 0.41 })! - 0.6) < 1e-12);
  assert.equal(marketImpliedProbabilityUp({ upBid: null, upAsk: 0.51, downBid: null, downAsk: 0.49 }), null);
  const unquoted = { ...marketWith(0.7, 0.49, 0.51), upBid: null, downBid: null };
  assert.equal(anchoredFairUp(unquoted), null);
  assert.equal(sideFairProbability(unquoted, "UP"), null);
});

test("a 17-point raw-model edge shrinks to its anchored size and does not trade", () => {
  const market = marketWith(0.7, 0.49, 0.51);
  const signal = analyzeMarketSignal(market, costs, 25, 0.04);
  const rawEdge = 0.7 - costPerShare(0.51);
  const anchored = anchorProbability(0.7, 0.5);
  assert.ok(rawEdge > 0.17, `raw edge ${rawEdge}`);
  assert.equal(signal.rawModelUp, 0.7);
  assert.ok(Math.abs(signal.fairUp! - anchored) < 1e-9);
  assert.ok(Math.abs(signal.upEdge! - (anchored - costPerShare(0.51))) < 1e-6, `up edge ${signal.upEdge}`);
  assert.ok(signal.upEdge! < 0.04);
  assert.equal(signal.action, "PASS");
  assert.match(signal.reason, /below the 4% entry floor/);
});

test("a model far from the book is treated as bad inputs, not edge", () => {
  const market = marketWith(0.6, 0.19, 0.21);
  assert.ok(Math.abs(0.6 - marketImpliedProbabilityUp(market)!) > MAX_MODEL_MARKET_GAP);
  const signal = analyzeMarketSignal(market, costs, 25, 0.04);
  assert.equal(signal.action, "PASS");
  assert.match(signal.reason, /points from the market/);
  assert.ok(signal.fairUp! < 0.3, "the displayed probability stays anchored to the book");
});

test("long shots below the entry-price floor pass even when the model favours them", () => {
  const signal = analyzeMarketSignal(marketWith(0.3, 0.09, 0.11, -1), costs, 25, 0.04);
  assert.equal(signal.action, "PASS");
  assert.match(signal.reason, /long shot/);
});

test("an anchored edge that clears the floor still enters, priced against the anchored probability", () => {
  const signal = analyzeMarketSignal(marketWith(0.99, 0.85, 0.86), costs, 25, 0.04);
  const anchored = anchorProbability(0.99, marketImpliedProbabilityUp(marketWith(0.99, 0.85, 0.86))!);
  assert.equal(signal.action, "UP");
  assert.ok(Math.abs(signal.edge! - (anchored - costPerShare(0.86))) < 1e-6, `edge ${signal.edge}`);
  assert.ok(signal.edge! < 0.99 - costPerShare(0.86), "anchored edge is smaller than the raw model edge");
});

const ledgerRow = (id: string, side: "UP" | "DOWN", fairUp: number, edge: number, outcome: "UP" | "DOWN"): MarketDecisionRow => ({
  id, marketId: id, observedAt: 1, firstSeenAt: 1, lastUpdatedAt: 1, asset: "BTC", duration: "5m", slug: id, question: id, sourceUrl: "",
  decision: side, initialDecision: side, tier: "ENTRY", fairUp, upEdge: null, downEdge: null, edge, entryPrice: null, upAsk: null, downAsk: null,
  reference: null, spot: null, remainingSeconds: 100, outcome, result: side === outcome ? "WIN" : "LOSS", outcomeAt: 2, simulatedStake: 0,
  simulatedUnits: 0, signalConfidence: null, biasConfidence: null, trend5m: "UP", trend15m: "UP", reason: "", changeCount: 0,
  modelVersion: ACTIVE_MODEL_VERSION, validationDecision: side, validationFairUp: fairUp, validationEdge: edge, validationEntryPrice: null,
  validationStakeUsd: null, validationAt: 1,
});

test("ledger compares the claimed edge with the edge settlement actually paid", () => {
  const metrics = computeLedgerMetrics([
    ledgerRow("a", "UP", 0.6, 0.05, "UP"),    // cost 0.55, paid 1 -> +0.45
    ledgerRow("b", "DOWN", 0.3, 0.1, "UP"),   // P(DOWN) 0.7, cost 0.60, paid 0 -> -0.60
  ]);
  assert.equal(metrics.edgeSamples, 2);
  assert.ok(Math.abs(metrics.claimedEdge! - 0.075) < 1e-12);
  assert.ok(Math.abs(metrics.realizedEdge! - -0.075) < 1e-12);
  assert.ok(Math.abs(metrics.predictedWinRate! - 0.65) < 1e-12);
  assert.equal(metrics.realizedWinRate, 0.5);
});

test("ledger edge check is empty until a prediction settles", () => {
  const pending = { ...ledgerRow("a", "UP", 0.6, 0.05, "UP"), outcome: null, result: "PENDING" as const };
  const metrics = computeLedgerMetrics([pending]);
  assert.equal(metrics.edgeSamples, 0);
  assert.equal(metrics.claimedEdge, null);
  assert.equal(metrics.realizedEdge, null);
});
