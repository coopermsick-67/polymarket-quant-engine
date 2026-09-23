import type { Horizon } from "./polymarket-data";
import type { MarketSignal, PaperSide } from "./engines";

export type LedgerDecision = PaperSide | "PASS";
export type LedgerResult = "WIN" | "LOSS" | "PENDING" | "NOT TRADED";
export const ACTIVE_MODEL_VERSION = "chainlink-vol-v2";

export type MarketDecisionRow = {
  id: string;
  marketId: string;
  observedAt: number;
  firstSeenAt: number;
  lastUpdatedAt: number;
  asset: string;
  duration: Horizon;
  slug: string;
  question: string;
  sourceUrl: string;
  decision: LedgerDecision;
  initialDecision: LedgerDecision;
  tier: MarketSignal["tier"];
  fairUp: number | null;
  upEdge: number | null;
  downEdge: number | null;
  edge: number | null;
  entryPrice: number | null;
  upAsk: number | null;
  downAsk: number | null;
  reference: number | null;
  spot: number | null;
  remainingSeconds: number;
  outcome: PaperSide | null;
  result: LedgerResult;
  outcomeAt: number | null;
  simulatedStake: number;
  simulatedUnits: number;
  signalConfidence: number | null;
  biasConfidence: number | null;
  trend5m: string;
  trend15m: string;
  reason: string;
  changeCount: number;
  modelVersion?: string;
  validationDecision?: LedgerDecision;
  validationFairUp?: number | null;
  validationEdge?: number | null;
  validationEntryPrice?: number | null;
  validationStakeUsd?: number | null;
  validationAt?: number | null;
};

export type LedgerMetrics = {
  tracked: number;
  up: number;
  down: number;
  pass: number;
  settled: number;
  wins: number;
  losses: number;
  pending: number;
  upSettled: number;
  upWins: number;
  downSettled: number;
  downWins: number;
  combinedWinRate: number | null;
  upWinRate: number | null;
  downWinRate: number | null;
  validationPredictions: number;
  brierScore: number | null;
  averageEdge: number | null;
};

const round = (value: number, digits = 6) => Number(value.toFixed(digits));
const numberOrNull = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? null : round(value);

export const ledgerResultFor = (decision: LedgerDecision, outcome: PaperSide | null): LedgerResult => {
  if (decision === "PASS") return "NOT TRADED";
  if (!outcome) return "PENDING";
  return decision === outcome ? "WIN" : "LOSS";
};

export const computeLedgerMetrics = (rows: MarketDecisionRow[]): LedgerMetrics => {
  const modelRows = rows.filter((row) => row.modelVersion === ACTIVE_MODEL_VERSION && (row.validationDecision === "UP" || row.validationDecision === "DOWN"));
  const settledRows = modelRows.filter((row) => row.outcome !== null);
  const wins = settledRows.filter((row) => row.validationDecision === row.outcome).length;
  const upSettledRows = settledRows.filter((row) => row.validationDecision === "UP");
  const downSettledRows = settledRows.filter((row) => row.validationDecision === "DOWN");
  const probabilityRows = settledRows.filter((row) => row.validationFairUp !== null && row.validationFairUp !== undefined && Number.isFinite(row.validationFairUp));
  const rate = (won: number, total: number) => total ? won / total : null;
  return {
    tracked: rows.length,
    up: modelRows.filter((row) => row.validationDecision === "UP").length,
    down: modelRows.filter((row) => row.validationDecision === "DOWN").length,
    pass: rows.filter((row) => row.modelVersion === ACTIVE_MODEL_VERSION && row.validationDecision === "PASS").length,
    settled: settledRows.length,
    wins,
    losses: settledRows.length - wins,
    pending: modelRows.filter((row) => row.outcome === null).length,
    upSettled: upSettledRows.length,
    upWins: upSettledRows.filter((row) => row.validationDecision === row.outcome).length,
    downSettled: downSettledRows.length,
    downWins: downSettledRows.filter((row) => row.validationDecision === row.outcome).length,
    combinedWinRate: rate(wins, settledRows.length),
    upWinRate: rate(upSettledRows.filter((row) => row.validationDecision === row.outcome).length, upSettledRows.length),
    downWinRate: rate(downSettledRows.filter((row) => row.validationDecision === row.outcome).length, downSettledRows.length),
    validationPredictions: modelRows.length,
    brierScore: probabilityRows.length ? probabilityRows.reduce((sum, row) => sum + ((row.validationFairUp! - (row.outcome === "UP" ? 1 : 0)) ** 2), 0) / probabilityRows.length : null,
    averageEdge: modelRows.length ? modelRows.reduce((sum, row) => sum + (Number.isFinite(row.validationEdge) ? row.validationEdge! : 0), 0) / modelRows.length : null,
  };
};

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
};

export const decisionLedgerCsv = (rows: MarketDecisionRow[]) => {
  const metrics = computeLedgerMetrics(rows);
  const headers = [
    "id", "market_id", "observed_at_utc", "first_seen_at_utc", "last_updated_at_utc", "asset", "duration",
    "slug", "question", "source_url", "decision", "initial_decision", "tier", "fair_up", "up_edge", "down_edge",
    "selected_edge", "entry_price", "up_ask", "down_ask", "reference", "spot", "remaining_seconds", "outcome",
    "result", "outcome_at_utc", "simulated_stake_usd", "simulated_units", "signal_confidence", "bias_confidence",
    "trend_5m", "trend_15m", "change_count", "reason", "tracked_markets", "settled_markets", "pass_count",
    "up_win_rate", "down_win_rate", "combined_win_rate", "model_version", "validation_decision",
    "validation_probability_up", "validation_edge", "validation_entry_price", "validation_stake_usd", "validation_at_utc",
  ];
  const lines = rows.slice().sort((left, right) => left.observedAt - right.observedAt).map((row) => [
    row.id,
    row.marketId,
    new Date(row.observedAt).toISOString(),
    new Date(row.firstSeenAt).toISOString(),
    new Date(row.lastUpdatedAt).toISOString(),
    row.asset,
    row.duration,
    row.slug,
    row.question,
    row.sourceUrl,
    row.decision,
    row.initialDecision,
    row.tier,
    numberOrNull(row.fairUp),
    numberOrNull(row.upEdge),
    numberOrNull(row.downEdge),
    numberOrNull(row.edge),
    numberOrNull(row.entryPrice),
    numberOrNull(row.upAsk),
    numberOrNull(row.downAsk),
    numberOrNull(row.reference),
    numberOrNull(row.spot),
    row.remainingSeconds,
    row.outcome ?? "",
    row.result,
    row.outcomeAt ? new Date(row.outcomeAt).toISOString() : "",
    numberOrNull(row.simulatedStake),
    numberOrNull(row.simulatedUnits),
    numberOrNull(row.signalConfidence),
    numberOrNull(row.biasConfidence),
    row.trend5m,
    row.trend15m,
    row.changeCount,
    row.reason,
    metrics.tracked,
    metrics.settled,
    metrics.pass,
    metrics.upWinRate,
    metrics.downWinRate,
    metrics.combinedWinRate,
    row.modelVersion ?? "",
    row.validationDecision ?? "",
    numberOrNull(row.validationFairUp),
    numberOrNull(row.validationEdge),
    numberOrNull(row.validationEntryPrice),
    numberOrNull(row.validationStakeUsd),
    row.validationAt ? new Date(row.validationAt).toISOString() : "",
  ].map(csvCell).join(","));
  return [headers.join(","), ...lines].join("\n") + "\n";
};
