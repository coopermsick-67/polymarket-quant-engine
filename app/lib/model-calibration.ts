import { MIN_CALIBRATION_MARKETS, type StackingCalibration } from "./polymarket-data";

/** One recorded decision-time snapshot; `outcome` is filled in after settlement. */
export type CalibrationObservation = {
  marketId: string;
  at: number;
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
  reason: string;
};

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
 * settled observations. Each market carries a total weight of one, however
 * many snapshots it contributed, and the interval for b_model resamples whole
 * markets. The fit is only returned as usable when there are enough markets
 * and the lower 95% bound of b_model is above zero, that is, when the model
 * demonstrably adds information to the order book.
 */
export const fitStackingCalibration = (
  observations: readonly CalibrationObservation[],
  options: { bootstrap?: number; seed?: number; minMarkets?: number; now?: number } = {},
): CalibrationFitReport => {
  const minMarkets = options.minMarkets ?? MIN_CALIBRATION_MARKETS;
  const settled = observations.filter((row) => (row.outcome === "UP" || row.outcome === "DOWN")
    && Number.isFinite(row.rawModelUp) && Number.isFinite(row.marketUp)
    && row.rawModelUp > 0 && row.rawModelUp < 1 && row.marketUp > 0 && row.marketUp < 1);
  const counts = new Map<string, number>();
  for (const row of settled) counts.set(row.marketId, (counts.get(row.marketId) ?? 0) + 1);
  const rows: Row[] = settled.map((row) => ({
    x: [1, logit(row.rawModelUp), logit(row.marketUp)],
    y: row.outcome === "UP" ? 1 : 0,
    weight: 1 / (counts.get(row.marketId) ?? 1),
    marketId: row.marketId,
  }));
  const empty: CalibrationFitReport = {
    calibration: null, markets: counts.size, observations: rows.length, intercept: null, modelCoefficient: null,
    marketCoefficient: null, modelCoefficientLower: null, modelCoefficientUpper: null, logLoss: null, marketOnlyLogLoss: null,
    reason: "",
  };
  if (counts.size < minMarkets) {
    return { ...empty, reason: `Only ${counts.size} settled markets; at least ${minMarkets} are needed before the model weight can be fitted.` };
  }
  const beta = fitWeightedLogistic(rows);
  if (!beta) return { ...empty, reason: "The stacking regression did not converge." };

  const byMarket = new Map<string, Row[]>();
  for (const row of rows) byMarket.set(row.marketId, [...(byMarket.get(row.marketId) ?? []), row]);
  const marketIds = [...byMarket.keys()];
  const random = mulberry32(options.seed ?? 20260925);
  const draws: number[] = [];
  for (let draw = 0; draw < (options.bootstrap ?? 200); draw += 1) {
    const sample: Row[] = [];
    for (let index = 0; index < marketIds.length; index += 1) {
      sample.push(...byMarket.get(marketIds[Math.floor(random() * marketIds.length)])!);
    }
    const fitted = fitWeightedLogistic(sample, 25);
    if (fitted) draws.push(fitted[1]);
  }
  const lower = quantile(draws, 0.025);
  const upper = quantile(draws, 0.975);
  const logLoss = weightedLogLoss(rows, (row) => sigmoid(row.x[0] * beta[0] + row.x[1] * beta[1] + row.x[2] * beta[2]));
  const marketOnlyLogLoss = weightedLogLoss(rows, (row) => sigmoid(row.x[2]));
  const report = {
    ...empty,
    intercept: beta[0], modelCoefficient: beta[1], marketCoefficient: beta[2],
    modelCoefficientLower: lower, modelCoefficientUpper: upper, logLoss, marketOnlyLogLoss,
  };
  if (lower === null || lower <= 0) {
    return { ...report, reason: "The model coefficient's lower 95% bound is not above zero, so the model adds no demonstrated information to the book. Keep the conservative prior." };
  }
  if (beta[2] <= 0) return { ...report, reason: "The fitted market coefficient is not positive; the fit is not trustworthy." };
  return {
    ...report,
    calibration: {
      version: 1, intercept: beta[0], modelCoefficient: beta[1], marketCoefficient: beta[2], modelCoefficientLower: lower,
      markets: counts.size, observations: rows.length, fittedAt: options.now ?? Date.now(),
    },
    reason: "The model adds information to the book; fitted stacking weights are usable.",
  };
};
