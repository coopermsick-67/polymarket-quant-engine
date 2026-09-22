import {
  bestAskFor,
  bestBidFor,
  estimateFairProbability,
  orderBookFor,
  sideFairProbability,
  type Horizon,
  type LiveMarket,
  type MarketCandle,
} from "./polymarket-data";

export type PaperSide = "UP" | "DOWN";

export type PaperPosition = {
  id: string;
  marketId: string;
  marketLabel: string;
  asset: string;
  duration: Horizon;
  side: PaperSide;
  shares: number;
  avgEntry: number;
  totalCost: number;
  mark: number | null;
  endTime: number;
  openedAt: number;
  lastUpdated: number;
};

export type PaperFill = {
  id: string;
  timestamp: number;
  action: "BUY" | "SELL";
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
  reason: string;
};

export type EquityPoint = { timestamp: number; equity: number };

export type PaperAccount = {
  startingCash: number;
  cash: number;
  realizedPnl: number;
  fees: number;
  openOrders: number;
  positions: PaperPosition[];
  fills: PaperFill[];
  closedTrades: ClosedPaperTrade[];
  equityHistory: EquityPoint[];
};

export type CostConfig = {
  feeRate: number;
  slippageBps: number;
};

export type FillResult = {
  shares: number;
  price: number;
  notional: number;
  fee: number;
  totalCost: number;
  levels: number;
};

export type MarketSignal = {
  action: PaperSide | "PASS";
  tier: "LOCK" | "ENTRY" | "PASS";
  bias: PaperSide | "NEUTRAL" | "WARMING UP";
  biasConfidence: number | null;
  confidence: number | null;
  fairUp: number | null;
  upEdge: number | null;
  downEdge: number | null;
  entryPrice: number | null;
  edge: number | null;
  trend5m: "UP" | "DOWN" | "MIXED" | "UNAVAILABLE";
  trend15m: "UP" | "DOWN" | "MIXED" | "UNAVAILABLE";
  score5m: number | null;
  score15m: number | null;
  rsi5m: number | null;
  rsi15m: number | null;
  reason: string;
  estimatedFill: FillResult | null;
};

export type TradeResult = {
  account: PaperAccount;
  fill: FillResult | null;
  error?: string;
};

export type BacktestRow = {
  timestamp: number;
  asset: string;
  duration: Horizon;
  marketId?: string;
  reference: number;
  spot: number;
  upAsk: number;
  downAsk: number;
  outcome: PaperSide | null;
  remainingSeconds?: number;
};

export type BacktestTrade = {
  timestamp: number;
  asset: string;
  duration: Horizon;
  side: PaperSide;
  fair: number;
  entry: number;
  edge: number;
  notional: number;
  status: "SETTLED WIN" | "SETTLED LOSS" | "UNSETTLED";
  pnl: number | null;
};

export type BacktestResult = {
  signals: number;
  settled: number;
  unsettled: number;
  wins: number;
  losses: number;
  netPnl: number | null;
  roi: number | null;
  maxDrawdown: number | null;
  winRate: number | null;
  averageEdge: number | null;
  brierScore: number | null;
  trades: BacktestTrade[];
  equityCurve: number[];
};

const round = (value: number, digits = 8) => Number(value.toFixed(digits));

export const createPaperAccount = (startingCash: number, timestamp = Date.now()): PaperAccount => {
  const safeCash = Number.isFinite(startingCash) && startingCash > 0 ? startingCash : 1000;
  return {
    startingCash: safeCash,
    cash: safeCash,
    realizedPnl: 0,
    fees: 0,
    openOrders: 0,
    positions: [],
    fills: [],
    closedTrades: [],
    equityHistory: [{ timestamp, equity: safeCash }],
  };
};

export const accountEquity = (account: PaperAccount, markets: Map<string, LiveMarket>): number => {
  return account.cash + account.positions.reduce((total, position) => {
    const market = markets.get(position.marketId);
    const mark = market ? bestBidFor(market, position.side) : position.mark;
    return total + (mark ?? position.mark ?? position.avgEntry) * position.shares;
  }, 0);
};

export const accountUnrealized = (account: PaperAccount, markets: Map<string, LiveMarket>): number => {
  return account.positions.reduce((total, position) => {
    const market = markets.get(position.marketId);
    const mark = market ? bestBidFor(market, position.side) : position.mark;
    return total + ((mark ?? position.avgEntry) - position.avgEntry) * position.shares;
  }, 0);
};

export const accountDeployed = (account: PaperAccount) => account.positions.reduce((total, position) => total + position.totalCost, 0);

export const accountWinRate = (account: PaperAccount): number | null => {
  if (!account.closedTrades.length) return null;
  return account.closedTrades.filter((trade) => trade.pnl > 0).length / account.closedTrades.length;
};

export const markAccount = (account: PaperAccount, markets: Map<string, LiveMarket>, timestamp = Date.now()): PaperAccount => {
  const positions = account.positions.map((position) => {
    const market = markets.get(position.marketId);
    return {
      ...position,
      mark: market ? bestBidFor(market, position.side) : position.mark,
      lastUpdated: timestamp,
    };
  });
  const marked = { ...account, positions };
  const equity = accountEquity(marked, markets);
  const last = marked.equityHistory[marked.equityHistory.length - 1];
  const shouldAppend = !last || timestamp - last.timestamp >= 2500;
  return shouldAppend ? { ...marked, equityHistory: [...marked.equityHistory, { timestamp, equity }].slice(-5000) } : marked;
};

const walkAsks = (market: LiveMarket, side: PaperSide, budget: number, costs: CostConfig): FillResult | null => {
  const book = orderBookFor(market, side);
  if (!book?.asks.length || budget <= 0) return null;
  const slippageMultiplier = 1 + Math.max(0, costs.slippageBps) / 10_000;
  const feeMultiplier = 1 + Math.max(0, costs.feeRate);
  let remainingBudget = budget;
  let shares = 0;
  let notional = 0;
  let levels = 0;
  for (const level of [...book.asks].sort((left, right) => left.price - right.price)) {
    const effectivePrice = level.price * slippageMultiplier;
    const maxShares = remainingBudget / (effectivePrice * feeMultiplier);
    const levelShares = Math.min(level.size, maxShares);
    if (levelShares <= 0) break;
    shares += levelShares;
    notional += levelShares * effectivePrice;
    remainingBudget -= levelShares * effectivePrice * feeMultiplier;
    levels += 1;
    if (remainingBudget <= 0.00000001) break;
  }
  const minOrderSize = book.minOrderSize ?? 0;
  if (shares <= 0 || shares + 0.00000001 < minOrderSize) return null;
  const fee = notional * Math.max(0, costs.feeRate);
  return { shares: round(shares), price: round(notional / shares), notional: round(notional), fee: round(fee), totalCost: round(notional + fee), levels };
};

export const buyPaper = (
  account: PaperAccount,
  market: LiveMarket,
  side: PaperSide,
  budget: number,
  costs: CostConfig,
  reason: string,
  timestamp = Date.now(),
): TradeResult => {
  const boundedBudget = Math.min(Math.max(0, budget), account.cash);
  const fill = walkAsks(market, side, boundedBudget, costs);
  if (!fill) return { account, fill: null, error: "No executable ask depth or the order is below the market minimum." };
  const marketLabel = `${market.asset} ${market.duration}`;
  const existing = account.positions.find((position) => position.marketId === market.id && position.side === side);
  const nextPosition: PaperPosition = existing ? {
    ...existing,
    shares: round(existing.shares + fill.shares),
    avgEntry: round((existing.totalCost + fill.totalCost) / (existing.shares + fill.shares)),
    totalCost: round(existing.totalCost + fill.totalCost),
    mark: bestBidFor(market, side),
    lastUpdated: timestamp,
  } : {
    id: `${market.id}-${side}-${timestamp}`,
    marketId: market.id,
    marketLabel,
    asset: market.asset,
    duration: market.duration,
    side,
    shares: fill.shares,
    avgEntry: round(fill.totalCost / fill.shares),
    totalCost: fill.totalCost,
    mark: bestBidFor(market, side),
    endTime: market.endTime,
    openedAt: timestamp,
    lastUpdated: timestamp,
  };
  const positions = existing ? account.positions.map((position) => position.id === existing.id ? nextPosition : position) : [...account.positions, nextPosition];
  const fillRecord: PaperFill = {
    id: `${timestamp}-${market.id}-${side}-buy`,
    timestamp,
    action: "BUY",
    marketId: market.id,
    marketLabel,
    asset: market.asset,
    duration: market.duration,
    side,
    shares: fill.shares,
    price: fill.price,
    notional: fill.notional,
    fee: fill.fee,
    reason,
  };
  return {
    account: {
      ...account,
      cash: round(account.cash - fill.totalCost),
      fees: round(account.fees + fill.fee),
      positions,
      fills: [fillRecord, ...account.fills].slice(0, 2000),
    },
    fill,
  };
};

export const closePaperPositions = (
  account: PaperAccount,
  markets: Map<string, LiveMarket>,
  costs: CostConfig,
  reason: string,
  timestamp = Date.now(),
  positionIds?: Set<string>,
): { account: PaperAccount; closed: number; skipped: number; realized: number } => {
  let cash = account.cash;
  let fees = account.fees;
  let realizedPnl = account.realizedPnl;
  const remaining: PaperPosition[] = [];
  const sells: PaperFill[] = [];
  const closedTrades: ClosedPaperTrade[] = [];
  let closed = 0;
  let skipped = 0;
  for (const position of account.positions) {
    if (positionIds && !positionIds.has(position.id)) {
      remaining.push(position);
      continue;
    }
    const market = markets.get(position.marketId);
    const exit = market ? bestBidFor(market, position.side) : position.mark;
    if (!market || exit === null) {
      remaining.push(position);
      skipped += 1;
      continue;
    }
    const proceeds = position.shares * exit;
    const exitFee = proceeds * Math.max(0, costs.feeRate);
    const pnl = proceeds - exitFee - position.totalCost;
    cash += proceeds - exitFee;
    fees += exitFee;
    realizedPnl += pnl;
    closed += 1;
    const marketLabel = position.marketLabel;
    sells.push({
      id: `${timestamp}-${position.marketId}-${position.side}-sell`,
      timestamp,
      action: "SELL",
      marketId: position.marketId,
      marketLabel,
      asset: position.asset,
      duration: position.duration,
      side: position.side,
      shares: position.shares,
      price: exit,
      notional: proceeds,
      fee: exitFee,
      reason,
    });
    closedTrades.push({
      id: `${timestamp}-${position.marketId}-${position.side}-closed`,
      timestamp,
      marketId: position.marketId,
      marketLabel,
      asset: position.asset,
      duration: position.duration,
      side: position.side,
      shares: position.shares,
      entry: position.avgEntry,
      exit,
      pnl,
      reason,
    });
  }
  return {
    account: {
      ...account,
      cash: round(cash),
      fees: round(fees),
      realizedPnl: round(realizedPnl),
      positions: remaining,
      fills: [...sells, ...account.fills].slice(0, 2000),
      closedTrades: [...closedTrades, ...account.closedTrades].slice(0, 2000),
    },
    closed,
    skipped,
    realized: round(realizedPnl - account.realizedPnl),
  };
};

export const settleResolvedPaperPositions = (
  account: PaperAccount,
  markets: Map<string, LiveMarket>,
  reason: string,
  timestamp = Date.now(),
): { account: PaperAccount; closed: number; skipped: number; realized: number } => {
  let cash = account.cash;
  let realizedPnl = account.realizedPnl;
  const remaining: PaperPosition[] = [];
  const sells: PaperFill[] = [];
  const closedTrades: ClosedPaperTrade[] = [];
  let closed = 0;
  let skipped = 0;
  for (const position of account.positions) {
    const market = markets.get(position.marketId);
    const isExpired = market ? market.endTime <= timestamp : position.endTime <= timestamp;
    const outcome = market && market.reference !== null && market.spot !== null && isExpired ? market.spot >= market.reference ? "UP" : "DOWN" : null;
    if (!isExpired || !outcome) {
      remaining.push(position);
      if (isExpired) skipped += 1;
      continue;
    }
    const exit = position.side === outcome ? 1 : 0;
    const proceeds = position.shares * exit;
    const pnl = proceeds - position.totalCost;
    cash += proceeds;
    realizedPnl += pnl;
    closed += 1;
    sells.push({
      id: `${timestamp}-${position.marketId}-${position.side}-resolve`,
      timestamp,
      action: "SELL",
      marketId: position.marketId,
      marketLabel: position.marketLabel,
      asset: position.asset,
      duration: position.duration,
      side: position.side,
      shares: position.shares,
      price: exit,
      notional: proceeds,
      fee: 0,
      reason: `${reason} · ${outcome} resolved`,
    });
    closedTrades.push({
      id: `${timestamp}-${position.marketId}-${position.side}-resolved`,
      timestamp,
      marketId: position.marketId,
      marketLabel: position.marketLabel,
      asset: position.asset,
      duration: position.duration,
      side: position.side,
      shares: position.shares,
      entry: position.avgEntry,
      exit,
      pnl,
      reason: `${reason} · ${outcome} resolved`,
    });
  }
  return {
    account: {
      ...account,
      cash: round(cash),
      realizedPnl: round(realizedPnl),
      positions: remaining,
      fills: [...sells, ...account.fills].slice(0, 2000),
      closedTrades: [...closedTrades, ...account.closedTrades].slice(0, 2000),
    },
    closed,
    skipped,
    realized: round(realizedPnl - account.realizedPnl),
  };
};

export const closeExpiringPaperPositions = (
  account: PaperAccount,
  markets: Map<string, LiveMarket>,
  costs: CostConfig,
  reason: string,
  timestamp = Date.now(),
): { account: PaperAccount; closed: number; skipped: number; realized: number } => {
  const expiring = new Set(account.positions.filter((position) => {
    const market = markets.get(position.marketId);
    return market ? market.remaining <= 15 || market.endTime <= timestamp : position.endTime <= timestamp;
  }).map((position) => position.id));
  return expiring.size ? closePaperPositions(account, markets, costs, reason, timestamp, expiring) : { account, closed: 0, skipped: 0, realized: 0 };
};

export const candidateFor = (market: LiveMarket, side: PaperSide, costs: CostConfig, budget = 25) => {
  if (market.remaining < 30) return null;
  const fair = sideFairProbability(market, side);
  const ask = bestAskFor(market, side);
  const fill = fair !== null ? walkAsks(market, side, budget, costs) : null;
  if (fair === null || ask === null || !fill) return null;
  const edge = fair - fill.totalCost / fill.shares;
  return { side, fair, ask: fill.price, edge, estimatedFill: fill };
};

type ChartTrendStats = { score: number; rsi: number; volatility: number };

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clampScore = (value: number) => Math.min(1, Math.max(-1, value));
const tanh = (value: number) => {
  const bounded = Math.max(-10, Math.min(10, value));
  const exponential = Math.exp(2 * bounded);
  return (exponential - 1) / (exponential + 1);
};

const ema = (values: number[], period: number) => {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  return values.slice(1).reduce((previous, value) => alpha * value + (1 - alpha) * previous, values[0]);
};

const rsi = (closes: number[], period = 14) => {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-period - 1);
  const changes = recent.slice(1).map((close, index) => close - recent[index]);
  const gains = changes.map((change) => Math.max(0, change));
  const losses = changes.map((change) => Math.max(0, -change));
  const averageGain = mean(gains);
  const averageLoss = mean(losses);
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
};

const standardDeviation = (values: number[]) => {
  if (values.length < 2) return null;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
};

const chartTrendStats = (history: MarketCandle[], barSeconds: number, now: number): ChartTrendStats | null => {
  const candles = history.filter((candle) => candle.timestamp + barSeconds * 1000 <= now && candle.close > 0 && candle.high >= candle.low).slice(-80);
  if (candles.length < 8) return null;
  const closes = candles.map((candle) => candle.close);
  const changes = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  const volatility = standardDeviation(changes.slice(-24));
  const rsiValue = rsi(closes, Math.min(14, closes.length - 1));
  if (volatility === null || volatility <= 0 || rsiValue === null) return null;

  const shortEma = ema(closes.slice(-8), 5);
  const longEma = ema(closes.slice(-24), 18);
  const atrCandles = candles.slice(-14);
  const averageTrueRange = mean(atrCandles.map((candle, index) => {
    const previousClose = atrCandles[index - 1]?.close ?? candle.close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  }));
  const emaScore = shortEma !== null && longEma !== null && averageTrueRange > 0 ? tanh(((shortEma - longEma) / averageTrueRange) * 1.4) : 0;
  const recentReturn = Math.log(closes[closes.length - 1] / closes[closes.length - 4]);
  const momentumScore = tanh(recentReturn / (volatility * Math.sqrt(3) * 1.35));
  const rsiScore = clampScore((rsiValue - 50) / 23);
  const recentCandles = candles.slice(-3);
  const bodyScore = mean(recentCandles.map((candle) => {
    const range = Math.max(candle.high - candle.low, candle.close * 0.000001);
    return clampScore((candle.close - candle.open) / range);
  }));
  const previousVolume = mean(candles.slice(-15, -5).map((candle) => candle.volume));
  const recentVolume = mean(recentCandles.map((candle) => candle.volume));
  const volumeAgreement = previousVolume > 0 && recentVolume > previousVolume * 1.05
    ? Math.sign(recentReturn) * Math.min(1, Math.log(recentVolume / previousVolume) / Math.log(2))
    : 0;
  const score = clampScore(emaScore * 0.34 + momentumScore * 0.32 + rsiScore * 0.16 + bodyScore * 0.1 + volumeAgreement * 0.08);
  return { score, rsi: rsiValue, volatility };
};

const trendLabel = (score: number | null): MarketSignal["trend5m"] => score === null
  ? "UNAVAILABLE"
  : score >= 0.16 ? "UP" : score <= -0.16 ? "DOWN" : "MIXED";

type DirectionalRead = { bias: MarketSignal["bias"]; confidence: number | null; ageSeconds: number | null };

const liveMicroScore = (history: { timestamp: number; price: number }[] | undefined, start: number, now: number, early: boolean): number | null => {
  const from = early ? start - 1500 : now - 30_000;
  const points = (history ?? []).filter((point) => point.timestamp >= from && point.timestamp <= now && point.price > 0).slice(-60);
  if (points.length < 5 || now - points[points.length - 1].timestamp > 5000 || points[points.length - 1].timestamp - points[0].timestamp < 4000) return null;
  const changes = points.slice(1).map((point, index) => Math.log(point.price / points[index].price));
  const volatility = standardDeviation(changes);
  const netReturn = Math.log(points[points.length - 1].price / points[0].price);
  if (volatility === null || volatility <= 0 || netReturn === 0) return 0;
  const path = changes.reduce((sum, change) => sum + Math.abs(change), 0);
  const efficiency = path > 0 ? Math.abs(netReturn) / path : 0;
  const activeFraction = changes.filter((change) => Math.abs(change) > Math.max(1e-8, volatility * 0.05)).length / changes.length;
  const zScore = netReturn / (volatility * Math.sqrt(changes.length));
  return clampScore(tanh(zScore / 2) * Math.sqrt(efficiency * activeFraction));
};

const directionalRead = (market: LiveMarket, stats5m: ChartTrendStats | null, stats15m: ChartTrendStats | null, now: number): DirectionalRead => {
  const marketStart = market.startTime ?? market.endTime - (market.duration === "5m" ? 300_000 : 900_000);
  const ageSeconds = Math.max(0, (now - marketStart) / 1000);
  const early = ageSeconds <= 90;
  const micro = liveMicroScore(market.spotHistory, marketStart, now, early);
  const target = market.duration === "5m" ? stats5m?.score : stats15m?.score;
  const context = market.duration === "5m" ? stats15m?.score : stats5m?.score;
  const chartScore = target !== undefined && target !== null && context !== undefined && context !== null
    ? target * 0.62 + context * 0.38
    : target !== undefined && target !== null ? target * 0.75
      : context !== undefined && context !== null ? context * 0.5 : null;
  const referenceScore = market.fairUp !== null
    ? clampScore((market.fairUp - 0.5) * 3)
    : market.distance !== null ? tanh(market.distance / 0.0008) : null;

  let weightedScore = 0;
  let totalWeight = 0;
  let sourceCount = 0;
  const add = (score: number | null, weight: number) => {
    if (score === null) return;
    weightedScore += score * weight;
    totalWeight += weight;
    sourceCount += 1;
  };
  if (early && micro !== null) {
    add(micro, 0.58);
    add(chartScore, 0.28);
    add(referenceScore, 0.14);
  } else {
    add(chartScore, 0.58);
    add(referenceScore, 0.27);
    add(micro, 0.15);
  }
  if (!totalWeight) return { bias: "WARMING UP", confidence: null, ageSeconds };
  const score = clampScore(weightedScore / totalWeight);
  const bias: MarketSignal["bias"] = score >= 0.08 ? "UP" : score <= -0.08 ? "DOWN" : "NEUTRAL";
  const confidence = Math.min(0.84, 0.5 + Math.abs(score) * 0.32 + Math.min(0.04, Math.max(0, sourceCount - 1) * 0.02));
  return { bias, confidence, ageSeconds };
};

const passSignal = (reason: string, stats5m: ChartTrendStats | null = null, stats15m: ChartTrendStats | null = null, fairUp: number | null = null, read: DirectionalRead = { bias: "WARMING UP", confidence: null, ageSeconds: null }, upEdge: number | null = null, downEdge: number | null = null): MarketSignal => ({
  action: "PASS",
  tier: "PASS",
  bias: read.bias,
  biasConfidence: read.confidence,
  confidence: null,
  fairUp,
  upEdge,
  downEdge,
  entryPrice: null,
  edge: null,
  trend5m: trendLabel(stats5m?.score ?? null),
  trend15m: trendLabel(stats15m?.score ?? null),
  score5m: stats5m?.score ?? null,
  score15m: stats15m?.score ?? null,
  rsi5m: stats5m?.rsi ?? null,
  rsi15m: stats15m?.rsi ?? null,
  reason,
  estimatedFill: null,
});

export const analyzeMarketSignal = (market: LiveMarket, costs: CostConfig, budget = 25, minNetEdge = 0.04): MarketSignal => {
  const now = market.sourceTimestamp || Date.now();
  const stats5m = chartTrendStats(market.chart5m, 300, now);
  const stats15m = chartTrendStats(market.chart15m, 900, now);
  const read = directionalRead(market, stats5m, stats15m, now);
  const comparePrices = (fairUp: number | null) => {
    if (fairUp === null) return { upEdge: null, downEdge: null };
    const upFill = walkAsks(market, "UP", budget, costs);
    const downFill = walkAsks(market, "DOWN", budget, costs);
    return {
      upEdge: upFill ? fairUp - upFill.totalCost / upFill.shares : null,
      downEdge: downFill ? 1 - fairUp - downFill.totalCost / downFill.shares : null,
    };
  };
  const pass = (reason: string, fairUp = market.fairUp) => {
    const comparison = comparePrices(fairUp);
    return passSignal(reason, stats5m, stats15m, fairUp, read, comparison.upEdge, comparison.downEdge);
  };
  if (market.reference === null || market.reference <= 0 || market.spot === null || market.spot <= 0) return pass("Missing live spot or market reference.");
  if (market.chartUpdatedAt === null || now - market.chartUpdatedAt > 120_000) return pass("Chart feed is stale; waiting for a fresh candle snapshot.");

  if (!stats5m || !stats15m) {
    const reason = !market.chart5m.length && !market.chart15m.length
      ? `Coinbase OHLC history is unavailable for ${market.asset}.`
      : "Need at least 8 complete candles on both 5m and 15m charts.";
    return pass(reason);
  }
  if (market.remaining < (market.duration === "5m" ? 30 : 60)) return pass("Too little time remains for a fresh entry.");
  if (market.fairUp === null) return pass("Candle volatility is unavailable, so probability is not estimated.");
  if (market.referenceSource === "COINBASE ESTIMATE" && Math.abs(market.distance ?? 0) < 0.0005) return pass("Estimated Coinbase opening price is too close to spot; waiting for a clearer move or the market reference.");

  const target = market.duration === "5m" ? stats5m.score : stats15m.score;
  const context = market.duration === "5m" ? stats15m.score : stats5m.score;
  const chartAgreement = Math.sign(target) !== 0 && Math.sign(target) === Math.sign(context) && Math.abs(target) >= 0.2 && Math.abs(context) >= 0.14;
  if (!chartAgreement) return pass("5m and 15m chart trends do not confirm the same direction.");
  if (Math.sign(market.fairUp - 0.5) !== Math.sign(target)) return pass("Spot versus the market reference conflicts with the candle trend.");

  const combinedScore = clampScore(target * 0.62 + context * 0.38);
  const fairUp = Math.min(0.99, Math.max(0.01, market.fairUp + combinedScore * 0.075));
  const upFill = walkAsks(market, "UP", budget, costs);
  const downFill = walkAsks(market, "DOWN", budget, costs);
  const candidates = [
    upFill ? { side: "UP" as const, fill: upFill, edge: fairUp - upFill.totalCost / upFill.shares } : null,
    downFill ? { side: "DOWN" as const, fill: downFill, edge: 1 - fairUp - downFill.totalCost / downFill.shares } : null,
  ].filter((candidate): candidate is { side: PaperSide; fill: FillResult; edge: number } => candidate !== null).sort((left, right) => right.edge - left.edge);
  const best = candidates[0];
  const priceComparison = comparePrices(fairUp);
  if (!best) return { ...pass("Neither UP nor DOWN has executable ask depth for the configured paper size.", fairUp), upEdge: priceComparison.upEdge, downEdge: priceComparison.downEdge };
  const side = best.side;
  const fill = best.fill;
  const edge = best.edge;
  const sideSpread = side === "UP" && market.upAsk !== null && market.upBid !== null ? market.upAsk - market.upBid : side === "DOWN" && market.downAsk !== null && market.downBid !== null ? market.downAsk - market.downBid : market.spread;
  if (sideSpread === null || sideSpread > 0.12) return { ...pass(`Best value is ${side}, but that side's spread is too wide for a reliable entry.`, fairUp), upEdge: priceComparison.upEdge, downEdge: priceComparison.downEdge };

  const confidence = Math.min(0.96, 0.54 + Math.abs(combinedScore) * 0.2 + Math.abs(fairUp - 0.5) * 0.72 + (chartAgreement ? 0.06 : 0) - (market.referenceSource === "COINBASE ESTIMATE" ? 0.04 : 0));
  const requiredEdge = Math.max(0.04, minNetEdge) + (market.referenceSource === "COINBASE ESTIMATE" ? 0.02 : 0);
  if (confidence < 0.66) return { ...pass("Chart agreement is present, but model confidence is below the entry threshold.", fairUp), confidence, upEdge: priceComparison.upEdge, downEdge: priceComparison.downEdge, entryPrice: fill.price, edge, estimatedFill: fill };
  if (edge < requiredEdge) return { ...pass(`Best price edge is ${Math.round(edge * 1000) / 10}% on ${side}, below the ${Math.round(requiredEdge * 1000) / 10}% entry floor.`, fairUp), confidence, upEdge: priceComparison.upEdge, downEdge: priceComparison.downEdge, entryPrice: fill.price, edge, estimatedFill: fill };

  const locked = market.referenceSource === "POLYMARKET" && confidence >= 0.82 && edge >= Math.max(0.08, requiredEdge * 2) && Math.abs(target) >= 0.5 && Math.abs(context) >= 0.25;
  return {
    action: side,
    tier: locked ? "LOCK" : "ENTRY",
    bias: read.bias,
    biasConfidence: read.confidence,
    confidence,
    fairUp,
    upEdge: priceComparison.upEdge,
    downEdge: priceComparison.downEdge,
    entryPrice: fill.price,
    edge,
    trend5m: trendLabel(stats5m.score),
    trend15m: trendLabel(stats15m.score),
    score5m: stats5m.score,
    score15m: stats15m.score,
    rsi5m: stats5m.rsi,
    rsi15m: stats15m.rsi,
    reason: locked ? "5m and 15m trends align; confidence, order-book depth, and net-edge gates pass." : market.referenceSource === "COINBASE ESTIMATE" ? "5m and 15m trends align; entry gates include extra protection for an estimated opening price." : "5m and 15m trends align and the cost-adjusted entry gates pass.",
    estimatedFill: fill,
  };
};

export const bestCandidateFor = (market: LiveMarket, costs: CostConfig, budget = 25, minNetEdge = 0.04) => {
  const signal = analyzeMarketSignal(market, costs, budget, minNetEdge);
  if (signal.action === "PASS" || signal.entryPrice === null || signal.edge === null || signal.fairUp === null || !signal.estimatedFill) return null;
  const fair = signal.action === "UP" ? signal.fairUp : 1 - signal.fairUp;
  return { side: signal.action, fair, ask: signal.entryPrice, edge: signal.edge, estimatedFill: signal.estimatedFill };
};

export const runBacktest = (
  inputRows: BacktestRow[],
  params: { startingCash: number; minEdge: number; maxTrade: number; feeRate: number; slippageBps: number },
): BacktestResult => {
  const rows = [...inputRows].sort((left, right) => left.timestamp - right.timestamp);
  const startingCash = Math.max(1, Number.isFinite(params.startingCash) ? params.startingCash : 1000);
  const minEdge = Math.max(0, Number.isFinite(params.minEdge) ? params.minEdge : 0);
  const maxTrade = Math.max(0, Number.isFinite(params.maxTrade) ? params.maxTrade : 0);
  const feeRate = Math.max(0, Number.isFinite(params.feeRate) ? params.feeRate : 0);
  const slippageMultiplier = 1 + Math.max(0, Number.isFinite(params.slippageBps) ? params.slippageBps : 0) / 10_000;
  const feeMultiplier = 1 + feeRate;
  let cash = startingCash;
  let committed = 0;
  let realized = 0;
  let peak = startingCash;
  let maxDrawdown = 0;
  let signals = 0;
  let settled = 0;
  let wins = 0;
  let losses = 0;
  let edgeSum = 0;
  let brierSum = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve = [startingCash];

  type OpenBacktestTrade = {
    tradeIndex: number;
    shares: number;
    entryCost: number;
    fair: number;
    side: PaperSide;
  };

  const openTrades = new Map<string, OpenBacktestTrade>();
  const completedMarkets = new Set<string>();
  const marketKeyFor = (row: BacktestRow) => row.marketId?.trim() || `${row.asset}:${row.duration}:${Math.floor(row.timestamp / (row.duration === "5m" ? 300_000 : 900_000))}`;
  const updateEquity = () => {
    const equity = round(cash + committed);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
    equityCurve.push(equity);
  };
  const settle = (marketKey: string, outcome: PaperSide) => {
    const open = openTrades.get(marketKey);
    if (!open) return;
    const won = outcome === open.side;
    const payout = won ? open.shares : 0;
    const exitFee = payout * feeRate;
    const pnl = round(payout - open.entryCost - exitFee);
    cash = round(cash + payout - exitFee);
    committed = Math.max(0, round(committed - open.entryCost));
    realized = round(realized + pnl);
    settled += 1;
    if (won) wins += 1;
    else losses += 1;
    brierSum += (open.fair - (won ? 1 : 0)) ** 2;
    const trade = trades[open.tradeIndex];
    if (trade) trades[open.tradeIndex] = { ...trade, status: won ? "SETTLED WIN" : "SETTLED LOSS", pnl };
    openTrades.delete(marketKey);
    completedMarkets.add(marketKey);
    updateEquity();
  };

  for (const row of rows) {
    const marketKey = marketKeyFor(row);
    if (openTrades.has(marketKey)) {
      if (row.outcome !== null) settle(marketKey, row.outcome);
      continue;
    }
    if (completedMarkets.has(marketKey)) continue;
    if (!Number.isFinite(row.reference) || !Number.isFinite(row.spot) || row.reference <= 0 || row.spot <= 0) continue;
    const remainingValue = row.remainingSeconds ?? (row.duration === "5m" ? 300 : 900);
    const remaining = Number.isFinite(remainingValue) ? Math.max(0, remainingValue) : row.duration === "5m" ? 300 : 900;
    if (remaining < 30) continue;
    const fairUp = estimateFairProbability(row.reference, row.spot, remaining);
    if (fairUp === null) continue;
    const upCost = row.upAsk * slippageMultiplier * feeMultiplier;
    const downCost = row.downAsk * slippageMultiplier * feeMultiplier;
    const upEdge = fairUp - upCost;
    const downEdge = 1 - fairUp - downCost;
    const side: PaperSide = upEdge >= downEdge ? "UP" : "DOWN";
    const fair = side === "UP" ? fairUp : 1 - fairUp;
    const entry = side === "UP" ? row.upAsk * slippageMultiplier : row.downAsk * slippageMultiplier;
    const edge = Math.max(upEdge, downEdge);
    if (!Number.isFinite(entry) || entry <= 0 || entry >= 1 || !Number.isFinite(edge) || edge < minEdge) continue;
    const entryBudget = Math.min(maxTrade, cash);
    const shares = entryBudget / (entry * feeMultiplier);
    if (!Number.isFinite(shares) || shares <= 0 || entryBudget <= 0) continue;
    const notional = shares * entry;
    const entryFee = notional * feeRate;
    const entryCost = round(notional + entryFee);
    signals += 1;
    edgeSum += edge;
    cash = round(cash - entryCost);
    committed = round(committed + entryCost);
    const tradeIndex = trades.push({ timestamp: row.timestamp, asset: row.asset, duration: row.duration, side, fair, entry, edge, notional: round(notional), status: "UNSETTLED", pnl: null }) - 1;
    openTrades.set(marketKey, { tradeIndex, shares, entryCost, fair, side });
    if (row.outcome !== null) settle(marketKey, row.outcome);
  }
  const unsettled = openTrades.size;
  return {
    signals,
    settled,
    unsettled,
    wins,
    losses,
    netPnl: settled ? realized : null,
    roi: settled ? realized / startingCash : null,
    maxDrawdown: settled ? maxDrawdown : null,
    winRate: settled ? wins / settled : null,
    averageEdge: signals ? edgeSum / signals : null,
    brierScore: settled ? brierSum / settled : null,
    trades: trades.slice(-250),
    equityCurve,
  };
};

export const parseBacktestCsv = (text: string): { rows: BacktestRow[]; rejected: number } => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { rows: [], rejected: 0 };
  const split = (line: string) => {
    const values: string[] = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
        else quoted = !quoted;
      } else if (char === "," && !quoted) { values.push(current.trim()); current = ""; }
      else current += char;
    }
    values.push(current.trim());
    return values;
  };
  const headers = split(lines[0]).map((header) => header.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  const valueFor = (values: string[], names: string[]) => {
    const index = headers.findIndex((header) => names.includes(header));
    return index >= 0 ? values[index] : "";
  };
  const numberFor = (values: string[], names: string[]) => {
    const raw = valueFor(values, names).replace(/[$,%]/g, "").replace(/,/g, "");
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const outcomeFor = (values: string[]): PaperSide | null => {
    const raw = valueFor(values, ["outcome", "winner", "settled_outcome", "resolved_outcome"]).toLowerCase().trim();
    if (["up", "yes", "higher", "above", "1", "true", "win"].includes(raw)) return "UP";
    if (["down", "no", "lower", "below", "0", "false", "loss"].includes(raw)) return "DOWN";
    return null;
  };
  const rows: BacktestRow[] = [];
  let rejected = 0;
  for (const line of lines.slice(1)) {
    const values = split(line);
    const timestampRaw = valueFor(values, ["timestamp", "time", "datetime", "date"]);
    const timestampNumber = Number(timestampRaw);
    const timestamp = Number.isFinite(timestampNumber) ? (timestampNumber < 10_000_000_000 ? timestampNumber * 1000 : timestampNumber) : Date.parse(timestampRaw);
    const asset = valueFor(values, ["asset", "symbol"]).toUpperCase();
    const durationRaw = valueFor(values, ["duration", "horizon"]).toLowerCase();
    const duration: Horizon = durationRaw.includes("15") ? "15m" : "5m";
    const reference = numberFor(values, ["reference", "reference_price", "strike", "threshold"]);
    const spot = numberFor(values, ["spot", "spot_price", "underlying"]);
    const upAsk = numberFor(values, ["up_ask", "yes_ask", "higher_ask"]);
    const downAsk = numberFor(values, ["down_ask", "no_ask", "lower_ask"]);
    if (!Number.isFinite(timestamp) || !asset || reference === null || spot === null || upAsk === null || downAsk === null) { rejected += 1; continue; }
    rows.push({ timestamp, asset, duration, reference, spot, upAsk, downAsk, outcome: outcomeFor(values), remainingSeconds: numberFor(values, ["remaining_seconds", "seconds_left"]) ?? undefined, marketId: valueFor(values, ["market_id", "market"]) || undefined });
  }
  return { rows, rejected };
};

export const backtestCsvTemplate = "timestamp,asset,duration,market_id,reference,spot,up_ask,down_ask,outcome,remaining_seconds\n";
