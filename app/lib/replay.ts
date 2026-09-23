// Event-level replay backtester. It runs the exact live decision function over
// recorded snapshots, fills orders only after an injected latency against the
// book that existed then (respecting the limit price and depth), settles on
// official outcomes, and reports calibration against the market, not just
// win rate.

import { clamp, mean, standardDeviation, wilsonInterval } from "./num";
import { DEFAULT_FEE_SCHEDULE } from "./pricing";
import { evaluateSignal, marketImpliedUp, normalizeSignalParams, simulateBuy, type MarketSnapshot, type Side, type SignalParams } from "./signal";

export type ReplayOptions = {
  params: Partial<SignalParams>;
  latencyMs: number;
  startingCash: number;
  stakeUsd: number;
  maxOpenExposurePct: number;
  checkpoints: number[];
};

export const DEFAULT_REPLAY_OPTIONS: ReplayOptions = {
  params: {},
  latencyMs: 750,
  startingCash: 1000,
  stakeUsd: 25,
  maxOpenExposurePct: 0.25,
  checkpoints: [240, 180, 120, 60, 30, 15],
};

export type ReplayTrade = {
  marketId: string;
  asset: string;
  duration: string;
  side: Side;
  decidedAt: number;
  filledAt: number;
  hourUtc: number;
  decisionCostPerShare: number;
  costPerShare: number;
  avgPrice: number;
  shares: number;
  totalCost: number;
  probability: number;
  marketProbability: number | null;
  predictedEdge: number;
  outcome: Side | null;
  pnl: number | null;
  markout5s: number | null;
  markout30s: number | null;
};

export type CalibrationRow = { marketId: string; checkpoint: number; model: number; posterior: number; market: number; outcome: 0 | 1 };

export type ScoreSet = { n: number; brier: number | null; logLoss: number | null };

export type ReliabilityBin = { from: number; to: number; n: number; predicted: number; observed: number };

export type ReplayReport = {
  snapshots: number;
  markets: number;
  signals: number;
  fills: number;
  fillRate: number | null;
  trades: ReplayTrade[];
  settled: number;
  wins: number;
  winRate: number | null;
  winRateCi: [number, number] | null;
  netPnl: number;
  evPerTrade: number | null;
  roiOnTurnover: number | null;
  avgPredictedEdge: number | null;
  avgRealizedEdge: number | null;
  avgSlippage: number | null;
  avgMarkout5s: number | null;
  avgMarkout30s: number | null;
  maxDrawdown: number;
  dailySharpe: number | null;
  equityCurve: { timestamp: number; equity: number }[];
  calibration: { model: ScoreSet; posterior: ScoreSet; market: ScoreSet; reliability: ReliabilityBin[]; rows: number };
  byAsset: Record<string, { trades: number; pnl: number }>;
  byDuration: Record<string, { trades: number; pnl: number }>;
  byHourUtc: Record<string, { trades: number; pnl: number }>;
  /** Trades needed to detect the observed edge at ~95% confidence (rough power estimate). */
  tradesNeededForSignificance: number | null;
};

const score = (rows: { p: number; y: 0 | 1 }[]): ScoreSet => {
  if (!rows.length) return { n: 0, brier: null, logLoss: null };
  const brier = mean(rows.map((row) => (row.p - row.y) ** 2));
  const logLoss = mean(
    rows.map((row) => {
      const p = clamp(row.p, 1e-4, 1 - 1e-4);
      return -(row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p));
    }),
  );
  return { n: rows.length, brier, logLoss };
};

const reliability = (rows: { p: number; y: 0 | 1 }[], bins = 10): ReliabilityBin[] =>
  Array.from({ length: bins }, (_, index) => {
    const from = index / bins;
    const to = (index + 1) / bins;
    const inBin = rows.filter((row) => row.p >= from && (index === bins - 1 ? row.p <= to : row.p < to));
    return {
      from,
      to,
      n: inBin.length,
      predicted: inBin.length ? mean(inBin.map((row) => row.p)) : 0,
      observed: inBin.length ? mean(inBin.map((row) => row.y)) : 0,
    };
  });

const sideMid = (snapshot: MarketSnapshot, side: Side) => {
  const book = side === "UP" ? snapshot.up : snapshot.down;
  const bid = book.bids.length ? Math.max(...book.bids.map((level) => level.price)) : null;
  const ask = book.asks.length ? Math.min(...book.asks.map((level) => level.price)) : null;
  return bid !== null && ask !== null ? (bid + ask) / 2 : null;
};

const bump = (bucket: Record<string, { trades: number; pnl: number }>, key: string, pnl: number) => {
  bucket[key] = bucket[key] ?? { trades: 0, pnl: 0 };
  bucket[key].trades += 1;
  bucket[key].pnl += pnl;
};

export const runReplay = (input: MarketSnapshot[], outcomes: Map<string, Side>, options: Partial<ReplayOptions> = {}): ReplayReport => {
  const config = { ...DEFAULT_REPLAY_OPTIONS, ...options };
  const snapshots = [...input].sort((left, right) => left.now - right.now);
  const byMarket = new Map<string, MarketSnapshot[]>();
  for (const snapshot of snapshots) {
    const list = byMarket.get(snapshot.marketId) ?? [];
    list.push(snapshot);
    byMarket.set(snapshot.marketId, list);
  }
  const nextAtOrAfter = (marketId: string, timestamp: number) => byMarket.get(marketId)?.find((snapshot) => snapshot.now >= timestamp) ?? null;

  let cash = config.startingCash;
  let open = 0;
  let peak = cash;
  let maxDrawdown = 0;
  const equityCurve = [{ timestamp: snapshots[0]?.now ?? 0, equity: cash }];
  const traded = new Set<string>();
  const openTrades: ReplayTrade[] = [];
  const trades: ReplayTrade[] = [];
  let signals = 0;

  const settleThrough = (timestamp: number) => {
    for (const trade of [...openTrades]) {
      const endTime = byMarket.get(trade.marketId)?.[0]?.endTime ?? Infinity;
      if (endTime > timestamp) continue;
      openTrades.splice(openTrades.indexOf(trade), 1);
      open -= trade.totalCost;
      const outcome = outcomes.get(trade.marketId) ?? null;
      trade.outcome = outcome;
      if (outcome === null) {
        cash += trade.totalCost; // unresolved: refund so it neither helps nor hurts
        continue;
      }
      const payout = outcome === trade.side ? trade.shares : 0; // redemption carries no fee
      trade.pnl = payout - trade.totalCost;
      cash += payout;
      peak = Math.max(peak, cash + open);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - (cash + open)) / peak : 0);
      equityCurve.push({ timestamp: endTime, equity: cash + open });
    }
  };

  for (const snapshot of snapshots) {
    settleThrough(snapshot.now);
    if (traded.has(snapshot.marketId)) continue;
    const budget = Math.min(config.stakeUsd, cash, Math.max(0, (cash + open) * config.maxOpenExposurePct - open));
    if (budget < 1) continue;
    const signal = evaluateSignal(snapshot, { ...config.params, budgetUsd: budget });
    if (signal.action === "PASS" || !signal.chosen?.fill || signal.chosen.limitPrice === null) continue;
    signals += 1;
    traded.add(snapshot.marketId);
    const side = signal.action;
    const fillSnapshot = nextAtOrAfter(snapshot.marketId, snapshot.now + config.latencyMs);
    if (!fillSnapshot || fillSnapshot.now >= fillSnapshot.endTime) continue;
    const book = side === "UP" ? fillSnapshot.up : fillSnapshot.down;
    const fill = simulateBuy(
      book.asks,
      budget,
      fillSnapshot.feeSchedule ?? DEFAULT_FEE_SCHEDULE,
      normalizeSignalParams(config.params).slippageBps,
      signal.chosen.limitPrice,
      fillSnapshot.minOrderSize,
    );
    if (!fill) continue;
    const later5 = nextAtOrAfter(snapshot.marketId, fillSnapshot.now + 5_000);
    const later30 = nextAtOrAfter(snapshot.marketId, fillSnapshot.now + 30_000);
    const mid5 = later5 && later5.now < later5.endTime ? sideMid(later5, side) : null;
    const mid30 = later30 && later30.now < later30.endTime ? sideMid(later30, side) : null;
    const marketUp = signal.pUpMarket;
    const trade: ReplayTrade = {
      marketId: snapshot.marketId,
      asset: snapshot.asset,
      duration: snapshot.duration,
      side,
      decidedAt: snapshot.now,
      filledAt: fillSnapshot.now,
      hourUtc: new Date(fillSnapshot.now).getUTCHours(),
      decisionCostPerShare: signal.chosen.fill.costPerShare,
      costPerShare: fill.costPerShare,
      avgPrice: fill.avgPrice,
      shares: fill.shares,
      totalCost: fill.totalCost,
      probability: signal.chosen.conservativeProbability,
      marketProbability: marketUp === null ? null : side === "UP" ? marketUp : 1 - marketUp,
      predictedEdge: signal.chosen.conservativeProbability - fill.costPerShare,
      outcome: null,
      pnl: null,
      markout5s: mid5 === null ? null : mid5 - fill.avgPrice,
      markout30s: mid30 === null ? null : mid30 - fill.avgPrice,
    };
    cash -= fill.totalCost;
    open += fill.totalCost;
    openTrades.push(trade);
    trades.push(trade);
  }
  settleThrough(Infinity);

  // Calibration on every market with an outcome, at fixed checkpoints, independent of trading.
  const calibrationRows: CalibrationRow[] = [];
  for (const [marketId, list] of byMarket) {
    const outcome = outcomes.get(marketId);
    if (!outcome) continue;
    for (const checkpoint of config.checkpoints) {
      const snapshot = list.find((candidate) => {
        const remaining = (candidate.endTime - candidate.now) / 1000;
        return remaining <= checkpoint && remaining > checkpoint - 15;
      });
      if (!snapshot) continue;
      const signal = evaluateSignal(snapshot, { ...config.params, budgetUsd: 1, minRemainingSeconds: 1 });
      const market = marketImpliedUp(snapshot);
      if (signal.pUpModel === null || signal.pUpPosterior === null || market === null) continue;
      calibrationRows.push({ marketId, checkpoint, model: signal.pUpModel, posterior: signal.pUpPosterior, market, outcome: outcome === "UP" ? 1 : 0 });
    }
  }

  const settledTrades = trades.filter((trade) => trade.pnl !== null);
  const wins = settledTrades.filter((trade) => (trade.pnl ?? 0) > 0).length;
  const netPnl = settledTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
  const turnover = settledTrades.reduce((sum, trade) => sum + trade.totalCost, 0);
  const dailyPnl = new Map<string, number>();
  for (const trade of settledTrades) {
    const day = new Date(trade.filledAt).toISOString().slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + (trade.pnl ?? 0));
  }
  const dailyValues = [...dailyPnl.values()];
  const dailySd = standardDeviation(dailyValues);
  const byAsset: ReplayReport["byAsset"] = {};
  const byDuration: ReplayReport["byDuration"] = {};
  const byHourUtc: ReplayReport["byHourUtc"] = {};
  for (const trade of settledTrades) {
    bump(byAsset, trade.asset, trade.pnl ?? 0);
    bump(byDuration, trade.duration, trade.pnl ?? 0);
    bump(byHourUtc, String(trade.hourUtc).padStart(2, "0"), trade.pnl ?? 0);
  }
  const realizedEdges = settledTrades.map((trade) => (trade.outcome === trade.side ? 1 : 0) - trade.costPerShare);
  const avgRealizedEdge = realizedEdges.length ? mean(realizedEdges) : null;
  const edgeSd = standardDeviation(realizedEdges);
  const markouts5 = trades.map((trade) => trade.markout5s).filter((value): value is number => value !== null);
  const markouts30 = trades.map((trade) => trade.markout30s).filter((value): value is number => value !== null);
  const rowsFor = (key: "model" | "posterior" | "market") => calibrationRows.map((row) => ({ p: row[key], y: row.outcome }));

  return {
    snapshots: snapshots.length,
    markets: byMarket.size,
    signals,
    fills: trades.length,
    fillRate: signals ? trades.length / signals : null,
    trades,
    settled: settledTrades.length,
    wins,
    winRate: settledTrades.length ? wins / settledTrades.length : null,
    winRateCi: wilsonInterval(wins, settledTrades.length),
    netPnl,
    evPerTrade: settledTrades.length ? netPnl / settledTrades.length : null,
    roiOnTurnover: turnover > 0 ? netPnl / turnover : null,
    avgPredictedEdge: trades.length ? mean(trades.map((trade) => trade.predictedEdge)) : null,
    avgRealizedEdge,
    avgSlippage: trades.length ? mean(trades.map((trade) => trade.costPerShare - trade.decisionCostPerShare)) : null,
    avgMarkout5s: markouts5.length ? mean(markouts5) : null,
    avgMarkout30s: markouts30.length ? mean(markouts30) : null,
    maxDrawdown,
    dailySharpe: dailySd && dailySd > 0 && dailyValues.length >= 2 ? (mean(dailyValues) / dailySd) * Math.sqrt(365) : null,
    equityCurve,
    calibration: {
      model: score(rowsFor("model")),
      posterior: score(rowsFor("posterior")),
      market: score(rowsFor("market")),
      reliability: reliability(rowsFor("model")),
      rows: calibrationRows.length,
    },
    byAsset,
    byDuration,
    byHourUtc,
    tradesNeededForSignificance: avgRealizedEdge !== null && avgRealizedEdge > 0 && edgeSd ? Math.ceil(((1.96 * edgeSd) / avgRealizedEdge) ** 2) : null,
  };
};

/** Tune on the earliest `trainFraction` of markets and report untouched out-of-sample results. */
export const walkForward = (
  snapshots: MarketSnapshot[],
  outcomes: Map<string, Side>,
  grid: Partial<SignalParams>[],
  options: Partial<ReplayOptions> = {},
  trainFraction = 0.6,
  minTrainTrades = 30,
) => {
  const starts = [...new Map(snapshots.map((snapshot) => [snapshot.marketId, snapshot.startTime])).entries()].sort((left, right) => left[1] - right[1]);
  const cut = starts[Math.floor(starts.length * trainFraction)]?.[1] ?? Infinity;
  const train = snapshots.filter((snapshot) => snapshot.startTime < cut);
  const test = snapshots.filter((snapshot) => snapshot.startTime >= cut);
  const candidates = (grid.length ? grid : [{}]).map((params) => ({
    params,
    report: runReplay(train, outcomes, { ...options, params: { ...options.params, ...params } }),
  }));
  const ranked = candidates
    .filter((candidate) => candidate.report.settled >= minTrainTrades)
    .sort((left, right) => (right.report.evPerTrade ?? -Infinity) - (left.report.evPerTrade ?? -Infinity));
  const chosen = ranked[0] ?? null;
  return {
    cutoff: cut,
    trainMarkets: new Set(train.map((snapshot) => snapshot.marketId)).size,
    testMarkets: new Set(test.map((snapshot) => snapshot.marketId)).size,
    chosen: chosen?.params ?? null,
    train: chosen?.report ?? null,
    test: chosen ? runReplay(test, outcomes, { ...options, params: { ...options.params, ...chosen.params } }) : null,
    candidates: candidates.map((candidate) => ({ params: candidate.params, trades: candidate.report.settled, evPerTrade: candidate.report.evPerTrade })),
  };
};

// ---------------------------------------------------------------------------
// Serialization. JSONL is the native format written by the recorder and the
// headless runner: {"type":"snapshot","snapshot":{...}} and
// {"type":"resolution","marketId":"...","outcome":"UP"} lines.

export type ReplayDataset = { snapshots: MarketSnapshot[]; outcomes: Map<string, Side>; rejected: number };

export const parseReplayJsonl = (text: string): ReplayDataset => {
  const snapshots: MarketSnapshot[] = [];
  const outcomes = new Map<string, Side>();
  let rejected = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as { type?: string; snapshot?: MarketSnapshot; marketId?: string; outcome?: string };
      if (item.type === "snapshot" && item.snapshot && typeof item.snapshot.marketId === "string" && typeof item.snapshot.now === "number")
        snapshots.push(item.snapshot);
      else if (item.type === "resolution" && item.marketId && (item.outcome === "UP" || item.outcome === "DOWN")) outcomes.set(item.marketId, item.outcome);
      else if (item.type !== "decision" && item.type !== "fill" && item.type !== "meta") rejected += 1;
    } catch {
      rejected += 1;
    }
  }
  return { snapshots, outcomes, rejected };
};

export const replayCsvTemplate =
  "timestamp,market_id,asset,duration,end_time,reference,spot,sigma_per_sqrt_second,up_bid,up_ask,down_bid,down_ask,depth_shares,twap_lookback_seconds,outcome\n";

/**
 * Minimal CSV import for externally collected data. CSV rows carry no tick
 * history, so any averaging window is approximated as flat at `spot` and
 * rows are marked EXCHANGE-sourced (the engine demands extra edge for that).
 */
export const parseReplayCsv = (text: string): ReplayDataset => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const snapshots: MarketSnapshot[] = [];
  const outcomes = new Map<string, Side>();
  let rejected = 0;
  if (lines.length < 2) return { snapshots, outcomes, rejected };
  const headers = lines[0].split(",").map((header) =>
    header
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_"),
  );
  const column = (values: string[], name: string) => values[headers.indexOf(name)]?.trim() ?? "";
  const numberAt = (values: string[], name: string) => {
    const raw = column(values, name);
    const parsed = raw === "" ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  for (const line of lines.slice(1)) {
    const values = line.split(",");
    const timestampRaw = column(values, "timestamp");
    const timestamp = /^\d+$/.test(timestampRaw)
      ? Number(timestampRaw) < 1e10
        ? Number(timestampRaw) * 1000
        : Number(timestampRaw)
      : Date.parse(timestampRaw);
    const endRaw = column(values, "end_time");
    const endTime = /^\d+$/.test(endRaw) ? (Number(endRaw) < 1e10 ? Number(endRaw) * 1000 : Number(endRaw)) : Date.parse(endRaw);
    const marketId = column(values, "market_id");
    const asset = column(values, "asset").toUpperCase();
    const duration = column(values, "duration").includes("15") ? "15m" : "5m";
    const reference = numberAt(values, "reference");
    const spot = numberAt(values, "spot");
    const sigma = numberAt(values, "sigma_per_sqrt_second");
    const upBid = numberAt(values, "up_bid");
    const upAsk = numberAt(values, "up_ask");
    const downBid = numberAt(values, "down_bid");
    const downAsk = numberAt(values, "down_ask");
    const depth = numberAt(values, "depth_shares") ?? 1_000;
    const lookback = numberAt(values, "settlement_lookback_seconds") ?? 0;
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(endTime) ||
      !marketId ||
      !asset ||
      reference === null ||
      spot === null ||
      upAsk === null ||
      downAsk === null
    ) {
      rejected += 1;
      continue;
    }
    const outcome = column(values, "outcome").toUpperCase();
    if (outcome === "UP" || outcome === "DOWN") outcomes.set(marketId, outcome);
    const ticks = Array.from({ length: Math.max(1, lookback) }, (_, index) => ({ timestamp: timestamp - index * 1000, price: spot })).reverse();
    snapshots.push({
      marketId,
      asset,
      duration,
      startTime: endTime - (duration === "5m" ? 300_000 : 900_000),
      endTime,
      now: timestamp,
      reference,
      referenceSource: "CHAINLINK",
      spot,
      spotTimestamp: timestamp,
      spotSource: "EXCHANGE",
      basisBps: null,
      ticks,
      sigmaPerSqrtSecond: sigma,
      settlementLookbackSeconds: lookback,
      feeSchedule: DEFAULT_FEE_SCHEDULE,
      tickSize: 0.01,
      minOrderSize: 5,
      up: { bids: upBid === null ? [] : [{ price: upBid, size: depth }], asks: [{ price: upAsk, size: depth }], timestamp },
      down: { bids: downBid === null ? [] : [{ price: downBid, size: depth }], asks: [{ price: downAsk, size: depth }], timestamp },
    });
  }
  return { snapshots, outcomes, rejected };
};

export const serializeSnapshotLine = (snapshot: MarketSnapshot) => JSON.stringify({ type: "snapshot", snapshot }) + "\n";
export const serializeResolutionLine = (marketId: string, outcome: Side) => JSON.stringify({ type: "resolution", marketId, outcome }) + "\n";
