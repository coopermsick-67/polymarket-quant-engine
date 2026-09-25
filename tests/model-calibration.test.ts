import assert from "node:assert/strict";
import test from "node:test";
import { fitStackingCalibration, type CalibrationObservation } from "../app/lib/model-calibration";
import { anchoredFairUp, anchorProbability, isUsableCalibration, setActiveCalibration, stackedProbability } from "../app/lib/polymarket-data";
import { marketWith } from "./market-fixture";

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Deterministic synthetic markets: the book is noisy, and the model carries `modelSignal` of the true log-odds. */
const synthetic = (markets: number, modelSignal: number, seed = 7): CalibrationObservation[] => {
  let state = seed;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
  const rows: CalibrationObservation[] = [];
  for (let market = 0; market < markets; market += 1) {
    const truth = normal() * 1.5;
    const marketLogit = 0.6 * truth + normal() * 0.6;
    const modelLogit = modelSignal * truth + (1 - modelSignal) * normal();
    const outcome = random() < sigmoid(truth) ? "UP" : "DOWN";
    for (let snapshot = 0; snapshot < 4; snapshot += 1) {
      rows.push({ marketId: `m${market}`, at: snapshot, remainingSeconds: 200 - snapshot * 30,
        rawModelUp: sigmoid(modelLogit + normal() * 0.05), marketUp: sigmoid(marketLogit + normal() * 0.05), outcome });
    }
  }
  return rows;
};

test("an informative model earns a fitted weight with a positive clustered lower bound", () => {
  const report = fitStackingCalibration(synthetic(600, 0.9), { bootstrap: 60 });
  assert.ok(report.calibration, report.reason);
  assert.ok(report.modelCoefficientLower! > 0);
  assert.ok(report.logLoss! < report.marketOnlyLogLoss!);
});

test("a model that adds nothing to the book is not given weight", () => {
  const report = fitStackingCalibration(synthetic(600, 0), { bootstrap: 60 });
  assert.equal(report.calibration, null);
  assert.match(report.reason, /adds no demonstrated information/);
});

test("fewer than 300 settled markets never produce a usable fit", () => {
  const report = fitStackingCalibration(synthetic(120, 0.9), { bootstrap: 20 });
  assert.equal(report.calibration, null);
  assert.match(report.reason, /at least 300/);
});

test("anchoring switches from the prior to fitted weights only for a usable calibration", () => {
  const market = marketWith(Date.now(), 0.8, 0.49, 0.51);
  const prior = anchoredFairUp(market)!;
  assert.ok(Math.abs(prior - anchorProbability(0.8, 0.5)) < 1e-12);
  const calibration = { version: 1 as const, intercept: 0, modelCoefficient: 0.9, marketCoefficient: 0.8, modelCoefficientLower: 0.5, markets: 400, observations: 1600, fittedAt: 1 };
  try {
    assert.ok(setActiveCalibration(calibration));
    assert.ok(Math.abs(anchoredFairUp(market)! - stackedProbability(0.8, 0.5, calibration)) < 1e-12);
    assert.ok(Math.abs(stackedProbability(0.8, 0.5, calibration) - sigmoid(0.9 * logit(0.8))) < 1e-9);
    assert.equal(setActiveCalibration({ ...calibration, modelCoefficientLower: -0.1 }), null);
    assert.ok(Math.abs(anchoredFairUp(market)! - prior) < 1e-12);
    assert.equal(isUsableCalibration({ ...calibration, markets: 50 }), false);
  } finally {
    setActiveCalibration(null);
  }
});
