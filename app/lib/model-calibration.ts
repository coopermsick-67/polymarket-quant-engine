import { FORECAST_MODEL_VERSION, MIN_CALIBRATION_MARKETS, type StackingCalibration } from "./polymarket-data";

/** One recorded decision-time snapshot; `outcome` is filled in after settlement. */
export type CalibrationObservation = {
  marketId: string;
  at: number;
  /** FORECAST_MODEL_VERSION that produced rawModelUp; rows from other versions are never mixed into a fit. */
  modelVersion?: string;
  duration?: "5m" | "15m";
  remainingSeconds: number;
  rawModelUp: number;
  marketUp: number;
  upTokenId?: string;
  downTokenId?: string;
  outcome?: "UP" | "DOWN" | null;
};

export type CalibrationFitReport = {
  calibration: StackingCalibration | null;
  markets: number;
  observations: number;
  intercept: number | null;
  modelCoefficient: number | null;
  marketCoefficient: number | null;
  modelCoefficientLower: number | null;
  modelCoefficientUpper: number | null;
  /** Market-weighted log loss of the fit and of the book mid alone. */
  logLoss: number | null;
  marketOnlyLogLoss: number | null;
  /** Chronological holdout (the most recent markets), evaluated with weights fitted on earlier markets only. */
  heldOutMarkets: number;
  heldOutLogLoss: number | null;
  heldOutMarketLogLoss: number | null;
  /** Holdout diagnostics by horizon and entry phase; informational, not a gate. */
  diagnostics: Array<{ segment: string; markets: number; logLoss: number | null; marketOnlyLogLoss: number | null }>;
  modelVersion: string;
  reason: string;
};

/** Share of markets, by time, held out for the out-of-sample check. */
export const HOLDOUT_FRACTION = 0.3;
/** Bootstrap blocks: markets whose first observation falls in the same hour share one draw (common shocks). */
const BOOTSTRAP_BLOCK_MS = 60 * 60_000;

const PROBABILITY_FLOOR = 0.01;
const logit = (probability: number) => {
  const bounded = Math.min(1 - PROBABILITY_FLOOR, Math.max(PROBABILITY_FLOOR, probability));
  return Math.log(bounded / (1 - bounded));
};
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

type Row = { x: [number, number, number]; y: 0 | 1; weight: number; marketId: string };

/** Solve a 3x3 linear system by Gaussian elimination with partial pivoting. */
const solve3 = (matrix: number[][], vector: number[]): number[] | null => {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-12) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = a[row][column] / a[column][column];
      for (let k = column; k < 4; k += 1) a[row][k] -= factor * a[column][k];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
};

/** Weighted logistic regression by iteratively reweighted least squares, with a tiny ridge for stability. */
export const fitWeightedLogistic = (rows: readonly Row[], iterations = 50): [number, number, number] | null => {
  if (!rows.length) return null;
  let beta: [number, number, number] = [0, 0, 1];
  const ridge = 1e-6;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const hessian = [[ridge, 0, 0], [0, ridge, 0], [0, 0, ridge]];
    const gradient = [0, 0, 0];
    for (const row of rows) {
      const p = sigmoid(row.x[0] * beta[0] + row.x[1] * beta[1] + row.x[2] * beta[2]);
      const w = row.weight * Math.max(1e-9, p * (1 - p));
      for (let i = 0; i < 3; i += 1) {
        gradient[i] += row.weight * (row.y - p) * row.x[i];
        for (let j = 0; j < 3; j += 1) hessian[i][j] += w * row.x[i] * row.x[j];
      }
    }
    for (let i = 0; i < 3; i += 1) gradient[i] -= ridge * beta[i];
    const step = solve3(hessian, gradient);
    if (!step || step.some((value) => !Number.isFinite(value))) return null;
    beta = [beta[0] + step[0], beta[1] + step[1], beta[2] + step[2]];
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return beta.every(Number.isFinite) ? beta : null;
};

const weightedLogLoss = (rows: readonly Row[], probability: (row: Row) => number) => {
  let loss = 0;
  let weight = 0;
  for (const row of rows) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, probability(row)));
    loss -= row.weight * (row.y ? Math.log(p) : Math.log(1 - p));
    weight += row.weight;
  }
  return weight > 0 ? loss / weight : null;
};

/** Deterministic PRNG so a refit on the same data gives the same interval. */
const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

/**
 * Fit logit P(UP) = a + b_model * logit(model) + b_market * logit(mid) on
 * settled observations of one model version.
 *
 * Validation is chronological: markets are ordered by their first observation,
 * the weights are fitted on the earlier 70% only, and the most recent 30% are
 * held out. The interval for b_model resamples whole time blocks (hours), so
 * markets hit by the same move are not treated as independent. A fit is usable
 * only when there are enough markets, b_model's lower 95% bound is above zero,
 * and on the holdout it beats the book mid alone. Each market carries a total
 * weight of one however many snapshots it contributed.
 */
export const fitStackingCalibration = (
  observations: readonly CalibrationObservation[],
  options: { bootstrap?: number; seed?: number; minMarkets?: number; now?: number; modelVersion?: string } = {},
): CalibrationFitReport => {
  const minMarkets = options.minMarkets ?? MIN_CALIBRATION_MARKETS;
  const modelVersion = options.modelVersion ?? FORECAST_MODEL_VERSION;
  const settled = observations.filter((row) => row.modelVersion === modelVersion
    && (row.outcome === "UP" || row.outcome === "DOWN")
    && Number.isFinite(row.rawModelUp) && Number.isFinite(row.marketUp) && Number.isFinite(row.at)
    && row.rawModelUp > 0 && row.rawModelUp < 1 && row.marketUp > 0 && row.marketUp < 1);
  const firstSeen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of settled) {
    counts.set(row.marketId, (counts.get(row.marketId) ?? 0) + 1);
    firstSeen.set(row.marketId, Math.min(firstSeen.get(row.marketId) ?? Number.POSITIVE_INFINITY, row.at));
  }
  const toRow = (row: CalibrationObservation): Row => ({
    x: [1, logit(row.rawModelUp), logit(row.marketUp)],
    y: row.outcome === "UP" ? 1 : 0,
    weight: 1 / (counts.get(row.marketId) ?? 1),
    marketId: row.marketId,
  });
  const empty: CalibrationFitReport = {
    calibration: null, markets: counts.size, observations: settled.length, intercept: null, modelCoefficient: null,
    marketCoefficient: null, modelCoefficientLower: null, modelCoefficientUpper: null, logLoss: null, marketOnlyLogLoss: null,
    heldOutMarkets: 0, heldOutLogLoss: null, heldOutMarketLogLoss: null, diagnostics: [], modelVersion, reason: "",
  };
  const excluded = observations.length - observations.filter((row) => row.modelVersion === modelVersion).length;
  const excludedNote = excluded ? ` ${excluded} observations from other model versions were excluded.` : "";
  if (counts.size < minMarkets) {
    return { ...empty, reason: `Only ${counts.size} settled markets for model ${modelVersion}; at least ${minMarkets} are needed before the model weight can be fitted.${excludedNote}` };
  }
  const chronological = [...firstSeen.entries()].sort((left, right) => left[1] - right[1]).map(([marketId]) => marketId);
  const holdoutCount = Math.max(1, Math.floor(chronological.length * HOLDOUT_FRACTION));
  const trainMarkets = new Set(chronological.slice(0, chronological.length - holdoutCount));
  const trainRows = settled.filter((row) => trainMarkets.has(row.marketId)).map(toRow);
  const holdoutObservations = settled.filter((row) => !trainMarkets.has(row.marketId));
  const holdoutRows = holdoutObservations.map(toRow);
  const beta = fitWeightedLogistic(trainRows);
  if (!beta) return { ...empty, reason: "The stacking regression did not converge." };

  const blockOf = (marketId: string) => Math.floor((firstSeen.get(marketId) ?? 0) / BOOTSTRAP_BLOCK_MS);
  const byBlock = new Map<number, Row[]>();
  for (const row of trainRows) byBlock.set(blockOf(row.marketId), [...(byBlock.get(blockOf(row.marketId)) ?? []), row]);
  const blocks = [...byBlock.keys()];
  const random = mulberry32(options.seed ?? 20260925);
  const draws: number[] = [];
  for (let draw = 0; draw < (options.bootstrap ?? 200); draw += 1) {
    const sample: Row[] = [];
    for (let index = 0; index < blocks.length; index += 1) sample.push(...byBlock.get(blocks[Math.floor(random() * blocks.length)])!);
    const fitted = fitWeightedLogistic(sample, 25);
    if (fitted) draws.push(fitted[1]);
  }
  const lower = quantile(draws, 0.025);
  const upper = quantile(draws, 0.975);
  const fitted = (row: Row) => sigmoid(row.x[0] * beta[0] + row.x[1] * beta[1] + row.x[2] * beta[2]);
  const bookOnly = (row: Row) => sigmoid(row.x[2]);
  const heldOutLogLoss = weightedLogLoss(holdoutRows, fitted);
  const heldOutMarketLogLoss = weightedLogLoss(holdoutRows, bookOnly);
  const segment = (label: string, keep: (row: CalibrationObservation) => boolean) => {
    const segmentRows = holdoutObservations.filter(keep).map(toRow);
    return { segment: label, markets: new Set(segmentRows.map((row) => row.marketId)).size,
      logLoss: weightedLogLoss(segmentRows, fitted), marketOnlyLogLoss: weightedLogLoss(segmentRows, bookOnly) };
  };
  const diagnostics = [
    segment("5m", (row) => row.duration === "5m"),
    segment("15m", (row) => row.duration === "15m"),
    segment("more than 60 s left", (row) => row.remainingSeconds > 60),
    segment("60 s or less left", (row) => row.remainingSeconds <= 60),
  ];
  const report: CalibrationFitReport = {
    ...empty,
    intercept: beta[0], modelCoefficient: beta[1], marketCoefficient: beta[2],
    modelCoefficientLower: lower, modelCoefficientUpper: upper,
    logLoss: weightedLogLoss(trainRows, fitted), marketOnlyLogLoss: weightedLogLoss(trainRows, bookOnly),
    heldOutMarkets: holdoutCount, heldOutLogLoss, heldOutMarketLogLoss, diagnostics,
  };
  if (lower === null || lower <= 0) {
    return { ...report, reason: `The model coefficient's lower 95% bound (time-block bootstrap) is not above zero, so the model adds no demonstrated information to the book. Keep the conservative prior.${excludedNote}` };
  }
  if (beta[2] <= 0) return { ...report, reason: "The fitted market coefficient is not positive; the fit is not trustworthy." };
  if (heldOutLogLoss === null || heldOutMarketLogLoss === null || heldOutLogLoss >= heldOutMarketLogLoss) {
    return { ...report, reason: `On the ${holdoutCount} most recent markets the fit does not beat the book mid alone out of sample. Keep the conservative prior.${excludedNote}` };
  }
  return {
    ...report,
    calibration: {
      version: 2, modelVersion, intercept: beta[0], modelCoefficient: beta[1], marketCoefficient: beta[2], modelCoefficientLower: lower,
      markets: counts.size, observations: settled.length, fittedAt: options.now ?? Date.now(),
      heldOutLogLoss, heldOutMarketLogLoss, heldOutMarkets: holdoutCount,
    },
    reason: `The model adds information to the book and beats it on the chronological holdout; fitted stacking weights are usable. A better log loss is not proof of a net-of-fee trading edge.${excludedNote}`,
  };
};

/** A recorded engine decision with its settled outcome, for the evidence report. */
export type DecisionObservation = CalibrationObservation & {
  decision?: "UP" | "DOWN" | "PASS" | null;
  signalEdge?: number | null;
  anchoredFairUp?: number | null;
};

export type DecisionEvidence = {
  entries: number;
  meanClaimedEdge: number | null;
  meanRealizedEdge: number | null;
  realizedLower: number | null;
  realizedUpper: number | null;
  reason: string;
};

/**
 * Candidate-level evidence: for each settled market, the first recorded UP/DOWN
 * decision's claimed net edge per share against what settlement paid
 * (win - all-in cost, where cost = side fair - claimed edge). The interval
 * resamples hour blocks. Only this, over many markets, can support a claim of
 * a net-of-fee edge; a calibration fit cannot.
 */
export const evaluateRecordedDecisions = (
  observations: readonly DecisionObservation[],
  options: { bootstrap?: number; seed?: number; modelVersion?: string } = {},
): DecisionEvidence => {
  const modelVersion = options.modelVersion ?? FORECAST_MODEL_VERSION;
  const firstEntry = new Map<string, DecisionObservation>();
  for (const row of [...observations].sort((left, right) => left.at - right.at)) {
    if (row.modelVersion !== modelVersion || (row.decision !== "UP" && row.decision !== "DOWN")) continue;
    if (row.outcome !== "UP" && row.outcome !== "DOWN") continue;
    if (!Number.isFinite(row.signalEdge) || !Number.isFinite(row.anchoredFairUp)) continue;
    if (!firstEntry.has(row.marketId)) firstEntry.set(row.marketId, row);
  }
  const entries = [...firstEntry.values()].map((row) => {
    const sideFair = row.decision === "UP" ? row.anchoredFairUp! : 1 - row.anchoredFairUp!;
    const cost = sideFair - row.signalEdge!;
    const won = row.decision === row.outcome ? 1 : 0;
    return { block: Math.floor(row.at / BOOTSTRAP_BLOCK_MS), claimed: row.signalEdge!, realized: won - cost };
  });
  if (!entries.length) {
    return { entries: 0, meanClaimedEdge: null, meanRealizedEdge: null, realizedLower: null, realizedUpper: null,
      reason: "No settled entry decisions recorded yet for this model version." };
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const byBlock = new Map<number, number[]>();
  for (const entry of entries) byBlock.set(entry.block, [...(byBlock.get(entry.block) ?? []), entry.realized]);
  const blocks = [...byBlock.values()];
  const random = mulberry32(options.seed ?? 20260925);
  const draws: number[] = [];
  for (let draw = 0; draw < (options.bootstrap ?? 500); draw += 1) {
    const sample: number[] = [];
    for (let index = 0; index < blocks.length; index += 1) sample.push(...blocks[Math.floor(random() * blocks.length)]);
    draws.push(mean(sample));
  }
  const realizedLower = quantile(draws, 0.025);
  const realizedUpper = quantile(draws, 0.975);
  const meanRealizedEdge = mean(entries.map((entry) => entry.realized));
  return {
    entries: entries.length,
    meanClaimedEdge: mean(entries.map((entry) => entry.claimed)),
    meanRealizedEdge,
    realizedLower,
    realizedUpper,
    reason: realizedLower !== null && realizedLower > 0
      ? "The realized edge's lower 95% bound is above zero on these entries."
      : "The realized edge is not distinguishable from zero or negative; there is no demonstrated net-of-fee edge.",
  };
};
