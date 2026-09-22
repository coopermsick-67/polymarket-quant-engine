import type { Horizon } from "./polymarket-data";
import type { MarketSignal, PaperSide } from "./engines";

export type LedgerDecision = PaperSide | "PASS";
export type LedgerResult = "WIN" | "LOSS" | "PENDING" | "NOT TRADED";

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
};

const round = (value: number, digits = 6) => Number(value.toFixed(digits));
const numberOrNull = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? null : round(value);

export const ledgerResultFor = (decision: LedgerDecision, outcome: PaperSide | null): LedgerResult => {
  if (decision === "PASS") return "NOT TRADED";
  if (!outcome) return "PENDING";
  return decision === outcome ? "WIN" : "LOSS";
};

export const computeLedgerMetrics = (rows: MarketDecisionRow[]): LedgerMetrics => {
  const upRows = rows.filter((row) => row.decision === "UP");
  const downRows = rows.filter((row) => row.decision === "DOWN");
  const settledRows = rows.filter((row) => row.result === "WIN" || row.result === "LOSS");
  const wins = settledRows.filter((row) => row.result === "WIN").length;
  const upSettledRows = upRows.filter((row) => row.result === "WIN" || row.result === "LOSS");
  const downSettledRows = downRows.filter((row) => row.result === "WIN" || row.result === "LOSS");
  const rate = (won: number, total: number) => total ? won / total : null;
  return {
    tracked: rows.length,
    up: upRows.length,
    down: downRows.length,
    pass: rows.filter((row) => row.decision === "PASS").length,
    settled: settledRows.length,
    wins,
    losses: settledRows.length - wins,
    pending: rows.filter((row) => row.result === "PENDING").length,
    upSettled: upSettledRows.length,
    upWins: upSettledRows.filter((row) => row.result === "WIN").length,
    downSettled: downSettledRows.length,
    downWins: downSettledRows.filter((row) => row.result === "WIN").length,
    combinedWinRate: rate(wins, settledRows.length),
    upWinRate: rate(upSettledRows.filter((row) => row.result === "WIN").length, upSettledRows.length),
    downWinRate: rate(downSettledRows.filter((row) => row.result === "WIN").length, downSettledRows.length),
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
    "up_win_rate", "down_win_rate", "combined_win_rate",
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
  ].map(csvCell).join(","));
  return [headers.join(","), ...lines].join("\n") + "\n";
};
