import assert from "node:assert/strict";
import test from "node:test";
import {
  buyPaper,
  createPaperAccount,
  feePerShareAt,
  isBookFreshForExecution,
  marketStreamingDataFreshnessIssue,
  runBacktest,
  settleResolvedPaperPositions,
} from "../app/lib/engines";
import {
  bookTopSize,
  clockOffsetFromTimeResponse,
  setPolymarketClockOffsetForTesting,
  synchronizedPolymarketTime,
  updateLiveMarketBookLevel,
} from "../app/lib/polymarket-data";
import { book, marketWith } from "./market-fixture";

test("the clock offset uses the middle of the whole-second server reading and of the round trip", () => {
  // Server said 1000 s; the request took 200 ms locally from t=1_062_000.
  assert.equal(clockOffsetFromTimeResponse(1_000_000, 1_062_000, 1_062_200), 1_000_500 - 1_062_100);
  assert.equal(clockOffsetFromTimeResponse(1_000_123, 0, 0), 1_000_123);
});

test("a PC clock 62 s fast does not make server-stamped books stale", () => {
  const localNow = Date.now();
  setPolymarketClockOffsetForTesting(-62_000);
  try {
    const serverNow = synchronizedPolymarketTime(localNow);
    const market = marketWith(serverNow, 0.6, 0.49, 0.51);
    assert.equal(isBookFreshForExecution(market.upBook, localNow), true);
    assert.equal(marketStreamingDataFreshnessIssue(market, localNow), null);
    const updated = updateLiveMarketBookLevel(market, "up", "BUY", 0.48, 100, localNow);
    assert.ok(Math.abs(updated.upBook!.timestamp! - serverNow) < 50, "stream updates are stamped in server time");
    assert.equal(marketStreamingDataFreshnessIssue(updated, localNow), null);
  } finally {
    setPolymarketClockOffsetForTesting(0);
  }
});

test("books older than 10 s cannot price an execution", () => {
  const now = Date.now();
  setPolymarketClockOffsetForTesting(0);
  assert.equal(isBookFreshForExecution(book("up", 0.49, 0.51, now - 9_000), now), true);
  assert.equal(isBookFreshForExecution(book("up", 0.49, 0.51, now - 11_000), now), false);
  assert.equal(isBookFreshForExecution(book("up", 0.49, 0.51, now + 5_000), now), false);
});

test("bids are kept best-first so the top-of-book size reads the best bid", () => {
  const now = Date.now();
  const market = marketWith(now, 0.6, 0.49, 0.51);
  const withDepth = { ...market, upBook: { ...market.upBook!, bids: [{ price: 0.49, size: 7 }, { price: 0.3, size: 900 }] } };
  assert.equal(bookTopSize(withDepth, "UP"), 7 + 5000);
});

test("a market's CLOB fee schedule is exact; the flat configured rate only stands in when it is unknown", () => {
  const clob = { feeSchedule: { rate: 0.07, exponent: 1, feesEnabled: true, source: "CLOB" as const } };
  assert.ok(Math.abs(feePerShareAt(clob, 0.8, { feeRate: 0.05, slippageBps: 0 }) - 0.07 * 0.8 * 0.2) < 1e-12);
  const fallback = { feeSchedule: { rate: 0.1, exponent: 1, feesEnabled: true, source: "CONSERVATIVE_FALLBACK" as const } };
  assert.ok(Math.abs(feePerShareAt(fallback, 0.8, { feeRate: 0.05, slippageBps: 0 }) - 0.04) < 1e-12);
});

test("a paper FAK order never buys above its limit price", () => {
  const now = Date.now();
  setPolymarketClockOffsetForTesting(0);
  const market = marketWith(now, 0.6, 0.49, 0.51);
  const laddered = { ...market, upBook: { ...market.upBook!, asks: [{ price: 0.51, size: 5 }, { price: 0.55, size: 500 }] } };
  const limited = buyPaper(createPaperAccount(100, now), laddered, "UP", 20, { feeRate: 0, slippageBps: 0 }, "test", now, 0.52);
  assert.ok(limited.fill && Math.abs(limited.fill.shares - 5) < 1e-9 && limited.fill.price === 0.51);
  const tooLow = buyPaper(createPaperAccount(100, now), laddered, "UP", 20, { feeRate: 0, slippageBps: 0 }, "test", now, 0.5);
  assert.equal(tooLow.fill, null);
});

test("browser settlement uses the settlement feed observed at expiry, not spot", () => {
  const now = Date.now();
  const market = { ...marketWith(now, 0.6, 0.49, 0.51), endTime: now - 1_000, reference: 100, spot: 101, settlementPrice: 99.9, settlementUpdatedAt: now - 500 };
  const account = buyPaper(createPaperAccount(100, now - 60_000), marketWith(now, 0.6, 0.49, 0.51), "UP", 5, { feeRate: 0, slippageBps: 0 }, "t", now - 60_000).account;
  const settled = settleResolvedPaperPositions(account, new Map([["m1", market]]), "t", now);
  assert.equal(settled.closed, 1);
  assert.equal(settled.account.closedTrades[0].exit, 0, "TWAP below the reference resolves DOWN even though spot is above it");
  const early = { ...market, settlementUpdatedAt: now - 10_000 };
  assert.equal(settleResolvedPaperPositions(account, new Map([["m1", early]]), "t", now).closed, 0);
});

test("the replay charges the fee curve on entry only and never invents a probability", () => {
  const base = { asset: "BTC", duration: "5m" as const, reference: 100, spot: 100.1, upAsk: 0.5, downAsk: 0.5, remainingSeconds: 120 };
  const result = runBacktest([
    { ...base, timestamp: 1, marketId: "a", outcome: "UP", modelFairUp: 0.7, modelAction: "UP" },
    { ...base, timestamp: 2, marketId: "b", outcome: "UP" },
  ], { startingCash: 100, minEdge: 0, maxTrade: 10, feeRate: 0.07, slippageBps: 0 });
  assert.equal(result.skippedWithoutModel, 1);
  assert.equal(result.settled, 1);
  const allIn = 0.5 + 0.07 * 0.25;
  const shares = 10 / allIn;
  assert.ok(Math.abs(result.netPnl! - (shares - 10)) < 1e-4, `net ${result.netPnl} vs ${shares - 10}`);
});
