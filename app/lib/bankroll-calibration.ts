/**
 * Historical probability diagnostics. A resolved result is never available to
 * a prediction made before that market's resolution timestamp.
 */
export type CalibrationObservation = {
  marketId: string;
  observedAt: number;
  resolvedAt: number;
  fairUp: number;
  outcome: "UP" | "DOWN";
  modelVersion: string;
};

export type CalibrationBucket = {
  label: string;
  lower: number;
  upper: number;
  samples: number;
  meanPredictedWinRate: number | null;
  actualWinRate: number | null;
};

export type CalibrationPoint = {
  marketId: string;
  observedAt: number;
  rawProbabilityUp: number;
  adjustedProbabilityUp: number;
  calibrated: boolean;
  trainingSamples: number;
  bucketTrainingSamples: number;
  outcome: "UP" | "DOWN";
};

export type ProbabilityMetrics = {
  samples: number;
  brierScore: number | null;
  logLoss: number | null;
};

export type WalkForwardCalibration = {
  points: CalibrationPoint[];
  buckets: CalibrationBucket[];
  raw: ProbabilityMetrics;
  /** Only points whose adjustment was trained on already-resolved markets. */
  adjustedOutOfSample: ProbabilityMetrics;
  rejected: number;
  minimumTrainingSamples: number;
  minimumBucketSamples: number;
};

export const CALIBRATION_BUCKETS = [
  { label: "50–55%", lower: 0.5, upper: 0.55 },
  { label: "55–60%", lower: 0.55, upper: 0.60 },
  { label: "60–65%", lower: 0.60, upper: 0.65 },
  { label: "65–70%", lower: 0.65, upper: 0.70 },
  { label: "70–80%", lower: 0.70, upper: 0.80 },
  { label: "80%+", lower: 0.80, upper: 1.000001 },
] as const;

const bucketIndex = (confidence: number) => CALIBRATION_BUCKETS.findIndex((bucket) => confidence >= bucket.lower && confidence < bucket.upper);
const validProbability = (value: number) => Number.isFinite(value) && value > 0 && value < 1;
const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));

const probabilityMetrics = (points: Array<{ probabilityUp: number; outcome: "UP" | "DOWN" }>): ProbabilityMetrics => {
  if (!points.length) return { samples: 0, brierScore: null, logLoss: null };
  let brier = 0;
  let logLoss = 0;
  for (const point of points) {
    const truth = point.outcome === "UP" ? 1 : 0;
    const p = clamp(point.probabilityUp, 1e-6, 1 - 1e-6);
    brier += (p - truth) ** 2;
    logLoss -= truth ? Math.log(p) : Math.log(1 - p);
  }
  return { samples: points.length, brierScore: brier / points.length, logLoss: logLoss / points.length };
};

/**
 * Report historical calibration by confidence bucket. Adjustments are a
 * conservative shrinkage estimate that is unavailable until both the entire
 * training pool and the matching bucket have enough *previously resolved*
 * markets. Results are never tuned against the current outcome.
 */
export const walkForwardCalibration = (
  observations: CalibrationObservation[],
  options: { modelVersion: string; minimumTrainingSamples?: number; minimumBucketSamples?: number; priorStrength?: number },
): WalkForwardCalibration => {
  const minimumTrainingSamples = Number.isFinite(options.minimumTrainingSamples)
    ? Math.max(1, Math.floor(options.minimumTrainingSamples!)) : 200;
  const minimumBucketSamples = Number.isFinite(options.minimumBucketSamples)
    ? Math.max(1, Math.floor(options.minimumBucketSamples!)) : 30;
  const priorStrength = Number.isFinite(options.priorStrength) ? Math.max(0, options.priorStrength!) : 40;
  const seen = new Set<string>();
  let rejected = 0;
  const eligible = observations.slice().sort((left, right) => left.observedAt - right.observedAt || left.marketId.localeCompare(right.marketId)).filter((row) => {
    const valid = row.modelVersion === options.modelVersion
      && Boolean(row.marketId) && Number.isFinite(row.observedAt) && Number.isFinite(row.resolvedAt)
      && row.resolvedAt > row.observedAt && validProbability(row.fairUp)
      && (row.outcome === "UP" || row.outcome === "DOWN");
    if (!valid) { rejected += 1; return false; }
    const key = `${row.modelVersion}:${row.marketId}`;
    if (seen.has(key)) { rejected += 1; return false; }
    seen.add(key);
    return true;
  });

  const resolvedOrder = [...eligible].sort((left, right) => left.resolvedAt - right.resolvedAt);
  const training: CalibrationObservation[][] = CALIBRATION_BUCKETS.map(() => []);
  const points: CalibrationPoint[] = [];
  let resolvedCursor = 0;
  let totalTrainingSamples = 0;
  for (const row of eligible) {
    while (resolvedCursor < resolvedOrder.length && resolvedOrder[resolvedCursor].resolvedAt < row.observedAt) {
      const prior = resolvedOrder[resolvedCursor++];
      const confidence = Math.max(prior.fairUp, 1 - prior.fairUp);
      const index = bucketIndex(confidence);
      if (index >= 0) { training[index].push(prior); totalTrainingSamples += 1; }
    }
    const isUp = row.fairUp >= 0.5;
    const confidence = Math.max(row.fairUp, 1 - row.fairUp);
    const index = bucketIndex(confidence);
    const bucket = index >= 0 ? training[index] : [];
    const calibrated = totalTrainingSamples >= minimumTrainingSamples && bucket.length >= minimumBucketSamples;
    const wins = bucket.reduce((sum, prior) => sum + ((prior.fairUp >= 0.5 ? "UP" : "DOWN") === prior.outcome ? 1 : 0), 0);
    const meanTrainingConfidence = bucket.length
      ? bucket.reduce((sum, prior) => sum + Math.max(prior.fairUp, 1 - prior.fairUp), 0) / bucket.length
      : confidence;
    const adjustedConfidence = calibrated
      ? clamp((wins + priorStrength * meanTrainingConfidence) / (bucket.length + priorStrength), 0.01, 0.99)
      : confidence;
    points.push({
      marketId: row.marketId,
      observedAt: row.observedAt,
      rawProbabilityUp: row.fairUp,
      adjustedProbabilityUp: isUp ? adjustedConfidence : 1 - adjustedConfidence,
      calibrated,
      trainingSamples: totalTrainingSamples,
      bucketTrainingSamples: bucket.length,
      outcome: row.outcome,
    });
  }

  const buckets = CALIBRATION_BUCKETS.map((bucket, index): CalibrationBucket => {
    const members = eligible.filter((row) => bucketIndex(Math.max(row.fairUp, 1 - row.fairUp)) === index);
    return {
      ...bucket,
      samples: members.length,
      meanPredictedWinRate: members.length ? members.reduce((sum, row) => sum + Math.max(row.fairUp, 1 - row.fairUp), 0) / members.length : null,
      actualWinRate: members.length ? members.reduce((sum, row) => sum + ((row.fairUp >= 0.5 ? "UP" : "DOWN") === row.outcome ? 1 : 0), 0) / members.length : null,
    };
  });
  return {
    points,
    buckets,
    raw: probabilityMetrics(points.map((point) => ({ probabilityUp: point.rawProbabilityUp, outcome: point.outcome }))),
    adjustedOutOfSample: probabilityMetrics(points.filter((point) => point.calibrated).map((point) => ({ probabilityUp: point.adjustedProbabilityUp, outcome: point.outcome }))),
    rejected,
    minimumTrainingSamples,
    minimumBucketSamples,
  };
};
