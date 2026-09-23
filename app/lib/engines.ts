// Paper account and the UI-facing signal wrapper. Paper fills use the same
// depth-walking, fee-curve simulation as the live limit-price logic, and paper
// positions settle only on official Polymarket resolutions.

import type { DerivedFeed } from "./feeds";
import { trendLabel, trendStats, type TrendLabel } from "./indicators";
import { round } from "./num";
import { snapshotFromLiveMarket, type Horizon, type LiveMarket, type Resolution } from "./polymarket-data";
import { evaluateSignal, simulateBuy, simulateSell, type FillEstimate, type Side, type Signal, type SignalParams } from "./signal";

export type PaperSide = Side;

export type PaperPosition = {
  id: string;
  marketId: string;
  marketLabel: string;
  asset: string;
  duration: Horizon;
  side: PaperSide;
  shares: number;
  /** All-in cost per share including fees. */
  avgEntry: number;
  totalCost: number;
  /** Model probability for this side at entry, for calibration. */
  entryProbability: number | null;
  mark: number | null;
  endTime: number;
  openedAt: number;
  lastUpdated: number;
};

export type PaperFill = {
  id: string;
  timestamp: number;
  action: "BUY" | "SELL" | "SETTLE";
  marketId: string;
  marketLabel: string;
  asset: string;
  duration: Horizon;
  side: PaperSide;
  shares: number;
  price: number;
  notional: number;
  fee: number;
  reason: string;
};

export type ClosedPaperTrade = {
  id: string;
  timestamp: number;
  marketId: string;
  marketLabel: string;
  asset: string;
  duration: Horizon;
  side: PaperSide;
  shares: number;
  entry: number;
  exit: number;
  pnl: number;
  entryProbability: number | null;
  won: boolean | null;
  reason: string;
};

export type EquityPoint = { timestamp: number; equity: number };

export type PaperAccount = {
  startingCash: number;
  cash: number;
  realizedPnl: number;
  fees: number;
  positions: PaperPosition[];
  fills: PaperFill[];
  closedTrades: ClosedPaperTrade[];
  equityHistory: EquityPoint[];
  /** Trading day (America/New_York) and the equity it opened with. */
  dayKey: string;
  dayStartEquity: number;
  peakEquity: number;
};

export type TradeResult = { account: PaperAccount; fill: FillEstimate | null; error?: string };

export const tradingDayKey = (timestamp: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));

export const createPaperAccount = (startingCash: number, timestamp = Date.now()): PaperAccount => {
  const cash = Number.isFinite(startingCash) && startingCash > 0 ? startingCash : 1000;
  return {
    startingCash: cash,
    cash,
    realizedPnl: 0,
    fees: 0,
    positions: [],
    fills: [],
    closedTrades: [],
    equityHistory: [{ timestamp, equity: cash }],
    dayKey: tradingDayKey(timestamp),
    dayStartEquity: cash,
    peakEquity: cash,
  };
};

/** Upgrade an account persisted by an older build. */
export const migratePaperAccount = (raw: Partial<PaperAccount> | null, timestamp = Date.now()): PaperAccount | null => {
  if (!raw || typeof raw.cash !== "number" || !Array.isArray(raw.positions)) return null;
  const base = createPaperAccount(typeof raw.startingCash === "number" ? raw.startingCash : raw.cash, timestamp);
  return {
    ...base,
    ...raw,
    positions: raw.positions.map((position) => ({ ...position, entryProbability: position.entryProbability ?? null })),
    closedTrades: (raw.closedTrades ?? []).map((trade) => ({ ...trade, entryProbability: trade.entryProbability ?? null, won: trade.won ?? null })),
    fills: raw.fills ?? [],
    equityHistory: raw.equityHistory ?? base.equityHistory,
    dayKey: raw.dayKey ?? base.dayKey,
    dayStartEquity: raw.dayStartEquity ?? raw.cash,
    peakEquity: raw.peakEquity ?? Math.max(raw.cash, base.startingCash),
  } as PaperAccount;
};

const markFor = (position: PaperPosition, markets: Map<string, LiveMarket>) => {
  const market = markets.get(position.marketId);
  if (!market) return position.mark;
  // A closed window's book empties before resolution; keep the last real mark rather than valuing the position at zero.
  return (position.side === "UP" ? market.upBid : market.downBid) ?? position.mark;
};

export const accountEquity = (account: PaperAccount, markets: Map<string, LiveMarket>) =>
  account.cash + account.positions.reduce((total, position) => total + (markFor(position, markets) ?? position.mark ?? 0) * position.shares, 0);

export const accountUnrealized = (account: PaperAccount, markets: Map<string, LiveMarket>) =>
  account.positions.reduce((total, position) => total + (markFor(position, markets) ?? position.mark ?? 0) * position.shares - position.totalCost, 0);

export const accountDeployed = (account: PaperAccount) => account.positions.reduce((total, position) => total + position.totalCost, 0);

export const accountWinRate = (account: PaperAccount): number | null => {
  const settled = account.closedTrades.filter((trade) => trade.pnl !== 0 || trade.won !== null);
  if (!settled.length) return null;
  return settled.filter((trade) => trade.pnl > 0).length / settled.length;
};

export const markAccount = (account: PaperAccount, markets: Map<string, LiveMarket>, timestamp = Date.now()): PaperAccount => {
  const positions = account.positions.map((position) => ({ ...position, mark: markFor(position, markets), lastUpdated: timestamp }));
  const marked = { ...account, positions };
  const equity = accountEquity(marked, markets);
  const dayKey = tradingDayKey(timestamp);
  const rolled = dayKey !== account.dayKey ? { dayKey, dayStartEquity: equity } : {};
  const last = marked.equityHistory[marked.equityHistory.length - 1];
  const equityHistory = !last || timestamp - last.timestamp >= 2500 ? [...marked.equityHistory, { timestamp, equity }].slice(-5000) : marked.equityHistory;
  return { ...marked, ...rolled, equityHistory, peakEquity: Math.max(account.peakEquity ?? equity, equity) };
};

export type HaltState = { halted: boolean; reason: string | null; dailyPnlPct: number; drawdownPct: number };

/** Daily loss (vs the trading-day open) and peak-to-trough drawdown are separate limits. */
export const haltState = (account: PaperAccount, equity: number, limits: { dailyLossPct: number; maxDrawdownPct: number }): HaltState => {
  const dailyPnlPct = account.dayStartEquity > 0 ? (equity - account.dayStartEquity) / account.dayStartEquity : 0;
  const drawdownPct = account.peakEquity > 0 ? Math.max(0, (account.peakEquity - equity) / account.peakEquity) : 0;
  if (dailyPnlPct <= -limits.dailyLossPct)
    return {
      halted: true,
      reason: `Daily loss ${(dailyPnlPct * 100).toFixed(1)}% hit the ${(limits.dailyLossPct * 100).toFixed(1)}% limit.`,
      dailyPnlPct,
      drawdownPct,
    };
  if (drawdownPct >= limits.maxDrawdownPct)
    return {
      halted: true,
      reason: `Drawdown ${(drawdownPct * 100).toFixed(1)}% hit the ${(limits.maxDrawdownPct * 100).toFixed(1)}% limit.`,
      dailyPnlPct,
      drawdownPct,
    };
  return { halted: false, reason: null, dailyPnlPct, drawdownPct };
};

export type ExposureLimits = { maxOpenExposurePct: number; maxSameWindowSameSide: number };

/** Portfolio checks before a new entry: one position per market, total exposure, and correlated windows. */
export const exposureCheck = (
  account: PaperAccount,
  equity: number,
  market: Pick<LiveMarket, "id" | "endTime">,
  side: Side,
  stake: number,
  limits: ExposureLimits,
): string | null => {
  if (account.positions.some((position) => position.marketId === market.id)) return "Already holding this market.";
  const open = accountDeployed(account);
  if (open + stake > equity * limits.maxOpenExposurePct) return `Open exposure would exceed ${(limits.maxOpenExposurePct * 100).toFixed(0)}% of equity.`;
  const correlated = account.positions.filter((position) => Math.abs(position.endTime - market.endTime) < 1_000 && position.side === side).length;
  if (correlated >= limits.maxSameWindowSameSide) return `Already ${correlated} ${side} position(s) in this window; crypto assets move together.`;
  return null;
};

export const buyPaper = (
  account: PaperAccount,
  market: LiveMarket,
  side: PaperSide,
  budget: number,
  options: { slippageBps: number; limitPrice?: number; probability?: number | null; reason: string },
  timestamp = Date.now(),
): TradeResult => {
  const book = side === "UP" ? market.upBook : market.downBook;
  const fill = book
    ? simulateBuy(book.asks, Math.min(Math.max(0, budget), account.cash), market.feeSchedule, options.slippageBps, options.limitPrice ?? 1, market.minOrderSize)
    : null;
  if (!fill) return { account, fill: null, error: "No executable ask depth under the limit price, or the order is below the market minimum." };
  const marketLabel = `${market.asset} ${market.duration}`;
  const position: PaperPosition = {
    id: `${market.id}-${side}-${timestamp}`,
    marketId: market.id,
    marketLabel,
    asset: market.asset,
    duration: market.duration,
    side,
    shares: round(fill.shares),
    avgEntry: round(fill.costPerShare),
    totalCost: round(fill.totalCost),
    entryProbability: options.probability ?? null,
    mark: side === "UP" ? market.upBid : market.downBid,
    endTime: market.endTime,
    openedAt: timestamp,
    lastUpdated: timestamp,
  };
  const existing = account.positions.find((candidate) => candidate.marketId === market.id && candidate.side === side);
  const positions = existing
    ? account.positions.map((candidate) =>
        candidate.id === existing.id
          ? {
              ...existing,
              shares: round(existing.shares + position.shares),
              totalCost: round(existing.totalCost + position.totalCost),
              avgEntry: round((existing.totalCost + position.totalCost) / (existing.shares + position.shares)),
              lastUpdated: timestamp,
            }
          : candidate,
      )
    : [...account.positions, position];
  const record: PaperFill = {
    id: `${timestamp}-${market.id}-${side}-buy`,
    timestamp,
    action: "BUY",
    marketId: market.id,
    marketLabel,
    asset: market.asset,
    duration: market.duration,
    side,
    shares: fill.shares,
    price: fill.avgPrice,
    notional: fill.notional,
    fee: fill.fee,
    reason: options.reason,
  };
  return {
    account: {
      ...account,
      cash: round(account.cash - fill.totalCost),
      fees: round(account.fees + fill.fee),
      positions,
      fills: [record, ...account.fills].slice(0, 2000),
    },
    fill,
  };
};

type CloseResult = { account: PaperAccount; closed: number; skipped: number; realized: number };

/** Sell positions into the bids (depth-walked, fee-curve). Unfilled shares stay open. */
export const closePaperPositions = (
  account: PaperAccount,
  markets: Map<string, LiveMarket>,
  options: { slippageBps: number; reason: string; limitPrice?: (position: PaperPosition) => number },
  timestamp = Date.now(),
  positionIds?: Set<string>,
): CloseResult => {
  let cash = account.cash;
  let fees = account.fees;
  let realizedPnl = account.realizedPnl;
  const positions: PaperPosition[] = [];
  const fills: PaperFill[] = [];
  const closedTrades: ClosedPaperTrade[] = [];
  let closed = 0;
  let skipped = 0;
  for (const position of account.positions) {
    if (positionIds && !positionIds.has(position.id)) {
      positions.push(position);
      continue;
    }
    const market = markets.get(position.marketId);
    const book = market ? (position.side === "UP" ? market.upBook : market.downBook) : null;
    const sale = market && book ? simulateSell(book.bids, position.shares, market.feeSchedule, options.slippageBps, options.limitPrice?.(position) ?? 0) : null;
    if (!sale) {
      positions.push(position);
      skipped += 1;
      continue;
    }
    const costBasis = position.avgEntry * sale.shares;
    const pnl = sale.netProceeds - costBasis;
    cash += sale.netProceeds;
    fees += sale.fee;
    realizedPnl += pnl;
    closed += 1;
    fills.push({
      id: `${timestamp}-${position.id}-sell`,
      timestamp,
      action: "SELL",
      marketId: position.marketId,
      marketLabel: position.marketLabel,
      asset: position.asset,
      duration: position.duration,
      side: position.side,
      shares: sale.shares,
      price: sale.avgPrice,
      notional: sale.proceeds,
      fee: sale.fee,
      reason: options.reason,
    });
    closedTrades.push({
      id: `${timestamp}-${position.id}-closed`,
      timestamp,
      marketId: position.marketId,
      marketLabel: position.marketLabel,
      asset: position.asset,
      duration: position.duration,
      side: position.side,
      shares: sale.shares,
      entry: position.avgEntry,
      exit: sale.netProceeds / sale.shares,
      pnl,
      entryProbability: position.entryProbability,
      won: null,
      reason: options.reason,
    });
    const remainingShares = round(position.shares - sale.shares);
    if (remainingShares > 1e-6)
      positions.push({ ...position, shares: remainingShares, totalCost: round(position.avgEntry * remainingShares), lastUpdated: timestamp });
  }
  return {
    account: {
      ...account,
      cash: round(cash),
      fees: round(fees),
      realizedPnl: round(realizedPnl),
      positions,
      fills: [...fills, ...account.fills].slice(0, 2000),
      closedTrades: [...closedTrades, ...account.closedTrades].slice(0, 2000),
    },
    closed,
    skipped,
    realized: round(realizedPnl - account.realizedPnl),
  };
};

/** Settle only on official outcomes. Winning shares redeem for $1; no fee on redemption. */
export const settleResolvedPaperPositions = (
  account: PaperAccount,
  resolutions: Map<string, Resolution | { outcome: Side }>,
  reason: string,
  timestamp = Date.now(),
): CloseResult => {
  let cash = account.cash;
  let realizedPnl = account.realizedPnl;
  const positions: PaperPosition[] = [];
  const fills: PaperFill[] = [];
  const closedTrades: ClosedPaperTrade[] = [];
  let closed = 0;
  let skipped = 0;
  for (const position of account.positions) {
    const resolution = resolutions.get(position.marketId);
    if (!resolution) {
      positions.push(position);
      if (position.endTime <= timestamp) skipped += 1;
      continue;
    }
    const won = position.side === resolution.outcome;
    const proceeds = won ? position.shares : 0;
    const pnl = proceeds - position.totalCost;
    cash += proceeds;
    realizedPnl += pnl;
    closed += 1;
    const label = `${reason} · ${resolution.outcome} resolved`;
    fills.push({
      id: `${timestamp}-${position.id}-settle`,
      timestamp,
      action: "SETTLE",
      marketId: position.marketId,
      marketLabel: position.marketLabel,
      asset: position.asset,
      duration: position.duration,
      side: position.side,
      shares: position.shares,
      price: won ? 1 : 0,
      notional: proceeds,
      fee: 0,
      reason: label,
    });
    closedTrades.push({
      id: `${timestamp}-${position.id}-resolved`,
      timestamp,
      marketId: position.marketId,
      marketLabel: position.marketLabel,
      asset: position.asset,
      duration: position.duration,
      side: position.side,
      shares: position.shares,
      entry: position.avgEntry,
      exit: won ? 1 : 0,
      pnl,
      entryProbability: position.entryProbability,
      won,
      reason: label,
    });
  }
  return {
    account: {
      ...account,
      cash: round(cash),
      realizedPnl: round(realizedPnl),
      positions,
      fills: [...fills, ...account.fills].slice(0, 2000),
      closedTrades: [...closedTrades, ...account.closedTrades].slice(0, 2000),
    },
    closed,
    skipped,
    realized: round(realizedPnl - account.realizedPnl),
  };
};

// ---------------------------------------------------------------------------
// UI-facing signal: the pure decision plus display-only chart context.

export type MarketSignal = {
  action: Side | "PASS";
  tier: Signal["tier"];
  gate: string;
  reason: string;
  /** Posterior P(UP) (model blended with the book). */
  fairUp: number | null;
  modelUp: number | null;
  marketUp: number | null;
  band: [number, number] | null;
  upEdge: number | null;
  downEdge: number | null;
  edge: number | null;
  requiredEdge: number;
  entryPrice: number | null;
  costPerShare: number | null;
  limitPrice: number | null;
  probability: number | null;
  estimatedFill: FillEstimate | null;
  trend5m: TrendLabel;
  trend15m: TrendLabel;
  rsi5m: number | null;
  rsi15m: number | null;
  raw: Signal;
};

export const analyzeMarketSignal = (market: LiveMarket, feed: DerivedFeed | null, params: Partial<SignalParams>, now = Date.now()): MarketSignal => {
  const signal = evaluateSignal(snapshotFromLiveMarket(market, feed, now), params);
  const stats5m = trendStats(market.chart5m, 300, now);
  const stats15m = trendStats(market.chart15m, 900, now);
  return {
    action: signal.action,
    tier: signal.tier,
    gate: signal.gate,
    reason: signal.reason,
    fairUp: signal.pUpPosterior,
    modelUp: signal.pUpModel,
    marketUp: signal.pUpMarket,
    band: signal.pUpBand,
    upEdge: signal.sides.UP?.edge ?? null,
    downEdge: signal.sides.DOWN?.edge ?? null,
    edge: signal.chosen?.edge ?? null,
    requiredEdge: signal.requiredEdge,
    entryPrice: signal.chosen?.fill?.avgPrice ?? null,
    costPerShare: signal.chosen?.fill?.costPerShare ?? null,
    limitPrice: signal.chosen?.limitPrice ?? null,
    probability: signal.chosen?.conservativeProbability ?? null,
    estimatedFill: signal.chosen?.fill ?? null,
    trend5m: trendLabel(stats5m),
    trend15m: trendLabel(stats15m),
    rsi5m: stats5m?.rsi ?? null,
    rsi15m: stats15m?.rsi ?? null,
    raw: signal,
  };
};
