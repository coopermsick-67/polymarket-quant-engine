import type { CalibrationRow, ReplayTrade, WalkForwardFold } from "./replay";

export type ConfidenceInterval = { estimate: number | null; lower: number | null; upper: number | null; clusters: number; samples: number };
export type ReliabilityPoint = { from: number; to: number; n: number; predicted: number | null; observed: number | null };
export type EvidenceGate = { status: "PASS" | "FAIL" | "NOT_MEASURED"; result: string };

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const loss = (probability: number, outcome: 0 | 1) => {
  const p = Math.max(1e-4, Math.min(1 - 1e-4, probability));
  return -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
};

const quantile = (sorted: number[], fraction: number) => {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

const seededRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Percentile bootstrap that resamples whole markets, preserving within-market dependence. */
export const clusteredBootstrapMean = <T>(
  rows: T[],
  cluster: (row: T) => string,
  value: (row: T) => number,
  options: { repetitions?: number; seed?: number } = {},
): ConfidenceInterval => {
  const usable = rows.filter((row) => Number.isFinite(value(row)) && cluster(row).length > 0);
  const groups = new Map<string, T[]>();
  for (const row of usable) groups.set(cluster(row), [...(groups.get(cluster(row)) ?? []), row]);
  const estimate = mean(usable.map(value));
  if (estimate === null || groups.size < 2) {
    return {
      estimate,
      lower: null,
      upper: null,
      clusters: groups.size,
      samples: usable.length,
    };
  }

  const clusters = [...groups.values()];
  const repetitions = Math.max(500, Math.floor(options.repetitions ?? 2_000));
  const random = seededRandom(options.seed ?? 0x504f4c59);
  const estimates: number[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let total = 0;
    let count = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const sampled = clusters[Math.floor(random() * clusters.length)];
      for (const row of sampled) {
        total += value(row);
        count += 1;
      }
    }
    if (count) estimates.push(total / count);
  }
  estimates.sort((left, right) => left - right);
  return {
    estimate,
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975),
    clusters: groups.size,
    samples: usable.length,
  };
};

const reliability = (rows: { p: number; y: 0 | 1 }[], bins = 10): ReliabilityPoint[] =>
  Array.from({ length: bins }, (_, index) => {
    const from = index / bins;
    const to = (index + 1) / bins;
    const values = rows.filter((row) => row.p >= from && (index === bins - 1 ? row.p <= to : row.p < to));
    return {
      from,
      to,
      n: values.length,
      predicted: mean(values.map((row) => row.p)),
      observed: mean(values.map((row) => row.y)),
    };
  });

const realizedEdge = (trade: ReplayTrade) => (trade.outcome === trade.side ? 1 : 0) - trade.costPerShare;
const weekLabel = (timestamp: number) => {
  const start = new Date(timestamp);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start.toISOString().slice(0, 10);
};

export type EvidenceReport = {
  generatedAt: string;
  sample: { recordedDays: number; recordedMarkets: number; resolvedMarkets: number; outOfSampleDays: number; outOfSampleResolvedMarkets: number };
  calibration: {
    checkpoints: number;
    posteriorBrier: number | null;
    bookBrier: number | null;
    brierDifferencePosteriorMinusBook: ConfidenceInterval;
    posteriorLogLoss: number | null;
    bookLogLoss: number | null;
    logLossDifferencePosteriorMinusBook: ConfidenceInterval;
    posteriorReliability: ReliabilityPoint[];
    bookReliability: ReliabilityPoint[];
  };
  trading: {
    outOfSampleTrades: number;
    realizedEdge: ConfidenceInterval;
    netPnl: number;
    meanMarkout5s: number | null;
    markout5sSamples: number;
    meanMarkout30s: number | null;
    markout30sSamples: number;
    weeklyFolds: { week: string; trades: number; realizedEdge: number | null; positive: boolean }[];
    positiveLastFourFolds: number;
  };
  gates: { G1: EvidenceGate; G2: EvidenceGate; G3: EvidenceGate; G4: EvidenceGate; G5: EvidenceGate; G6: EvidenceGate };
};

export const buildEvidenceReport = (input: {
  snapshots: { marketId: string; startTime: number }[];
  outcomes: Map<string, string>;
  folds: WalkForwardFold[];
  generatedAt?: Date;
  bootstrapRepetitions?: number;
}): EvidenceReport => {
  const tested = input.folds.filter((fold): fold is WalkForwardFold & { test: NonNullable<WalkForwardFold["test"]> } => fold.test !== null);
  const calibrationRows: CalibrationRow[] = tested.flatMap((fold) => fold.test.calibrationRows);
  const allTrades = tested.flatMap((fold) => fold.test.trades);
  const trades = allTrades.filter((trade) => trade.outcome !== null && trade.pnl !== null);
  const posteriorRows = calibrationRows.map((row) => ({ marketId: row.marketId, p: row.posterior, y: row.outcome }));
  const bookRows = calibrationRows.map((row) => ({ marketId: row.marketId, p: row.market, y: row.outcome }));
  const brierDifference = calibrationRows.map((row) => ({
    marketId: row.marketId,
    value: (row.posterior - row.outcome) ** 2 - (row.market - row.outcome) ** 2,
  }));
  const logLossDifference = calibrationRows.map((row) => ({
    marketId: row.marketId,
    value: loss(row.posterior, row.outcome) - loss(row.market, row.outcome),
  }));
  const edgeRows = trades.map((trade) => ({ marketId: trade.marketId, edge: realizedEdge(trade), trade }));
  const testedSnapshots = input.snapshots.filter((snapshot) =>
    tested.some((fold) => new Date(snapshot.startTime).toISOString().slice(0, 10) === new Date(fold.dayStart).toISOString().slice(0, 10)),
  );
  const recordedDays = new Set(input.snapshots.map((snapshot) => new Date(snapshot.startTime).toISOString().slice(0, 10)));
  const recordedMarkets = new Set(input.snapshots.map((snapshot) => snapshot.marketId));
  const resolvedMarkets = [...recordedMarkets].filter((marketId) => input.outcomes.has(marketId)).length;
  const outOfSampleDays = new Set(testedSnapshots.map((snapshot) => new Date(snapshot.startTime).toISOString().slice(0, 10))).size;
  const outOfSampleResolvedMarkets = new Set(testedSnapshots.map((snapshot) => snapshot.marketId).filter((marketId) => input.outcomes.has(marketId))).size;
  const byWeek = new Map<string, ReplayTrade[]>();
  for (const fold of tested) {
    for (const trade of fold.test.trades) {
      if (trade.outcome === null || trade.pnl === null) continue;
      const week = weekLabel(trade.filledAt);
      byWeek.set(week, [...(byWeek.get(week) ?? []), trade]);
    }
  }
  const weeklyFolds = [...byWeek.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([week, foldTrades]) => {
      const edge = mean(foldTrades.map(realizedEdge));
      return { week, trades: foldTrades.length, realizedEdge: edge, positive: edge !== null && edge > 0 };
    });
  const lastFour = weeklyFolds.slice(-4);
  const positiveLastFourFolds = lastFour.filter((fold) => fold.positive).length;
  const brierDifferencePosteriorMinusBook = clusteredBootstrapMean(
    brierDifference,
    (row) => row.marketId,
    (row) => row.value,
    { repetitions: input.bootstrapRepetitions, seed: 0x47314252 },
  );
  const logLossDifferencePosteriorMinusBook = clusteredBootstrapMean(
    logLossDifference,
    (row) => row.marketId,
    (row) => row.value,
    { repetitions: input.bootstrapRepetitions, seed: 0x47314c4c },
  );
  const realizedEdgeCi = clusteredBootstrapMean(
    edgeRows,
    (row) => row.marketId,
    (row) => row.edge,
    { repetitions: input.bootstrapRepetitions, seed: 0x47324544 },
  );
  const daysPass = outOfSampleDays >= 7 && outOfSampleResolvedMarkets >= 3_000;
  const g1Pass =
    daysPass &&
    brierDifferencePosteriorMinusBook.upper !== null &&
    brierDifferencePosteriorMinusBook.upper < 0 &&
    logLossDifferencePosteriorMinusBook.upper !== null &&
    logLossDifferencePosteriorMinusBook.upper < 0;
  const g2Pass = trades.length >= 500 && realizedEdgeCi.lower !== null && realizedEdgeCi.lower > 0 && lastFour.length === 4 && positiveLastFourFolds >= 3;
  const markout5s = allTrades.map((trade) => trade.markout5s).filter((value): value is number => value !== null);
  const markout30s = allTrades.map((trade) => trade.markout30s).filter((value): value is number => value !== null);
  const meanMarkout5s = mean(markout5s);
  const meanMarkout30s = mean(markout30s);
  const g3Measured = markout5s.length > 0 && markout30s.length > 0;
  const g3Pass = g3Measured && meanMarkout5s !== null && meanMarkout5s >= 0 && meanMarkout30s !== null && meanMarkout30s >= 0;

  return {
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    sample: { recordedDays: recordedDays.size, recordedMarkets: recordedMarkets.size, resolvedMarkets, outOfSampleDays, outOfSampleResolvedMarkets },
    calibration: {
      checkpoints: calibrationRows.length,
      posteriorBrier: mean(posteriorRows.map((row) => (row.p - row.y) ** 2)),
      bookBrier: mean(bookRows.map((row) => (row.p - row.y) ** 2)),
      brierDifferencePosteriorMinusBook,
      posteriorLogLoss: mean(posteriorRows.map((row) => loss(row.p, row.y))),
      bookLogLoss: mean(bookRows.map((row) => loss(row.p, row.y))),
      logLossDifferencePosteriorMinusBook,
      posteriorReliability: reliability(posteriorRows),
      bookReliability: reliability(bookRows),
    },
    trading: {
      outOfSampleTrades: trades.length,
      realizedEdge: realizedEdgeCi,
      netPnl: trades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0),
      meanMarkout5s,
      markout5sSamples: markout5s.length,
      meanMarkout30s,
      markout30sSamples: markout30s.length,
      weeklyFolds,
      positiveLastFourFolds,
    },
    gates: {
      G1: {
        status: g1Pass ? "PASS" : recordedMarkets.size ? "FAIL" : "NOT_MEASURED",
        result: `${outOfSampleDays} out-of-sample days, ${outOfSampleResolvedMarkets} resolved markets; requires at least 7 days, 3,000 resolved markets, and both paired 95% CI upper bounds below zero.`,
      },
      G2: {
        status: g2Pass ? "PASS" : recordedMarkets.size ? "FAIL" : "NOT_MEASURED",
        result: `${trades.length} out-of-sample trades; realized edge 95% CI [${realizedEdgeCi.lower ?? "unavailable"}, ${realizedEdgeCi.upper ?? "unavailable"}]; ${positiveLastFourFolds}/4 positive latest weekly folds.`,
      },
      G3: {
        status: g3Pass ? "PASS" : g3Measured || recordedMarkets.size ? "FAIL" : "NOT_MEASURED",
        result: `5 s markout ${meanMarkout5s ?? "unavailable"} (${markout5s.length} fills); 30 s markout ${meanMarkout30s ?? "unavailable"} (${markout30s.length} fills); both must be non-negative.`,
      },
      G4: { status: "NOT_MEASURED", result: "Requires dry-run/canary comparison: fill-rate gap ≤10 percentage points and average fill price gap ≤$0.005." },
      G5: { status: "NOT_MEASURED", result: "Requires 100 canary orders and zero reconciliation mismatches, duplicates, or unresolved uncertain states." },
      G6: { status: "NOT_MEASURED", result: "Requires live canary tests of kill switch, dead-man switch, and daily-loss stop." },
    },
  };
};

const fmt = (value: number | null, digits = 4) => (value === null ? "unavailable" : value.toFixed(digits));
const interval = (ci: ConfidenceInterval) => (ci.lower === null || ci.upper === null ? "unavailable" : `[${fmt(ci.lower)}, ${fmt(ci.upper)}]`);

export const formatEvidenceReport = (report: EvidenceReport) => {
  const lines = [
    `# Nightly evidence report · ${report.generatedAt}`,
    "",
    `Recorded sample: ${report.sample.recordedDays} days · ${report.sample.recordedMarkets} markets · ${report.sample.resolvedMarkets} resolved markets. Walk-forward test: ${report.sample.outOfSampleDays} days · ${report.sample.outOfSampleResolvedMarkets} resolved markets.`,
    "",
    "## Forecast quality (daily expanding walk-forward test folds)",
    "",
    `Checkpoints: ${report.calibration.checkpoints}`,
    `Brier: posterior ${fmt(report.calibration.posteriorBrier)} · book ${fmt(report.calibration.bookBrier)} · posterior minus book CI ${interval(report.calibration.brierDifferencePosteriorMinusBook)}`,
    `Log-loss: posterior ${fmt(report.calibration.posteriorLogLoss)} · book ${fmt(report.calibration.bookLogLoss)} · posterior minus book CI ${interval(report.calibration.logLossDifferencePosteriorMinusBook)}`,
    "",
    "| Posterior probability | n | Mean predicted | Observed | Book mean predicted | Book observed |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.calibration.posteriorReliability.map((bin, index) => {
      const book = report.calibration.bookReliability[index];
      return `| ${bin.from.toFixed(1)}–${bin.to.toFixed(1)} | ${bin.n} | ${fmt(bin.predicted, 3)} | ${fmt(bin.observed, 3)} | ${fmt(book.predicted, 3)} | ${fmt(book.observed, 3)} |`;
    }),
    "",
    "## Trading and markouts",
    "",
    `Out-of-sample settled trades: ${report.trading.outOfSampleTrades} · net P&L $${report.trading.netPnl.toFixed(2)} · realized edge ${fmt(report.trading.realizedEdge.estimate)} · market-cluster bootstrap 95% CI ${interval(report.trading.realizedEdge)}`,
    `Markout 5 s: ${fmt(report.trading.meanMarkout5s)} (n=${report.trading.markout5sSamples}) · 30 s: ${fmt(report.trading.meanMarkout30s)} (n=${report.trading.markout30sSamples})`,
    "",
    "| Weekly test fold | Settled trades | Mean realized edge | Positive |",
    "| --- | ---: | ---: | ---: |",
    ...report.trading.weeklyFolds.map((fold) => `| ${fold.week} | ${fold.trades} | ${fmt(fold.realizedEdge)} | ${fold.positive ? "yes" : "no"} |`),
    "",
    "## Required gates",
    "",
    "| Gate | Status | Result |",
    "| --- | --- | --- |",
    ...Object.entries(report.gates).map(([gate, value]) => `| ${gate} | **${value.status}** | ${value.result} |`),
    "",
    "G1–G3 failures block promotion. G4–G6 are never inferred from paper data; they require dry-run or human-operated canary evidence.",
    "",
  ];
  return lines.join("\n");
};
