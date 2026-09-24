import type { Horizon } from "./polymarket-data";
import type { MarketSignal, PaperSide } from "./engines";

export type LedgerDecision = PaperSide | "PASS";
export type LedgerResult = "WIN" | "LOSS" | "PENDING" | "NOT TRADED";
export const ACTIVE_MODEL_VERSION = "chainlink-vol-v3-anchored";
export type RecordedAskLevel = { price: number; size: number };

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
  upBid?: number | null;
  downBid?: number | null;
  upDepthUsd?: number | null;
  downDepthUsd?: number | null;
  upBidDepthUsd?: number | null;
  downBidDepthUsd?: number | null;
  minOrderShares?: number | null;
  minOrderUsd?: number | null;
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
  microScore?: number | null;
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
  validationReference?: number | null;
  validationReferenceAt?: number | null;
  validationSpot?: number | null;
  validationSpotAt?: number | null;
  validationUpAsk?: number | null;
  validationDownAsk?: number | null;
  validationUpBid?: number | null;
  validationDownBid?: number | null;
  validationUpDepthUsd?: number | null;
  validationDownDepthUsd?: number | null;
  validationUpBidDepthUsd?: number | null;
  validationDownBidDepthUsd?: number | null;
  validationMinOrderShares?: number | null;
  validationMinOrderUsd?: number | null;
  validationMicroScore?: number | null;
  validationBiasConfidence?: number | null;
  validationUpAskLevels?: RecordedAskLevel[] | null;
  validationDownAskLevels?: RecordedAskLevel[] | null;
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
  /** Settled directional predictions with a recorded probability, edge, and price. */
  edgeSamples: number;
  /** Mean net edge the signal claimed on those settled predictions. */
  claimedEdge: number | null;
  /** Mean (payout - cost per share) actually realized on the same predictions. */
  realizedEdge: number | null;
  /** Mean predicted win probability of the chosen side on the same predictions. */
  predictedWinRate: number | null;
  /** Win rate actually realized on the same predictions. */
  realizedWinRate: number | null;
};

const round = (value: number, digits = 6) => Number(value.toFixed(digits));
const numberOrNull = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? null : round(value);

export const ledgerResultFor = (decision: LedgerDecision, outcome: PaperSide | null): LedgerResult => {
  if (decision === "PASS") return "NOT TRADED";
  if (!outcome) return "PENDING";
  return decision === outcome ? "WIN" : "LOSS";
};

type EdgeSample = { claimedEdge: number; costPerShare: number; predictedWin: number; won: boolean };

/**
 * Compare the edge the signal claimed with what settlement paid. The recorded
 * edge is net of fees, so cost per share = P(side) - edge, and the realized
 * edge per share is payout (1 or 0) minus that cost.
 */
const edgeSampleFor = (row: MarketDecisionRow): EdgeSample | null => {
  const side = row.validationDecision;
  const fairUp = row.validationFairUp;
  const edge = row.validationEdge;
  if ((side !== "UP" && side !== "DOWN") || row.outcome === null) return null;
  if (fairUp === null || fairUp === undefined || !Number.isFinite(fairUp) || edge === null || edge === undefined || !Number.isFinite(edge)) return null;
  const predictedWin = side === "UP" ? fairUp : 1 - fairUp;
  const costPerShare = predictedWin - edge;
  if (!Number.isFinite(costPerShare) || costPerShare <= 0 || costPerShare >= 1) return null;
  return { claimedEdge: edge, costPerShare, predictedWin, won: side === row.outcome };
};

export const computeLedgerMetrics = (rows: MarketDecisionRow[]): LedgerMetrics => {
  const modelRows = rows.filter((row) => row.modelVersion === ACTIVE_MODEL_VERSION && (row.validationDecision === "UP" || row.validationDecision === "DOWN"));
  const settledRows = modelRows.filter((row) => row.outcome !== null);
  const wins = settledRows.filter((row) => row.validationDecision === row.outcome).length;
  const upSettledRows = settledRows.filter((row) => row.validationDecision === "UP");
  const downSettledRows = settledRows.filter((row) => row.validationDecision === "DOWN");
  const probabilityRows = settledRows.filter((row) => row.validationFairUp !== null && row.validationFairUp !== undefined && Number.isFinite(row.validationFairUp));
  const rate = (won: number, total: number) => total ? won / total : null;
  const edgeSamples = settledRows.map(edgeSampleFor).filter((sample): sample is EdgeSample => sample !== null);
  const meanOf = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
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
    edgeSamples: edgeSamples.length,
    claimedEdge: meanOf(edgeSamples.map((sample) => sample.claimedEdge)),
    realizedEdge: meanOf(edgeSamples.map((sample) => (sample.won ? 1 : 0) - sample.costPerShare)),
    predictedWinRate: meanOf(edgeSamples.map((sample) => sample.predictedWin)),
    realizedWinRate: meanOf(edgeSamples.map((sample) => sample.won ? 1 : 0)),
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
    "selected_edge", "entry_price", "up_ask", "down_ask", "up_bid", "down_bid", "up_depth_usd", "down_depth_usd",
    "up_bid_depth_usd", "down_bid_depth_usd", "min_order_shares", "min_order_usd", "reference", "spot", "remaining_seconds", "outcome",
    "result", "outcome_at_utc", "simulated_stake_usd", "simulated_units", "signal_confidence", "bias_confidence",
    "trend_5m", "trend_15m", "micro_score", "change_count", "reason", "tracked_markets", "settled_markets", "pass_count",
    "up_win_rate", "down_win_rate", "combined_win_rate", "model_version", "validation_decision",
    "validation_probability_up", "validation_edge", "validation_entry_price", "validation_stake_usd", "validation_at_utc",
    "validation_reference", "validation_reference_at_utc", "validation_spot", "validation_spot_at_utc",
    "validation_up_ask", "validation_down_ask", "validation_up_bid", "validation_down_bid", "validation_up_depth_usd",
    "validation_down_depth_usd", "validation_up_bid_depth_usd", "validation_down_bid_depth_usd", "validation_min_order_shares",
    "validation_min_order_usd", "validation_micro_score", "validation_bias_confidence", "validation_up_ask_levels_json", "validation_down_ask_levels_json",
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
    numberOrNull(row.upBid),
    numberOrNull(row.downBid),
    numberOrNull(row.upDepthUsd),
    numberOrNull(row.downDepthUsd),
    numberOrNull(row.upBidDepthUsd),
    numberOrNull(row.downBidDepthUsd),
    numberOrNull(row.minOrderShares),
    numberOrNull(row.minOrderUsd),
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
    numberOrNull(row.microScore),
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
    numberOrNull(row.validationReference),
    row.validationReferenceAt ? new Date(row.validationReferenceAt).toISOString() : "",
    numberOrNull(row.validationSpot),
    row.validationSpotAt ? new Date(row.validationSpotAt).toISOString() : "",
    numberOrNull(row.validationUpAsk),
    numberOrNull(row.validationDownAsk),
    numberOrNull(row.validationUpBid),
    numberOrNull(row.validationDownBid),
    numberOrNull(row.validationUpDepthUsd),
    numberOrNull(row.validationDownDepthUsd),
    numberOrNull(row.validationUpBidDepthUsd),
    numberOrNull(row.validationDownBidDepthUsd),
    numberOrNull(row.validationMinOrderShares),
    numberOrNull(row.validationMinOrderUsd),
    numberOrNull(row.validationMicroScore),
    numberOrNull(row.validationBiasConfidence),
    row.validationUpAskLevels ? JSON.stringify(row.validationUpAskLevels) : "",
    row.validationDownAskLevels ? JSON.stringify(row.validationDownAskLevels) : "",
  ].map(csvCell).join(","));
  return [headers.join(","), ...lines].join("\n") + "\n";
};
