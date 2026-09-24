import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessBankrollRisk,
  bankrollProfile,
  calculateBankrollAwareStake,
  minimumExecutableOrderCost,
  scoreBankrollOpportunity,
  type BankrollSizingInput,
} from "../../app/lib/bankroll-policy";

const candidate = (equityUsd: number, overrides: Partial<BankrollSizingInput> = {}): BankrollSizingInput => ({
  equityUsd,
  cashUsd: equityUsd,
  dayStartEquityUsd: equityUsd,
  peakEquityUsd: equityUsd,
  positions: [],
  marketId: "btc-5m-123",
  asset: "BTC",
  side: "UP",
  correlationGroup: "CRYPTO",
  strategyKey: "trend-confirmation",
  modelProbability: 0.72,
  entryPrice: 0.5,
  netEdge: 0.22,
  minExecutableOrderUsd: 1,
  availableDepthUsd: 100_000,
  spreadPct: 0.005,
  timeRemainingSeconds: 240,
  probabilityUncertainty: 0.02,
  ...overrides,
});

test("tier boundaries, reserve, and per-trade caps change with liquidation equity", () => {
  const amounts = [19.99, 20, 25, 49.99, 50, 75, 99.99, 100, 249.99, 250, 999.99, 1_000, 10_000];
  const tiers = ["MICRO", "MICRO", "MICRO", "MICRO", "SMALL", "SMALL", "SMALL", "GROWTH", "GROWTH", "STANDARD", "STANDARD", "LARGE", "LARGE"];
  amounts.forEach((amount, index) => assert.equal(bankrollProfile(amount).tier, tiers[index]));
  assert.equal(bankrollProfile(19.99).eligible, false);
  assert.equal(bankrollProfile(20).eligible, true);
  assert.ok(bankrollProfile(20).maxStakePct > bankrollProfile(1_000).maxStakePct);
  assert.ok(bankrollProfile(20).reservePct > bankrollProfile(1_000).reservePct);
});

test("minimum order may lift target only within every hard cap across bankrolls", () => {
  for (const equity of [20, 25, 50, 75, 100, 250, 1_000, 10_000]) {
    const maxStake = equity * bankrollProfile(equity).maxStakePct;
    const minimum = Math.min(1, maxStake, equity * bankrollProfile(equity).maxDailyLossPct);
    const sizing = calculateBankrollAwareStake(candidate(equity, { minExecutableOrderUsd: minimum }));
    assert.equal(sizing.approved, true, `Expected approved for $${equity}: ${sizing.reason}`);
    assert.ok(sizing.stakeUsd >= minimum, `${equity}: below minimum`);
    assert.ok(sizing.stakeUsd <= maxStake + 1e-9, `${equity}: above stake cap`);
    assert.ok(sizing.stakeUsd <= sizing.portfolio.remainingExposureUsd + 1e-9);
    assert.ok(sizing.stakeUsd <= sizing.portfolio.remainingCorrelatedExposureUsd + 1e-9);
    assert.ok(sizing.reserveUsd <= equity);
  }
});

test("worst-case open-position value consumes the remaining daily loss budget", () => {
  const withinRoom = calculateBankrollAwareStake(candidate(100, { openPositionRiskUsd: 4, minExecutableOrderUsd: 1 }));
  const beyondRoom = calculateBankrollAwareStake(candidate(100, { openPositionRiskUsd: 4.5, minExecutableOrderUsd: 1 }));
  assert.equal(withinRoom.approved, true, withinRoom.reason);
  assert.equal(withinRoom.portfolio.remainingDailyRiskUsd, 1);
  assert.equal(beyondRoom.approved, false);
  assert.match(beyondRoom.reason, /remaining daily-loss/i);
});

test("minimum exchange size above a MICRO cap is an explicit PASS", () => {
  assert.equal(minimumExecutableOrderCost(5, 0.2001), 1.01);
  assert.equal(minimumExecutableOrderCost(0, 0.2), Number.POSITIVE_INFINITY);
  const sizing = calculateBankrollAwareStake(candidate(20, { minExecutableOrderUsd: 1.01 }));
  assert.equal(sizing.approved, false);
  assert.equal(sizing.stakeUsd, 0);
  assert.match(sizing.reason, /Minimum executable order risks 5\.1%/);
});

test("insufficient cash after reserve and shallow depth both block entry", () => {
  const cash = calculateBankrollAwareStake(candidate(50, { cashUsd: 20, minExecutableOrderUsd: 1 }));
  const depth = calculateBankrollAwareStake(candidate(50, { availableDepthUsd: 10, minExecutableOrderUsd: 1 }));
  assert.equal(cash.approved, false);
  assert.equal(depth.approved, false);
  assert.equal(cash.stakeUsd, 0);
  assert.equal(depth.stakeUsd, 0);
});

test("same market, total exposure, correlated exposure, and position count are capped", () => {
  const sameMarket = calculateBankrollAwareStake(candidate(100, { positions: [{ marketId: "btc-5m-123", asset: "BTC", side: "DOWN", costUsd: 1, correlationGroup: "CRYPTO" }] }));
  const correlated = calculateBankrollAwareStake(candidate(100, { positions: [{ marketId: "eth-5m-456", asset: "ETH", side: "UP", costUsd: 6.5, correlationGroup: "CRYPTO" }], minExecutableOrderUsd: 1 }));
  const count = calculateBankrollAwareStake(candidate(100, { positions: [
    { marketId: "a", asset: "BTC", side: "UP", costUsd: 1, correlationGroup: "CRYPTO" },
    { marketId: "b", asset: "ETH", side: "DOWN", costUsd: 1, correlationGroup: "CRYPTO" },
    { marketId: "c", asset: "SOL", side: "UP", costUsd: 1, correlationGroup: "CRYPTO" },
  ] }));
  assert.equal(sameMarket.approved, false);
  assert.match(sameMarket.reason, /already open/);
  assert.equal(correlated.approved, false);
  assert.equal(count.approved, false);
  assert.match(count.reason, /Open-position limit/);
});

test("daily loss and peak drawdown halt; rising drawdown scales stake down", () => {
  const profile = bankrollProfile(25);
  assert.equal(assessBankrollRisk({ equityUsd: 23.99, dayStartEquityUsd: 25, peakEquityUsd: 25, profile }).approved, false);
  assert.equal(assessBankrollRisk({ equityUsd: 21, dayStartEquityUsd: 21, peakEquityUsd: 25, profile }).approved, false);
  const healthy = calculateBankrollAwareStake(candidate(100));
  const drawn = calculateBankrollAwareStake(candidate(98, { dayStartEquityUsd: 98, peakEquityUsd: 100 }));
  assert.equal(healthy.approved, true);
  assert.equal(drawn.approved, true);
  assert.ok(drawn.drawdownAdjustment < healthy.drawdownAdjustment);
  assert.ok(drawn.riskMultiplier < healthy.riskMultiplier);
});

test("calibrated fractional Kelly is a hard cap, not a suggested target", () => {
  const tooSmall = calculateBankrollAwareStake(candidate(100, {
    modelProbability: 0.32, calibratedProbability: 0.22, calibrationSampleSize: 200,
    netEdge: 0.12, minExecutableOrderUsd: 1,
  }));
  assert.equal(tooSmall.kellyApplied, true);
  assert.equal(tooSmall.approved, false);
  assert.equal(tooSmall.stakeUsd, 0);
  const enough = calculateBankrollAwareStake(candidate(100, {
    calibratedProbability: 0.75, calibrationSampleSize: 200, minExecutableOrderUsd: 0.25,
  }));
  assert.equal(enough.approved, true, enough.reason);
  assert.ok(enough.stakeUsd <= 100 * enough.kellyAdjusted + 0.01);
});

test("thin edge, spread, tail prices, expired market and unaffordable expected profit PASS", () => {
  assert.equal(calculateBankrollAwareStake(candidate(100, { netEdge: 0.01 })).approved, false);
  assert.equal(calculateBankrollAwareStake(candidate(100, { spreadPct: 0.1 })).approved, false);
  assert.equal(calculateBankrollAwareStake(candidate(20, { entryPrice: 0.05, modelProbability: 0.3, netEdge: 0.25 })).approved, false);
  assert.equal(calculateBankrollAwareStake(candidate(20, { timeRemainingSeconds: 10 })).approved, false);
  assert.equal(calculateBankrollAwareStake(candidate(20, { probabilityUncertainty: 0.2 })).approved, false);
  assert.equal(calculateBankrollAwareStake(candidate(20, { probabilityUncertainty: -0.01 })).approved, false);
  assert.equal(calculateBankrollAwareStake(candidate(20, { maxTradeUsd: -1 })).approved, false);
});

test("opportunity score remains explainable and never ranks a PASS", () => {
  const input = candidate(100);
  const sizing = calculateBankrollAwareStake(input);
  const ranked = scoreBankrollOpportunity({ sizing, spreadPct: input.spreadPct, availableDepthUsd: input.availableDepthUsd, timeRemainingSeconds: input.timeRemainingSeconds });
  assert.ok(ranked.score > 0 && ranked.score <= 100);
  assert.deepEqual(Object.keys(ranked.components), ["edge", "profit", "spread", "liquidity", "uncertainty", "time"]);
  const rejected = calculateBankrollAwareStake(candidate(100, { spreadPct: 1 }));
  assert.equal(scoreBankrollOpportunity({ sizing: rejected, spreadPct: 1, availableDepthUsd: 100, timeRemainingSeconds: 240 }).score, 0);
});
