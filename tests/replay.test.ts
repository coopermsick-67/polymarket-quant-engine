import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReplayCsv, parseReplayJsonl, runReplay, serializeResolutionLine, serializeSnapshotLine, walkForward } from "../app/lib/replay";
import { simulateMarkets } from "./sim";

describe("replay backtester", () => {
  const stale = simulateMarkets({ markets: 160, seed: 11, style: "stale-point" });
  const fair = simulateMarkets({ markets: 160, seed: 12, style: "fair" });

  it("finds real, fee-adjusted edge against a stale point-price book", () => {
    const report = runReplay(stale.snapshots, stale.outcomes, { latencyMs: 1_000 });
    assert.ok(report.fills >= 20, `expected trades, got ${report.fills}`);
    assert.ok(report.netPnl > 0, `expected profit, got ${report.netPnl}`);
    assert.ok((report.avgRealizedEdge ?? 0) > 0);
    // Model beats the stale book on calibration.
    assert.ok(report.calibration.model.brier! < report.calibration.market.brier!);
  });

  it("does not manufacture profit against a fairly priced book", () => {
    const report = runReplay(fair.snapshots, fair.outcomes, { latencyMs: 1_000 });
    // With fees and a 3pt edge floor, a fair book offers almost nothing.
    assert.ok(report.fills <= 0.1 * report.markets, `too many trades vs a fair book: ${report.fills}`);
    // Model and market are equally calibrated when the book is the truth.
    assert.ok(Math.abs(report.calibration.model.brier! - report.calibration.market.brier!) < 0.01);
  });

  it("latency and limit prices only ever reduce fills", () => {
    const fast = runReplay(stale.snapshots, stale.outcomes, { latencyMs: 0 });
    const slow = runReplay(stale.snapshots, stale.outcomes, { latencyMs: 20_000 });
    assert.ok(slow.fills <= fast.fills);
  });

  it("settles on outcomes without a redemption fee", () => {
    const report = runReplay(stale.snapshots, stale.outcomes, { latencyMs: 1_000 });
    for (const trade of report.trades.filter((candidate) => candidate.pnl !== null)) {
      const expected = (trade.outcome === trade.side ? trade.shares : 0) - trade.totalCost;
      assert.ok(Math.abs(trade.pnl! - expected) < 1e-9);
    }
  });

  it("walk-forward tunes on the past and reports an untouched test set", () => {
    const result = walkForward(stale.snapshots, stale.outcomes, [{ minEdge: 0.02 }, { minEdge: 0.05 }], { latencyMs: 1_000 }, 0.6, 5);
    assert.ok(result.trainMarkets > result.testMarkets);
    assert.ok(result.test !== null && result.chosen !== null);
    const trained = new Set(result.train!.calibrationRows.map((row) => row.marketId));
    const tested = new Set(result.test!.calibrationRows.map((row) => row.marketId));
    assert.equal(
      [...tested].some((marketId) => trained.has(marketId)),
      false,
    );
    assert.ok([...trained].every((marketId) => stale.snapshots.find((snapshot) => snapshot.marketId === marketId)!.endTime < result.cutoff));
  });

  it("round-trips JSONL and imports CSV", () => {
    const text = stale.snapshots.slice(0, 5).map(serializeSnapshotLine).join("") + serializeResolutionLine("sim-11-0", "UP") + "garbage\n";
    const parsed = parseReplayJsonl(text);
    assert.equal(parsed.snapshots.length, 5);
    assert.equal(parsed.outcomes.get("sim-11-0"), "UP");
    assert.equal(parsed.rejected, 1);
    const csv =
      "timestamp,market_id,asset,duration,end_time,reference,spot,sigma_per_sqrt_second,up_bid,up_ask,down_bid,down_ask,depth_shares,twap_lookback_seconds,outcome\n1790000030,m1,BTC,5m,1790000300,100000,100010,0.0001,0.55,0.57,0.43,0.45,500,60,UP\nbad,row\n";
    const imported = parseReplayCsv(csv);
    assert.equal(imported.snapshots.length, 1);
    assert.equal(imported.rejected, 1);
    assert.equal(imported.snapshots[0].spotSource, "EXCHANGE");
  });
});
