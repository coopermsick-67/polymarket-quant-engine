// Every-market decision ledger. Rows record the FIRST entry decision (so a
// later flip cannot hide a bad call), a fixed pre-expiry checkpoint for honest
// calibration against the market, and the official Polymarket outcome.

import { mean, wilsonInterval } from "./num";
import type { LiveMarket, Resolution } from "./polymarket-data";
import type { Side, Signal } from "./signal";

export type LedgerDecision = Side | "PASS";
export type LedgerResult = "WIN" | "LOSS" | "PENDING" | "NOT TRADED";

export const CHECKPOINT_SECONDS = 120;

export type MarketDecisionRow = {
  id: string;
  marketId: string;
  firstSeenAt: number;
  lastUpdatedAt: number;
  asset: string;
  duration: string;
  slug: string;
  question: string;
  sourceUrl: string;
  endTime: number;
  decision: LedgerDecision;
  gate: string;
  reason: string;
  changeCount: number;
  /** First non-PASS decision; this is what the ledger is graded on. */
  entry: { side: Side; at: number; probability: number; costPerShare: number; edge: number; tier: string } | null;
  /** Model, posterior and market P(UP) at the first observation inside the checkpoint. */
  checkpoint: { at: number; remaining: number; model: number; posterior: number; market: number } | null;
  reference: number | null;
  outcome: Side | null;
  outcomeAt: number | null;
  result: LedgerResult;
};

export const ledgerResultFor = (entry: MarketDecisionRow["entry"], outcome: Side | null): LedgerResult => {
  if (!entry) return "NOT TRADED";
  if (!outcome) return "PENDING";
  return entry.side === outcome ? "WIN" : "LOSS";
};

export const updateLedgerRow = (previous: MarketDecisionRow | undefined, market: LiveMarket, signal: Signal, now: number): MarketDecisionRow => {
  const remaining = (market.endTime - now) / 1000;
  const entry =
    previous?.entry ??
    (signal.action !== "PASS" && signal.chosen?.fill
      ? {
          side: signal.action,
          at: now,
          probability: signal.chosen.conservativeProbability,
          costPerShare: signal.chosen.fill.costPerShare,
          edge: signal.chosen.edge ?? 0,
          tier: signal.tier,
        }
      : null);
  const checkpoint =
    previous?.checkpoint ??
    (remaining <= CHECKPOINT_SECONDS &&
    remaining > CHECKPOINT_SECONDS - 30 &&
    signal.pUpModel !== null &&
    signal.pUpPosterior !== null &&
    signal.pUpMarket !== null
      ? { at: now, remaining, model: signal.pUpModel, posterior: signal.pUpPosterior, market: signal.pUpMarket }
      : null);
  const outcome = previous?.outcome ?? null;
  return {
    id: market.id,
    marketId: market.id,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastUpdatedAt: now,
    asset: market.asset,
    duration: market.duration,
    slug: market.slug,
    question: market.question,
    sourceUrl: market.sourceUrl,
    endTime: market.endTime,
    decision: signal.action,
    gate: signal.gate,
    reason: signal.reason,
    changeCount: (previous?.changeCount ?? 0) + (previous && previous.decision !== signal.action ? 1 : 0),
    entry,
    checkpoint,
    reference: market.reference,
    outcome,
    outcomeAt: previous?.outcomeAt ?? null,
    result: ledgerResultFor(entry, outcome),
  };
};

export const resolveLedgerRow = (row: MarketDecisionRow, resolution: Resolution): MarketDecisionRow =>
  row.outcome ? row : { ...row, outcome: resolution.outcome, outcomeAt: resolution.resolvedAt, result: ledgerResultFor(row.entry, resolution.outcome) };

export type LedgerMetrics = {
  tracked: number;
  entries: number;
  settled: number;
  wins: number;
  winRate: number | null;
  winRateCi: [number, number] | null;
  /** Mean of (outcome - all-in cost) per entered share: the edge actually realized. */
  realizedEdge: number | null;
  predictedEdge: number | null;
  pending: number;
  calibrated: number;
  brierModel: number | null;
  brierPosterior: number | null;
  brierMarket: number | null;
};

export const computeLedgerMetrics = (rows: MarketDecisionRow[]): LedgerMetrics => {
  const entered = rows.filter((row) => row.entry);
  const settled = entered.filter((row) => row.outcome);
  const wins = settled.filter((row) => row.entry!.side === row.outcome).length;
  const calibrated = rows.filter((row) => row.checkpoint && row.outcome);
  const brier = (key: "model" | "posterior" | "market") =>
    calibrated.length ? mean(calibrated.map((row) => (row.checkpoint![key] - (row.outcome === "UP" ? 1 : 0)) ** 2)) : null;
  return {
    tracked: rows.length,
    entries: entered.length,
    settled: settled.length,
    wins,
    winRate: settled.length ? wins / settled.length : null,
    winRateCi: wilsonInterval(wins, settled.length),
    realizedEdge: settled.length ? mean(settled.map((row) => (row.entry!.side === row.outcome ? 1 : 0) - row.entry!.costPerShare)) : null,
    predictedEdge: settled.length ? mean(settled.map((row) => row.entry!.edge)) : null,
    pending: entered.filter((row) => !row.outcome).length,
    calibrated: calibrated.length,
    brierModel: brier("model"),
    brierPosterior: brier("posterior"),
    brierMarket: brier("market"),
  };
};

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const decisionLedgerCsv = (rows: MarketDecisionRow[]) => {
  const headers = [
    "market_id",
    "asset",
    "duration",
    "slug",
    "end_time_utc",
    "first_seen_utc",
    "reference",
    "last_decision",
    "last_gate",
    "entry_side",
    "entry_at_utc",
    "entry_probability",
    "entry_cost_per_share",
    "entry_edge",
    "entry_tier",
    "checkpoint_remaining_s",
    "checkpoint_model_up",
    "checkpoint_posterior_up",
    "checkpoint_market_up",
    "outcome",
    "result",
    "change_count",
    "reason",
  ];
  const iso = (value: number | null | undefined) => (value ? new Date(value).toISOString() : "");
  const lines = [...rows]
    .sort((left, right) => left.endTime - right.endTime)
    .map((row) =>
      [
        row.marketId,
        row.asset,
        row.duration,
        row.slug,
        iso(row.endTime),
        iso(row.firstSeenAt),
        row.reference,
        row.decision,
        row.gate,
        row.entry?.side,
        iso(row.entry?.at),
        row.entry?.probability,
        row.entry?.costPerShare,
        row.entry?.edge,
        row.entry?.tier,
        row.checkpoint?.remaining,
        row.checkpoint?.model,
        row.checkpoint?.posterior,
        row.checkpoint?.market,
        row.outcome,
        row.result,
        row.changeCount,
        row.reason,
      ]
        .map(csvCell)
        .join(","),
    );
  return [headers.join(","), ...lines].join("\n") + "\n";
};
