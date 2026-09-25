import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIVE_EARLY_EXIT, evaluateModelAwareExit, evaluatePaperHoldExit, normalizeEarlyExitPolicy } from "../../app/lib/early-exit";
import { enforceLiveExecutionRisk } from "../../app/lib/live-risk";

const policy = { ...DEFAULT_LIVE_EARLY_EXIT, earlyExitEnabled: true, earlyExitTakeProfitPct: 0.2, earlyExitStopLossPct: 0.2 };

test("live policy keeps fixed take-profit and stop-loss off by default", () => {
  const normalized = normalizeEarlyExitPolicy({}, DEFAULT_LIVE_EARLY_EXIT);
  assert.equal(normalized.earlyExitTakeProfitPct, 0);
  assert.equal(normalized.earlyExitStopLossPct, 0);
  assert.equal(normalized.earlyExitStopLossMinRemainingSeconds, 5);
  assert.equal(enforceLiveExecutionRisk({}).earlyExitStopLossPct, 0, "server limits must not switch a disabled stop-loss on");
  assert.equal(enforceLiveExecutionRisk({ earlyExitStopLossPct: 0.02 }).earlyExitStopLossPct, 0.05);
  assert.equal(enforceLiveExecutionRisk({ earlyExitStopLossPct: 0.3 }).earlyExitStopLossPct, 0.3);
});

test("take-profit sells when the model does not value holding above the sale", () => {
  const result = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 20, netExitProceedsUsd: 12.1,
    sideFairProbability: 0.45, remainingSeconds: 90,
  });
  assert.equal(result.shouldExit, true);
  assert.match(result.reason, /^Take-profit:/);
});

test("take-profit holds when the model values the shares well above the sale", () => {
  const result = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 20, netExitProceedsUsd: 12.1,
    sideFairProbability: 0.8, remainingSeconds: 90,
  });
  assert.equal(result.shouldExit, false);
});

test("stop-loss sells a partial executable quantity when the model agrees the position is worth less", () => {
  const result = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 10, netExitProceedsUsd: 3.9,
    sideFairProbability: 0.35, remainingSeconds: 20,
  });
  assert.equal(result.shouldExit, true);
  assert.equal(result.filledShares, 10);
  assert.match(result.reason, /^Stop-loss:/);
});

test("stop-loss never sells blind: it holds without model data or when holding is worth more", () => {
  const withoutModel = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 10, netExitProceedsUsd: 3.9,
    sideFairProbability: 0.35, modelDataAvailable: false, remainingSeconds: 20,
  });
  assert.equal(withoutModel.shouldExit, false);
  const holdWorthMore = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 10, netExitProceedsUsd: 3.9,
    sideFairProbability: 0.5, remainingSeconds: 20,
  });
  assert.equal(holdWorthMore.shouldExit, false);
  assert.match(holdWorthMore.reason, /values holding above/i);
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
    sideFairProbability: 0.3, remainingSeconds: 90,
  });
  assert.equal(belowThreshold.shouldExit, false);

  const tooClose = evaluatePaperHoldExit({
    policy, entryCostUsd: 10, originalShares: 20, filledShares: 20, netExitProceedsUsd: 7.5,
    sideFairProbability: 0.3, remainingSeconds: 4,
  });
  assert.equal(tooClose.shouldExit, false);
  assert.match(tooClose.reason, /too close to settlement/i);
});

test("live mark stop-loss defers to the model's fair value", () => {
  const modelSaysHold = evaluateModelAwareExit({
    policy, entryPrice: 0.5, currentPrice: 0.35, fairProbability: 0.8, shares: 20, feeRate: 0.05, remainingSeconds: 10,
  });
  assert.equal(modelSaysHold.shouldExit, false);
  const modelAgrees = evaluateModelAwareExit({
    policy, entryPrice: 0.5, currentPrice: 0.35, fairProbability: 0.3, shares: 20, feeRate: 0.05, remainingSeconds: 10,
  });
  assert.equal(modelAgrees.shouldExit, true);
  assert.match(modelAgrees.reason, /^Stop-loss:/);
});

test("without model data neither fixed thresholds nor model cashouts sell", () => {
  const takeProfit = evaluateModelAwareExit({
    policy, entryPrice: 0.5, currentPrice: 0.68, fairProbability: 0.5, shares: 20, feeRate: 0.05,
    remainingSeconds: 90, modelDataAvailable: false,
  });
  assert.equal(takeProfit.shouldExit, false);
  assert.match(takeProfit.reason, /model inputs are unavailable/i);

  const modelCashout = evaluateModelAwareExit({
    policy, entryPrice: 0.5, currentPrice: 0.6, fairProbability: 0.5, shares: 20, feeRate: 0.05,
    remainingSeconds: 90, modelDataAvailable: false,
  });
  assert.equal(modelCashout.shouldExit, false);
  assert.match(modelCashout.reason, /model inputs are unavailable/i);
});
