import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closePaperPositions, createPaperAccount, haltState, markAccount, settleResolvedPaperPositions, buyPaper } from "../app/lib/engines";
import { createEngineState, normalizePaperConfig, stepPaperEngine } from "../app/lib/paper-engine";
import type { DerivedFeed } from "../app/lib/feeds";
import type { LiveMarket } from "../app/lib/polymarket-data";
import { DEFAULT_FEE_SCHEDULE, takerFeePerShare } from "../app/lib/pricing";

const now = 1_790_000_000_000;
const market = (overrides: Partial<LiveMarket> = {}): LiveMarket => ({
  id: "m1",
  conditionId: "0xc",
  slug: "btc-updown-5m-1789999800",
  question: "BTC Up or Down",
  asset: "BTC",
  duration: "5m",
  startTime: now - 275_000,
  endTime: now + 25_000,
  upTokenId: "up",
  downTokenId: "down",
  sourceUrl: "",
  declaredTwapSeconds: 60,
  feeSchedule: DEFAULT_FEE_SCHEDULE,
  tickSize: 0.01,
  minOrderSize: 5,
  negRisk: false,
  remaining: 25,
  reference: 100_000,
  referenceSource: "CHAINLINK",
  officialClose: null,
  upBook: {
    tokenId: "up",
    bids: [{ price: 0.84, size: 2000 }],
    asks: [{ price: 0.85, size: 2000 }],
    timestamp: now - 200,
    minOrderSize: 5,
    tickSize: 0.01,
    hash: null,
  },
  downBook: {
    tokenId: "down",
    bids: [{ price: 0.15, size: 2000 }],
    asks: [{ price: 0.16, size: 2000 }],
    timestamp: now - 200,
    minOrderSize: 5,
    tickSize: 0.01,
    hash: null,
  },
  upBid: 0.84,
  upAsk: 0.85,
  downBid: 0.15,
  downAsk: 0.16,
  spread: 0.01,
  liquidity: 1000,
  imbalance: 0,
  sourceTimestamp: now,
  chart5m: [],
  chart15m: [],
  chartUpdatedAt: null,
  ...overrides,
});
const feed = (spot: number): DerivedFeed => ({
  asset: "BTC",
  spot,
  spotTimestamp: now - 100,
  spotSource: "ANCHORED",
  ticks: Array.from({ length: 300 }, (_, index) => ({ timestamp: now - (299 - index) * 1000, price: spot })),
  settlementValue: spot,
  settlementTimestamp: now - 100,
  basisBps: 1,
  exchangeSpot: spot,
  exchangeSpotTimestamp: now - 100,
  sigmaPerSqrtSecond: 0.0001,
  sigmaSource: "TICKS",
  volSamples: 1000,
});

describe("paper account accounting", () => {
  it("charges the fee curve on buys and settles winners at $1 with no redemption fee", () => {
    const account = createPaperAccount(1000, now);
    const bought = buyPaper(account, market(), "UP", 25, { slippageBps: 0, reason: "t" }, now);
    const fill = bought.fill!;
    assert.ok(Math.abs(fill.fee - fill.shares * takerFeePerShare(0.85)) < 1e-9);
    assert.ok(Math.abs(bought.account.cash - (1000 - fill.totalCost)) < 1e-6);
    const settled = settleResolvedPaperPositions(bought.account, new Map([["m1", { outcome: "UP" as const }]]), "official", now + 60_000);
    assert.equal(settled.closed, 1);
    assert.ok(Math.abs(settled.account.cash - (1000 - fill.totalCost + fill.shares)) < 1e-4);
  });
  it("does not settle without an official resolution", () => {
    const bought = buyPaper(createPaperAccount(1000, now), market(), "UP", 25, { slippageBps: 0, reason: "t" }, now);
    const settled = settleResolvedPaperPositions(bought.account, new Map(), "official", now + 600_000);
    assert.equal(settled.closed, 0);
    assert.equal(settled.skipped, 1);
  });
  it("sells into bid depth and leaves unfilled shares open", () => {
    const bought = buyPaper(createPaperAccount(1000, now), market(), "UP", 25, { slippageBps: 0, reason: "t" }, now);
    const thin = market({ upBook: { ...market().upBook!, bids: [{ price: 0.9, size: 10 }] } });
    const closed = closePaperPositions(bought.account, new Map([["m1", thin]]), { slippageBps: 0, reason: "exit" }, now);
    assert.equal(closed.closed, 1);
    assert.equal(closed.account.positions.length, 1);
    assert.ok(Math.abs(closed.account.positions[0].shares - (bought.fill!.shares - 10)) < 1e-6);
  });
  it("separates the daily loss limit from the drawdown limit", () => {
    const account = { ...createPaperAccount(1000, now), dayStartEquity: 1000, peakEquity: 1200 };
    assert.equal(haltState(account, 940, { dailyLossPct: 0.05, maxDrawdownPct: 0.5 }).halted, true);
    assert.equal(haltState(account, 990, { dailyLossPct: 0.05, maxDrawdownPct: 0.15 }).halted, true);
    assert.equal(haltState(account, 1150, { dailyLossPct: 0.05, maxDrawdownPct: 0.15 }).halted, false);
    const rolled = markAccount({ ...account, dayKey: "1999-01-01" }, new Map(), now);
    assert.notEqual(rolled.dayKey, "1999-01-01");
  });
});

describe("paper engine step", () => {
  it("decides now, fills only after latency at the limit, then settles on the official outcome", () => {
    const config = normalizePaperConfig({ latencyMs: 750 });
    const markets = new Map([["m1", market()]]);
    const spot = 100_000 * 1.002; // 20 bp above the price to beat, 25 s left
    let state = createEngineState(createPaperAccount(1000, now));
    let step = stepPaperEngine(state, { markets, feed: () => feed(spot), resolutions: new Map(), config, now, autoTrade: true });
    assert.equal(step.state.pending.length, 1);
    assert.equal(step.state.account.positions.length, 0);
    state = step.state;
    step = stepPaperEngine(state, { markets, feed: () => feed(spot), resolutions: new Map(), config, now: now + 800, autoTrade: true });
    assert.equal(step.state.account.positions.length, 1);
    assert.equal(step.state.account.positions[0].side, "UP");
    state = step.state;
    step = stepPaperEngine(state, {
      markets,
      feed: () => feed(spot),
      resolutions: new Map([["m1", { marketId: "m1", outcome: "UP" as const, resolvedAt: now + 60_000 }]]),
      config,
      now: now + 60_000,
      autoTrade: true,
    });
    assert.equal(step.state.account.positions.length, 0);
    assert.ok(step.state.account.realizedPnl > 0);
  });
  it("misses the fill when the book moves above the limit during latency", () => {
    const config = normalizePaperConfig({ latencyMs: 750 });
    const spot = 100_000 * 1.002;
    const first = stepPaperEngine(createEngineState(createPaperAccount(1000, now)), {
      markets: new Map([["m1", market()]]),
      feed: () => feed(spot),
      resolutions: new Map(),
      config,
      now,
      autoTrade: true,
    });
    const moved = market({ upBook: { ...market().upBook!, asks: [{ price: 0.99, size: 2000 }] }, upAsk: 0.99 });
    const second = stepPaperEngine(first.state, {
      markets: new Map([["m1", moved]]),
      feed: () => feed(spot),
      resolutions: new Map(),
      config,
      now: now + 800,
      autoTrade: false,
    });
    assert.equal(second.state.account.positions.length, 0);
    assert.ok(second.events.some((event) => event.kind === "miss"));
  });
  it("halts and clears pending orders when the daily loss limit is hit", () => {
    const config = normalizePaperConfig({ dailyLossPct: 0.01 });
    const account = { ...createPaperAccount(1000, now), cash: 980 };
    const step = stepPaperEngine(
      {
        ...createEngineState(account),
        pending: [{ marketId: "m1", side: "UP", limitPrice: 0.9, budget: 10, probability: 0.99, decidedAt: now, executeAt: now + 10_000, reason: "" }],
      },
      { markets: new Map(), feed: () => null, resolutions: new Map(), config, now, autoTrade: true },
    );
    assert.ok(step.state.halt);
    assert.equal(step.state.pending.length, 0);
  });
});

describe("live-run regressions (paper)", () => {
  it("keeps the last mark when a closed window's book empties, so equity does not collapse", () => {
    const bought = buyPaper(createPaperAccount(1000, now), market(), "UP", 25, { slippageBps: 0, reason: "t" }, now);
    const marked = markAccount(bought.account, new Map([["m1", market()]]), now);
    const emptied = market({ upBook: { ...market().upBook!, bids: [], asks: [] }, upBid: null, upAsk: null });
    const after = markAccount(marked, new Map([["m1", emptied]]), now + 30_000);
    assert.equal(after.positions[0].mark, 0.84);
  });
});
