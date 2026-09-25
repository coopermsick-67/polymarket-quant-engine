import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRecordedDecisions, fitStackingCalibration, type CalibrationObservation } from "../app/lib/model-calibration";
import {
  anchoredFairUp,
  anchorProbability,
  FORECAST_MODEL_VERSION,
  isUsableCalibration,
  setActiveCalibration,
  stackedProbability,
  type StackingCalibration,
} from "../app/lib/polymarket-data";
import { marketWith } from "./market-fixture";

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Deterministic synthetic markets, one every five minutes: the book is noisy,
 * and the model carries \`modelSignal\` of the true log-odds. \`decayAt\` makes
 * the model uninformative for markets from that index on (a regime change).
 */
const synthetic = (markets: number, modelSignal: number, options: { seed?: number; modelVersion?: string; decayAt?: number } = {}): CalibrationObservation[] => {
  let state = options.seed ?? 7;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
  const rows: CalibrationObservation[] = [];
  for (let market = 0; market < markets; market += 1) {
    const truth = normal() * 1.5;
    const marketLogit = 0.6 * truth + normal() * 0.6;
    const signal = options.decayAt !== undefined && market >= options.decayAt ? 0 : modelSignal;
    const modelLogit = signal * truth + (1 - signal) * normal() * 1.5;
    const outcome = random() < sigmoid(truth) ? "UP" : "DOWN";
    for (let snapshot = 0; snapshot < 4; snapshot += 1) {
      rows.push({ marketId: `m${market}`, at: market * 300_000 + snapshot * 15_000, remainingSeconds: 200 - snapshot * 30, duration: "5m",
        modelVersion: options.modelVersion ?? FORECAST_MODEL_VERSION,
        rawModelUp: sigmoid(modelLogit + normal() * 0.05), marketUp: sigmoid(marketLogit + normal() * 0.05), outcome });
    }
  }
  return rows;
};

test("an informative model earns a fitted weight that also beats the book on the chronological holdout", () => {
  const report = fitStackingCalibration(synthetic(600, 0.9), { bootstrap: 60 });
  assert.ok(report.calibration, report.reason);
  assert.ok(report.modelCoefficientLower! > 0);
  assert.ok(report.heldOutLogLoss! < report.heldOutMarketLogLoss!);
  assert.equal(report.heldOutMarkets, 180);
  assert.equal(report.calibration!.modelVersion, FORECAST_MODEL_VERSION);
  assert.ok(isUsableCalibration(report.calibration));
});

test("a model that adds nothing to the book is not given weight", () => {
  const report = fitStackingCalibration(synthetic(600, 0), { bootstrap: 60 });
  assert.equal(report.calibration, null);
  assert.match(report.reason, /adds no demonstrated information|does not beat the book/);
});

test("a fit that only worked in the past fails the chronological holdout", () => {
  // Informative for the first 420 markets, useless for the most recent 180 (the holdout).
  const report = fitStackingCalibration(synthetic(600, 0.95, { decayAt: 420 }), { bootstrap: 40 });
  assert.equal(report.calibration, null);
  assert.match(report.reason, /does not beat the book mid alone out of sample/);
});

test("fewer than 300 settled markets never produce a usable fit", () => {
  const report = fitStackingCalibration(synthetic(120, 0.9), { bootstrap: 20 });
  assert.equal(report.calibration, null);
  assert.match(report.reason, /at least 300/);
});

test("observations from another model version are never mixed into a fit", () => {
  const report = fitStackingCalibration(synthetic(600, 0.9, { modelVersion: "an-older-model" }), { bootstrap: 20 });
  assert.equal(report.markets, 0);
  assert.equal(report.calibration, null);
  assert.match(report.reason, /other model versions were excluded/);
});

test("anchoring switches to fitted weights only for a usable calibration of the current model", () => {
  const market = marketWith(Date.now(), 0.8, 0.49, 0.51);
  const prior = anchoredFairUp(market)!;
  assert.ok(Math.abs(prior - anchorProbability(0.8, 0.5)) < 1e-12);
  const calibration: StackingCalibration = { version: 2, modelVersion: FORECAST_MODEL_VERSION, intercept: 0, modelCoefficient: 0.9, marketCoefficient: 0.8,
    modelCoefficientLower: 0.5, markets: 400, observations: 1600, fittedAt: 1, heldOutLogLoss: 0.6, heldOutMarketLogLoss: 0.65, heldOutMarkets: 120 };
  try {
    assert.ok(setActiveCalibration(calibration));
    assert.ok(Math.abs(anchoredFairUp(market)! - stackedProbability(0.8, 0.5, calibration)) < 1e-12);
    assert.ok(Math.abs(stackedProbability(0.8, 0.5, calibration) - sigmoid(0.9 * logit(0.8))) < 1e-9);
    assert.equal(setActiveCalibration({ ...calibration, modelCoefficientLower: -0.1 }), null);
    assert.ok(Math.abs(anchoredFairUp(market)! - prior) < 1e-12);
    assert.equal(isUsableCalibration({ ...calibration, markets: 50 }), false);
    assert.equal(isUsableCalibration({ ...calibration, modelVersion: "an-older-model" }), false, "weights from another model never arm this one");
    assert.equal(isUsableCalibration({ ...calibration, heldOutLogLoss: 0.7 }), false, "no weight without an out-of-sample win");
    assert.equal(isUsableCalibration({ ...calibration, version: 1 }), false);
  } finally {
    setActiveCalibration(null);
  }
});

test("the decision evidence report compares claimed with realized edge and only credits a positive lower bound", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    marketId: `d${index}`, at: index * 300_000, remainingSeconds: 150, rawModelUp: 0.6, marketUp: 0.55, modelVersion: FORECAST_MODEL_VERSION,
    // Claims 5c of edge at a 55% fair value, but only wins half the time: cost 0.50 and realized ~0.
    decision: "UP" as const, signalEdge: 0.05, anchoredFairUp: 0.55, outcome: (index % 2 ? "UP" : "DOWN") as "UP" | "DOWN",
  }));
  const evidence = evaluateRecordedDecisions(rows, { bootstrap: 200 });
  assert.equal(evidence.entries, 200);
  assert.ok(Math.abs(evidence.meanClaimedEdge! - 0.05) < 1e-12);
  assert.ok(Math.abs(evidence.meanRealizedEdge! - 0) < 1e-9);
  assert.match(evidence.reason, /no demonstrated net-of-fee edge/);
});
