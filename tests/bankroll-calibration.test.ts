import assert from "node:assert/strict";
import test from "node:test";
import { walkForwardCalibration, type CalibrationObservation } from "../app/lib/bankroll-calibration";

const observation = (id: number, observedAt: number, resolvedAt: number, fairUp = 0.62, outcome: "UP" | "DOWN" = "UP"): CalibrationObservation => ({
  marketId: `market-${id}`,
  observedAt,
  resolvedAt,
  fairUp,
  outcome,
  modelVersion: "model-a",
});

test("calibration bucket diagnostics and probability scoring use settled outcomes", () => {
  const report = walkForwardCalibration([
    observation(1, 100, 200, 0.52, "UP"),
    observation(2, 300, 400, 0.58, "DOWN"),
    observation(3, 500, 600, 0.63, "UP"),
    observation(4, 700, 800, 0.72, "DOWN"),
    observation(5, 900, 1000, 0.88, "UP"),
    observation(6, 1100, 1200, 0.44, "DOWN"),
  ], { modelVersion: "model-a" });
  assert.deepEqual(report.buckets.map((bucket) => bucket.samples), [1, 2, 1, 0, 1, 1]);
  assert.equal(report.raw.samples, 6);
  assert.ok(report.raw.brierScore !== null && report.raw.brierScore > 0);
  assert.ok(report.raw.logLoss !== null && report.raw.logLoss > 0);
  assert.equal(report.adjustedOutOfSample.samples, 0);
});

test("walk-forward adjustment sees only earlier resolved markets", () => {
  const report = walkForwardCalibration([
    observation(3, 300, 500, 0.62, "DOWN"),
    observation(2, 200, 250, 0.62, "DOWN"),
    observation(1, 100, 400, 0.62, "DOWN"),
    observation(4, 450, 500, 0.62, "UP"),
    observation(5, 600, 700, 0.62, "UP"),
  ], { modelVersion: "model-a", minimumTrainingSamples: 2, minimumBucketSamples: 2, priorStrength: 0 });
  assert.equal(report.points[0].trainingSamples, 0);
  assert.equal(report.points[1].trainingSamples, 0);
  assert.equal(report.points[2].trainingSamples, 1); // Market 2 resolved; market 1 has not.
  assert.equal(report.points[3].trainingSamples, 2); // Markets 1 and 2 resolved.
  assert.equal(report.points[3].calibrated, true);
  assert.equal(report.points[3].adjustedProbabilityUp, 0.01);
  assert.equal(report.points[4].trainingSamples, 4);
  assert.equal(report.adjustedOutOfSample.samples, 2);
});

test("future outcomes, duplicate markets, and another model version cannot train calibration", () => {
  const inputs = [
    observation(1, 100, 1000),
    observation(1, 200, 250),
    { ...observation(2, 100, 150), modelVersion: "model-b" },
    observation(3, 300, 400),
  ];
  const report = walkForwardCalibration(inputs, { modelVersion: "model-a", minimumTrainingSamples: 1, minimumBucketSamples: 1 });
  assert.equal(report.points.length, 2);
  assert.equal(report.points[1].trainingSamples, 0);
  assert.equal(report.rejected, 2);
  assert.equal(report.points[1].calibrated, false);
});
