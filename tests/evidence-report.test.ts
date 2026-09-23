import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEvidenceReport, clusteredBootstrapMean } from "../app/lib/evidence-report";
import { walkForwardByDay } from "../app/lib/replay";
import type { MarketSnapshot } from "../app/lib/signal";
import { simulateMarkets } from "./sim";

const makeDailySample = () => {
  const source = simulateMarkets({ markets: 32, seed: 44, style: "stale-point" });
  const byMarket = new Map<string, MarketSnapshot[]>();
  for (const snapshot of source.snapshots) byMarket.set(snapshot.marketId, [...(byMarket.get(snapshot.marketId) ?? []), snapshot]);
  const marketIds = [...byMarket.keys()];
  const snapshots: MarketSnapshot[] = [];
  const outcomes = new Map<string, "UP" | "DOWN">();
  for (const [marketIndex, oldMarketId] of marketIds.entries()) {
    const dayIndex = Math.floor(marketIndex / 8);
    const indexWithinDay = marketIndex % 8;
    const newMarketId = `day-${dayIndex}-${oldMarketId}`;
    const oldOutcome = source.outcomes.get(oldMarketId)!;
    outcomes.set(newMarketId, oldOutcome);
    const series = byMarket.get(oldMarketId)!;
    const shift = Date.UTC(2026, 0, 1 + dayIndex) + indexWithinDay * 300_000 - series[0].startTime;
    for (const snapshot of series) {
      snapshots.push({
        ...snapshot,
        marketId: newMarketId,
        startTime: snapshot.startTime + shift,
        endTime: snapshot.endTime + shift,
        now: snapshot.now + shift,
        spotTimestamp: snapshot.spotTimestamp === null ? null : snapshot.spotTimestamp + shift,
        ticks: snapshot.ticks.map((tick) => ({ ...tick, timestamp: tick.timestamp + shift })),
        up: { ...snapshot.up, timestamp: snapshot.up.timestamp === null ? null : snapshot.up.timestamp + shift },
        down: { ...snapshot.down, timestamp: snapshot.down.timestamp === null ? null : snapshot.down.timestamp + shift },
      });
    }
  }
  return { snapshots, outcomes };
};

describe("evidence reports", () => {
  it("bootstraps whole clusters deterministically, including a zero point estimate", () => {
    const rows = [
      { market: "a", value: -1 },
      { market: "a", value: 1 },
      { market: "b", value: -1 },
      { market: "b", value: 1 },
      { market: "c", value: -1 },
      { market: "c", value: 1 },
      { market: "d", value: -1 },
      { market: "d", value: 1 },
    ];
    const first = clusteredBootstrapMean(
      rows,
      (row) => row.market,
      (row) => row.value,
      { seed: 7 },
    );
    const second = clusteredBootstrapMean(
      rows,
      (row) => row.market,
      (row) => row.value,
      { seed: 7 },
    );
    assert.equal(first.estimate, 0);
    assert.notEqual(first.lower, null);
    assert.equal(first.lower, second.lower);
    assert.equal(first.upper, second.upper);
    assert.equal(first.clusters, 4);
  });

  it("keeps each test day out of its fit and fails sample-size gates without enough evidence", () => {
    const { snapshots, outcomes } = makeDailySample();
    const folds = walkForwardByDay(snapshots, outcomes, [{ minEdge: 0.02, modelWeight: 0.5 }], { latencyMs: 1_000 }, 1);
    assert.equal(folds.length, 3);
    for (const fold of folds) {
      assert.ok(fold.test);
      const trainMarkets = new Set(fold.train!.calibrationRows.map((row) => row.marketId));
      const testMarkets = new Set(fold.test.calibrationRows.map((row) => row.marketId));
      assert.equal(
        [...testMarkets].some((marketId) => trainMarkets.has(marketId)),
        false,
      );
      assert.ok(
        fold.test.calibrationRows.every(
          (row) =>
            new Date(fold.dayStart).toISOString().slice(0, 10) ===
            new Date(snapshots.find((snapshot) => snapshot.marketId === row.marketId)!.startTime).toISOString().slice(0, 10),
        ),
      );
    }
    const report = buildEvidenceReport({ snapshots, outcomes, folds, generatedAt: new Date("2026-01-10T00:00:00Z"), bootstrapRepetitions: 500 });
    assert.equal(report.sample.recordedDays, 4);
    assert.equal(report.sample.outOfSampleDays, 3);
    assert.ok(report.calibration.checkpoints > 0);
    assert.equal(report.gates.G1.status, "FAIL", "synthetic 4-day data must not pass the 7-day/3,000-market gate");
    assert.equal(report.gates.G2.status, "FAIL", "synthetic trades must not pass the 500-trade gate");
    assert.equal(report.gates.G4.status, "NOT_MEASURED");
    assert.equal(
      report.calibration.posteriorReliability.reduce((sum, bin) => sum + bin.n, 0),
      report.calibration.checkpoints,
    );
  });
});
