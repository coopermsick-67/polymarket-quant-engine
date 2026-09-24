"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Ban,
  Check,
  ChevronDown,
  CircleDollarSign,
  CircleDot,
  Clock3,
  Copy,
  Database,
  Download,
  FileUp,
  Gauge,
  LayoutDashboard,
  LineChart,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Play,
  RefreshCw,
  ScanLine,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Terminal,
  TrendingDown,
  TrendingUp,
  Upload,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  anchoredFairUp,
  buildLiveMarket,
  applyPolymarketPriceTicks,
  chartFairProbability,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  fetchResolvedMarketOutcomes,
  replaceLiveMarketBook,
  updateLiveMarketBookLevel,
  updateLiveCandles,
  type Asset,
  type Horizon,
  type LiveMarket,
  type PolymarketPriceTick,
} from "./lib/polymarket-data";
import { subscribePolymarketPrices, type PolymarketPriceStreamStatus } from "./lib/polymarket-price-stream";
import {
  accountDeployed,
  accountEquity,
  accountLiquidationEquity,
  accountUnrealized,
  accountWinRate,
  analyzeMarketSignal,
  backtestCsvTemplate,
  buyPaper,
  closePaperPositions,
  createPaperAccount,
  estimatePaperExitFill,
  markAccount,
  marketDataFreshnessIssue,
  paperEntryBookEconomics,
  parseBacktestCsv,
  runBacktest,
  settlePaperPositionsByOutcome,
  updatePaperRiskBaselines,
  type BacktestResult,
  type BacktestRow,
  type CostConfig,
  type PaperAccount,
  type PaperSide,
} from "./lib/engines";
import LiveExecutionPanel, { type LiveExecutionStatus, type LiveSessionState } from "./components/live-execution-panel";
import PaperLabPanel, { type PaperTestViewState, type TelegramViewState } from "./components/paper-lab-panel";
import LocalPaperDaemonPanel from "./components/local-paper-daemon-panel";
import { ACTIVE_MODEL_VERSION, computeLedgerMetrics, decisionLedgerCsv, ledgerResultFor, type MarketDecisionRow } from "./lib/decision-ledger";
import { DEFAULT_PAPER_EARLY_EXIT, evaluateModelAwareExit, evaluatePaperHoldExit, normalizeEarlyExitPolicy, type EarlyExitPolicy } from "./lib/early-exit";
import { evaluatePaperMarket } from "./lib/paper-bankroll";
import { assessBankrollRisk, bankrollProfile } from "./lib/bankroll-policy";
import { enforceLiveExecutionRisk, normalizeLiveRiskConfig, type LiveRiskConfig } from "./lib/live-risk";

type View = "overview" | "paper" | "account" | "live" | "backtest";
type Tone = "positive" | "warning" | "negative" | "neutral";
type DataStatus = "loading" | "ready" | "error";

type LogItem = { id: string; time: string; message: string; detail: string; tone: Tone };
type Config = EarlyExitPolicy & { minEdge: number; maxTrade: number; maxLoss: number; feeRate: number; slippageBps: number };
type AccountConnection = { walletAddress: string; privateKey: string; signatureType: string };
type AccountPosition = { id: string; title: string; slug: string | null; outcome: string; size: number | null; averagePrice: number | null; currentPrice: number | null; currentValue: number | null; unrealizedPnl: number | null; realizedPnl: number | null; percentPnl: number | null; status: string; lastEventAt: number | null };
type AccountOrder = { id: string; side: string; price: number | null; size: number | null; matched: number | null; status: string; createdAt: number | null };
type AccountTrade = { id: string; timestamp: number | null; title: string; slug: string | null; side: string; outcome: string; price: number | null; shares: number | null; amount: number | null; status: string; transactionHash: string | null };
type ConnectedAccount = { walletAddress: string; authenticated: boolean; portfolioValue: number | null; cashBalance: number | null; openPositions: AccountPosition[]; openOrders: AccountOrder[]; recentTrades: AccountTrade[]; pnl: number | null; tradedMarketCount: number | null; fetchedAt: number; warnings: string[] };
type LivePositionSnapshot = { id: string; tokenID: string | null; conditionId: string | null; title: string; outcome: string; size: number | null; averagePrice: number | null };

const PAPER_STORAGE_KEY = "polymarket-quant-paper-v2";
const CONFIG_STORAGE_KEY = "polymarket-quant-config-v2";
const ACCOUNT_WALLET_STORAGE_KEY = "polymarket-quant-account-wallet-v1";
const LIVE_RISK_STORAGE_KEY = "polymarket-quant-live-risk-v1";
const LEDGER_STORAGE_KEY = "polymarket-quant-decision-ledger-v1";
const OPENING_TICKS_STORAGE_KEY = "polymarket-quant-opening-ticks-v1";
const TELEGRAM_LAST_SENT_KEY = "polymarket-quant-telegram-last-sent-v1";
const DEFAULT_CONFIG: Config = { minEdge: 0.04, maxTrade: 25, maxLoss: 0.05, feeRate: 0.02, slippageBps: 15, ...DEFAULT_PAPER_EARLY_EXIT };
const EMPTY_ACCOUNT_CONNECTION: AccountConnection = { walletAddress: "", privateKey: "", signatureType: "3" };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const dollars = (value: number | null, digits = 2) => value === null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const signedDollars = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : "−"}${dollars(Math.abs(value))}`;
const cents = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}¢`;
const percentage = (value: number | null | undefined, digits = 1) => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;
const timeLeft = (seconds: number | null) => { if (seconds === null || !Number.isFinite(seconds)) return "—"; const safe = Math.max(0, Math.floor(seconds)); return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`; };
const formatSpot = (asset: string, value: number | null) => { if (value === null || !Number.isFinite(value)) return "—"; const digits = asset === "BTC" ? 0 : asset === "ETH" ? 1 : 2; return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`; };
const formatTime = (timestamp: number | null) => timestamp ? new Date(timestamp).toLocaleTimeString("en-US", { hour12: false }) : "—";
const formatAge = (timestamp: number | null, now: number) => timestamp ? `${Math.max(0, now - timestamp)} ms ago` : "waiting";
const assetTone = (asset: string) => asset === "BTC" ? "asset-btc" : asset === "ETH" ? "asset-eth" : asset === "SOL" ? "asset-sol" : "asset-xrp";
const quantity = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : value.toFixed(2);

const readStoredJson = <T,>(key: string): T | null => {
  if (typeof window === "undefined") return null;
  try { const value = window.localStorage.getItem(key); return value ? JSON.parse(value) as T : null; } catch { return null; }
};

function Sparkline({ values, color = "#6cf2c4", height = 28 }: { values: number[]; color?: string; height?: number }) {
  const safeValues = values.length ? values : [0];
  const min = Math.min(...safeValues); const max = Math.max(...safeValues); const range = max - min || 1;
  const points = safeValues.map((value, index) => { const x = safeValues.length === 1 ? 50 : (index / (safeValues.length - 1)) * 100; const y = 3 + (1 - (value - min) / range) * (height - 7); return `${x},${y}`; }).join(" ");
  return <svg aria-hidden="true" className="sparkline" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none"><polyline fill="none" points={points} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

function PriceSparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className="market-sparkline-empty">Waiting for 5m history</div>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${3 + (1 - (value - min) / range) * 16}`).join(" ");
  return <svg aria-hidden="true" className="market-sparkline" viewBox="0 0 100 22" preserveAspectRatio="none"><polyline fill="none" points={points} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" vectorEffect="non-scaling-stroke" /></svg>;
}

function CandleChart({ label, candles, trend, rsiValue }: { label: string; candles: LiveMarket["chart5m"]; trend: string; rsiValue: number | null }) {
  const visible = candles.slice(-24);
  const tone = trend === "UP" ? "text-positive" : trend === "DOWN" ? "text-negative" : "text-muted";
  if (!visible.length) return <div className="candle-chart candle-chart-empty"><div><strong>{label}</strong><span className={tone}>{trend}</span></div><small>OHLC history unavailable</small></div>;
  const low = Math.min(...visible.map((candle) => candle.low));
  const high = Math.max(...visible.map((candle) => candle.high));
  const range = high - low || Math.max(high * 0.0001, 0.000001);
  const width = 280;
  const height = 74;
  const step = width / visible.length;
  const yFor = (price: number) => 8 + (1 - (price - low) / range) * (height - 16);
  return <div className="candle-chart"><div className="candle-chart-heading"><strong>{label}</strong><span className={tone}>{trend}</span><small>RSI {rsiValue === null ? "—" : rsiValue.toFixed(0)}</small></div><svg role="img" aria-label={`${label} price candles, trend ${trend}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
    {[0.25, 0.5, 0.75].map((ratio) => <line className="candle-grid" key={ratio} x1="0" x2={width} y1={8 + ratio * (height - 16)} y2={8 + ratio * (height - 16)} />)}
    {visible.map((candle, index) => {
      const x = step * index + step / 2;
      const up = candle.close >= candle.open;
      const color = up ? "#6cf2c4" : "#ff7d8a";
      const bodyTop = Math.min(yFor(candle.open), yFor(candle.close));
      const bodyHeight = Math.max(2, Math.abs(yFor(candle.open) - yFor(candle.close)));
      return <g key={candle.timestamp}><line x1={x} x2={x} y1={yFor(candle.high)} y2={yFor(candle.low)} stroke={color} strokeWidth="1" /><rect x={x - Math.max(1, step * 0.28)} y={bodyTop} width={Math.max(2, step * 0.56)} height={bodyHeight} fill={color} rx="0.5" /></g>;
    })}
  </svg></div>;
}

function EquityChart({ values, color = "#6cf2c4" }: { values: number[]; color?: string }) {
  const safeValues = values.length ? values : [0]; const min = Math.min(...safeValues) - 1; const max = Math.max(...safeValues) + 1; const range = max - min || 1;
  const points = safeValues.map((value, index) => { const x = safeValues.length === 1 ? 310 : (index / (safeValues.length - 1)) * 620; const y = 178 - ((value - min) / range) * 150; return `${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");
  return <svg className="equity-chart" viewBox="0 0 620 190" preserveAspectRatio="none" role="img" aria-label="Paper equity curve"><defs><linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.25" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs><line className="chart-grid-line" x1="0" x2="620" y1="28" y2="28" /><line className="chart-grid-line" x1="0" x2="620" y1="78" y2="78" /><line className="chart-grid-line" x1="0" x2="620" y1="128" y2="128" /><polygon fill="url(#equity-fill)" points={`0,190 ${points} 620,190`} /><polyline fill="none" points={points} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" vectorEffect="non-scaling-stroke" /></svg>;
}

function StatusDot({ label, status, detail }: { label: string; status: "READY" | "PUBLIC" | "WARN" | "LOCKED"; detail: string }) {
  const statusClass = status === "READY" ? "status-ready" : status === "PUBLIC" ? "status-sim" : status === "WARN" ? "status-warning" : "status-locked";
  return <div className="status-item" title={detail}><span className={`status-dot ${statusClass}`} /><span className="status-label">{label}</span><span className={`status-value ${statusClass}`}>{status}</span></div>;
}

function MetricCard({ label, value, delta, deltaTone = "positive", detail, icon, spark }: { label: string; value: string; delta?: string; deltaTone?: Tone; detail: string; icon: ReactNode; spark?: number[] }) {
  return <article className="metric-card"><div className="metric-topline"><span className="metric-label">{label}</span><span className="metric-icon">{icon}</span></div><div className="metric-value">{value}</div><div className="metric-bottom"><span className={`delta ${deltaTone}`}>{delta}</span><span className="metric-detail">{detail}</span></div>{spark && spark.length > 1 ? <Sparkline values={spark} color={deltaTone === "negative" ? "#ff7d8a" : "#6cf2c4"} /> : null}</article>;
}

const hasVerifiedOpeningReference = (market: LiveMarket) => market.startTimeVerified && market.startTime !== null
  && market.referenceVerified && market.referenceSource === "POLYMARKET" && market.reference !== null
  && market.referenceUpdatedAt === market.startTime;

const topBidDepthUsd = (levels: Array<{ price: number; size: number }> | undefined) => {
  const bestBid = levels?.reduce((best, level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1
    && Number.isFinite(level.size) && level.size > 0 ? Math.max(best, level.price) : best, 0) ?? 0;
  if (!bestBid) return null;
  const size = (levels ?? []).reduce((sum, level) => level.price === bestBid && Number.isFinite(level.size) && level.size > 0 ? sum + level.size : sum, 0);
  return size > 0 ? bestBid * size : null;
};

const replayBookFields = (market: LiveMarket, costs: CostConfig, side: PaperSide | null) => {
  const up = paperEntryBookEconomics(market, "UP", costs, 1);
  const down = paperEntryBookEconomics(market, "DOWN", costs, 1);
  const selected = side === "UP" ? up : side === "DOWN" ? down : null;
  const selectedBook = side === "UP" ? market.upBook : side === "DOWN" ? market.downBook : null;
  return {
    upAsk: up.bestAsk,
    downAsk: down.bestAsk,
    upBid: market.upBid,
    downBid: market.downBid,
    upDepthUsd: up.availableDepthUsd,
    downDepthUsd: down.availableDepthUsd,
    upBidDepthUsd: topBidDepthUsd(market.upBook?.bids),
    downBidDepthUsd: topBidDepthUsd(market.downBook?.bids),
    minOrderShares: selectedBook?.minOrderSize ?? null,
    minOrderUsd: selected && selected.minimumSharesKnown && selected.minimumDepthAvailable ? selected.minimumExecutableOrderUsd : null,
  };
};

const validationBookFields = (market: LiveMarket, costs: CostConfig, side: PaperSide | null, microScore: number | null, biasConfidence: number | null) => {
  const fields = replayBookFields(market, costs, side);
  return {
    validationReference: hasVerifiedOpeningReference(market) ? market.reference : null,
    validationReferenceAt: hasVerifiedOpeningReference(market) ? market.referenceUpdatedAt : null,
    validationSpot: market.spotSource === "POLYMARKET" ? market.spot : null,
    validationSpotAt: market.spotSource === "POLYMARKET" ? market.spotUpdatedAt : null,
    validationUpAsk: fields.upAsk,
    validationDownAsk: fields.downAsk,
    validationUpBid: fields.upBid,
    validationDownBid: fields.downBid,
    validationUpDepthUsd: fields.upDepthUsd,
    validationDownDepthUsd: fields.downDepthUsd,
    validationUpBidDepthUsd: fields.upBidDepthUsd,
    validationDownBidDepthUsd: fields.downBidDepthUsd,
    validationMinOrderShares: fields.minOrderShares,
    validationMinOrderUsd: fields.minOrderUsd,
    validationMicroScore: side === null ? null : microScore,
    validationBiasConfidence: side === null ? null : biasConfidence,
    validationUpAskLevels: (market.upBook?.asks ?? []).filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1 && Number.isFinite(level.size) && level.size > 0).sort((left, right) => left.price - right.price).slice(0, 80),
    validationDownAskLevels: (market.downBook?.asks ?? []).filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1 && Number.isFinite(level.size) && level.size > 0).sort((left, right) => left.price - right.price).slice(0, 80),
  };
};

function MarketCard({ market, selected, config, clock, onSelect }: { market: LiveMarket; selected: boolean; config: Config; clock: number; onSelect: () => void }) {
  const signal = analyzeMarketSignal(market, { feeRate: config.feeRate, slippageBps: config.slippageBps }, config.maxTrade, config.minEdge, clock);
  const action: { label: string; tone: Tone } = signal.action === "PASS"
    ? { label: "PASS", tone: "warning" }
    : { label: `${signal.tier} ${signal.action}`, tone: signal.action === "UP" ? "positive" : "negative" };
  const distance = market.distance;
  const oracleCurrent = market.spotSource === "POLYMARKET" && market.spot !== null && market.spotUpdatedAt !== null
    && clock > 0 && clock - market.spotUpdatedAt <= 10_000 && market.spotUpdatedAt <= clock + 1_000;
  const verifiedReference = hasVerifiedOpeningReference(market);
  const oracleLabel = market.priceFeed === "TWAP_60" ? "POLYMARKET 60S TWAP" : "POLYMARKET ORACLE";
  const referenceTitle = market.priceFeed === "TWAP_60"
    ? "Price to Beat is the Polymarket Chainlink 60-second TWAP observation at this market's exact start time."
    : "Price to Beat is the verified Polymarket oracle observation at this market's exact start time.";
  const chartValues = market.chart5m.slice(-18).map((candle) => candle.close);
  return <button className={`market-card ${selected ? "market-card-selected" : ""}`} onClick={onSelect} type="button">
    <div className="market-card-header"><div className="market-identity"><span className={`asset-token ${assetTone(market.asset)}`}>{market.asset.slice(0, 1)}</span><span><strong>{market.asset}</strong><small>{market.duration} · live book</small></span></div><span className={`action-pill ${action.tone}`}>{action.label}</span></div>
    <div className="market-question">{market.question}</div>
    <div className="market-price-row"><div><small>TIME LEFT</small><strong className="countdown">{timeLeft(market.remaining)}</strong></div><div className="market-spot"><small>{oracleLabel}</small><strong>{oracleCurrent ? formatSpot(market.asset, market.spot) : market.spot !== null ? "STALE · HOLD" : "WAITING FOR ORACLE"}</strong><small className="market-reference" title={referenceTitle}>{verifiedReference ? `PRICE TO BEAT ${formatSpot(market.asset, market.reference)}` : "PRICE TO BEAT · exact opening tick pending"}</small><span className={oracleCurrent && verifiedReference && distance !== null && distance >= 0 ? "text-positive" : oracleCurrent && verifiedReference && distance !== null ? "text-negative" : "text-muted"}>{!oracleCurrent || !verifiedReference || distance === null ? "—" : `${distance >= 0 ? "+" : ""}${percentage(distance, 2)}`}</span></div></div>
    <div className="book-grid"><div><span>UP</span><strong>{cents(market.upAsk)}</strong><small>bid {cents(market.upBid)}</small></div><div><span>DOWN</span><strong>{cents(market.downAsk)}</strong><small>bid {cents(market.downBid)}</small></div><div title="Candle model pulled toward the order book in log-odds. Edges are priced against this number."><span>P(UP)</span><strong>{percentage(signal.fairUp)}</strong><small>model {percentage(signal.rawModelUp, 0)} · mkt {percentage(signal.marketProbabilityUp, 0)}</small></div></div>
    <div className="entry-signal"><div><small title="Directional trend score, not a win probability.">TREND READ</small><strong className={signal.bias === "UP" ? "text-positive" : signal.bias === "DOWN" ? "text-negative" : "text-warning"}>{signal.bias}{signal.biasConfidence === null ? "" : ` · ${percentage(signal.biasConfidence, 0)}`}</strong></div><div><small>ENTRY</small><strong className={signal.action === "UP" ? "text-positive" : signal.action === "DOWN" ? "text-negative" : "text-warning"}>{signal.action === "PASS" ? "PASS" : `${signal.action} · ${cents(signal.entryPrice)}`}</strong></div><div className="entry-price-checks"><div><small>UP · P {percentage(signal.fairUp)} / ASK {cents(market.upAsk)}</small><strong className={signal.upEdge === null ? "text-muted" : signal.upEdge >= 0 ? "text-positive" : "text-negative"}>EDGE {signal.upEdge === null ? "—" : percentage(signal.upEdge)}</strong></div><div><small>DOWN · P {percentage(signal.fairUp === null ? null : 1 - signal.fairUp)} / ASK {cents(market.downAsk)}</small><strong className={signal.downEdge === null ? "text-muted" : signal.downEdge >= 0 ? "text-positive" : "text-negative"}>EDGE {signal.downEdge === null ? "—" : percentage(signal.downEdge)}</strong></div></div><div className="entry-trends"><span>5M {signal.trend5m}</span><span>15M {signal.trend15m}</span></div><PriceSparkline values={chartValues} color={signal.bias === "DOWN" ? "#ff7d8a" : "#6cf2c4"} /><small className="entry-reason">{signal.reason}</small></div>
    <div className="market-footer"><span className="market-edge"><span className="metric-label">NET EDGE</span><strong className={signal.action !== "PASS" ? "text-positive" : "text-muted"}>{signal.edge === null ? "—" : `${signal.edge >= 0 ? "+" : ""}${percentage(signal.edge)}`}</strong></span><span className="market-liquidity"><span className="metric-label">ASK DEPTH</span><strong>{market.liquidity ? dollars(market.liquidity, 0) : "—"}</strong></span></div>
  </button>;
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-state-icon"><Database size={18} /></div><strong>{title}</strong><p>{detail}</p>{action}</div>;
}

function AccountView({ account, loading, error, onConnect, onRefresh, onDisconnect }: { account: ConnectedAccount | null; loading: boolean; error: string; onConnect: () => void; onRefresh: () => void; onDisconnect: () => void }) {
  return <section className="account-view"><div className="section-heading"><div><div className="eyebrow">ACCOUNT CONSOLE</div><h2>Connected Polymarket account</h2><p className="section-subtitle">Wallet, balance, and execution-session data. Live order controls are isolated in the Live Executor tab.</p></div><div className="account-heading-actions">{account ? <><button className="button-secondary" disabled={loading} onClick={onRefresh} type="button">{loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}REFRESH</button><button className="button-secondary" onClick={onConnect} type="button"><Settings2 size={14} />EDIT CONNECTION</button><button className="button-danger" onClick={onDisconnect} type="button"><X size={14} />DISCONNECT</button></> : <button className="button-primary" onClick={onConnect} type="button"><Wallet size={14} />LINK POLYMARKET</button>}</div></div>{error ? <div className="data-alert account-alert"><AlertTriangle size={16} /><div><strong>Account sync failed</strong><span>{error}</span></div><button onClick={onRefresh} type="button">Retry</button></div> : null}{!account ? <EmptyState title="No Polymarket account linked" detail="Enter your wallet address and signer private key once. The app establishes a short-lived encrypted live session, then uses it to fetch balance, positions, open orders, and trades." action={<button className="button-primary" onClick={onConnect} type="button"><Wallet size={14} />Connect account</button>} /> : <><div className="account-identity"><div><span className="metric-label">WALLET</span><strong>{account.walletAddress}</strong></div><div className="account-badges"><span className="result-badge ready"><span className="status-dot status-ready" />PUBLIC DATA</span><span className={"result-badge " + (account.authenticated ? "ready" : "waiting")}><span className={"status-dot " + (account.authenticated ? "status-ready" : "status-warning")} />{account.authenticated ? "CLOB AUTHENTICATED" : "WALLET ONLY"}</span><span className="account-fetched">synced {formatTime(account.fetchedAt)}</span></div></div><div className="account-metrics metric-grid"><MetricCard label="PORTFOLIO VALUE" value={dollars(account.portfolioValue)} delta="Data API" deltaTone="neutral" detail="public wallet value" icon={<CircleDollarSign size={17} />} /><MetricCard label="CASH BALANCE" value={account.authenticated ? dollars(account.cashBalance) : "—"} delta={account.authenticated ? "authenticated" : "link wallet key"} deltaTone={account.authenticated ? "positive" : "warning"} detail="collateral available" icon={<Wallet size={17} />} /><MetricCard label="ACCOUNT P&L" value={signedDollars(account.pnl)} delta="user-pnl" deltaTone={account.pnl !== null && account.pnl >= 0 ? "positive" : "neutral"} detail="latest cumulative point" icon={<TrendingUp size={17} />} /><MetricCard label="POSITIONS" value={String(account.openPositions.length)} delta={account.openOrders.length + " open orders"} deltaTone="neutral" detail="public positions" icon={<BarChart3 size={17} />} /><MetricCard label="RECENT TRADES" value={String(account.recentTrades.length)} delta={account.tradedMarketCount === null ? "—" : String(account.tradedMarketCount) + " markets"} deltaTone="neutral" detail="latest wallet activity" icon={<Activity size={17} />} /></div>{account.warnings.length ? <div className="account-warnings"><AlertTriangle size={15} /><div>{account.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div></div> : null}<div className="account-grid"><article className="panel positions-panel"><div className="panel-heading"><div><div className="eyebrow">PUBLIC POSITIONS</div><h3>Open positions <span className="heading-muted">/ {account.openPositions.length}</span></h3></div><span className="feed-live"><span className="status-dot status-ready" />DATA API</span></div><div className="positions-table-wrap"><table className="positions-table"><thead><tr><th>MARKET</th><th>OUTCOME</th><th>SIZE</th><th>MARK</th><th>P&amp;L</th></tr></thead><tbody>{account.openPositions.length ? account.openPositions.map((position) => <tr key={position.id}><td><strong>{position.title}</strong><small>{position.status} · {formatTime(position.lastEventAt)}</small></td><td>{position.outcome}</td><td>{quantity(position.size)}</td><td>{cents(position.currentPrice)}</td><td className={position.unrealizedPnl === null ? "text-muted" : position.unrealizedPnl >= 0 ? "text-positive" : "text-negative"}>{signedDollars(position.unrealizedPnl)}</td></tr>) : <tr><td className="empty-row" colSpan={5}>No open positions returned for this wallet.</td></tr>}</tbody></table></div></article><article className="panel positions-panel"><div className="panel-heading"><div><div className="eyebrow">ACCOUNT ACTIVITY</div><h3>Recent trades <span className="heading-muted">/ {account.recentTrades.length}</span></h3></div><span className="feed-live"><span className={"status-dot " + (account.authenticated ? "status-ready" : "status-warning")} />{account.authenticated ? "CLOB + DATA" : "DATA API"}</span></div><div className="positions-table-wrap"><table className="positions-table"><thead><tr><th>TIME</th><th>MARKET</th><th>SIDE</th><th>PRICE</th><th>SIZE</th></tr></thead><tbody>{account.recentTrades.length ? account.recentTrades.map((trade) => <tr key={trade.id}><td>{formatTime(trade.timestamp)}</td><td><strong>{trade.title}</strong><small>{trade.status}</small></td><td><span className={"side-chip " + (trade.side.toUpperCase() === "BUY" ? "up" : "down")}>{trade.side}</span></td><td>{cents(trade.price)}</td><td>{quantity(trade.shares)}</td></tr>) : <tr><td className="empty-row" colSpan={5}>No trade activity returned for this wallet.</td></tr>}</tbody></table></div></article></div><article className="panel account-orders-panel"><div className="panel-heading"><div><div className="eyebrow">AUTHENTICATED CLOB</div><h3>Open orders <span className="heading-muted">/ {account.openOrders.length}</span></h3></div><span className="panel-footnote"><LockKeyhole size={13} /> Session-authenticated</span></div>{account.authenticated ? account.openOrders.length ? <div className="positions-table-wrap"><table className="positions-table"><thead><tr><th>SIDE</th><th>PRICE</th><th>SIZE</th><th>MATCHED</th><th>STATUS</th></tr></thead><tbody>{account.openOrders.map((order) => <tr key={order.id}><td>{order.side}</td><td>{cents(order.price)}</td><td>{quantity(order.size)}</td><td>{quantity(order.matched)}</td><td>{order.status}</td></tr>)}</tbody></table></div> : <div className="account-empty-line">No open CLOB orders returned.</div> : <div className="account-empty-line">Link your wallet to read private open orders and collateral balance.</div>}</article></> }</section>;
}

function AccountConnectModal({ connection, loading, error, onChange, onSubmit, onClose }: { connection: AccountConnection; loading: boolean; error: string; onChange: <K extends keyof AccountConnection>(field: K, value: AccountConnection[K]) => void; onSubmit: () => void; onClose: () => void }) {
  return <div className="modal-backdrop" onClick={onClose} role="presentation"><div aria-labelledby="account-connect-title" aria-modal="true" className="modal-card account-modal" onClick={(event) => event.stopPropagation()} role="dialog"><button aria-label="Close account connection" className="modal-close" onClick={onClose} type="button"><X size={17} /></button><div className="modal-icon account-modal-icon"><Wallet size={20} /></div><div className="eyebrow">SECURE LIVE CONNECTION</div><h2 id="account-connect-title">Link Polymarket account</h2><p>Enter your Polymarket wallet address and signer private key. The key is used once to derive CLOB credentials, check your balance, and establish a short-lived encrypted session for the live executor.</p><form className="account-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><label><span>Wallet address <em>required</em></span><input autoComplete="off" autoFocus onChange={(event) => onChange("walletAddress", event.target.value)} placeholder="0x…" spellCheck={false} value={connection.walletAddress} /></label><label><span>Wallet / signer type <em>select the Polymarket account type</em></span><select onChange={(event) => onChange("signatureType", event.target.value)} value={connection.signatureType}><option value="3">Polymarket proxy / smart wallet (3)</option><option value="0">EOA signer (0)</option><option value="1">Proxy wallet (1)</option><option value="2">Gnosis Safe (2)</option></select></label><label><span>Signer private key <em>required</em></span><input autoComplete="new-password" onChange={(event) => onChange("privateKey", event.target.value)} placeholder="64 hex characters" spellCheck={false} type="password" value={connection.privateKey} /></label>{error ? <div className="account-form-error"><AlertTriangle size={14} />{error}</div> : null}<div className="account-security-note"><LockKeyhole size={15} /><span>Raw private keys are highly sensitive. Use this only if you trust this deployment. The browser clears the key after linking; it is not stored in localStorage or logs. The encrypted session expires automatically.</span></div><div className="account-docs"><a href="https://docs.polymarket.com/getting-started/api" rel="noreferrer" target="_blank">API authentication docs ↗</a><a href="https://docs.polymarket.com/trading/wallets-auth" rel="noreferrer" target="_blank">Wallet auth docs ↗</a></div><div className="modal-actions"><button className="button-secondary" onClick={onClose} type="button">Cancel</button><button className="button-primary" disabled={loading || !connection.walletAddress.trim() || !connection.privateKey.trim()} type="submit">{loading ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {loading ? "Linking…" : "Connect & secure session"}</button></div></form></div></div>;
}

const RUNNER_COMMAND = "powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\run_forever.ps1";

function RunnerSetupModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(RUNNER_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return <div className="modal-backdrop" onClick={onClose} role="presentation"><div aria-labelledby="runner-setup-title" aria-modal="true" className="modal-card runner-modal" onClick={(event) => event.stopPropagation()} role="dialog"><button aria-label="Close 24/7 runner setup" className="modal-close" onClick={onClose} type="button"><X size={17} /></button><div className="modal-icon runner-modal-icon"><Terminal size={20} /></div><div className="eyebrow">24/7 PAPER SUPERVISOR</div><h2 id="runner-setup-title">Keep the local terminal alive</h2><p>This supervisor keeps the built local server running and restarts it if it exits. Open http://127.0.0.1:8787 in a browser and keep that tab awake because market scanning, paper fills, resolution settlement, and Telegram scheduling run in the browser.</p><div className="runner-checks"><div><span className="status-dot status-ready" /><span>Unified paper account</span><b className="gate-pass">ON</b></div><div><span className="status-dot status-ready" /><span>Restart local server</span><b className="gate-pass">ON</b></div><div><span className="status-dot status-locked" /><span>Background live orders</span><b className="gate-pending">OFF</b></div></div><div className="runner-command"><div className="runner-command-label"><span>RUN FROM THE PROJECT ROOT</span><button className="text-button" onClick={() => void copyCommand()} type="button"><Copy size={13} />{copied ? "COPIED" : "COPY"}</button></div><code>{RUNNER_COMMAND}</code></div><div className="runner-note"><ShieldCheck size={15} /><span>Use Windows Task Scheduler at logon, disable sleep while plugged in, and keep the browser tab open for continuous paper updates.</span></div><div className="modal-actions"><button className="button-secondary" onClick={onClose} type="button">Close</button><button className="button-primary" onClick={() => void copyCommand()} type="button"><Copy size={14} />{copied ? "COMMAND COPIED" : "COPY 24/7 COMMAND"}</button></div></div></div>;
}

export default function Home() {
  const [view, setView] = useState<View>("overview"); const [markets, setMarkets] = useState<LiveMarket[]>([]); const [selectedMarketId, setSelectedMarketId] = useState(""); const [durationFilter, setDurationFilter] = useState<"ALL" | Horizon>("ALL");
  const [account, setAccount] = useState<PaperAccount>(() => createPaperAccount(100, 0)); const [config, setConfig] = useState<Config>(DEFAULT_CONFIG); const [logs, setLogs] = useState<LogItem[]>([]);
  const [dataStatus, setDataStatus] = useState<DataStatus>("loading"); const [dataError, setDataError] = useState(""); const [lastUpdated, setLastUpdated] = useState<number | null>(null); const [clock, setClock] = useState(0); const [refreshing, setRefreshing] = useState(false); const [streamStatus, setStreamStatus] = useState<"CONNECTING" | "LIVE" | "REST FALLBACK">("CONNECTING"); const [polymarketStreamStatus, setPolymarketStreamStatus] = useState<PolymarketPriceStreamStatus>("DISCONNECTED");
  const [engineRunning, setEngineRunning] = useState(false); const [paused, setPaused] = useState(false); const [killSwitch, setKillSwitch] = useState(false); const [runnerDialogOpen, setRunnerDialogOpen] = useState(false); const [selectedRange, setSelectedRange] = useState("ALL"); const [startingCashInput, setStartingCashInput] = useState("100");
  const [recordedTicks, setRecordedTicks] = useState<BacktestRow[]>([]); const [backtestRows, setBacktestRows] = useState<BacktestRow[]>([]); const [backtestRejected, setBacktestRejected] = useState(0); const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null); const [backtestStartingCash, setBacktestStartingCash] = useState(100);
  const [accountConnection, setAccountConnection] = useState<AccountConnection>(() => ({ ...EMPTY_ACCOUNT_CONNECTION, walletAddress: readStoredJson<{ walletAddress?: string }>(ACCOUNT_WALLET_STORAGE_KEY)?.walletAddress ?? "" })); const [connectedAccount, setConnectedAccount] = useState<ConnectedAccount | null>(null); const [accountLoading, setAccountLoading] = useState(false); const [accountError, setAccountError] = useState(""); const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [liveRisk, setLiveRisk] = useState<LiveRiskConfig>(() => enforceLiveExecutionRisk(readStoredJson<Partial<LiveRiskConfig>>(LIVE_RISK_STORAGE_KEY))); const [liveSession, setLiveSession] = useState<LiveSessionState | null>(null); const [liveRunning, setLiveRunning] = useState(false); const [livePaused, setLivePaused] = useState(false); const [liveConsent, setLiveConsent] = useState(false); const [liveStatus, setLiveStatus] = useState<LiveExecutionStatus>({ lastAction: "", lastDetail: "", lastError: "", lastLatencyMs: null });
  const [ledgerRows, setLedgerRows] = useState<MarketDecisionRow[]>(() => readStoredJson<MarketDecisionRow[]>(LEDGER_STORAGE_KEY) ?? []);
  const [paperTestStartingBalanceInput, setPaperTestStartingBalanceInput] = useState("100"); const [paperTestDurationDaysInput, setPaperTestDurationDaysInput] = useState("1");
  const [paperTest, setPaperTest] = useState<PaperTestViewState>({ status: "IDLE", startingBalance: 100, days: 1, startedAt: null, endsAt: null, balance: 100, trades: 0, openPositions: 0, realizedPnl: 0, winRate: null });
  const [telegram, setTelegram] = useState<TelegramViewState>({ connected: false, botUsername: "", botName: "", chatId: "", chatTitle: "", expiresAt: null, lastStatus: "", lastError: "" });
  const polymarketPriceTickCache = useRef(new Map<string, PolymarketPriceTick>()); const polymarketOpeningTickCache = useRef(new Map<string, PolymarketPriceTick>()); const marketsRef = useRef(markets); const autoLastFill = useRef(new Map<string, number>()); const dataLogState = useRef(""); const hydrated = useRef(false); const refreshBusy = useRef(false); const paperAutoStarted = useRef(false); const liveBusy = useRef(false); const liveAttempted = useRef(new Map<string, number>()); const liveReason = useRef(""); const paperExitObservations = useRef(new Map<string, { count: number; lastSeen: number }>()); const livePositionsRef = useRef<LivePositionSnapshot[]>([]); const liveExitObservations = useRef(new Map<string, { count: number; lastSeen: number }>()); const livePositionRefreshBusy = useRef(false); const livePositionRefreshedAt = useRef(0);
  const paperAccountRef = useRef(account); const resolutionBusy = useRef(false); const resolutionCheckedAt = useRef(new Map<string, number>()); const completedTestLogAt = useRef<number | null>(null);
  const ledgerSnapshots = useRef(new Map<string, { market: LiveMarket; observedAt: number }>()); const ledgerLastScan = useRef(0); const telegramSendBusy = useRef(false);

  const appendLog = useCallback((message: string, detail: string, tone: Tone = "neutral") => { setLogs((current) => [{ id: `${Date.now()}-${message}`, time: new Date().toLocaleTimeString("en-US", { hour12: false }), message, detail, tone }, ...current].slice(0, 18)); }, []);

  useEffect(() => { if (typeof window === "undefined") return; const rawAccount = readStoredJson<PaperAccount>(PAPER_STORAGE_KEY); const rawConfig = readStoredJson<Partial<Config>>(CONFIG_STORAGE_KEY); if (rawAccount?.startingCash) setAccount(rawAccount); if (rawConfig) setConfig({ ...DEFAULT_CONFIG, ...rawConfig, ...normalizeEarlyExitPolicy(rawConfig, DEFAULT_PAPER_EARLY_EXIT) }); setStartingCashInput(String(rawAccount?.startingCash ?? 100)); hydrated.current = true; }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = readStoredJson<PolymarketPriceTick[]>(OPENING_TICKS_STORAGE_KEY);
    const now = Date.now();
    if (!Array.isArray(saved)) return;
    for (const tick of saved) {
      if (!tick || typeof tick.asset !== "string" || !tick.asset || (tick.priceFeed !== "TWAP_60" && tick.priceFeed !== "CHAINLINK_SPOT")
        || !Number.isFinite(tick.timestamp) || tick.timestamp < now - 24 * 60 * 60_000 || tick.timestamp > now + 1000
        || !Number.isFinite(tick.price) || tick.price <= 0) continue;
      const key = `${tick.asset}:${tick.priceFeed}:${tick.timestamp}`;
      polymarketOpeningTickCache.current.set(key, tick);
      polymarketPriceTickCache.current.set(key, tick);
    }
  }, []);
  useEffect(() => { marketsRef.current = markets; }, [markets]);
  useEffect(() => {
    const now = Date.now();
    for (const market of markets) {
      if (!market.startTimeVerified || !market.referenceVerified || market.referenceSource !== "POLYMARKET" || market.reference === null
        || market.startTime === null || market.referenceUpdatedAt !== market.startTime
        || (market.priceFeed !== "TWAP_60" && market.priceFeed !== "CHAINLINK_SPOT")) continue;
      const tick: PolymarketPriceTick = { asset: market.asset, priceFeed: market.priceFeed, timestamp: market.startTime, price: market.reference };
      const key = `${tick.asset}:${tick.priceFeed}:${tick.timestamp}`;
      polymarketOpeningTickCache.current.set(key, tick);
      polymarketPriceTickCache.current.set(key, tick);
    }
    for (const [key, tick] of polymarketOpeningTickCache.current) {
      if (tick.timestamp < now - 24 * 60 * 60_000) polymarketOpeningTickCache.current.delete(key);
    }
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem(OPENING_TICKS_STORAGE_KEY, JSON.stringify([...polymarketOpeningTickCache.current.values()].slice(-500))); }
      catch { /* Keep exact references available in memory when browser storage is full. */ }
    }
  }, [markets]);
  useEffect(() => { paperAccountRef.current = account; }, [account]);
  useEffect(() => { if (hydrated.current && typeof window !== "undefined") window.localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(account)); }, [account]);
  useEffect(() => { if (typeof window !== "undefined") window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config)); }, [config]);
  useEffect(() => { if (typeof window !== "undefined") window.localStorage.setItem(LIVE_RISK_STORAGE_KEY, JSON.stringify(liveRisk)); }, [liveRisk]);
  useEffect(() => { if (typeof window !== "undefined") { try { window.localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledgerRows)); } catch { /* Keep the in-memory ledger if browser storage is full. */ } } }, [ledgerRows]);
  useEffect(() => {
    if (paperAutoStarted.current || killSwitch) return;
    paperAutoStarted.current = true; setEngineRunning(true); setPaused(false); setView("paper"); appendLog("Paper engine started automatically", "Paper mode is open. Candle signals and public asks only; no live orders.", "positive");
  }, [appendLog, killSwitch]);
  const fetchConnectedAccount = useCallback(async (connection: AccountConnection): Promise<boolean> => {
    if (!connection.walletAddress.trim()) { setAccountError("Enter a wallet address before connecting."); return false; }
    setAccountLoading(true); setAccountError("");
    try {
      const response = await fetch("/api/polymarket/account", { body: JSON.stringify(connection), cache: "no-store", headers: { "Content-Type": "application/json" }, method: "POST" });
      const payload = await response.json() as { ok?: boolean; error?: string; account?: ConnectedAccount };
      if (!response.ok || !payload.ok || !payload.account) throw new Error(payload.error || "The account endpoint did not return a usable snapshot.");
      setConnectedAccount(payload.account);
      if (payload.account.authenticated) {
        const accountSnapshot = payload.account;
        setLiveSession((current) => current ? { ...current, balance: accountSnapshot.cashBalance ?? current.balance, openOrders: accountSnapshot.openOrders.length } : current);
      }
      if (typeof window !== "undefined") window.localStorage.setItem(ACCOUNT_WALLET_STORAGE_KEY, JSON.stringify({ walletAddress: connection.walletAddress.trim() }));
      appendLog("Polymarket account synchronized", String(payload.account.openPositions.length) + " positions · " + String(payload.account.recentTrades.length) + " recent trades · " + (payload.account.authenticated ? "authenticated CLOB reads" : "public wallet reads"), "positive");
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Account request failed.";
      setAccountError(detail); appendLog("Polymarket account unavailable", detail, "negative"); return false;
    } finally { setAccountLoading(false); }
  }, [appendLog]);

  const connectAccount = async () => {
    const connection = accountConnection;
    if (!connection.walletAddress.trim() || !connection.privateKey.trim()) { setAccountError("Enter the wallet address and signer private key to establish the live session."); return; }
    setAccountLoading(true); setAccountError("");
    try {
      const response = await fetch("/api/polymarket/live", { body: JSON.stringify({ action: "connect", walletAddress: connection.walletAddress, privateKey: connection.privateKey, signatureType: Number(connection.signatureType) }), cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, method: "POST" });
      const payload = await response.json() as { ok?: boolean; error?: string; live?: LiveSessionState };
      if (!response.ok || !payload.ok || !payload.live) throw new Error(payload.error || "The live session could not be established.");
      setLiveSession({ ...payload.live, connected: true });
      setAccountConnection((current) => ({ ...current, privateKey: "" }));
      const accountConnectionWithoutKey = { ...connection, privateKey: "" };
      const synced = await fetchConnectedAccount(accountConnectionWithoutKey);
      if (!synced) throw new Error("Live session established, but the account snapshot could not be loaded.");
      setAccountDialogOpen(false); setView("account"); appendLog("Polymarket live session armed", "Wallet linked; raw key cleared from browser state. Live execution remains opt-in until you confirm the risk notice.", "positive");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Live account connection failed.";
      setAccountError(detail); appendLog("Polymarket live session unavailable", detail, "negative");
    } finally { setAccountLoading(false); }
  };
  const disconnectAccount = () => {
    void fetch("/api/polymarket/live", { body: JSON.stringify({ action: "disconnect" }), cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, method: "POST" }).catch(() => undefined);
    setLiveRunning(false); setLivePaused(false); setLiveSession(null); setConnectedAccount(null); setAccountConnection(EMPTY_ACCOUNT_CONNECTION); setAccountError(""); setView("overview"); if (typeof window !== "undefined") window.localStorage.removeItem(ACCOUNT_WALLET_STORAGE_KEY); appendLog("Polymarket account disconnected", "Encrypted live session cleared from this browser session.", "neutral");
  };
  useEffect(() => { if (!connectedAccount || !accountConnection.walletAddress.trim()) return; const timer = window.setInterval(() => void fetchConnectedAccount(accountConnection), 30000); return () => window.clearInterval(timer); }, [accountConnection, connectedAccount, fetchConnectedAccount]);

  const costs = useMemo<CostConfig>(() => ({ feeRate: config.feeRate, slippageBps: config.slippageBps }), [config.feeRate, config.slippageBps]);
  const liveMarkets = useMemo(() => markets.map((market) => {
    const remaining = Math.max(0, Math.ceil((market.countdownEndsAt - clock) / 1000));
    const fairUp = chartFairProbability(market.reference, market.spot, remaining, market.duration, market.duration === "5m" ? market.chart5m : market.chart15m, clock);
    return { ...market, remaining, fairUp, edgeUp: fairUp !== null && market.upAsk !== null ? fairUp - market.upAsk : null, edgeDown: fairUp !== null && market.downAsk !== null ? 1 - fairUp - market.downAsk : null };
  }), [clock, markets]);
  const marketMap = useMemo(() => new Map(markets.map((market) => [market.id, market])), [markets]); const liveMarketMap = useMemo(() => new Map(liveMarkets.map((market) => [market.id, market])), [liveMarkets]); const selectedMarket = useMemo(() => liveMarkets.find((market) => market.id === selectedMarketId) ?? liveMarkets[0] ?? null, [liveMarkets, selectedMarketId]); const filteredMarkets = useMemo(() => durationFilter === "ALL" ? liveMarkets : liveMarkets.filter((market) => market.duration === durationFilter), [durationFilter, liveMarkets]);
  const liveTokenMap = useMemo(() => {
    const next = new Map<string, { market: LiveMarket; side: PaperSide }>();
    for (const market of liveMarkets) {
      next.set(market.upTokenId, { market, side: "UP" });
      next.set(market.downTokenId, { market, side: "DOWN" });
    }
    return next;
  }, [liveMarkets]);
  const ledgerMetrics = useMemo(() => computeLedgerMetrics(ledgerRows), [ledgerRows]);
  useEffect(() => {
    if (!liveMarkets.length) return;
    const now = Date.now();
    if (now - ledgerLastScan.current < 4500) return;
    ledgerLastScan.current = now;
      for (const market of liveMarkets) ledgerSnapshots.current.set(market.id, { market, observedAt: now });
    setLedgerRows((current) => {
      const rows = new Map(current.map((row) => [row.id, row]));
      let changed = false;
      for (const market of liveMarkets) {
        const signal = analyzeMarketSignal(market, costs, config.maxTrade, config.minEdge);
        const previous = rows.get(market.id);
        const decision = signal.action;
        const outcome = previous?.outcome ?? null;
        const isCurrentModel = previous?.modelVersion === ACTIVE_MODEL_VERSION;
        let validationDecision = isCurrentModel ? previous?.validationDecision ?? "PASS" : "PASS";
        let validationFairUp = isCurrentModel ? previous?.validationFairUp ?? null : null;
        let validationEdge = isCurrentModel ? previous?.validationEdge ?? null : null;
        let validationEntryPrice = isCurrentModel ? previous?.validationEntryPrice ?? null : null;
        let validationStakeUsd = isCurrentModel ? previous?.validationStakeUsd ?? null : null;
        let validationAt = isCurrentModel ? previous?.validationAt ?? null : null;
        if (validationDecision === "PASS" && decision !== "PASS" && signal.fairUp !== null && market.referenceSource === "POLYMARKET") {
          validationDecision = decision;
          validationFairUp = signal.fairUp;
          validationEdge = signal.edge;
          validationEntryPrice = signal.entryPrice;
          validationStakeUsd = signal.estimatedFill?.totalCost ?? null;
          validationAt = now;
        }
        const hasValidationDecision = validationDecision === "UP" || validationDecision === "DOWN";
        const validationSide: PaperSide | null = validationDecision === "UP" ? "UP" : validationDecision === "DOWN" ? "DOWN" : null;
        const captureValidationBook = hasValidationDecision && (!isCurrentModel || !previous
          || (previous.validationDecision !== "UP" && previous.validationDecision !== "DOWN"));
        const currentReplayBooks = replayBookFields(market, costs, validationSide);
        const capturedValidationBooks = captureValidationBook && market.referenceSource === "POLYMARKET"
          ? validationBookFields(market, costs, validationSide, signal.microScore, signal.biasConfidence) : null;
        const next: MarketDecisionRow = previous ? {
          ...previous,
          ...currentReplayBooks,
          ...(capturedValidationBooks ?? {}),
          lastUpdatedAt: now,
          asset: market.asset,
          duration: market.duration,
          slug: market.slug,
          question: market.question,
          sourceUrl: market.sourceUrl,
          decision,
          tier: signal.tier,
          fairUp: signal.fairUp,
          upEdge: signal.upEdge,
          downEdge: signal.downEdge,
          edge: signal.edge,
          entryPrice: signal.entryPrice,
          upAsk: market.upAsk,
          downAsk: market.downAsk,
          reference: market.reference,
          spot: market.spot,
          remainingSeconds: market.remaining,
          result: ledgerResultFor(validationDecision, outcome),
          simulatedStake: signal.estimatedFill?.totalCost ?? 0,
          simulatedUnits: signal.estimatedFill?.shares ?? 0,
          signalConfidence: signal.confidence,
          biasConfidence: signal.biasConfidence,
          microScore: signal.microScore,
          trend5m: signal.trend5m,
          trend15m: signal.trend15m,
          reason: signal.reason,
          changeCount: previous.changeCount + (previous.decision === decision ? 0 : 1),
          modelVersion: ACTIVE_MODEL_VERSION,
          validationDecision,
          validationFairUp,
          validationEdge,
          validationEntryPrice,
          validationStakeUsd,
          validationAt,
        } : {
          id: market.id,
          marketId: market.id,
          observedAt: now,
          firstSeenAt: now,
          lastUpdatedAt: now,
          asset: market.asset,
          duration: market.duration,
          slug: market.slug,
          question: market.question,
          sourceUrl: market.sourceUrl,
          decision,
          initialDecision: decision,
          tier: signal.tier,
          fairUp: signal.fairUp,
          upEdge: signal.upEdge,
          downEdge: signal.downEdge,
          edge: signal.edge,
          entryPrice: signal.entryPrice,
          ...currentReplayBooks,
          ...(validationDecision === "UP" || validationDecision === "DOWN" ? validationBookFields(market, costs, validationDecision, signal.microScore, signal.biasConfidence) : {}),
          reference: market.reference,
          spot: market.spot,
          remainingSeconds: market.remaining,
          outcome: null,
          result: ledgerResultFor(decision !== "PASS" && market.referenceSource === "POLYMARKET" ? decision : "PASS", null),
          outcomeAt: null,
          simulatedStake: signal.estimatedFill?.totalCost ?? 0,
          simulatedUnits: signal.estimatedFill?.shares ?? 0,
          signalConfidence: signal.confidence,
          biasConfidence: signal.biasConfidence,
          microScore: signal.microScore,
          trend5m: signal.trend5m,
          trend15m: signal.trend15m,
          reason: signal.reason,
          changeCount: 0,
          modelVersion: ACTIVE_MODEL_VERSION,
          validationDecision: decision !== "PASS" && market.referenceSource === "POLYMARKET" ? decision : "PASS",
          validationFairUp: decision !== "PASS" && market.referenceSource === "POLYMARKET" ? signal.fairUp : null,
          validationEdge: decision !== "PASS" && market.referenceSource === "POLYMARKET" ? signal.edge : null,
          validationEntryPrice: decision !== "PASS" && market.referenceSource === "POLYMARKET" ? signal.entryPrice : null,
          validationStakeUsd: decision !== "PASS" && market.referenceSource === "POLYMARKET" ? signal.estimatedFill?.totalCost ?? null : null,
          validationAt: decision !== "PASS" && market.referenceSource === "POLYMARKET" ? now : null,
        };
        if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) { rows.set(market.id, next); changed = true; }
      }
      return changed ? [...rows.values()].sort((left, right) => right.observedAt - left.observedAt) : current;
    });
  }, [config.maxTrade, config.minEdge, costs, liveMarkets]);

  useEffect(() => {
    let disposed = false;
    const resolveExpired = async () => {
      if (resolutionBusy.current) return;
      const now = Date.now();
      const pending = new Map<string, { id: string; upTokenId?: string; downTokenId?: string }>();
      for (const [marketId, snapshot] of ledgerSnapshots.current) {
        if (snapshot.market.endTime <= now - 1500 && now - (resolutionCheckedAt.current.get(marketId) ?? 0) >= 60_000) {
          pending.set(marketId, { id: marketId, upTokenId: snapshot.market.upTokenId, downTokenId: snapshot.market.downTokenId });
        }
      }
      for (const position of paperAccountRef.current.positions) {
        if (position.endTime <= now - 1500 && now - (resolutionCheckedAt.current.get(position.marketId) ?? 0) >= 60_000 && !pending.has(position.marketId)) {
          pending.set(position.marketId, { id: position.marketId });
        }
      }
      const batch = [...pending.values()].slice(0, 24);
      if (!batch.length) return;
      for (const market of batch) resolutionCheckedAt.current.set(market.id, now);
      resolutionBusy.current = true;
      try {
        const outcomes = await fetchResolvedMarketOutcomes(batch);
        if (disposed || !outcomes.size) return;
        const settledAt = Date.now();
        setAccount((current) => settlePaperPositionsByOutcome(current, outcomes, "market resolution", settledAt).account);
        setLedgerRows((current) => current.map((row) => {
          const outcome = outcomes.get(row.marketId);
          if (!outcome || row.outcome) return row;
          return {
            ...row,
            remainingSeconds: 0,
            outcome,
            outcomeAt: row.outcomeAt ?? settledAt,
            result: ledgerResultFor(row.validationDecision ?? "PASS", outcome),
            lastUpdatedAt: settledAt,
          };
        }));
        for (const marketId of outcomes.keys()) {
          ledgerSnapshots.current.delete(marketId);
          resolutionCheckedAt.current.delete(marketId);
        }
        appendLog("Gamma market results confirmed", `${outcomes.size} expired market${outcomes.size === 1 ? "" : "s"} resolved from final Polymarket outcomes.`, "positive");
      } catch {
        // Keep expired positions open and retry on a later poll when Gamma is unavailable.
      } finally {
        resolutionBusy.current = false;
      }
    };
    void resolveExpired();
    const timer = window.setInterval(() => void resolveExpired(), 15_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [appendLog]);
  useEffect(() => {
    if (paperTest.status !== "PENDING_RESOLUTION" || account.positions.length > 0) return;
    if (paperTest.startedAt !== null && completedTestLogAt.current === paperTest.startedAt) return;
    completedTestLogAt.current = paperTest.startedAt;
    setPaperTest((current) => current.status === "PENDING_RESOLUTION" ? {
      ...current,
      status: "COMPLETE",
      balance: accountEquity(account, liveMarketMap),
      trades: account.fills.filter((fill) => fill.action === "BUY").length,
      openPositions: 0,
      realizedPnl: account.realizedPnl,
      winRate: accountWinRate(account),
    } : current);
    appendLog("Forward paper test complete", `${paperTest.days} day${paperTest.days === 1 ? "" : "s"} elapsed · all positions received final Gamma outcomes.`, "positive");
  }, [account, liveMarketMap, paperTest.days, paperTest.startedAt, paperTest.status, appendLog]);
  const equity = useMemo(() => accountEquity(account, marketMap), [account, marketMap]); const unrealized = useMemo(() => accountUnrealized(account, marketMap), [account, marketMap]); const winRate = useMemo(() => accountWinRate(account), [account]); const deployed = useMemo(() => accountDeployed(account), [account]); const todayPnl = equity - account.startingCash;
  const paperTestView = useMemo<PaperTestViewState>(() => ({ ...paperTest, balance: accountEquity(account, liveMarketMap), trades: account.fills.filter((fill) => fill.action === "BUY").length, openPositions: account.positions.length, realizedPnl: account.realizedPnl, winRate: accountWinRate(account) }), [account, liveMarketMap, paperTest]);
  const maxDrawdown = useMemo(() => { let peak = 0; let drawdown = 0; for (const point of account.equityHistory) { peak = Math.max(peak, point.equity); if (peak > 0) drawdown = Math.max(drawdown, (peak - point.equity) / peak); } return drawdown; }, [account.equityHistory]);
  const equitySeries = useMemo(() => account.equityHistory.map((point) => point.equity), [account.equityHistory]);
  const liquidationEquity = useMemo(() => accountLiquidationEquity(account, marketMap, costs), [account, marketMap, costs]);
  const selectedOpportunity = selectedMarket ? evaluatePaperMarket({ market: selectedMarket, markets: marketMap, account, costs,
    liquidationEquityUsd: liquidationEquity, maxTradeUsd: config.maxTrade, minNetEdge: config.minEdge, now: clock }) : null;
  const selectedProfile = bankrollProfile(liquidationEquity);
  const paperRisk = assessBankrollRisk({ equityUsd: liquidationEquity, dayStartEquityUsd: account.riskDayStartEquityUsd ?? account.startingCash,
    peakEquityUsd: account.peakLiquidationEquityUsd ?? account.startingCash });
  const selectedSignal = selectedOpportunity?.signal ?? null;
  const currentAction = !selectedOpportunity?.approved || !selectedSignal || selectedSignal.action === "PASS"
    ? { label: "PASS", tone: "warning" as Tone }
    : { label: `${selectedSignal.tier} ${selectedSignal.action}`, tone: selectedSignal.action === "UP" ? "positive" as Tone : "negative" as Tone };

  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, []);

  const refreshMarkets = useCallback(async () => {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    const controller = new AbortController(); setRefreshing(true);
    try {
      const definitions = await discoverCryptoMarkets(controller.signal); const tokenIds = definitions.flatMap((market) => [market.upTokenId, market.downTokenId]); const assets = [...new Set(definitions.map((market) => market.asset))]; const [books, candles] = await Promise.all([fetchOrderBooks(tokenIds, controller.signal), fetchCandleHistories(assets, controller.signal)]); const timestamp = Date.now(); const oracleTicks = [...new Map([...polymarketOpeningTickCache.current.values(), ...polymarketPriceTickCache.current.values()].map((tick) => [`${tick.asset}:${tick.priceFeed}:${tick.timestamp}`, tick])).values()]; const nextMarkets = definitions.map((definition) => applyPolymarketPriceTicks(buildLiveMarket(definition, books, new Map<Asset, number>(), null, timestamp, candles.get(definition.asset) ?? null), oracleTicks, timestamp)).filter((market) => market.remaining > 0);
      setMarkets(nextMarkets); if (nextMarkets.length) { setDataStatus("ready"); setDataError(""); if (dataLogState.current !== "ready") appendLog("Public market data synchronized", `${nextMarkets.length} eligible crypto markets · Polymarket oracle + CLOB + Coinbase research candles`, "positive"); dataLogState.current = "ready"; } else { setDataStatus("ready"); setDataError("No active crypto 5m/15m markets were returned by Gamma right now."); if (dataLogState.current !== "empty") appendLog("No eligible public markets", "The engine is holding new trades until Gamma returns a matching market.", "warning"); dataLogState.current = "empty"; }
      const usableTicks = nextMarkets.filter((market) => market.referenceVerified && market.reference !== null && market.spotSource === "POLYMARKET" && market.spot !== null && market.spotUpdatedAt !== null && market.upAsk !== null && market.downAsk !== null).map((market) => ({ timestamp: market.spotUpdatedAt as number, asset: market.asset, duration: market.duration, marketId: market.id, reference: market.reference as number, spot: market.spot as number, upAsk: market.upAsk as number, downAsk: market.downAsk as number, outcome: null, remainingSeconds: market.remaining }));
      if (usableTicks.length) setRecordedTicks((current) => { const seen = new Set(current.map((tick) => `${tick.marketId}:${tick.timestamp}`)); const fresh = usableTicks.filter((tick) => !seen.has(`${tick.marketId}:${tick.timestamp}`)); return [...current, ...fresh].slice(-5000); }); setLastUpdated(timestamp);
    } catch (error) { if (controller.signal.aborted) return; const detail = error instanceof Error ? error.message : "Public market request failed"; setDataStatus("error"); setDataError(detail); if (dataLogState.current !== "error") appendLog("Public data unavailable", detail, "negative"); dataLogState.current = "error"; } finally { refreshBusy.current = false; setRefreshing(false); }
  }, [appendLog]);

  useEffect(() => {
    void refreshMarkets();
    const refreshOnWake = () => void refreshMarkets();
    const handleVisibility = () => { if (document.visibilityState === "visible") refreshOnWake(); };
    const timer = window.setInterval(refreshOnWake, 15000);
    window.addEventListener("focus", refreshOnWake);
    window.addEventListener("online", refreshOnWake);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshOnWake); window.removeEventListener("online", refreshOnWake); document.removeEventListener("visibilitychange", handleVisibility); };
  }, [refreshMarkets]);
  const streamAssetKey = useMemo(() => [...new Set(markets.map((market) => market.asset))].sort().join(","), [markets]);
  const streamTokenKey = useMemo(() => [...new Set(markets.flatMap((market) => [market.upTokenId, market.downTokenId]))].sort().join(","), [markets]);
  const streamAssets = useMemo(() => streamAssetKey ? streamAssetKey.split(",") : [], [streamAssetKey]);
  const streamTokens = useMemo(() => streamTokenKey ? streamTokenKey.split(",") : [], [streamTokenKey]);
  useEffect(() => {
    if (!streamAssets.length) return;
    return subscribePolymarketPrices(streamAssets, (ticks) => {
      const now = Date.now();
      for (const tick of ticks) {
        const key = `${tick.asset}:${tick.priceFeed}:${tick.timestamp}`;
        polymarketPriceTickCache.current.set(key, tick);
        if (marketsRef.current.some((market) => market.startTimeVerified && market.asset === tick.asset && market.priceFeed === tick.priceFeed && market.startTime === tick.timestamp)) {
          polymarketOpeningTickCache.current.set(key, tick);
          try { window.localStorage.setItem(OPENING_TICKS_STORAGE_KEY, JSON.stringify([...polymarketOpeningTickCache.current.values()].slice(-500))); }
          catch { /* The market state effect also persists exact openings after React commits. */ }
        }
      }
      const cutoff = now - 20 * 60_000;
      for (const [key, tick] of polymarketPriceTickCache.current) if (tick.timestamp < cutoff) polymarketPriceTickCache.current.delete(key);
      if (polymarketPriceTickCache.current.size > 30_000) {
        const ordered = [...polymarketPriceTickCache.current.entries()].sort((left, right) => left[1].timestamp - right[1].timestamp);
        for (const [key] of ordered.slice(0, ordered.length - 30_000)) polymarketPriceTickCache.current.delete(key);
      }
      setMarkets((current) => current.map((market) => applyPolymarketPriceTicks(market, ticks, now)));
    }, setPolymarketStreamStatus);
  }, [streamAssetKey, streamAssets]);
  useEffect(() => {
    if (!streamAssetKey || !streamTokenKey) return;
    let disposed = false;
    let liveSockets = 0;
    let fallbackActivated = false;
    const retries = new Set<number>();
    const markSocket = (isLive: boolean) => {
      liveSockets = Math.max(0, liveSockets + (isLive ? 1 : -1));
      setStreamStatus(liveSockets >= 2 ? "LIVE" : fallbackActivated ? "REST FALLBACK" : "CONNECTING");
    };
    const reconnect = (connect: () => void, delay: number) => {
      const timer = window.setTimeout(() => { retries.delete(timer); if (!disposed) connect(); }, delay);
      retries.add(timer);
    };
    const connectCoinbase = () => {
      let opened = false;
      let socket: WebSocket;
      try { socket = new WebSocket("wss://ws-feed.exchange.coinbase.com"); }
      catch { reconnect(connectCoinbase, 3000); return; }
      socket.onopen = () => {
        opened = true; markSocket(true);
        socket.send(JSON.stringify({ type: "subscribe", product_ids: streamAssets.map((asset) => `${asset}-USD`), channels: ["ticker"] }));
      };
      socket.onmessage = (message) => {
        try {
          const tick = JSON.parse(String(message.data)) as { type?: string; product_id?: string; price?: string };
          if (tick.type !== "ticker" || !tick.product_id || !tick.price) return;
          const asset = tick.product_id.replace(/-USD$/, ""); const spot = Number(tick.price); const now = Date.now();
          if (!Number.isFinite(spot) || spot <= 0) return;
          setMarkets((current) => current.map((market) => {
            if (market.asset !== asset) return market;
            // Coinbase updates the research candles only. The market's displayed
            // current price, opening target, and probability use its own oracle.
            return { ...market, ...updateLiveCandles(market, spot, now), chartUpdatedAt: now };
          }));
          setLastUpdated(now);
        } catch { /* Ignore malformed exchange messages; REST refresh remains available. */ }
      };
      socket.onclose = () => { if (opened) markSocket(false); reconnect(connectCoinbase, 1500); };
      socket.onerror = () => socket.close();
      sockets.push(socket);
    };
    const connectClob = () => {
      let opened = false;
      let socket: WebSocket;
      try { socket = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market"); }
      catch { reconnect(connectClob, 3000); return; }
      socket.onopen = () => {
        opened = true; markSocket(true);
        socket.send(JSON.stringify({ type: "market", assets_ids: streamTokens, custom_feature_enabled: true }));
      };
      socket.onmessage = (message) => {
        try {
          const packet = JSON.parse(String(message.data)); const events = Array.isArray(packet) ? packet : [packet]; const now = Date.now();
          for (const rawEvent of events) {
            const event = rawEvent.payload && typeof rawEvent.payload === "object" ? { ...rawEvent.payload, event_type: rawEvent.type } : rawEvent;
            const kind = event.event_type ?? event.type;
            if (kind === "book") {
              const tokenId = String(event.asset_id ?? event.token_id ?? event.tokenId ?? "");
              const parseLevels = (value: unknown) => Array.isArray(value) ? value.flatMap((level: { price?: unknown; size?: unknown }) => { const price = Number(level.price); const size = Number(level.size); return Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0 ? [{ price, size }] : []; }) : [];
              const bids = parseLevels(event.bids); const asks = parseLevels(event.asks);
              if (!tokenId) continue;
              setMarkets((current) => current.map((market) => replaceLiveMarketBook(market, tokenId, bids, asks, Number(event.timestamp) || now, String(event.hash ?? "") || null, now)));
              setLastUpdated(now);
              continue;
            }
            const updates = kind === "price_change" ? (event.price_changes ?? event.priceChanges ?? []) : [event];
            if (!Array.isArray(updates)) continue;
            for (const update of updates) {
              const tokenId = String(update.asset_id ?? update.token_id ?? update.tokenId ?? "");
              if (!tokenId) continue;
              const bidValue = update.best_bid ?? update.bestBid;
              const askValue = update.best_ask ?? update.bestAsk;
              const bid = bidValue === null || bidValue === undefined ? null : Number(bidValue);
              const ask = askValue === null || askValue === undefined ? null : Number(askValue);
              const price = Number(update.price); const size = Number(update.size);
              setMarkets((current) => current.map((market) => {
                if (market.upTokenId !== tokenId && market.downTokenId !== tokenId) return market;
                if (kind === "price_change" && (update.side === "BUY" || update.side === "SELL") && Number.isFinite(price) && Number.isFinite(size)) return updateLiveMarketBookLevel(market, tokenId, update.side, price, size, now);
                const isUp = market.upTokenId === tokenId;
                const upBid = isUp && bidValue !== undefined ? (bid !== null && Number.isFinite(bid) ? bid : null) : market.upBid;
                const upAsk = isUp && askValue !== undefined ? (ask !== null && Number.isFinite(ask) ? ask : null) : market.upAsk;
                const downBid = !isUp && bidValue !== undefined ? (bid !== null && Number.isFinite(bid) ? bid : null) : market.downBid;
                const downAsk = !isUp && askValue !== undefined ? (ask !== null && Number.isFinite(ask) ? ask : null) : market.downAsk;
                const fairUp = market.fairUp;
                const spreads = [upBid !== null && upAsk !== null ? upAsk - upBid : null, downBid !== null && downAsk !== null ? downAsk - downBid : null].filter((value): value is number => value !== null);
                return { ...market, upBid, upAsk, downBid, downAsk, spread: spreads.length ? Math.max(...spreads) : null, edgeUp: fairUp !== null && upAsk !== null ? fairUp - upAsk : null, edgeDown: fairUp !== null && downAsk !== null ? 1 - fairUp - downAsk : null, sourceTimestamp: now };
              }));
              setLastUpdated(now);
            }
          }
        } catch { /* Ignore malformed CLOB messages; REST refresh remains available. */ }
      };
      const heartbeat = window.setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send("PING"); }, 10000);
      socket.onclose = () => { window.clearInterval(heartbeat); if (opened) markSocket(false); reconnect(connectClob, 1500); };
      socket.onerror = () => socket.close();
      sockets.push(socket);
    };
    const sockets: WebSocket[] = [];
    connectCoinbase(); connectClob();
    const fallbackTimer = window.setTimeout(() => { fallbackActivated = true; if (liveSockets < 2) setStreamStatus("REST FALLBACK"); }, 10000);
    return () => { disposed = true; window.clearTimeout(fallbackTimer); for (const timer of retries) window.clearTimeout(timer); for (const socket of sockets) socket.close(); };
  }, [streamAssetKey, streamTokenKey, streamAssets, streamTokens]);
  useEffect(() => { if (markets.length && !markets.some((market) => market.id === selectedMarketId)) setSelectedMarketId(markets[0].id); }, [markets, markets.length, selectedMarketId]);
  useEffect(() => { setAccount((current) => markAccount(current, marketMap, Date.now(), costs)); }, [costs, marketMap]);
  useEffect(() => {
    const refreshRiskBaselines = () => setAccount((current) => updatePaperRiskBaselines(current,
      accountLiquidationEquity(current, marketMap, costs), Date.now()));
    const timer = window.setInterval(refreshRiskBaselines, 1000);
    return () => window.clearInterval(timer);
  }, [costs, marketMap]);

  useEffect(() => {
    if (!engineRunning) return;
    const now = Date.now();
    const simulationMarkets = new Map(liveMarketMap);
    for (const [marketId, snapshot] of ledgerSnapshots.current) if (!simulationMarkets.has(marketId)) simulationMarkets.set(marketId, snapshot.market);
    if (paperTest.status === "RUNNING" && paperTest.endsAt !== null && now >= paperTest.endsAt) {
      const complete = account.positions.length === 0;
      setPaperTest((current) => ({ ...current, status: complete ? "COMPLETE" : "PENDING_RESOLUTION", balance: accountEquity(account, simulationMarkets), trades: account.fills.filter((fill) => fill.action === "BUY").length, openPositions: account.positions.length, realizedPnl: account.realizedPnl, winRate: accountWinRate(account) }));
      setEngineRunning(false); setPaused(true);
      appendLog(complete ? "Forward paper test complete" : "Forward paper test ended; awaiting Gamma", complete ? `${paperTest.days} day${paperTest.days === 1 ? "" : "s"} elapsed · no open positions · ${account.fills.filter((fill) => fill.action === "BUY").length} entries recorded.` : `${paperTest.days} day${paperTest.days === 1 ? "" : "s"} elapsed · ${account.positions.length} positions remain open until their final Polymarket outcomes are available.`, complete ? "positive" : "warning");
      return;
    }
    if (!killSwitch && account.positions.length) {
      const exitIds = new Set<string>();
      const exitDetails: string[] = [];
      const activePositionIds = new Set(account.positions.map((position) => position.id));
      for (const key of paperExitObservations.current.keys()) if (!activePositionIds.has(key)) paperExitObservations.current.delete(key);
      for (const position of account.positions) {
        const market = simulationMarkets.get(position.marketId);
        const fairUp = market ? anchoredFairUp(market) : null;
        if (!market || fairUp === null || market.remaining <= 0 || marketDataFreshnessIssue(market, now)) {
          paperExitObservations.current.delete(position.id);
          continue;
        }
        const fairProbability = position.side === "UP" ? fairUp : 1 - fairUp;
        const exitFill = estimatePaperExitFill(market, position.side, position.shares, costs);
        if (!exitFill) { paperExitObservations.current.delete(position.id); continue; }
        const exitSignal = analyzeMarketSignal(market, costs, Math.max(1, position.totalCost), config.minEdge);
        const liquidationEquity = accountLiquidationEquity(account, simulationMarkets, costs);
        const tier = bankrollProfile(liquidationEquity);
        const tierPolicy = { ...config, earlyExitMinProfitUsd: Math.min(config.earlyExitMinProfitUsd,
          Math.max(0.03, position.totalCost * (tier.tier === "MICRO" ? 0.04 : tier.tier === "SMALL" ? 0.05 : 0.08))) };
        const evaluation = evaluatePaperHoldExit({ policy: tierPolicy, entryCostUsd: position.totalCost,
          originalShares: position.shares, filledShares: exitFill.shares, netExitProceedsUsd: exitFill.totalCost,
          sideFairProbability: fairProbability, remainingSeconds: market.remaining,
          directionalReversal: exitSignal.bias === (position.side === "UP" ? "DOWN" : "UP") && (exitSignal.biasConfidence ?? 0) >= 0.62 });
        if (!evaluation.shouldExit) {
          paperExitObservations.current.delete(position.id);
          continue;
        }
        const previous = paperExitObservations.current.get(position.id);
        const count = previous && now - previous.lastSeen <= 15_000 ? previous.count + 1 : 1;
        paperExitObservations.current.set(position.id, { count, lastSeen: now });
        if (count >= config.earlyExitConfirmations) {
          exitIds.add(position.id);
          exitDetails.push(`${position.asset} ${position.duration} ${position.side} ${evaluation.reason}`);
        }
      }
      if (exitIds.size) {
        const earlyExit = closePaperPositions(account, simulationMarkets, costs, "model-aware early exit", now, exitIds);
        if (earlyExit.closed) {
          setAccount(markAccount(earlyExit.account, simulationMarkets, now, costs));
          for (const id of exitIds) paperExitObservations.current.delete(id);
          appendLog("Model-aware paper cashout", `${exitDetails.join(" · ")} · ${signedDollars(earlyExit.realized)} realized.`, earlyExit.realized >= 0 ? "positive" : "warning");
          return;
        }
      }
    } else if (!config.earlyExitEnabled) {
      paperExitObservations.current.clear();
    }
    if (paused || killSwitch || !markets.length) return;
    const liquidEquity = accountLiquidationEquity(account, marketMap, costs);
    const dayStartLiquidation = account.riskDayStartEquityUsd ?? account.startingCash;
    const risk = assessBankrollRisk({ equityUsd: liquidEquity, dayStartEquityUsd: dayStartLiquidation,
      peakEquityUsd: account.peakLiquidationEquityUsd ?? account.startingCash });
    const configuredDailyLossPct = dayStartLiquidation > 0 ? Math.max(0, (dayStartLiquidation - liquidEquity) / dayStartLiquidation) : 1;
    if (!risk.approved || configuredDailyLossPct >= config.maxLoss) {
      setEngineRunning(false); setPaused(true);
      appendLog("Paper risk halt triggered", !risk.approved ? risk.reason : `Daily liquidation loss reached the configured ${percentage(config.maxLoss)} ceiling.`, "negative");
      return;
    }
    const candidates = liveMarkets.map((market) => ({ market, opportunity: evaluatePaperMarket({ market, markets: marketMap, account, costs,
      liquidationEquityUsd: liquidEquity, maxTradeUsd: config.maxTrade, minNetEdge: config.minEdge, now }) }))
      .filter((item) => item.opportunity.approved)
      .sort((left, right) => (right.opportunity.score?.score ?? 0) - (left.opportunity.score?.score ?? 0));
    const next = candidates[0];
    if (!next) return;
    const last = autoLastFill.current.get(next.market.id) ?? 0;
    if (now - last < 15_000) return;
    const refreshed = evaluatePaperMarket({ market: next.market, markets: marketMap, account, costs,
      liquidationEquityUsd: liquidEquity, maxTradeUsd: config.maxTrade, minNetEdge: config.minEdge, now });
    if (!refreshed.approved || refreshed.signal.action === "PASS") return;
    const result = buyPaper(account, next.market, refreshed.signal.action, refreshed.stakeUsd, costs, `adaptive ${refreshed.sizing?.tier} score ${refreshed.score?.score ?? 0}`, now);
    if (!result.fill) return;
    autoLastFill.current.set(next.market.id, now);
    setAccount(markAccount(result.account, marketMap, now, costs));
    appendLog(`${next.market.asset} ${next.market.duration} paper fill`, `${refreshed.signal.action} · ${result.fill.shares.toFixed(2)} shares @ ${cents(result.fill.price)} · ${dollars(result.fill.totalCost)} stake · edge ${percentage(refreshed.signal.edge)} · score ${refreshed.score?.score ?? 0}`, "positive");
  }, [account, config, costs, engineRunning, killSwitch, liveMarketMap, liveMarkets, marketMap, markets.length, paused, maxDrawdown, appendLog, paperTest.days, paperTest.endsAt, paperTest.status]);

  const startEngine = () => { if (killSwitch) { appendLog("Start blocked by kill switch", "Reset the paper session before enabling the engine.", "negative"); return; } setEngineRunning(true); setPaused(false); setPaperTest((current) => current.status === "PAUSED" ? { ...current, status: "RUNNING" } : current); setView("paper"); appendLog("Paper engine started", "The Paper Trader and Paper Lab now use the same shared account, positions, and resolution ledger.", "positive"); };
  const togglePause = () => { const nextPaused = !paused; setPaused(nextPaused); setPaperTest((current) => current.status === "RUNNING" || current.status === "PAUSED" ? { ...current, status: nextPaused ? "PAUSED" : "RUNNING" } : current); appendLog(nextPaused ? "New paper trades paused" : "Paper engine resumed", "Existing shared positions remain marked and will settle from market outcomes.", "warning"); };
  const cancelOrders = () => { setAccount((current) => ({ ...current, openOrders: 0 })); appendLog("Paper order queue cleared", "Immediate paper fills are already ledgered; there were no live orders to cancel.", "warning"); };
  const closePositions = () => { const result = closePaperPositions(account, marketMap, costs, "manual close all"); setAccount(markAccount(result.account, marketMap, Date.now(), costs)); appendLog(result.closed ? "Paper positions closed" : "No executable paper exits", `${result.closed} closed · ${result.skipped} held because no fresh executable bid was available.`, result.closed ? "positive" : "warning"); };
  const triggerKillSwitch = () => { setKillSwitch(true); setEngineRunning(false); setPaused(true); setPaperTest((current) => current.status === "RUNNING" ? { ...current, status: "PAUSED" } : current); setAccount((current) => ({ ...current, openOrders: 0 })); appendLog("EMERGENCY KILL SWITCH", "Auto execution disabled and new shared paper orders blocked.", "negative"); };
  const resetPaperSession = () => { if ((account.positions.length || account.fills.length || account.closedTrades.length) && typeof window !== "undefined" && !window.confirm("Reset this paper balance and discard its browser-local trade ledger?")) return; const startingCash = Number(startingCashInput); const next = createPaperAccount(Number.isFinite(startingCash) && startingCash > 0 ? startingCash : 100); setAccount(next); setPaperTest({ status: "IDLE", startingBalance: next.startingCash, days: 1, startedAt: null, endsAt: null, balance: next.startingCash, trades: 0, openPositions: 0, realizedPnl: 0, winRate: null }); setKillSwitch(false); setEngineRunning(false); setPaused(false); appendLog("Shared paper account reset", `New empty ledger created with ${dollars(next.startingCash)} starting cash.`, "neutral"); };
  const manualBuy = (side: PaperSide) => {
    if (!selectedMarket || killSwitch || paused) {
      if (paused) appendLog(`${side} paper entry blocked`, "Pause is active; resume new paper entries first.", "warning");
      return;
    }
    const opportunity = evaluatePaperMarket({ market: selectedMarket, markets: marketMap, account, costs,
      liquidationEquityUsd: accountLiquidationEquity(account, marketMap, costs), maxTradeUsd: config.maxTrade, minNetEdge: config.minEdge, now: Date.now() });
    if (!opportunity.approved || opportunity.signal.action !== side) {
      appendLog(`${side} paper entry blocked`, opportunity.reason, "warning");
      return;
    }
    const result = buyPaper(account, selectedMarket, side, opportunity.stakeUsd, costs, `adaptive ${opportunity.sizing?.tier} manual entry`);
    if (!result.fill) { appendLog(`${side} paper order rejected`, result.error ?? "No executable public ask depth.", "warning"); return; }
    setAccount(markAccount(result.account, marketMap, Date.now(), costs)); setView("paper");
    appendLog(`${selectedMarket.asset} ${selectedMarket.duration} paper fill`, `${side} · ${result.fill.shares.toFixed(2)} shares @ ${cents(result.fill.price)} · ${dollars(result.fill.totalCost)} including fee`, "positive");
  };
  const handleCsvUpload = async (file: File | undefined) => { if (!file) return; const parsed = parseBacktestCsv(await file.text()); setBacktestRows(parsed.rows); setBacktestRejected(parsed.rejected); setBacktestResult(null); appendLog("Backtest dataset loaded", `${parsed.rows.length} valid rows · ${parsed.rejected} rejected rows · ${file.name}`, parsed.rows.length ? "positive" : "warning"); };
  const useRecordedTicks = () => { setBacktestRows(recordedTicks); setBacktestRejected(0); setBacktestResult(null); appendLog("Recorded public ticks selected", `${recordedTicks.length} rows from this browser session; outcomes are not invented.`, recordedTicks.length ? "positive" : "warning"); };
  const downloadTemplate = () => { const blob = new Blob([backtestCsvTemplate], { type: "text/csv" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "polymarket-backtest-template.csv"; anchor.click(); URL.revokeObjectURL(url); };
  const executeBacktest = () => { if (!backtestRows.length) return; const result = runBacktest(backtestRows, { startingCash: backtestStartingCash, minEdge: config.minEdge, maxTrade: config.maxTrade, feeRate: config.feeRate, slippageBps: config.slippageBps }); setBacktestResult(result); appendLog("Backtest completed", `${result.signals} signals · ${result.settled} settled · ${result.unsettled} unsettled`, result.settled ? "positive" : "warning"); };

  const startPaperTest = () => {
    const startingBalance = clamp(Number(paperTestStartingBalanceInput), 1, 1_000_000_000);
    const days = clamp(Math.floor(Number(paperTestDurationDaysInput)), 1, 90);
    if (!Number.isFinite(startingBalance) || !Number.isFinite(days)) return;
    if ((account.positions.length || account.fills.length || account.closedTrades.length) && typeof window !== "undefined" && !window.confirm("Starting this test resets the shared Paper Trader and Paper Lab account. Continue?")) return;
    const now = Date.now();
    const endsAt = now + days * 24 * 60 * 60 * 1000;
    setAccount(createPaperAccount(startingBalance, now));
    setKillSwitch(false); setEngineRunning(true); setPaused(false);
    setPaperTest({ status: "RUNNING", startingBalance, days, startedAt: now, endsAt, balance: startingBalance, trades: 0, openPositions: 0, realizedPnl: 0, winRate: null });
    setView("backtest");
    appendLog("Shared forward paper test started", `${dollars(startingBalance)} shared starting balance · ${days} day${days === 1 ? "" : "s"} · the Paper Trader and Paper Lab are using one account.`, "positive");
  };
  const togglePaperTestPause = () => {
    if (paperTest.status === "RUNNING" || paperTest.status === "PAUSED") togglePause();
  };
  const stopPaperTest = () => {
    if (paperTest.status !== "RUNNING" && paperTest.status !== "PAUSED") return;
    setPaperTest((current) => ({ ...current, status: "COMPLETE", balance: accountEquity(account, liveMarketMap), trades: account.fills.filter((fill) => fill.action === "BUY").length, openPositions: account.positions.length, realizedPnl: account.realizedPnl, winRate: accountWinRate(account) }));
    setEngineRunning(false); setPaused(true);
    appendLog("Shared forward paper test stopped", `${account.fills.filter((fill) => fill.action === "BUY").length} entries recorded before the shared engine stopped.`, "warning");
  };
  const resetPaperTest = () => {
    const startingBalance = clamp(Number(paperTestStartingBalanceInput), 1, 1_000_000_000);
    if ((account.positions.length || account.fills.length || account.closedTrades.length) && typeof window !== "undefined" && !window.confirm("Resetting the test resets the shared Paper Trader and Paper Lab account. Continue?")) return;
    const next = createPaperAccount(Number.isFinite(startingBalance) ? startingBalance : 100);
    setAccount(next); setKillSwitch(false); setEngineRunning(false); setPaused(false);
    setPaperTest({ status: "IDLE", startingBalance: next.startingCash, days: Math.max(1, Math.floor(Number(paperTestDurationDaysInput)) || 1), startedAt: null, endsAt: null, balance: next.startingCash, trades: 0, openPositions: 0, realizedPnl: 0, winRate: null });
    appendLog("Shared paper account reset", "The Paper Trader and Paper Lab were cleared together; the all-market decision ledger was preserved.", "neutral");
  };

  const exportDecisionLedger = () => {
    if (typeof window === "undefined" || !ledgerRows.length) return;
    const blob = new Blob([decisionLedgerCsv(ledgerRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `polymarket-decision-ledger-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
  };
  const clearDecisionLedger = () => {
    if (typeof window !== "undefined" && !window.confirm("Clear the complete browser-local market decision ledger? This cannot be undone.")) return;
    setLedgerRows([]); ledgerSnapshots.current.clear(); appendLog("Decision ledger cleared", "All browser-local UP, DOWN, PASS, and outcome rows were removed.", "warning");
  };

  const telegramRequest = useCallback(async (body: Record<string, unknown>) => fetch("/api/telegram", { body: JSON.stringify(body), cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, method: "POST" }), []);
  const refreshTelegramStatus = useCallback(async () => {
    try {
      const response = await telegramRequest({ action: "status" });
      const payload = await response.json() as { ok?: boolean; error?: string; telegram?: Partial<TelegramViewState> };
      if (!response.ok || !payload.ok || !payload.telegram) {
        if (response.status === 401) setTelegram((current) => ({ ...current, connected: false }));
        throw new Error(payload.error || "Telegram status is unavailable.");
      }
      setTelegram((current) => ({ ...current, connected: true, botUsername: payload.telegram?.botUsername ?? "", botName: payload.telegram?.botName ?? "", chatId: payload.telegram?.chatId ?? "", chatTitle: payload.telegram?.chatTitle ?? "", expiresAt: payload.telegram?.expiresAt ?? null, lastError: "", lastStatus: "Telegram link is ready." }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Telegram status is unavailable.";
      if (!detail.includes("expired") && !detail.includes("Sign in")) setTelegram((current) => ({ ...current, lastError: detail }));
    }
  }, [telegramRequest]);
  useEffect(() => { void refreshTelegramStatus(); }, [refreshTelegramStatus]);
  const connectTelegram = useCallback(async (botToken: string, chatId: string): Promise<boolean> => {
    try {
      const response = await telegramRequest({ action: "connect", botToken, chatId });
      const payload = await response.json() as { ok?: boolean; error?: string; telegram?: Partial<TelegramViewState> };
      if (!response.ok || !payload.ok || !payload.telegram) throw new Error(payload.error || "Telegram link failed.");
      setTelegram((current) => ({ ...current, connected: true, botUsername: payload.telegram?.botUsername ?? "", botName: payload.telegram?.botName ?? "", chatId: payload.telegram?.chatId ?? chatId, chatTitle: payload.telegram?.chatTitle ?? chatId, expiresAt: payload.telegram?.expiresAt ?? null, lastStatus: "Telegram linked and verified.", lastError: "" }));
      appendLog("Telegram reports linked", `Verified ${payload.telegram.botUsername ? "@" + payload.telegram.botUsername : "the Telegram bot"} for ${payload.telegram.chatTitle || chatId}.`, "positive");
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Telegram link failed.";
      setTelegram((current) => ({ ...current, lastError: detail })); appendLog("Telegram link failed", detail, "negative"); return false;
    }
  }, [appendLog, telegramRequest]);
  const disconnectTelegram = () => {
    void telegramRequest({ action: "disconnect" }).catch(() => undefined);
    setTelegram({ connected: false, botUsername: "", botName: "", chatId: "", chatTitle: "", expiresAt: null, lastStatus: "Telegram unlinked.", lastError: "" });
    appendLog("Telegram reports unlinked", "The encrypted Telegram session cookie was cleared.", "neutral");
  };
  const telegramReportText = useCallback((label: string) => {
    const recentRows = ledgerRows.slice().sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt).slice(0, 8);
    const testLine = paperTestView.startedAt ? `${paperTestView.status} · ${paperTestView.days}d · ${dollars(paperTestView.balance)} shared balance · ${signedDollars(paperTestView.realizedPnl)} realized · ${paperTestView.openPositions} open` : "No timeframe paper test started";
    const lines = [
      `Polymarket Quant Engine · ${label}`,
      `Eastern time: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}`,
      `Tracked: ${ledgerMetrics.tracked} · UP ${ledgerMetrics.up} · DOWN ${ledgerMetrics.down} · PASS ${ledgerMetrics.pass}`,
      `Settled: ${ledgerMetrics.settled} · combined ${percentage(ledgerMetrics.combinedWinRate)} · UP ${percentage(ledgerMetrics.upWinRate)} · DOWN ${percentage(ledgerMetrics.downWinRate)}`,
      `Paper test: ${testLine}`,
      "Recent decisions:",
      ...recentRows.map((row) => `${row.asset} ${row.duration} · ${row.decision} · ${row.result}${row.outcome ? ` (${row.outcome})` : ""} · ${new Date(row.observedAt).toISOString()}`),
    ];
    return lines.join("\n").slice(0, 3900);
  }, [ledgerMetrics, ledgerRows, paperTestView]);
  const sendTelegramReport = useCallback(async (label: string): Promise<boolean> => {
    if (!telegram.connected || telegramSendBusy.current) return false;
    telegramSendBusy.current = true;
    try {
      const response = await telegramRequest({ action: "send-report", text: telegramReportText(label) });
      const payload = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Telegram report failed.");
      setTelegram((current) => ({ ...current, lastStatus: `${label} sent to Telegram.`, lastError: "" }));
      appendLog("Telegram report sent", label, "positive");
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Telegram report failed.";
      setTelegram((current) => ({ ...current, lastError: detail })); appendLog("Telegram report failed", detail, "negative"); return false;
    } finally { telegramSendBusy.current = false; }
  }, [appendLog, telegram.connected, telegramReportText, telegramRequest]);
  const sendTelegramTest = () => { void sendTelegramReport("Manual test report"); };
  useEffect(() => {
    if (!telegram.connected) return;
    const checkSchedule = () => {
      const parts = new Intl.DateTimeFormat("en-US", { day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", timeZone: "America/New_York", weekday: "short", year: "numeric" }).formatToParts(new Date());
      const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
      if (part("weekday") !== "Sun" || Number(part("hour")) !== 21 || Number(part("minute")) > 2) return;
      const weekKey = `${part("year")}-${part("month")}-${part("day")}`;
      if (readStoredJson<{ weekKey?: string }>(TELEGRAM_LAST_SENT_KEY)?.weekKey === weekKey) return;
      void sendTelegramReport("Scheduled Sunday 9pm ET report").then((sent) => { if (sent && typeof window !== "undefined") window.localStorage.setItem(TELEGRAM_LAST_SENT_KEY, JSON.stringify({ weekKey })); });
    };
    checkSchedule(); const timer = window.setInterval(checkSchedule, 30_000); return () => window.clearInterval(timer);
  }, [sendTelegramReport, telegram.connected]);

  const liveCandidates = useMemo(() => liveMarkets.map((market) => ({ market, signal: analyzeMarketSignal(market, { feeRate: liveRisk.feeRate, slippageBps: liveRisk.slippageBps }, liveRisk.maxTradeUsd, liveRisk.minEdge) })).filter((item) => item.market.remaining >= 30 && liveRisk.allowedDurations.includes(item.market.duration) && item.signal.action !== "PASS" && (!liveRisk.requireLock || item.signal.tier === "LOCK")).sort((left, right) => (right.signal.edge ?? -1) - (left.signal.edge ?? -1)), [liveMarkets, liveRisk]);
  const liveRequest = useCallback(async (body: Record<string, unknown>, confirm = false) => fetch("/api/polymarket/live", { body: JSON.stringify(body), cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json", ...(confirm ? { "x-polymarket-live-confirm": "1" } : {}) }, method: "POST" }), []);
  const refreshLivePositions = useCallback(async () => {
    if (!liveSession?.connected || livePositionRefreshBusy.current) return;
    livePositionRefreshBusy.current = true;
    try {
      const response = await liveRequest({ action: "positions" });
      const payload = await response.json() as { ok?: boolean; error?: string; positions?: LivePositionSnapshot[] };
      if (!response.ok || !payload.ok || !Array.isArray(payload.positions)) throw new Error(payload.error || "Live positions could not be refreshed.");
      livePositionsRef.current = payload.positions.filter((position) => (position.size ?? 0) > 0);
      livePositionRefreshedAt.current = Date.now();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Live positions could not be refreshed.";
      appendLog("Live positions unavailable", detail, "warning");
    } finally {
      livePositionRefreshedAt.current = Date.now();
      livePositionRefreshBusy.current = false;
    }
  }, [appendLog, liveRequest, liveSession?.connected]);
  const refreshLiveBalance = useCallback(async () => {
    if (!liveSession?.connected) return;
    try {
      const response = await liveRequest({ action: "balance" });
      const payload = await response.json() as { ok?: boolean; error?: string; live?: LiveSessionState };
      if (!response.ok || !payload.ok || !payload.live) throw new Error(payload.error || "Live balance refresh failed.");
      setLiveSession({ ...payload.live, connected: true }); setLiveStatus((current) => ({ ...current, lastError: "" })); appendLog("Live balance refreshed", String(payload.live.openOrders) + " open CLOB orders · " + dollars(payload.live.balance), "positive");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Live balance refresh failed.";
      setLiveStatus((current) => ({ ...current, lastError: detail })); appendLog("Live balance unavailable", detail, "negative");
    }
  }, [appendLog, liveRequest, liveSession?.connected]);
  const startLiveExecutor = () => {
    if (!liveSession?.connected) { setView("account"); setAccountDialogOpen(true); return; }
    if (!liveConsent || killSwitch) { setLiveStatus((current) => ({ ...current, lastError: killSwitch ? "Reset the paper risk halt before starting live execution." : "Confirm the live-order risk notice before starting." })); return; }
    setLiveStatus({ lastAction: "LIVE RUNNER STARTED", lastDetail: "Scanning fresh validated 5m/15m markets with fractional Kelly sizing.", lastError: "", lastLatencyMs: null }); setLiveRunning(true); setLivePaused(false); setView("live"); appendLog("Live executor started", "Owner-authenticated runner is scanning balance-aware LOCK signals. Orders remain capped by the Live Risk Policy.", "warning");
  };
  const toggleLivePause = () => { setLivePaused((current) => !current); setLiveStatus((current) => ({ ...current, lastError: "" })); appendLog(livePaused ? "Live executor resumed" : "Live new orders paused", "Existing CLOB orders are not automatically cancelled; use Kill + Cancel All when needed.", "warning"); };
  const killLiveExecutor = async () => {
    setLiveRunning(false); setLivePaused(true); setLiveConsent(false);
    if (!liveSession?.connected) return;
    try {
      const response = await liveRequest({ action: "cancel-all", confirmLive: true }, true);
      const payload = await response.json() as { ok?: boolean; error?: string; status?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Cancel-all request failed.");
      setLiveStatus({ lastAction: "KILL SWITCH", lastDetail: "Live runner stopped and Polymarket cancel-all returned successfully.", lastError: "", lastLatencyMs: null }); appendLog("LIVE KILL + CANCEL ALL", "New live submissions stopped; the server accepted the explicit cancel-all request.", "negative");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Cancel-all request failed.";
      setLiveStatus({ lastAction: "LIVE RUNNER STOPPED", lastDetail: "Cancel-all could not be confirmed. Reconcile open orders in Account.", lastError: detail, lastLatencyMs: null }); appendLog("Live cancel-all uncertain", detail, "negative");
    }
  };
  useEffect(() => {
    if (!liveRunning || livePaused || !liveSession?.connected || killSwitch) return;
    let disposed = false;
    let timer: number | undefined;
    const loop = async () => {
      if (disposed) return;
      if (liveBusy.current) { timer = window.setTimeout(() => void loop(), 900); return; }
      const now = Date.now();
      if (liveRisk.earlyExitEnabled && now - livePositionRefreshedAt.current >= 5_000) {
        if (!livePositionsRef.current.length) await refreshLivePositions();
        else void refreshLivePositions();
      }
      if (liveRisk.earlyExitEnabled && livePositionsRef.current.length) {
        const activePositionKeys = new Set<string>();
        const exitCandidates: Array<{ position: LivePositionSnapshot; market: LiveMarket; side: PaperSide; tokenID: string; evaluation: ReturnType<typeof evaluateModelAwareExit> }> = [];
        for (const position of livePositionsRef.current) {
          const tokenID = position.tokenID ?? position.id;
          const mapped = liveTokenMap.get(tokenID);
          if (!mapped || position.size === null || position.averagePrice === null) continue;
          activePositionKeys.add(tokenID);
          const currentPrice = mapped.side === "UP" ? mapped.market.upBid : mapped.market.downBid;
          const mappedFairUp = anchoredFairUp(mapped.market);
          const fairProbability = mappedFairUp === null ? null : mapped.side === "UP" ? mappedFairUp : 1 - mappedFairUp;
          if (currentPrice === null || fairProbability === null) {
            liveExitObservations.current.delete(tokenID);
            continue;
          }
          const evaluation = evaluateModelAwareExit({ policy: liveRisk, entryPrice: position.averagePrice, currentPrice, fairProbability, shares: position.size, feeRate: liveRisk.feeRate, remainingSeconds: mapped.market.remaining });
          if (!evaluation.shouldExit) {
            liveExitObservations.current.delete(tokenID);
            continue;
          }
          const previous = liveExitObservations.current.get(tokenID);
          const count = previous && now - previous.lastSeen <= 15_000 ? previous.count + 1 : 1;
          liveExitObservations.current.set(tokenID, { count, lastSeen: now });
          if (count >= liveRisk.earlyExitConfirmations) exitCandidates.push({ position, market: mapped.market, side: mapped.side, tokenID, evaluation });
        }
        for (const key of liveExitObservations.current.keys()) if (!activePositionKeys.has(key)) liveExitObservations.current.delete(key);
        const exitCandidate = exitCandidates[0];
        if (exitCandidate) {
          liveBusy.current = true;
          let stopAfterResponse = false;
          try {
            const response = await liveRequest({ action: "exit", marketId: exitCandidate.market.id, tokenID: exitCandidate.tokenID, amount: exitCandidate.position.size, requestId: `exit:${exitCandidate.tokenID}:${Math.floor(now / 10_000)}`, confirmLive: true, config: liveRisk }, true);
            const payload = await response.json() as { ok?: boolean; status?: string; reason?: string; error?: string; uncertain?: boolean; latencyMs?: number; balanceAfter?: number | null; sizing?: { shares?: number; netProfit?: number; modelGap?: number } };
            const latencyMs = typeof payload.latencyMs === "number" ? payload.latencyMs : null;
            const detail = payload.reason || payload.error || "No live exit submitted.";
            setLiveStatus({ lastAction: payload.status === "EXECUTED" ? "EARLY EXIT EXECUTED" : payload.status || "EARLY EXIT PASSED", lastDetail: detail, lastError: payload.uncertain ? (payload.error || "Exit outcome is uncertain; reconcile the Account tab.") : response.ok ? "" : (payload.error || "Live exit request failed."), lastLatencyMs: latencyMs });
            liveExitObservations.current.delete(exitCandidate.tokenID);
            const balanceAfter = typeof payload.balanceAfter === "number" ? payload.balanceAfter : null;
            if (balanceAfter !== null) setLiveSession((current) => current ? { ...current, balance: balanceAfter } : current);
            if (payload.status === "DISABLED") {
              stopAfterResponse = true; setLiveRunning(false); setLivePaused(true); appendLog("Live executor stopped", payload.error || "Live order submissions are disabled by the server.", "warning");
            } else if (payload.uncertain || response.status === 401 || response.status === 403) {
              setLiveRunning(false); setLivePaused(true); appendLog("Live executor stopped", payload.error || "Live exit authorization or submission state needs reconciliation.", "negative");
            } else if (payload.status === "EXECUTED") {
              appendLog(`${exitCandidate.market.asset} ${exitCandidate.market.duration} live early exit`, `${exitCandidate.side} · ${detail} · ${latencyMs ?? "—"} ms`, "positive");
              livePositionRefreshedAt.current = 0;
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : "Live exit request failed.";
            setLiveStatus({ lastAction: "EARLY EXIT ERROR", lastDetail: detail, lastError: detail, lastLatencyMs: null });
            appendLog("Live early exit unavailable", detail, "negative");
            liveExitObservations.current.delete(exitCandidate.tokenID);
          }
          liveBusy.current = false;
          if (!stopAfterResponse) timer = window.setTimeout(() => void loop(), 1_100);
          return;
        }
      }
      const next = liveCandidates.find((item) => now - (liveAttempted.current.get(item.market.id) ?? 0) >= 45000);
      if (!next) {
        const reason = liveCandidates.length ? "Candidates are cooling down after a recent attempt." : "No fresh LOCK candidate passes the configured live gates.";
        if (liveReason.current !== reason) { liveReason.current = reason; setLiveStatus((current) => ({ ...current, lastAction: "SCANNING", lastDetail: reason, lastError: "" })); }
        timer = window.setTimeout(() => void loop(), 1200);
        return;
      }
      liveBusy.current = true;
      const startedAt = Date.now();
      let stopAfterResponse = false;
      try {
        const requestId = next.market.id + ":" + Math.floor(now / 10000);
        const response = await liveRequest({ action: "execute", marketId: next.market.id, requestId, confirmLive: true, config: liveRisk }, true);
        const payload = await response.json() as { ok?: boolean; status?: string; reason?: string; error?: string; uncertain?: boolean; latencyMs?: number; balanceAfter?: number | null; sizing?: { stakeUsd?: number; units?: number }; signal?: { action?: string; tier?: string; edge?: number | null } };
        const latencyMs = typeof payload.latencyMs === "number" ? payload.latencyMs : Date.now() - startedAt;
        const detail = payload.reason || payload.error || (payload.status === "EXECUTED" ? "Order accepted by Polymarket." : "No order submitted.");
        setLiveStatus({ lastAction: payload.status || (response.ok ? "REJECTED" : "ERROR"), lastDetail: detail, lastError: payload.uncertain ? (payload.error || "Execution outcome is uncertain; reconcile the Account tab.") : response.ok ? "" : (payload.error || "Live execution request failed."), lastLatencyMs: latencyMs });
        const balanceAfter = typeof payload.balanceAfter === "number" ? payload.balanceAfter : null;
        if (balanceAfter !== null) setLiveSession((current) => current ? { ...current, balance: balanceAfter } : current);
        liveAttempted.current.set(next.market.id, Date.now());
        if (payload.status === "DISABLED") {
          stopAfterResponse = true; setLiveRunning(false); setLivePaused(true); appendLog("Live executor stopped", payload.error || "Live order submissions are disabled by the server.", "warning");
        } else if (payload.uncertain || response.status === 401 || response.status === 403) {
          setLiveRunning(false); setLivePaused(true); appendLog("Live executor stopped", payload.error || "Live authorization or submission state needs reconciliation.", "negative");
        } else if (payload.status === "EXECUTED") {
          appendLog(next.market.asset + " " + next.market.duration + " LIVE order", String(next.signal.action) + " · " + dollars(payload.sizing?.stakeUsd ?? null) + " · " + String(payload.sizing?.units ?? 0) + " units · " + String(latencyMs) + " ms", "warning");
        } else if (payload.status !== "PASS" && liveReason.current !== detail) {
          liveReason.current = detail; appendLog("Live candidate held", detail, "warning");
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Live execution request failed.";
        setLiveStatus({ lastAction: "ERROR", lastDetail: detail, lastError: detail, lastLatencyMs: Date.now() - startedAt }); setLiveRunning(false); setLivePaused(true); appendLog("Live executor stopped", detail, "negative");
      } finally {
        liveBusy.current = false;
        if (!disposed && !stopAfterResponse) timer = window.setTimeout(() => void loop(), 1100);
      }
    };
    void loop();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [killSwitch, liveCandidates, livePaused, liveRequest, liveRisk, liveRunning, liveSession?.connected, liveTokenMap, refreshLivePositions, appendLog]);

  const statusForData = dataStatus === "error" || dataStatus === "loading" ? "WARN" : "READY"; const selectedOracleTickAt = selectedMarket?.spotUpdatedAt ?? null; const oracleFresh = polymarketStreamStatus === "CONNECTED" && selectedMarket?.spotSource === "POLYMARKET" && selectedOracleTickAt !== null && clock > 0 && clock - selectedOracleTickAt <= 10_000 && selectedOracleTickAt <= clock + 1_000; const oracleStatus: "READY" | "WARN" = oracleFresh ? "READY" : "WARN"; const rangeLength = ({ "5M": 5, "15M": 15, "1H": 60, "6H": 360, "24H": 1440 } as Record<string, number | undefined>)[selectedRange] ?? equitySeries.length; const selectedTicks = selectedRange === "ALL" ? equitySeries : equitySeries.slice(-rangeLength);
  const paperLab = <PaperLabPanel paperTest={paperTestView} paperAccount={account} paperMarkets={liveMarketMap} clock={clock} engineRunning={engineRunning} paused={paused} startingBalanceInput={paperTestStartingBalanceInput} durationDaysInput={paperTestDurationDaysInput} ledgerRows={ledgerRows} metrics={ledgerMetrics} telegram={telegram} onStartingBalanceChange={setPaperTestStartingBalanceInput} onDurationDaysChange={setPaperTestDurationDaysInput} onStart={startPaperTest} onPause={togglePaperTestPause} onStop={stopPaperTest} onReset={resetPaperTest} onExport={exportDecisionLedger} onClearLedger={clearDecisionLedger} onTelegramConnect={connectTelegram} onTelegramDisconnect={disconnectTelegram} onTelegramTest={sendTelegramTest} onTelegramRefresh={() => void refreshTelegramStatus()} />;

    return <><main className="terminal-shell"><aside className="sidebar-rail"><div className="brand-mark" aria-label="Polymarket Quant Engine"><span className="brand-mark-core">P</span><span className="brand-mark-pulse" /></div><nav className="rail-nav" aria-label="Primary navigation"><button className={`rail-button ${view === "overview" ? "active" : ""}`} onClick={() => setView("overview")} type="button" title="Overview"><LayoutDashboard size={19} /></button><button className={`rail-button ${view === "paper" ? "active" : ""}`} onClick={() => setView("paper")} type="button" title="Paper trader"><BarChart3 size={19} /></button><button className={`rail-button ${view === "backtest" ? "active" : ""}`} onClick={() => setView("backtest")} type="button" title="Paper lab"><LineChart size={19} /></button><button className={`rail-button ${view === "account" ? "active" : ""}`} onClick={() => setView("account")} type="button" title="Connected account"><CircleDollarSign size={19} /></button><button className="rail-button" onClick={() => setView("overview")} type="button" title="Public market data"><ScanLine size={19} /></button></nav><div className="rail-bottom"><button className="rail-button" onClick={() => setView("live")} type="button" title="Live executor"><Settings2 size={19} /></button><span className="rail-version">v0.2</span></div></aside>
    <section className="terminal-main"><header className="topbar"><div className="title-block"><div className="eyebrow"><span className="eyebrow-dot" />POLYMARKET / PM5 PREDICTOR</div><h1>Decision terminal</h1><p>Public market data in. Cost-aware paper signals out. Every result traceable.</p></div><div className="topbar-right"><div className="connection-strip"><StatusDot label="GAMMA" status={statusForData} detail="Public market metadata layer" /><StatusDot label="CLOB" status="PUBLIC" detail="Public Polymarket order books" /><StatusDot label="ORACLE" status={oracleStatus} detail={selectedMarket ? oracleFresh ? `${selectedMarket.asset} ${selectedMarket.priceFeed} stream tick ${formatAge(selectedOracleTickAt, clock)} ago; Price to Beat is ${hasVerifiedOpeningReference(selectedMarket) ? "verified" : "still pending"}.` : `${selectedMarket.asset} ${selectedMarket.priceFeed} feed is stale or waiting; entries in this market are blocked.` : "No selected market has an oracle observation."} /><StatusDot label="LEDGER" status="READY" detail="Browser-local paper ledger" /><StatusDot label="ACCOUNT" status={connectedAccount ? "READY" : "LOCKED"} detail="Read-only wallet and CLOB account data" /></div><div className="topbar-actions"><button className="mode-pill runner-pill" onClick={() => setRunnerDialogOpen(true)} type="button"><Terminal size={13} />24/7 RUNNER</button><button className="mode-pill account-mode" onClick={() => setAccountDialogOpen(true)} type="button"><Wallet size={13} />{connectedAccount ? "ACCOUNT READY" : "LINK ACCOUNT"}</button><button className="mode-pill" onClick={() => setView("live")} type="button"><span className="mode-pill-dot" />{liveRunning ? "LIVE ACTIVE" : "PAPER / LIVE"}<ChevronDown size={13} /></button><span className="clock-readout"><Clock3 size={14} />{clock ? new Date(clock).toLocaleTimeString("en-US", { hour12: false, timeZone: "UTC" }) : "--:--:--"} UTC</span></div></div></header>
      {killSwitch ? <div className="critical-banner"><AlertTriangle size={17} /><span><strong>RISK HALT</strong> — paper auto-execution is disabled; reset only after reviewing the ledger.</span><button onClick={resetPaperSession} type="button">Reset empty ledger</button></div> : <div className="info-banner"><Activity size={16} /><span><strong>Paper is the default.</strong> Live execution is opt-in, owner-authenticated, balance-aware, and fail-closed.</span><span className="banner-spacer" /><button onClick={() => setRunnerDialogOpen(true)} type="button">24/7 runner setup <Terminal size={14} /></button><button onClick={() => setView("live")} type="button">Open live executor <ArrowUpRight size={14} /></button></div>}
      <div className="terminal-content"><div className="workspace-tabs" role="tablist" aria-label="Workspace"><button className={view === "overview" ? "active" : ""} onClick={() => setView("overview")} role="tab" aria-selected={view === "overview"} type="button"><LayoutDashboard size={14} />Overview</button><button className={view === "paper" ? "active" : ""} onClick={() => setView("paper")} role="tab" aria-selected={view === "paper"} type="button"><Wallet size={14} />Paper trader</button><button className={view === "backtest" ? "active" : ""} onClick={() => setView("backtest")} role="tab" aria-selected={view === "backtest"} type="button"><LineChart size={14} />Paper lab</button><button className={view === "account" ? "active" : ""} onClick={() => setView("account")} role="tab" aria-selected={view === "account"} type="button"><CircleDollarSign size={14} />Account</button><button className={view === "live" ? "active" : ""} onClick={() => setView("live")} role="tab" aria-selected={view === "live"} type="button"><Zap size={14} />Live executor</button><span className="workspace-tab-spacer" /><span className="data-receipt"><span className={`status-dot ${oracleFresh ? "status-ready" : "status-warning"}`} />{oracleFresh ? `SELECTED ORACLE LIVE · ${formatAge(selectedOracleTickAt, clock)} ago` : `SELECTED ORACLE ${polymarketStreamStatus.toLowerCase()} · entries held`}<span className={`status-dot ${streamStatus === "LIVE" ? "status-ready" : "status-warning"}`} />{streamStatus === "LIVE" ? "books/research live" : `aux ${streamStatus.toLowerCase()}`}</span></div>
        {view === "paper" ? <LocalPaperDaemonPanel /> : null}<section className="control-row" aria-label="Trading controls"><div className="engine-state"><span className={`engine-pulse ${engineRunning && !paused && !killSwitch ? "running" : ""}`} /><span><strong>{killSwitch ? "HALTED" : engineRunning ? (paused ? "PAPER ENGINE PAUSED" : "PAPER ENGINE RUNNING") : "PAPER ENGINE STANDBY"}</strong><small>{engineRunning ? "Candidate scan uses only executable public asks" : "Start the paper engine to scan signals"}</small></span></div><div className="control-buttons"><button className="button-primary" disabled={killSwitch || engineRunning} onClick={startEngine} type="button"><Play size={15} fill="currentColor" />{engineRunning ? "RUNNING" : "START PAPER ENGINE"}</button><button className={`button-secondary ${paused ? "button-warning" : ""}`} disabled={!engineRunning} onClick={togglePause} type="button"><Pause size={15} />{paused ? "RESUME" : "PAUSE NEW TRADES"}</button><button className="button-secondary" onClick={cancelOrders} type="button"><Ban size={15} />CLEAR QUEUE <span className="button-count">{account.openOrders}</span></button><button className="button-secondary" disabled={!account.positions.length} onClick={closePositions} type="button"><Wallet size={15} />CLOSE POSITIONS</button><button className="button-danger" onClick={triggerKillSwitch} type="button"><Zap size={15} />KILL SWITCH</button></div></section>
        {view === "account" ? <AccountView account={connectedAccount} error={accountError} loading={accountLoading} onConnect={() => setAccountDialogOpen(true)} onDisconnect={disconnectAccount} onRefresh={() => void fetchConnectedAccount(accountConnection)} /> : view === "live" ? <LiveExecutionPanel candidateCount={liveCandidates.length} consent={liveConsent} killSwitch={killSwitch} marketCount={liveMarkets.length} onConsentChange={setLiveConsent} onKill={() => void killLiveExecutor()} onLink={() => setAccountDialogOpen(true)} onPause={toggleLivePause} onRefresh={() => void refreshLiveBalance()} onRiskChange={(patch) => setLiveRisk((current) => normalizeLiveRiskConfig({ ...current, ...patch }))} onStart={startLiveExecutor} paused={livePaused} risk={liveRisk} running={liveRunning} session={liveSession} status={liveStatus} /> : view !== "backtest" ? <><section className="metric-grid" aria-label="Paper account summary"><MetricCard label="TOTAL EQUITY" value={dollars(equity)} delta={signedDollars(todayPnl)} deltaTone={todayPnl >= 0 ? "positive" : "negative"} detail="vs. starting cash" icon={<CircleDollarSign size={17} />} spark={selectedTicks} /><MetricCard label="CASH" value={dollars(account.cash)} delta={`${account.positions.length} open`} deltaTone="neutral" detail="available balance" icon={<Wallet size={17} />} /><MetricCard label="SESSION P&L" value={signedDollars(todayPnl)} delta={`${account.fills.length} fills`} deltaTone={todayPnl >= 0 ? "positive" : "negative"} detail="paper ledger" icon={todayPnl >= 0 ? <TrendingUp size={17} /> : <TrendingDown size={17} />} spark={selectedTicks} /><MetricCard label="UNREALIZED" value={signedDollars(unrealized)} delta={`${account.positions.length} positions`} deltaTone={unrealized >= 0 ? "positive" : "negative"} detail="marked to bid" icon={<Activity size={17} />} /><MetricCard label="REALIZED P&L" value={signedDollars(account.realizedPnl)} delta={`${account.closedTrades.length} closed`} deltaTone={account.realizedPnl >= 0 ? "positive" : "negative"} detail="after recorded fees" icon={<Target size={17} />} /><MetricCard label="FEES" value={dollars(account.fees)} delta={`${(config.feeRate * 100).toFixed(2)}% model`} deltaTone="neutral" detail="configured cost" icon={<CircleDot size={17} />} /><MetricCard label="DRAWDOWN" value={percentage(maxDrawdown)} delta={maxDrawdown <= config.maxLoss ? "within limit" : "halt threshold"} deltaTone={maxDrawdown <= config.maxLoss ? "positive" : "negative"} detail={`max ${percentage(config.maxLoss)} configured`} icon={<Gauge size={17} />} /><MetricCard label="WIN RATE" value={percentage(winRate)} delta={account.closedTrades.length ? `${account.closedTrades.length} settled` : "no settled trades"} deltaTone="neutral" detail="paper ledger only" icon={<ShieldCheck size={17} />} /></section>
          <section className="section-heading"><div><div className="eyebrow">PUBLIC MARKET DISCOVERY</div><h2>Active short-duration markets</h2></div><div className="section-heading-right"><span className="last-tick">{filteredMarkets.length ? `${filteredMarkets.length} markets` : "no markets"}</span><span className="last-tick"><span className={`status-dot ${dataStatus === "ready" ? "status-ready" : "status-warning"}`} />{lastUpdated ? formatAge(lastUpdated, clock) : "no tick"}</span><div className="filter-tabs" role="tablist" aria-label="Market duration">{(["ALL", "5m", "15m"] as const).map((filter) => <button aria-selected={durationFilter === filter} className={durationFilter === filter ? "filter-tab active" : "filter-tab"} key={filter} onClick={() => setDurationFilter(filter)} role="tab" type="button">{filter}</button>)}</div><button className="icon-button" disabled={refreshing} onClick={() => void refreshMarkets()} title="Refresh public market discovery" type="button">{refreshing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button></div></section>
          {dataStatus === "error" ? <div className="data-alert"><AlertTriangle size={16} /><div><strong>Public data unavailable</strong><span>{dataError}</span></div><button onClick={() => void refreshMarkets()} type="button">Retry</button></div> : null}{dataStatus === "ready" && !filteredMarkets.length ? <EmptyState title="No eligible markets right now" detail={dataError || "Gamma returned no active crypto markets matching the 5m/15m filters. The engine will keep checking; it will not fabricate quotes."} action={<button className="button-secondary" onClick={() => void refreshMarkets()} type="button"><RefreshCw size={14} />Refresh public feed</button>} /> : null}
          <section className="market-layout">{filteredMarkets.length ? <div className="market-grid" aria-label="Public markets">{filteredMarkets.map((market) => <MarketCard key={market.id} clock={clock} config={config} market={market} onSelect={() => setSelectedMarketId(market.id)} selected={selectedMarket?.id === market.id} />)}</div> : <div />}{selectedMarket && selectedSignal ? <aside className="panel signal-panel" aria-label="Selected market signal">
            <div className="panel-heading"><div><div className="eyebrow">CHART SIGNAL</div><h3>{selectedMarket.asset} {selectedMarket.duration}</h3></div><span className={`action-pill ${currentAction.tone}`}>{currentAction.label}</span></div>
            <p className="market-question signal-question">{selectedMarket.question}</p>
            <div className="signal-hero"><div><span className="metric-label">MARKET-ANCHORED P(UP)</span><strong>{percentage(selectedSignal.fairUp)}</strong><small>{selectedMarket.priceFeed === "TWAP_60" ? "Polymarket 60s TWAP" : "Polymarket oracle"} · Price to Beat {hasVerifiedOpeningReference(selectedMarket) ? formatSpot(selectedMarket.asset, selectedMarket.reference) : "waiting for exact opening tick"} · oracle spot {selectedMarket.spotSource === "POLYMARKET" && selectedMarket.spotUpdatedAt !== null && clock - selectedMarket.spotUpdatedAt <= 10_000 ? formatSpot(selectedMarket.asset, selectedMarket.spot) : "stale / unavailable"}</small></div><div className="signal-confidence"><span className="confidence-ring" style={{ "--confidence": `${selectedSignal.biasConfidence === null ? 0 : clamp(selectedSignal.biasConfidence, 0, 1) * 100}%` } as CSSProperties}><span>{percentage(selectedSignal.biasConfidence, 0)}</span></span><small>direction · uncalibrated</small></div></div>
            <div className="signal-price-checks"><div><small>UP · P(UP) {percentage(selectedSignal.fairUp)} vs ask {cents(selectedMarket.upAsk)}</small><strong className={selectedSignal.upEdge === null ? "text-muted" : selectedSignal.upEdge >= 0 ? "text-positive" : "text-negative"}>net edge {selectedSignal.upEdge === null ? "—" : percentage(selectedSignal.upEdge)}</strong></div><div><small>DOWN · P(DOWN) {percentage(selectedSignal.fairUp === null ? null : 1 - selectedSignal.fairUp)} vs ask {cents(selectedMarket.downAsk)}</small><strong className={selectedSignal.downEdge === null ? "text-muted" : selectedSignal.downEdge >= 0 ? "text-positive" : "text-negative"}>net edge {selectedSignal.downEdge === null ? "—" : percentage(selectedSignal.downEdge)}</strong></div></div>
            <div className="candle-chart-grid"><CandleChart label="5M CANDLES" candles={selectedMarket.chart5m} trend={selectedSignal.trend5m} rsiValue={selectedSignal.rsi5m} /><CandleChart label="15M CANDLES" candles={selectedMarket.chart15m} trend={selectedSignal.trend15m} rsiValue={selectedSignal.rsi15m} /></div>
            <div className="signal-divider" />
            <div className="signal-metrics"><div><span>UP ASK</span><strong>{cents(selectedMarket.upAsk)}</strong></div><div><span>DOWN ASK</span><strong>{cents(selectedMarket.downAsk)}</strong></div><div><span>ENTRY</span><strong className={selectedSignal.action === "UP" ? "text-positive" : selectedSignal.action === "DOWN" ? "text-negative" : "text-muted"}>{selectedSignal.action === "PASS" ? "PASS" : `${selectedSignal.action} · ${cents(selectedSignal.entryPrice)}`}</strong></div><div><span>NET EDGE</span><strong className={selectedSignal.edge !== null && selectedSignal.edge >= config.minEdge ? "text-positive" : "text-muted"}>{percentage(selectedSignal.edge)}</strong></div></div>
            <div className="signal-metrics"><div><span>BANKROLL PROFILE</span><strong>{selectedProfile.tier}</strong></div><div><span>LIQUIDATION EQUITY</span><strong>{dollars(liquidationEquity)}</strong></div><div><span>AVAILABLE CASH</span><strong>{dollars(account.cash)}</strong></div><div><span>RESERVE CASH</span><strong>{dollars(selectedOpportunity?.sizing?.reserveUsd ?? liquidationEquity * selectedProfile.reservePct)}</strong></div></div>
            <div className="signal-metrics"><div><span>RISK STATE</span><strong>{selectedOpportunity?.sizing?.risk.state ?? paperRisk.state}</strong></div><div><span>MAX TRADE</span><strong>{dollars(selectedOpportunity?.sizing?.maxAllowedStakeUsd ?? Math.min(config.maxTrade, liquidationEquity * selectedProfile.maxStakePct))}</strong></div><div><span>RECOMMENDED TRADE</span><strong>{dollars(selectedOpportunity?.stakeUsd ?? 0)}</strong></div><div><span>TRADE / EQUITY</span><strong>{percentage(selectedOpportunity?.stakeUsd ? selectedOpportunity.stakeUsd / liquidationEquity : 0)}</strong></div></div>
            <div className="signal-metrics"><div><span>TOTAL EXPOSURE</span><strong>{dollars(deployed)} / {dollars(liquidationEquity * selectedProfile.maxExposurePct)}</strong></div><div><span>CORRELATED EXPOSURE</span><strong>{dollars(selectedOpportunity?.sizing?.portfolio.existingCorrelatedExposureUsd ?? deployed)}</strong></div><div><span>LOSS ROOM</span><strong>{dollars(paperRisk.dailyLossRemainingUsd)}</strong></div><div><span>STRATEGY</span><strong>{selectedProfile.strategy}</strong></div></div>
            <div className="signal-metrics"><div><span>RAW MODEL P(UP)</span><strong>{percentage(selectedSignal.rawModelUp)}</strong></div><div><span>MARKET P(UP)</span><strong>{percentage(selectedSignal.marketProbabilityUp)}</strong></div><div><span>NET EDGE</span><strong>{percentage(selectedSignal.edge)}</strong></div><div><span>EXPECTED NET PROFIT</span><strong>{dollars(selectedOpportunity?.sizing?.expectedNetProfitUsd ?? null)}</strong></div></div>
            <div className="signal-metrics"><div><span>OPPORTUNITY SCORE</span><strong>{selectedOpportunity?.score?.score.toFixed(1) ?? "—"}</strong></div><div><span>NEAR-TOUCH DEPTH</span><strong>{dollars(selectedOpportunity?.book?.availableDepthUsd ?? null)}</strong></div><div><span>BOOK SPREAD</span><strong>{percentage(selectedOpportunity?.book?.spreadPct ?? null)}</strong></div><div><span>MIN EXECUTABLE</span><strong>{dollars(selectedOpportunity?.book?.minimumExecutableOrderUsd ?? null)}</strong></div></div>
            <div className="signal-block"><div className="signal-block-title"><span>ENTRY FILTERS</span><small>public chart + book data</small></div><div className="signal-bar-row"><span>Ask depth</span><span>{selectedMarket.liquidity ? dollars(selectedMarket.liquidity, 0) : "—"}</span><div className="signal-bar"><i style={{ width: `${Math.min(100, selectedMarket.liquidity / Math.max(1, config.maxTrade) * 10)}%` }} /></div></div><div className="signal-bar-row"><span>Book spread</span><span>{percentage(selectedMarket.spread)}</span><div className="signal-bar amber"><i style={{ width: `${Math.min(100, (selectedMarket.spread ?? 0) * 500)}%` }} /></div></div><div className="signal-bar-row"><span>Chart snapshot</span><span>{selectedMarket.chartUpdatedAt === null ? "MISSING" : formatAge(selectedMarket.chartUpdatedAt, clock)}</span><div className="signal-bar cyan"><i style={{ width: `${selectedMarket.chartUpdatedAt === null ? 0 : Math.max(0, 100 - Math.max(0, (clock - selectedMarket.chartUpdatedAt) / 1200))}%` }} /></div></div></div>
            <div className={`no-trade-box ${selectedOpportunity?.approved ? "candidate-box" : ""}`}><div className="no-trade-icon"><ShieldCheck size={16} /></div><div><strong>{selectedOpportunity?.approved ? `ENTRY ${selectedSignal.action} · bankroll gates passed` : "PASS · No entry"}</strong><p>{selectedOpportunity?.reason ?? selectedSignal.reason} {selectedProfile.tier === "MICRO" || selectedProfile.tier === "SMALL" ? "Small-account protection active. " : ""}“LOCK” is a strict filter label, not a guaranteed outcome. Paper only.</p></div></div>
            <div className="paper-order-actions"><button className="button-primary" disabled={killSwitch || paused || !selectedOpportunity?.approved || selectedSignal.action !== "UP" || selectedMarket.upAsk === null || !selectedMarket.upBook} onClick={() => manualBuy("UP")} type="button"><ArrowUpRight size={14} />PAPER UP · {dollars(selectedOpportunity?.stakeUsd ?? 0)}</button><button className="button-secondary" disabled={killSwitch || paused || !selectedOpportunity?.approved || selectedSignal.action !== "DOWN" || selectedMarket.downAsk === null || !selectedMarket.downBook} onClick={() => manualBuy("DOWN")} type="button"><ArrowDownRight size={14} />PAPER DOWN · {dollars(selectedOpportunity?.stakeUsd ?? 0)}</button></div>
            <div className="panel-footnote"><span>5M</span><strong>{selectedSignal.trend5m}</strong><span>15M</span><strong>{selectedSignal.trend15m}</strong><span className="footnote-spacer" /><span>LEFT</span><strong>{timeLeft(selectedMarket.remaining)}</strong><a href={selectedMarket.sourceUrl} target="_blank" rel="noreferrer">OPEN MARKET ↗</a></div>
          </aside> : null}</section>
          <section className="dashboard-grid"><article className="panel chart-panel"><div className="panel-heading"><div><div className="eyebrow">PAPER PORTFOLIO MONITOR</div><h3>Equity curve <span className="heading-muted">/ local ledger</span></h3></div><div className="range-tabs" role="tablist" aria-label="Chart period">{["5M", "15M", "1H", "6H", "24H", "ALL"].map((range) => <button aria-selected={selectedRange === range} className={selectedRange === range ? "range-tab active" : "range-tab"} key={range} onClick={() => setSelectedRange(range)} role="tab" type="button">{range}</button>)}</div></div><div className="chart-summary"><span><strong>{dollars(equity)}</strong><small>current equity</small></span><span className={todayPnl >= 0 ? "chart-stat-positive" : "chart-stat-negative"}>{todayPnl >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />} {signedDollars(todayPnl)} <small>session P&amp;L</small></span><span><small>MAX DD</small><strong>{percentage(maxDrawdown)}</strong></span></div><div className="chart-wrap"><EquityChart values={selectedTicks} color={todayPnl >= 0 ? "#6cf2c4" : "#ff7d8a"} /><div className="chart-axis"><span>{account.equityHistory.length ? formatTime(account.equityHistory[0].timestamp) : "—"}</span><span>{account.equityHistory.length > 2 ? formatTime(account.equityHistory[Math.floor(account.equityHistory.length / 2)].timestamp) : "—"}</span><span>NOW</span></div></div></article><article className="panel positions-panel"><div className="panel-heading"><div><div className="eyebrow">EXPOSURE</div><h3>Paper positions <span className="heading-muted">/ {account.positions.length}</span></h3></div><button className="text-button" disabled={!account.positions.length} onClick={closePositions} type="button">Close all <ArrowUpRight size={13} /></button></div><div className="positions-table-wrap"><table className="positions-table"><thead><tr><th>MARKET</th><th>SIDE</th><th>SIZE</th><th>MARK</th><th>P&amp;L</th></tr></thead><tbody>{account.positions.length ? account.positions.map((position) => { const mark = marketMap.get(position.marketId)?.[position.side === "UP" ? "upBid" : "downBid"] ?? position.mark; const pnl = mark === null || mark === undefined ? null : (mark - position.avgEntry) * position.shares; return <tr key={position.id}><td><strong>{position.marketLabel}</strong><small>{timeLeft(Math.max(0, Math.round((position.endTime - clock) / 1000)))} left</small></td><td><span className={`side-chip ${position.side === "UP" ? "up" : "down"}`}>{position.side}</span></td><td>{position.shares.toFixed(2)} sh</td><td>{cents(mark)}</td><td className={pnl === null ? "text-muted" : pnl >= 0 ? "text-positive" : "text-negative"}>{signedDollars(pnl)}</td></tr>; }) : <tr><td className="empty-row" colSpan={5}>No open paper positions. The ledger is flat.</td></tr>}</tbody></table></div><div className="positions-footer"><span><span className="status-dot status-ready" />Marked from current public bids</span><span>{dollars(deployed)} deployed</span></div></article></section>
          <section className="dashboard-grid lower"><article className="panel feed-panel"><div className="panel-heading"><div><div className="eyebrow">AUDIT TRAIL</div><h3>Engine feed <span className="heading-muted">/ this browser</span></h3></div><span className="feed-live"><span className={`status-dot ${dataStatus === "ready" ? "status-ready" : "status-warning"}`} />{dataStatus === "ready" ? "PUBLIC" : "WAITING"}</span></div>{logs.length ? <div className="feed-list">{logs.map((log) => <div className="feed-row" key={log.id}><span className="feed-time">{log.time}</span><span className={`feed-marker ${log.tone}`} /><div><strong>{log.message}</strong><small>{log.detail}</small></div></div>)}</div> : <EmptyState title="No events yet" detail="The audit trail will populate when public data syncs or you submit a paper action." />}</article><article className="panel risk-panel"><div className="panel-heading"><div><div className="eyebrow">RISK CONFIGURATION</div><h3>Guardrails <span className="heading-muted">/ editable</span></h3></div><SlidersHorizontal size={17} className="heading-icon" /></div><div className="risk-controls"><label className="range-control"><span><b>Minimum net edge</b><em>{percentage(config.minEdge)}</em></span><input max="0.12" min="0" onChange={(event) => setConfig((current) => ({ ...current, minEdge: Number(event.target.value) }))} step="0.005" type="range" value={config.minEdge} /></label><label className="range-control"><span><b>Max paper trade</b><em>{dollars(config.maxTrade, 0)}</em></span><input max="250" min="5" onChange={(event) => setConfig((current) => ({ ...current, maxTrade: Number(event.target.value) }))} step="5" type="range" value={config.maxTrade} /></label><label className="range-control"><span><b>Daily loss halt</b><em>{percentage(config.maxLoss)}</em></span><input max="0.25" min="0.01" onChange={(event) => setConfig((current) => ({ ...current, maxLoss: Number(event.target.value) }))} step="0.01" type="range" value={config.maxLoss} /></label><label className="range-control"><span><b>Fee assumption</b><em>{percentage(config.feeRate, 2)}</em></span><input max="0.1" min="0" onChange={(event) => setConfig((current) => ({ ...current, feeRate: Number(event.target.value) }))} step="0.0025" type="range" value={config.feeRate} /></label><label className="range-control"><span><b>Slippage buffer</b><em>{config.slippageBps} bps</em></span><input max="100" min="0" onChange={(event) => setConfig((current) => ({ ...current, slippageBps: Number(event.target.value) }))} step="5" type="range" value={config.slippageBps} /></label></div><div className="risk-note"><ShieldCheck size={15} /><span>No martingale or live orders. Missing candles, reference, quote, or ask depth blocks entry.</span></div></article></section></> : <section className="backtest-lab">{paperLab}<div className="section-heading"><div><div className="eyebrow">RESEARCH WORKBENCH</div><h2>Historical backtest</h2><p className="section-subtitle">Replay a reference/spot baseline from timestamped rows. This does not validate the live OHLC signal.</p></div><span className="research-badge"><LineChart size={14} />DETERMINISTIC</span></div><div className="backtest-grid"><article className="panel dataset-panel"><div className="panel-heading"><div><div className="eyebrow">DATASET</div><h3>Bring your own history</h3></div><FileUp size={17} className="heading-icon" /></div><p className="panel-copy">Import timestamp, asset, duration, reference, spot, up_ask, down_ask, and optional outcome columns. This baseline omits live candle filters; outcomes are required for settled P&amp;L.</p><div className="upload-zone"><input accept=".csv,text/csv" id="backtest-upload" onChange={(event) => void handleCsvUpload(event.target.files?.[0])} type="file" /><label htmlFor="backtest-upload"><Upload size={17} /><strong>Import CSV</strong><span>Local browser parsing · no upload</span></label></div><div className="dataset-actions"><button className="button-secondary" disabled={!recordedTicks.length} onClick={useRecordedTicks} type="button"><Database size={14} />Use recorded public ticks <span className="button-count">{recordedTicks.length}</span></button><button className="text-button" onClick={downloadTemplate} type="button"><Download size={13} />Download template</button></div><div className="dataset-status"><span className={`status-dot ${backtestRows.length ? "status-ready" : "status-warning"}`} /><strong>{backtestRows.length ? `${backtestRows.length} rows ready` : "No dataset loaded"}</strong><span>{backtestRejected ? `${backtestRejected} rejected` : "Settled outcomes are optional"}</span></div></article><article className="panel backtest-config-panel"><div className="panel-heading"><div><div className="eyebrow">SIMULATION CONFIG</div><h3>Cost-aware replay</h3></div><SlidersHorizontal size={17} className="heading-icon" /></div><div className="backtest-form"><label><span>Starting capital</span><input min="1" onChange={(event) => setBacktestStartingCash(Number(event.target.value))} step="10" type="number" value={backtestStartingCash} /></label><label><span>Minimum net edge</span><input max="0.5" min="0" onChange={(event) => setConfig((current) => ({ ...current, minEdge: Number(event.target.value) }))} step="0.005" type="number" value={config.minEdge} /></label><label><span>Max trade</span><input min="1" onChange={(event) => setConfig((current) => ({ ...current, maxTrade: Number(event.target.value) }))} step="1" type="number" value={config.maxTrade} /></label><label><span>Fee rate</span><input max="0.5" min="0" onChange={(event) => setConfig((current) => ({ ...current, feeRate: Number(event.target.value) }))} step="0.0025" type="number" value={config.feeRate} /></label><label><span>Slippage bps</span><input max="500" min="0" onChange={(event) => setConfig((current) => ({ ...current, slippageBps: Number(event.target.value) }))} step="1" type="number" value={config.slippageBps} /></label></div><button className="button-primary run-backtest" disabled={!backtestRows.length} onClick={executeBacktest} type="button"><Play size={15} fill="currentColor" />RUN BACKTEST</button></article></div><div className="backtest-metrics metric-grid"><MetricCard label="SIGNALS" value={backtestResult ? String(backtestResult.signals) : "—"} delta={backtestResult ? `${backtestResult.unsettled} unsettled` : "run a dataset"} deltaTone="neutral" detail="edge filter passes" icon={<ScanLine size={17} />} /><MetricCard label="NET P&L" value={backtestResult ? signedDollars(backtestResult.netPnl) : "—"} delta={backtestResult ? percentage(backtestResult.roi) : "—"} deltaTone={backtestResult?.netPnl !== null && backtestResult?.netPnl !== undefined && backtestResult.netPnl >= 0 ? "positive" : "neutral"} detail="settled rows only" icon={<TrendingUp size={17} />} /><MetricCard label="WIN RATE" value={backtestResult ? percentage(backtestResult.winRate) : "—"} delta={backtestResult ? `${backtestResult.wins}W / ${backtestResult.losses}L` : "—"} deltaTone="neutral" detail="settled trades" icon={<Target size={17} />} /><MetricCard label="MAX DD" value={backtestResult ? percentage(backtestResult.maxDrawdown) : "—"} delta={backtestResult ? `${backtestResult.settled} settled` : "—"} deltaTone="neutral" detail="replayed equity" icon={<Gauge size={17} />} /><MetricCard label="BRIER" value={backtestResult ? backtestResult.brierScore?.toFixed(4) ?? "—" : "—"} delta={backtestResult ? "lower is better" : "—"} deltaTone="neutral" detail="probability calibration" icon={<ShieldCheck size={17} />} /></div>{backtestResult ? <section className="backtest-results"><article className="panel chart-panel"><div className="panel-heading"><div><div className="eyebrow">REPLAY OUTPUT</div><h3>Settled equity <span className="heading-muted">/ no outcome guessing</span></h3></div><span className={`result-badge ${backtestResult.settled ? "ready" : "waiting"}`}>{backtestResult.settled ? `${backtestResult.settled} SETTLED` : "NO SETTLED ROWS"}</span></div>{backtestResult.settled ? <div className="chart-wrap"><EquityChart values={backtestResult.equityCurve} color={backtestResult.netPnl !== null && backtestResult.netPnl >= 0 ? "#6cf2c4" : "#ff7d8a"} /></div> : <EmptyState title="No settled outcomes in this dataset" detail="Signals are shown below, but P&L, ROI, win rate, drawdown, and Brier score remain unavailable until outcome values are supplied." />}</article><article className="panel backtest-trades-panel"><div className="panel-heading"><div><div className="eyebrow">TRADE REPLAY</div><h3>Signals and outcomes <span className="heading-muted">/ latest 250</span></h3></div><span className="feed-live"><span className="status-dot status-ready" />LOCAL</span></div><div className="positions-table-wrap"><table className="positions-table"><thead><tr><th>TIME</th><th>MARKET</th><th>SIDE</th><th>EDGE</th><th>STATUS</th><th>P&amp;L</th></tr></thead><tbody>{backtestResult.trades.length ? backtestResult.trades.slice().reverse().map((trade, index) => <tr key={`${trade.timestamp}-${trade.asset}-${index}`}><td>{formatTime(trade.timestamp)}</td><td><strong>{trade.asset} {trade.duration}</strong><small>fair {percentage(trade.fair)}</small></td><td><span className={`side-chip ${trade.side === "UP" ? "up" : "down"}`}>{trade.side}</span></td><td>{percentage(trade.edge)}</td><td className={trade.status === "SETTLED WIN" ? "text-positive" : trade.status === "SETTLED LOSS" ? "text-negative" : "text-warning"}>{trade.status}</td><td className={trade.pnl === null ? "text-muted" : trade.pnl >= 0 ? "text-positive" : "text-negative"}>{signedDollars(trade.pnl)}</td></tr>) : <tr><td className="empty-row" colSpan={6}>No signals passed the configured edge filter.</td></tr>}</tbody></table></div></article></section> : <EmptyState title="Backtest output is waiting" detail="Load a user-supplied CSV or record public ticks from the Overview tab, then run the deterministic replay." />}</section>}
        <footer className="terminal-footer"><span><Terminal size={14} />Paper ledger stays in this browser</span><span><Database size={14} />Public data is not synthetic</span><span><LockKeyhole size={14} />Raw key is cleared after linking; session is encrypted</span><span className="footer-spacer" /><span>Research first. Trade deliberately.</span></footer></div>
    </section>
    {null}
    {accountDialogOpen ? <AccountConnectModal connection={accountConnection} error={accountError} loading={accountLoading} onChange={(field, value) => setAccountConnection((current) => ({ ...current, [field]: value }))} onClose={() => setAccountDialogOpen(false)} onSubmit={() => void connectAccount()} /> : null}
    {runnerDialogOpen ? <RunnerSetupModal onClose={() => setRunnerDialogOpen(false)} /> : null}
  </main></>;
}
