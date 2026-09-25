import assert from "node:assert/strict";
import test from "node:test";
import { createPaperAccount, MAX_MODEL_MARKET_GAP } from "../app/lib/engines";
import { liveBankrollProfile, MIN_SIZING_UNCERTAINTY } from "../app/lib/live-bankroll-policy";
import { evaluatePaperMarket } from "../app/lib/paper-bankroll";
import { setPolymarketClockOffsetForTesting } from "../app/lib/polymarket-data";
import { marketWith } from "./market-fixture";

setPolymarketClockOffsetForTesting(0);
const LIVE_COSTS = { feeRate: 0.05, slippageBps: 25 };

/** Sweep every 1c book and every raw model value the gap cap allows, through the real live path. */
const approvals = (equity: number) => {
  const now = Date.now();
  const profile = liveBankrollProfile(equity, 10, 0.15, "5m");
  let approved = 0;
  for (let bidCents = 3; bidCents <= 96; bidCents += 1) {
    const bid = bidCents / 100;
    const ask = Number((bid + 0.01).toFixed(2));
    const mid = (bid + ask) / 2;
    for (let model = Math.max(0.01, mid - MAX_MODEL_MARKET_GAP + 0.005); model <= Math.min(0.99, mid + MAX_MODEL_MARKET_GAP - 0.005); model += 0.02) {
      const market = marketWith(now, model, bid, ask);
      const opportunity = evaluatePaperMarket({
        market, markets: new Map([[market.id, market]]), account: createPaperAccount(equity, now), costs: LIVE_COSTS,
        liquidationEquityUsd: equity, dayStartLiquidationEquityUsd: equity, peakLiquidationEquityUsd: equity, minOrderUsd: 1.05,
        maxTradeUsd: Math.min(5, equity * profile.maxStakePct), maxExposurePct: profile.maxExposurePct, minimumSharesOverride: 5,
        profileOverride: profile, minNetEdge: 0.04,
        strategyThresholds: { microScoreMinimum: profile.microScoreMinimum, smallBiasConfidenceMinimum: profile.smallBiasConfidenceMinimum }, now,
      });
      if (opportunity.approved) approved += 1;
    }
  }
  return approved;
};

test("live tiers no longer contradict themselves: an entry at the edge floor and top price can pass the per-stake floor", () => {
  for (const equity of [25, 75, 150, 500, 5_000]) {
    const profile = liveBankrollProfile(equity);
    const conservativeEdgeAtFloor = profile.minNetEdge - MIN_SIZING_UNCERTAINTY;
    assert.ok(conservativeEdgeAtFloor / profile.maxEntryPrice + 1e-12 >= profile.minExpectedProfitOnStakePct, `equity ${equity}`);
    assert.ok(profile.minExpectedProfitUsd <= 0.05, "the dollar floor fits a $5 live order");
  }
});

test("with each market's CLOB fees the live path can approve entries from $50 upward (it approved none before)", () => {
  for (const equity of [50, 100, 1_000]) assert.ok(approvals(equity) > 0, `no live approval at $${equity}`);
});
