import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIVE_EARLY_EXIT, evaluateModelAwareExit, evaluatePaperHoldExit, normalizeEarlyExitPolicy } from "../../app/lib/early-exit";

const policy = { ...DEFAULT_LIVE_EARLY_EXIT, earlyExitEnabled: true };

test("live policy defaults to a 20% net take-profit and stop-loss with a 5-second stop window", () => {
  const normalized = normalizeEarlyExitPolicy({}, DEFAULT_LIVE_EARLY_EXIT);
  assert.equal(normalized.earlyExitTakeProfitPct, 0.2);
  assert.equal(normalized.earlyExitStopLossPct, 0.2);
  assert.equal(normalized.earlyExitStopLossMinRemainingSeconds, 5);
});

test("take-profit exits use fee-adjusted realized gains", () => {
  const result = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 20, netExitProceedsUsd: 12.1,
    sideFairProbability: 0.45, remainingSeconds: 90,
  });
  assert.equal(result.shouldExit, true);
  assert.match(result.reason, /^Take-profit:/);
});

test("stop-loss exits on a partial executable quantity and does not require model data", () => {
  const result = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 10, netExitProceedsUsd: 3.9,
    sideFairProbability: 0.5, modelDataAvailable: false, remainingSeconds: 20,
  });
  assert.equal(result.shouldExit, true);
  assert.equal(result.filledShares, 10);
  assert.match(result.reason, /^Stop-loss:/);
});

test("model-based cashouts remain available below the take-profit target", () => {
  const result = evaluatePaperHoldExit({
    policy: { ...policy, earlyExitMinProfitUsd: 0.05 }, entryCostUsd: 10, originalShares: 20,
    filledShares: 20, netExitProceedsUsd: 10.55, sideFairProbability: 0.4, remainingSeconds: 90,
  });
  assert.equal(result.shouldExit, true);
  assert.match(result.reason, /^Executable sale exceeds estimated hold value/);
});

test("a stop-loss does not trigger below its net-loss threshold or inside its settlement buffer", () => {
  const belowThreshold = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 20, netExitProceedsUsd: 8.01,
    sideFairProbability: 0.5, remainingSeconds: 90,
  });
  assert.equal(belowThreshold.shouldExit, false);

  const tooClose = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 20, netExitProceedsUsd: 7.5,
    sideFairProbability: 0.5, remainingSeconds: 4,
  });
  assert.equal(tooClose.shouldExit, false);
  assert.match(tooClose.reason, /too close to settlement/i);
});

test("live mark exits can stop a loss without satisfying the profit or model-gap conditions", () => {
  const result = evaluateModelAwareExit({
    policy, entryPrice: 0.5, currentPrice: 0.35, fairProbability: 0.8, shares: 20, feeRate: 0.05, remainingSeconds: 10,
  });
  assert.equal(result.shouldExit, true);
  assert.match(result.reason, /^Stop-loss:/);
});

test("live take-profit works when model data is unavailable, while model cashouts fail closed", () => {
  const takeProfit = evaluateModelAwareExit({
    policy, entryPrice: 0.5, currentPrice: 0.68, fairProbability: 0.5, shares: 20, feeRate: 0.05,
    remainingSeconds: 90, modelDataAvailable: false,
  });
  assert.equal(takeProfit.shouldExit, true);
  assert.match(takeProfit.reason, /^Take-profit:/);

  const modelCashout = evaluateModelAwareExit({
    policy, entryPrice: 0.5, currentPrice: 0.6, fairProbability: 0.5, shares: 20, feeRate: 0.05,
    remainingSeconds: 90, modelDataAvailable: false,
  });
  assert.equal(modelCashout.shouldExit, false);
  assert.match(modelCashout.reason, /model inputs are unavailable/i);
});
