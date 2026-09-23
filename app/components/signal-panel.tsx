import { ArrowDownRight, ArrowUpRight, ShieldCheck } from "lucide-react";
import type { MarketSignal } from "../lib/engines";
import type { DerivedFeed } from "../lib/feeds";
import type { LiveMarket } from "../lib/polymarket-data";
import { takerFeePerShare } from "../lib/pricing";
import type { SideEvaluation } from "../lib/signal";
import { CandleChart } from "./charts";
import { cents, dollars, formatAge, formatSpot, percentage, points, timeLeft } from "./format";

const SideRow = ({ label, evaluation, feeSchedule }: { label: string; evaluation: SideEvaluation | null; feeSchedule: LiveMarket["feeSchedule"] }) => (
  <div>
    <small>
      {label} · fair {percentage(evaluation?.probability)} (worst {percentage(evaluation?.conservativeProbability)}) · ask {cents(evaluation?.bestAsk)} + fee{" "}
      {cents(evaluation?.bestAsk ? takerFeePerShare(evaluation.bestAsk, feeSchedule) : null)}
    </small>
    <strong className={evaluation?.edge === null || evaluation?.edge === undefined ? "text-muted" : evaluation.edge >= 0 ? "text-positive" : "text-negative"}>
      edge {points(evaluation?.edge)} · limit {evaluation?.limitPrice?.toFixed(3) ?? "—"}
    </strong>
  </div>
);

export function SignalPanel({
  market,
  signal,
  feed,
  now,
  stakeUsd,
  disabled,
  onBuy,
}: {
  market: LiveMarket;
  signal: MarketSignal;
  feed: DerivedFeed | null;
  now: number;
  stakeUsd: number;
  disabled: boolean;
  onBuy: (side: "UP" | "DOWN") => void;
}) {
  const raw = signal.raw;
  const distribution = raw.fair?.distribution ?? null;
  const tone = signal.action === "PASS" ? "warning" : signal.action === "UP" ? "positive" : "negative";
  return (
    <aside className="panel signal-panel" aria-label="Selected market signal">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">TWAP SETTLEMENT MODEL</div>
          <h3>
            {market.asset} {market.duration}
          </h3>
        </div>
        <span className={`action-pill ${tone}`}>{signal.action === "PASS" ? `PASS · ${signal.gate}` : `${signal.tier} ${signal.action}`}</span>
      </div>
      <p className="market-question signal-question">{market.question}</p>
      <div className="signal-hero">
        <div>
          <span className="metric-label">POSTERIOR P(UP)</span>
          <strong>{percentage(signal.fairUp)}</strong>
          <small>
            model {percentage(signal.modelUp)} · book {percentage(signal.marketUp)} · vol band{" "}
            {signal.band ? `${percentage(signal.band[0])}–${percentage(signal.band[1])}` : "—"}
          </small>
        </div>
        <div className="signal-confidence">
          <small>price to beat</small>
          <strong>{formatSpot(market.asset, market.reference)}</strong>
          <small>{market.referenceSource === "CHAINLINK" ? "Chainlink TWAP open" : "pending"}</small>
        </div>
      </div>
      <div className="signal-price-checks">
        <SideRow label="UP" evaluation={raw.sides.UP} feeSchedule={market.feeSchedule} />
        <SideRow label="DOWN" evaluation={raw.sides.DOWN} feeSchedule={market.feeSchedule} />
      </div>
      <div className="signal-block">
        <div className="signal-block-title">
          <span>SETTLEMENT DISTRIBUTION</span>
          <small>
            {market.twapLookbackSeconds}s TWAP · fee rate {market.feeSchedule.rate} × (p(1−p))^{market.feeSchedule.exponent}
          </small>
        </div>
        <div className="signal-metrics">
          <div>
            <span>EXPECTED SETTLE</span>
            <strong>{formatSpot(market.asset, distribution?.mean)}</strong>
          </div>
          <div>
            <span>SETTLE σ</span>
            <strong>{distribution && market.reference ? `${((distribution.sd / market.reference) * 10_000).toFixed(1)}bp` : "—"}</strong>
          </div>
          <div>
            <span>WINDOW OBSERVED</span>
            <strong>{distribution ? `${Math.round(distribution.observedSeconds)}s · ${percentage(distribution.observedCoverage, 0)}` : "—"}</strong>
          </div>
          <div>
            <span>EDGE FLOOR</span>
            <strong>{points(signal.requiredEdge)}</strong>
          </div>
        </div>
      </div>
      <div className="signal-block">
        <div className="signal-block-title">
          <span>FEED HEALTH</span>
          <small>{feed?.spotSource ?? "MISSING"}</small>
        </div>
        <div className="signal-metrics">
          <div>
            <span>CHAINLINK</span>
            <strong>{formatSpot(market.asset, feed?.settlementValue)}</strong>
            <small>{formatAge(feed?.settlementTimestamp, now)}</small>
          </div>
          <div>
            <span>EXCHANGE</span>
            <strong>{formatSpot(market.asset, feed?.exchangeSpot)}</strong>
            <small>{formatAge(feed?.exchangeSpotTimestamp, now)}</small>
          </div>
          <div>
            <span>BASIS</span>
            <strong>{feed?.basisBps === null || feed?.basisBps === undefined ? "—" : `${feed.basisBps.toFixed(1)}bp`}</strong>
          </div>
          <div>
            <span>VOL / MIN</span>
            <strong>{feed?.sigmaPerSqrtSecond ? `${(feed.sigmaPerSqrtSecond * Math.sqrt(60) * 10_000).toFixed(1)}bp` : "—"}</strong>
            <small>{feed?.sigmaSource ?? ""}</small>
          </div>
        </div>
      </div>
      <div className="candle-chart-grid">
        <CandleChart label="5M CANDLES" candles={market.chart5m} trend={signal.trend5m} rsiValue={signal.rsi5m} />
        <CandleChart label="15M CANDLES" candles={market.chart15m} trend={signal.trend15m} rsiValue={signal.rsi15m} />
      </div>
      <div className={`no-trade-box ${signal.action !== "PASS" ? "candidate-box" : ""}`}>
        <div className="no-trade-icon">
          <ShieldCheck size={16} />
        </div>
        <div>
          <strong>{signal.action === "PASS" ? `PASS · ${signal.gate}` : `${signal.tier} ${signal.action} · limit ${signal.limitPrice?.toFixed(3)}`}</strong>
          <p>{signal.reason} Candles and RSI are display-only; they do not move the fair value.</p>
        </div>
      </div>
      <div className="paper-order-actions">
        <button className="button-primary" disabled={disabled || signal.action !== "UP"} onClick={() => onBuy("UP")} type="button">
          <ArrowUpRight size={14} />
          PAPER UP · {dollars(stakeUsd, 0)}
        </button>
        <button className="button-secondary" disabled={disabled || signal.action !== "DOWN"} onClick={() => onBuy("DOWN")} type="button">
          <ArrowDownRight size={14} />
          PAPER DOWN · {dollars(stakeUsd, 0)}
        </button>
      </div>
      <div className="panel-footnote">
        <span>LEFT</span>
        <strong>{timeLeft((market.endTime - now) / 1000)}</strong>
        <span>TICK</span>
        <strong>{market.tickSize}</strong>
        <span className="footnote-spacer" />
        <a href={market.sourceUrl} target="_blank" rel="noreferrer">
          OPEN MARKET ↗
        </a>
      </div>
    </aside>
  );
}
