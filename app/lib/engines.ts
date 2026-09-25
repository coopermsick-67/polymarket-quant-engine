import {
  anchoredFairUp,
  bestAskFor,
  bestBidFor,
  CONSERVATIVE_CRYPTO_FEE_SCHEDULE,
  marketImpliedProbabilityUp,
  orderBookFor,
  sideFairProbability,
  synchronizedPolymarketTime,
  type Horizon,
  type LiveMarket,
  type MarketCandle,
  type OrderBook,
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
  riskDayKey?: string;
  riskDayStartEquityUsd?: number;
  peakLiquidationEquityUsd?: number;
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

export type SidePriceEstimate = {
  bestAsk: number | null;
  averagePrice: number | null;
  costPerShare: number | null;
  grossEdgeAtBestAsk: number | null;
  /** Raw candle-model edge after the same depth walk, fee, and slippage. */
  rawModelNetEdge: number | null;
  /** Portion of all-in cost attributable to fees per share. */
  feePerShare: number | null;
  netEdge: number | null;
  fill: FillResult | null;
};

export type MarketSignal = {
  action: PaperSide | "PASS";
  tier: "LOCK" | "ENTRY" | "PASS";
  bias: PaperSide | "NEUTRAL" | "WARMING UP";
  biasConfidence: number | null;
  /** Compatibility field; this is a directional heuristic score, not a calibrated win probability. */
  confidence: number | null;
  /** Candle probability blended with the book midpoint; every displayed net edge uses this. */
  fairUp: number | null;
  /** Unanchored candle-model P(UP), shown for transparency only. */
  rawModelUp: number | null;
  /** Midpoint indication only; orders pay the executable ask and fees. */
  marketProbabilityUp: number | null;
  /** Heuristic uncertainty penalty, not a calibrated confidence interval. */
  modelUncertainty: number;
  microScore: number | null;
  executableCostProbability: number | null;
  expectedNetProfitUsd: number | null;
  /** Net probability edge at the requested budget after book walk, fee estimate and slippage. */
  upEdge: number | null;
  /** Net probability edge at the requested budget after book walk, fee estimate and slippage. */
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
  /** Probability captured when the live model made the decision. */
  modelFairUp?: number | null;
  /** Captured live decision; PASS rows are never replayed as trades. */
  modelAction?: PaperSide | "PASS" | null;
  modelEdge?: number | null;
  modelEntryPrice?: number | null;
  modelStakeUsd?: number | null;
  /** The market's taker fee coefficient recorded at observation time (rate in rate*p*(1-p)). */
  feeRate?: number | null;
};

/** Polymarket's crypto taker fee coefficient: fee per share = rate * p * (1 - p). */
export const POLYMARKET_CRYPTO_TAKER_FEE_RATE = 0.07;

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
  /** Rows skipped because no explicit decision and valid model probability were recorded for them. */
  skippedWithoutModel: number;
  /** Decision rows that could not be replayed consistently (no expiry, bad prices, conflicting outcomes). */
  rejectedRows: number;
  /** Drawdown is measured on cash plus the cost of open positions, i.e. at settlement, not intramarket liquidation. */
  drawdownBasis: "SETTLEMENT";
  /** Net P&L with every fee scaled, to show how much of the result depends on the fee assumption. */
  feeSensitivity: Array<{ feeMultiplier: number; netPnl: number | null }>;
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
const roundFee = (value: number) => Number((Math.round(Math.max(0, value) * 100_000) / 100_000).toFixed(5));
/**
 * A book older than this cannot price a decision on a 5-minute market. Books
 * are stamped in Polymarket server time; a healthy stream re-confirms quiet
 * books, so this only trips when data has genuinely stopped arriving.
 */
export const MAX_ORDER_BOOK_AGE_MS = 10_000;

const feeScheduleFor = (market: Pick<LiveMarket, "feeSchedule">) => {
  const schedule = market.feeSchedule;
  if (schedule && Number.isFinite(schedule.rate) && schedule.rate >= 0 && schedule.rate <= 1
    && Number.isFinite(schedule.exponent) && schedule.exponent >= 0 && schedule.exponent <= 8) return schedule;
  return CONSERVATIVE_CRYPTO_FEE_SCHEDULE;
};

/**
 * Polymarket's taker fee curve is shares * rate * (price * (1-price)) ** exponent.
 * When the market's own schedule was read from the CLOB it is exact and is
 * used as is. The configured notional rate is only a conservative stand-in
 * when that schedule could not be read; applying it on top of a known
 * schedule overstated fees several times over near the price extremes.
 */
export const feePerShareAt = (market: Pick<LiveMarket, "feeSchedule">, price: number, costs: CostConfig): number => {
  const schedule = feeScheduleFor(market);
  const boundedPrice = Math.min(1, Math.max(0, price));
  const curve = Math.pow(boundedPrice * (1 - boundedPrice), schedule.exponent);
  const marketFee = schedule.feesEnabled ? schedule.rate * curve : 0;
  if (schedule.source === "CLOB") return marketFee;
  const configuredRate = Number.isFinite(costs.feeRate) ? Math.max(0, costs.feeRate) : 0;
  return Math.max(marketFee, boundedPrice * configuredRate);
};

export const createPaperAccount = (startingCash: number, timestamp = Date.now()): PaperAccount => {
  const safeCash = Number.isFinite(startingCash) && startingCash > 0 ? startingCash : 1000;
  return {
    startingCash: safeCash,
    cash: safeCash,
    riskDayKey: new Date(timestamp).toISOString().slice(0, 10),
    riskDayStartEquityUsd: safeCash,
    peakLiquidationEquityUsd: safeCash,
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

/**
 * Legacy paper sizing for callers that have not yet supplied market-specific
 * liquidity and fee inputs. A venue minimum never overrides the risk cap.
 */
export const paperStakeUsd = (
  bankroll: number,
  availableCash: number,
  minFraction = 0.005,
  maxFraction = 0.03,
  minimumUsd = 1,
): number => {
  const safeBankroll = Math.max(0, Number.isFinite(bankroll) ? bankroll : 0);
  const safeCash = Math.max(0, Number.isFinite(availableCash) ? availableCash : 0);
  const floor = Math.max(0, Number.isFinite(minimumUsd) ? minimumUsd : 1);
  const minPct = Math.max(0, Number.isFinite(minFraction) ? minFraction : 0.005);
  const maxPct = Math.max(minPct, Number.isFinite(maxFraction) ? maxFraction : 0.03);
  const target = Math.max(floor, safeBankroll * minPct);
  const cap = Math.min(safeCash, safeBankroll * maxPct);
  return cap + 0.00000001 < floor ? 0 : round(Math.min(target, cap));
};

/** Conservative net proceeds estimate for the daily-loss guard. */
export const accountLiquidationEquity = (account: PaperAccount, markets: Map<string, LiveMarket>, costs: CostConfig): number => {
  const liquidatableProceeds = account.positions.reduce((total, position) => {
    const market = markets.get(position.marketId);
    if (!market) return total;
    const fill = walkBids(market, position.side, position.shares, costs);
    // Any shares beyond visible bid depth are valued at zero until a fresh
    // executable bid appears, so a thin book cannot inflate the loss baseline.
    return total + (fill?.totalCost ?? 0);
  }, 0);
  return round(account.cash + liquidatableProceeds, 4);
};

export const updatePaperRiskBaselines = (account: PaperAccount, liquidationEquityUsd: number, timestamp = Date.now()): PaperAccount => {
  if (!Number.isFinite(liquidationEquityUsd) || liquidationEquityUsd < 0) return account;
  const riskDayKey = new Date(timestamp).toISOString().slice(0, 10);
  const sameDay = account.riskDayKey === riskDayKey && Number.isFinite(account.riskDayStartEquityUsd)
    && (account.riskDayStartEquityUsd ?? 0) > 0;
  const riskDayStartEquityUsd = sameDay ? account.riskDayStartEquityUsd! : liquidationEquityUsd;
  const peakLiquidationEquityUsd = Math.max(account.peakLiquidationEquityUsd ?? account.startingCash, liquidationEquityUsd);
  if (account.riskDayKey === riskDayKey && account.riskDayStartEquityUsd === riskDayStartEquityUsd
    && account.peakLiquidationEquityUsd === peakLiquidationEquityUsd) return account;
  return { ...account, riskDayKey, riskDayStartEquityUsd, peakLiquidationEquityUsd };
};

export const accountWinRate = (account: PaperAccount): number | null => {
  if (!account.closedTrades.length) return null;
  return account.closedTrades.filter((trade) => trade.pnl > 0).length / account.closedTrades.length;
};

export const markAccount = (account: PaperAccount, markets: Map<string, LiveMarket>, timestamp = Date.now(), costs: CostConfig = { feeRate: 0, slippageBps: 0 }): PaperAccount => {
  const positions = account.positions.map((position) => {
    const market = markets.get(position.marketId);
    return {
      ...position,
      mark: market ? bestBidFor(market, position.side) : position.mark,
      lastUpdated: timestamp,
    };
  });
  const marked = { ...account, positions };
  const withRiskBaselines = updatePaperRiskBaselines(marked, accountLiquidationEquity(marked, markets, costs), timestamp);
  const equity = accountEquity(withRiskBaselines, markets);
  const last = withRiskBaselines.equityHistory[withRiskBaselines.equityHistory.length - 1];
  const shouldAppend = !last || timestamp - last.timestamp >= 2500;
  return shouldAppend ? { ...withRiskBaselines, equityHistory: [...withRiskBaselines.equityHistory, { timestamp, equity }].slice(-5000) } : withRiskBaselines;
};

/**
 * Walk the ask ladder with a cash budget. With `fak`, the venue minimum is
 * checked against the order as submitted (budget at the limit price) and any
 * positive matched quantity is returned, as a real FAK order can partially
 * fill below the minimum; otherwise the fill itself must meet the minimum.
 */
const walkAsks = (market: LiveMarket, side: PaperSide, budget: number, costs: CostConfig, maxPrice = 1, fak = false): FillResult | null => {
  const book = orderBookFor(market, side);
  if (!isBookFreshForExecution(book) || !book.asks.length || budget <= 0) return null;
  const slippageBps = Number.isFinite(costs.slippageBps) ? Math.max(0, costs.slippageBps) : 0;
  const slippageMultiplier = 1 + slippageBps / 10_000;
  let remainingBudget = budget;
  let shares = 0;
  let notional = 0;
  let fee = 0;
  let levels = 0;
  for (const level of [...book.asks].sort((left, right) => left.price - right.price)) {
    // A limit order never takes liquidity above its limit price.
    if (level.price > maxPrice + 1e-9) break;
    const effectivePrice = level.price * slippageMultiplier;
    if (!Number.isFinite(effectivePrice) || effectivePrice <= 0 || effectivePrice >= 1) continue;
    const feePerShare = feePerShareAt(market, effectivePrice, costs);
    // Leave room for the CLOB's five-decimal fee rounding so a fill cannot overspend cash.
    const maxShares = Math.max(0, remainingBudget - 0.000005) / (effectivePrice + feePerShare);
    const levelShares = Math.min(level.size, maxShares);
    if (levelShares <= 0) break;
    const levelNotional = levelShares * effectivePrice;
    const levelFee = roundFee(levelShares * feePerShare);
    shares += levelShares;
    notional += levelNotional;
    fee += levelFee;
    remainingBudget -= levelNotional + levelFee;
    levels += 1;
    if (remainingBudget <= 0.00000001) break;
  }
  const minOrderSize = book.minOrderSize ?? 0;
  if (shares <= 0) return null;
  if (fak) {
    const limit = Math.min(maxPrice, 1 - 1e-9) * slippageMultiplier;
    const submittedShares = budget / (limit + feePerShareAt(market, limit, costs));
    if (submittedShares + 0.00000001 < minOrderSize) return null;
  } else if (shares + 0.00000001 < minOrderSize) return null;
  return { shares: round(shares), price: round(notional / shares), notional: round(notional), fee: round(fee, 5), totalCost: round(notional + fee, 5), levels };
};

/** Book timestamps are server time, so compare them with the synchronized clock, not the local one. */
export const isBookFreshForExecution = (book: OrderBook | null, now = Date.now()): book is OrderBook => {
  if (!book || book.timestamp === null) return false;
  const serverNow = synchronizedPolymarketTime(now);
  return book.timestamp <= serverNow + 2_000 && serverNow - book.timestamp <= MAX_ORDER_BOOK_AGE_MS;
};

/**
 * Quote one side at the requested cash size. `netEdge` compares blended fair
 * probability with the estimated all-in cost per share; it is unavailable if
 * the visible ask ladder cannot fill that size. The caller must also enforce
 * market data freshness before presenting it as actionable.
 */
export const estimateSidePrice = (
  market: LiveMarket,
  side: PaperSide,
  costs: CostConfig,
  budget: number,
  fairUp = anchoredFairUp(market),
): SidePriceEstimate => {
  const bestAsk = bestAskFor(market, side);
  const fairProbability = fairUp === null ? null : side === "UP" ? fairUp : 1 - fairUp;
  const rawModelProbability = market.fairUp === null ? null : side === "UP" ? market.fairUp : 1 - market.fairUp;
  const fill = walkAsks(market, side, budget, costs);
  const costPerShare = fill && fill.shares > 0 ? fill.totalCost / fill.shares : null;
  return {
    bestAsk,
    averagePrice: fill?.price ?? null,
    costPerShare,
    grossEdgeAtBestAsk: fairProbability !== null && bestAsk !== null ? fairProbability - bestAsk : null,
    rawModelNetEdge: rawModelProbability !== null && costPerShare !== null ? rawModelProbability - costPerShare : null,
    feePerShare: fill && fill.shares > 0 ? fill.fee / fill.shares : null,
    netEdge: fairProbability !== null && costPerShare !== null ? fairProbability - costPerShare : null,
    fill,
  };
};

const walkBids = (market: LiveMarket, side: PaperSide, requestedShares: number, costs: CostConfig, now = Date.now()): FillResult | null => {
  const book = orderBookFor(market, side);
  if (!isBookFreshForExecution(book, now) || !book.bids.length || requestedShares <= 0) return null;
  const slippageBps = Number.isFinite(costs.slippageBps) ? Math.max(0, costs.slippageBps) : 0;
  const slippageMultiplier = Math.max(0, 1 - slippageBps / 10_000);
  let remainingShares = requestedShares;
  let shares = 0;
  let notional = 0;
  let fee = 0;
  let levels = 0;
  for (const level of [...book.bids].sort((left, right) => right.price - left.price)) {
    const effectivePrice = level.price * slippageMultiplier;
    if (!Number.isFinite(effectivePrice) || effectivePrice <= 0 || effectivePrice > 1) continue;
    const levelShares = Math.min(level.size, remainingShares);
    if (levelShares <= 0) break;
    const levelNotional = levelShares * effectivePrice;
    shares += levelShares;
    notional += levelNotional;
    fee += roundFee(levelShares * feePerShareAt(market, effectivePrice, costs));
    remainingShares -= levelShares;
    levels += 1;
    if (remainingShares <= 0.00000001) break;
  }
  if (shares <= 0) return null;
  const netProceeds = Math.max(0, notional - fee);
  return { shares: round(shares), price: round(notional / shares), notional: round(notional), fee: round(fee, 5), totalCost: round(netProceeds, 5), levels };
};

/** What a paper cashout could actually receive from the visible bid book. */
export const estimatePaperExitFill = (
  market: LiveMarket,
  side: PaperSide,
  shares: number,
  costs: CostConfig,
  now = Date.now(),
): FillResult | null => walkBids(market, side, shares, costs, now);

/** Per-side order economics from the current ask book, for bankroll gates. */
export const paperEntryBookEconomics = (
  market: LiveMarket,
  side: PaperSide,
  costs: CostConfig,
  minimumUsd = 1,
  minimumSharesOverride = 0,
) => {
  const book = orderBookFor(market, side);
  const asks = (book?.asks ?? []).filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1 && Number.isFinite(level.size) && level.size > 0).sort((a, b) => a.price - b.price);
  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bestBidFor(market, side);
  const spreadPct = bestAsk !== null && bestBid !== null ? Math.max(0, bestAsk - bestBid) / bestAsk : null;
  const slippageMultiplier = 1 + Math.max(0, Number.isFinite(costs.slippageBps) ? costs.slippageBps : 0) / 10_000;
  // Only near-touch asks count toward the sizing liquidity cap. Far-away
  // shares cannot justify a large affordable stake at the displayed price.
  const nearTouchAsks = asks.filter((level) => bestAsk !== null && level.price <= bestAsk * slippageMultiplier + 1e-10);
  const availableDepthUsd = nearTouchAsks.reduce((sum, level) => {
    const price = level.price * slippageMultiplier;
    return price < 1 ? sum + level.size * (price + feePerShareAt(market, price, costs)) : sum;
  }, 0);
  const venueMinShares = book?.minOrderSize;
  const minimumSharesKnown = venueMinShares !== null && venueMinShares !== undefined && Number.isFinite(venueMinShares) && venueMinShares > 0;
  const minShares = Math.max(minimumSharesKnown ? venueMinShares : 0,
    Number.isFinite(minimumSharesOverride) && minimumSharesOverride > 0 ? minimumSharesOverride : 0);
  let remainingMinimumShares = minShares;
  let minimumSharesCost = 0;
  for (const level of asks) {
    if (remainingMinimumShares <= 0) break;
    const price = level.price * slippageMultiplier;
    if (price >= 1) continue;
    const taken = Math.min(remainingMinimumShares, level.size);
    minimumSharesCost += taken * (price + feePerShareAt(market, price, costs));
    remainingMinimumShares -= taken;
  }
  const minimumDepthAvailable = remainingMinimumShares <= 0;
  return {
    bestAsk,
    spreadPct,
    availableDepthUsd: round(availableDepthUsd, 5),
    minimumExecutableOrderUsd: minimumDepthAvailable ? Math.max(minimumUsd, Math.ceil((minimumSharesCost + (minShares > 0 ? 0.00001 : 0)) * 100) / 100) : Number.MAX_SAFE_INTEGER,
    minimumShares: minShares,
    minimumSharesKnown,
    minimumDepthAvailable,
  };
};

export const buyPaper = (
  account: PaperAccount,
  market: LiveMarket,
  side: PaperSide,
  budget: number,
  costs: CostConfig,
  reason: string,
  timestamp = Date.now(),
  maxPrice = 1,
  fak = false,
): TradeResult => {
  const boundedBudget = Math.min(Math.max(0, budget), account.cash);
  const fill = walkAsks(market, side, boundedBudget, costs, maxPrice, fak);
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
    const fill = market ? walkBids(market, position.side, position.shares, costs, timestamp) : null;
    if (!fill) {
      remaining.push(position);
      skipped += 1;
      continue;
    }
    const fullyClosed = fill.shares + 0.00000001 >= position.shares;
    const closedShares = fullyClosed ? position.shares : Math.min(position.shares, fill.shares);
    const basis = fullyClosed ? position.totalCost : position.totalCost * (closedShares / position.shares);
    const remainingShares = fullyClosed ? 0 : round(position.shares - closedShares);
    const remainingCost = fullyClosed ? 0 : Math.max(0, round(position.totalCost - basis));
    const exitFee = fill.fee;
    const netProceeds = fill.totalCost;
    const pnl = netProceeds - basis;
    cash += netProceeds;
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
      shares: closedShares,
      price: fill.price,
      notional: fill.notional,
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
      shares: closedShares,
      entry: position.avgEntry,
      exit: fill.price,
      pnl,
      reason,
    });
    if (!fullyClosed) {
      remaining.push({
        ...position,
        shares: remainingShares,
        totalCost: remainingCost,
        avgEntry: remainingShares > 0 ? round(remainingCost / remainingShares) : position.avgEntry,
        mark: bestBidFor(market!, position.side),
        lastUpdated: timestamp,
      });
    }
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
    // Settle on the feed named by the market rules (the TWAP for TWAP markets),
    // and only from an observation taken at or after expiry.
    const settlement = market?.settlementPrice ?? null;
    const settledAtExpiry = market && market.settlementUpdatedAt !== null && market.settlementUpdatedAt !== undefined
      && market.settlementUpdatedAt >= market.endTime - 1_000;
    const outcome = market && market.reference !== null && settlement !== null && isExpired && settledAtExpiry
      ? settlement >= market.reference ? "UP" : "DOWN" : null;
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

export const settlePaperPositionsByOutcome = (
  account: PaperAccount,
  outcomes: Map<string, PaperSide>,
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
    const outcome = position.endTime <= timestamp ? outcomes.get(position.marketId) ?? null : null;
    if (!outcome) {
      remaining.push(position);
      if (position.endTime <= timestamp) skipped += 1;
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
      reason: `${reason} · ${outcome} resolved by Gamma`,
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
      reason: `${reason} · ${outcome} resolved by Gamma`,
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

const usableCompletedCandles = (history: MarketCandle[], barSeconds: number, now: number) => history.filter((candle) =>
  Number.isFinite(candle.timestamp)
  && Number.isFinite(candle.open) && candle.open > 0
  && Number.isFinite(candle.close) && candle.close > 0
  && Number.isFinite(candle.high) && Number.isFinite(candle.low)
  && candle.low > 0 && candle.high >= candle.low
  && Number.isFinite(candle.volume) && candle.volume >= 0
  && candle.timestamp + barSeconds * 1000 <= now,
);

const newestCompletedCandleAt = (history: MarketCandle[], barSeconds: number, now: number): number | null => {
  const candles = usableCompletedCandles(history, barSeconds, now);
  if (!candles.length) return null;
  return Math.max(...candles.map((candle) => candle.timestamp + barSeconds * 1000));
};

/** Feed/book health, independent of whether this market's exact opening tick was observed. */
export const marketStreamingDataFreshnessIssue = (market: LiveMarket, now = Date.now()): string | null => {
  const marketNow = synchronizedPolymarketTime(now);
  if (market.priceFeed === "UNSUPPORTED") return "This market uses an unsupported price-resolution feed; waiting for a supported Polymarket oracle market.";
  if (market.spot === null || market.spot <= 0 || market.spotSource !== "POLYMARKET"
    || market.spotUpdatedAt === null || market.spotUpdatedAt > marketNow + 1_000) {
    return "Waiting for a current observation from this market's Polymarket oracle feed.";
  }
  if (marketNow - market.spotUpdatedAt > 10_000) return "Polymarket oracle data is stale; waiting for a fresh tick.";
  if (market.chartUpdatedAt === null || marketNow - market.chartUpdatedAt > 120_000) return "Chart feed is stale; waiting for a fresh candle snapshot.";
  for (const orderBook of [market.upBook, market.downBook]) {
    if (!orderBook || orderBook.timestamp === null || marketNow - orderBook.timestamp > MAX_ORDER_BOOK_AGE_MS || orderBook.timestamp - marketNow > 2_000) {
      return "An order-book snapshot is stale or has no usable timestamp.";
    }
  }
  const chartDuration = market.duration === "5m" ? 300 : 900;
  const chartHistory = market.duration === "5m" ? market.chart5m : market.chart15m;
  const newestChartClose = newestCompletedCandleAt(chartHistory, chartDuration, marketNow);
  if (newestChartClose === null || marketNow - newestChartClose > 2 * chartDuration * 1000) {
    return `Completed ${market.duration} candle data is stale; waiting for fresh usable bars for this market.`;
  }
  return null;
};

export const marketDataFreshnessIssue = (
  market: LiveMarket,
  now = Date.now(),
): string | null => {
  if (market.priceFeed === "UNSUPPORTED") return "This market uses an unsupported price-resolution feed; waiting for a supported Polymarket oracle market.";
  if (!market.startTimeVerified || market.startTime === null) return "Market start time is missing or cannot be verified against the market interval.";
  if (market.startTime > synchronizedPolymarketTime(now) + 1_000) return "Market interval has not started yet.";
  const liveIssue = marketStreamingDataFreshnessIssue(market, now);
  if (liveIssue) return liveIssue;
  if (market.reference === null || market.reference <= 0 || !market.referenceVerified
    || market.referenceSource !== "POLYMARKET" || market.referenceUpdatedAt !== market.startTime) {
    return "Waiting for the exact Polymarket opening oracle observation used as Price to Beat.";
  }
  return null;
};

const chartTrendStats = (history: MarketCandle[], barSeconds: number, now: number): ChartTrendStats | null => {
  const candles = usableCompletedCandles(history, barSeconds, now).slice(-80);
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

type DirectionalRead = { bias: MarketSignal["bias"]; confidence: number | null; ageSeconds: number | null; microScore: number | null };

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
  // Each contract uses only its own horizon's chart score. The other
  // timeframe remains visible as context in the UI, but cannot steer this
  // market's live signal or veto its entry.
  const chartScore = market.duration === "5m" ? stats5m?.score ?? null : stats15m?.score ?? null;
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
  if (!totalWeight) return { bias: "WARMING UP", confidence: null, ageSeconds, microScore: micro };
  const score = clampScore(weightedScore / totalWeight);
  const bias: MarketSignal["bias"] = score >= 0.08 ? "UP" : score <= -0.08 ? "DOWN" : "NEUTRAL";
  const confidence = Math.min(0.84, 0.5 + Math.abs(score) * 0.32 + Math.min(0.04, Math.max(0, sourceCount - 1) * 0.02));
  return { bias, confidence, ageSeconds, microScore: micro };
};

const modelUncertainty = (market: LiveMarket, stats5m: ChartTrendStats | null, stats15m: ChartTrendStats | null, read: DirectionalRead) => {
  // Keep uncertainty market-specific too; do not use the other horizon's
  // volatility as an input to this contract's probability.
  const targetStats = market.duration === "5m" ? stats5m : stats15m;
  return Math.min(1, 0.35 + (targetStats?.volatility ? 0 : 0.2)
    + (market.referenceSource === "POLYMARKET" ? 0 : 0.2)
    + (read.ageSeconds !== null && read.ageSeconds <= 90 && read.microScore === null ? 0.2 : 0));
};

/**
 * Asks below this are long shots: a few points of model error swamp the
 * payoff, and the recorded paper runs lost 14 of 15 entries under 30c.
 */
export const MIN_ENTRY_PRICE = 0.15;

/**
 * When the raw model and the book disagree by more than this, stale or wrong
 * inputs (reference, spot, volatility) are the likelier explanation than a
 * mispriced market, so the signal passes instead of calling it edge.
 */
export const MAX_MODEL_MARKET_GAP = 0.25;

const passSignal = (reason: string, stats5m: ChartTrendStats | null = null, stats15m: ChartTrendStats | null = null, fairUp: number | null = null, read: DirectionalRead = { bias: "WARMING UP", confidence: null, ageSeconds: null, microScore: null }, upEdge: number | null = null, downEdge: number | null = null, market: LiveMarket | null = null): MarketSignal => ({
  action: "PASS",
  tier: "PASS",
  bias: read.bias,
  biasConfidence: read.confidence,
  confidence: null,
  fairUp,
  rawModelUp: fairUp === null ? null : market?.fairUp ?? null,
  marketProbabilityUp: fairUp === null || !market ? null : marketImpliedProbabilityUp(market),
  modelUncertainty: market ? modelUncertainty(market, stats5m, stats15m, read) : 1,
  microScore: read.microScore,
  executableCostProbability: null,
  expectedNetProfitUsd: null,
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

export const analyzeMarketSignal = (
  market: LiveMarket,
  costs: CostConfig,
  budget = 25,
  minNetEdge = 0.04,
  now = Date.now(),
): MarketSignal => {
  const stats5m = chartTrendStats(market.chart5m, 300, now);
  const stats15m = chartTrendStats(market.chart15m, 900, now);
  const read = directionalRead(market, stats5m, stats15m, now);
  const comparePrices = (fairUp: number | null) => {
    if (fairUp === null) return { upEdge: null, downEdge: null };
    const up = estimateSidePrice(market, "UP", costs, budget, fairUp);
    const down = estimateSidePrice(market, "DOWN", costs, budget, fairUp);
    return {
      upEdge: up.netEdge,
      downEdge: down.netEdge,
    };
  };
  const anchoredUp = anchoredFairUp(market);
  const pass = (reason: string, fairUp = anchoredUp) => {
    const comparison = comparePrices(fairUp);
    return passSignal(reason, stats5m, stats15m, fairUp, read, comparison.upEdge, comparison.downEdge, market);
  };
  const freshnessIssue = marketDataFreshnessIssue(market, now);
  if (freshnessIssue) return pass(freshnessIssue, null);

  const targetStats = market.duration === "5m" ? stats5m : stats15m;
  if (!targetStats) {
    const targetCandles = market.duration === "5m" ? market.chart5m : market.chart15m;
    const reason = !targetCandles.length
      ? `Coinbase ${market.duration} OHLC history is unavailable for ${market.asset}.`
      : `Need at least 8 complete ${market.duration} candles for this market.`;
    return pass(reason);
  }
  if (market.remaining < (market.duration === "5m" ? 30 : 60)) return pass("Too little time remains for a fresh entry.");
  if (market.fairUp === null) return pass("Candle volatility is unavailable, so probability is not estimated.");
  if (anchoredUp === null) return pass("No two-sided order book quote to anchor the model probability.");
  const marketUp = marketImpliedProbabilityUp(market);
  if (marketUp !== null && Math.abs(market.fairUp - marketUp) > MAX_MODEL_MARKET_GAP) {
    return pass(`Raw model P(UP) ${Math.round(market.fairUp * 100)}% is ${Math.round(Math.abs(market.fairUp - marketUp) * 100)} points from the market's ${Math.round(marketUp * 100)}%; a gap that large is more often stale or wrong inputs than edge.`);
  }
  const target = targetStats.score;
  if (Math.abs(target) < 0.2) return pass(`${market.duration} trend is not strong enough for an entry.`);
  if (Math.sign(market.fairUp - 0.5) !== Math.sign(target)) return pass("Spot versus the market reference conflicts with the candle trend.");

  // Price every edge against the market-anchored probability. The raw candle
  // probability alone treated any disagreement with the book as edge.
  const fairUp = anchoredUp;
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
  const executionCostProbability = fill.totalCost / fill.shares;
  const expectedNetProfitUsd = edge * fill.shares;
  // The micro feed is the only within-window momentum evidence. During the
  // opening 90 seconds, chart context alone is a WATCH rather than an ENTRY.
  if (read.ageSeconds !== null && read.ageSeconds <= 90 &&
    (read.microScore === null || Math.abs(read.microScore) < 0.08 || Math.sign(read.microScore) !== (side === "UP" ? 1 : -1))) {
    return { ...pass(`WATCH ${side}: wait for fresh, aligned within-market spot observations before entering.`, fairUp),
      entryPrice: fill.price, edge, estimatedFill: fill,
      executableCostProbability: executionCostProbability, expectedNetProfitUsd };
  }
  if (fill.price < MIN_ENTRY_PRICE) return { ...pass(`Best value is ${side} at ${Math.round(fill.price * 1000) / 10}c, a long shot below the ${MIN_ENTRY_PRICE * 100}c entry floor.`, fairUp), upEdge: priceComparison.upEdge, downEdge: priceComparison.downEdge, entryPrice: fill.price, edge, estimatedFill: fill, executableCostProbability: executionCostProbability, expectedNetProfitUsd };
  const sideSpread = side === "UP" && market.upAsk !== null && market.upBid !== null ? market.upAsk - market.upBid : side === "DOWN" && market.downAsk !== null && market.downBid !== null ? market.downAsk - market.downBid : market.spread;
  if (sideSpread === null || sideSpread > 0.12) return { ...pass(`Best value is ${side}, but that side's spread is too wide for a reliable entry.`, fairUp), upEdge: priceComparison.upEdge, downEdge: priceComparison.downEdge };

  const confidence = read.confidence;
  const requiredEdge = Math.max(0.04, minNetEdge);
  if (edge < requiredEdge) return { ...pass(`Best price edge is ${Math.round(edge * 1000) / 10}% on ${side}, below the ${Math.round(requiredEdge * 1000) / 10}% entry floor.`, fairUp), confidence, upEdge: priceComparison.upEdge, downEdge: priceComparison.downEdge, entryPrice: fill.price, edge, estimatedFill: fill, executableCostProbability: executionCostProbability, expectedNetProfitUsd };

  const locked = edge >= Math.max(0.08, requiredEdge * 2) && Math.abs(target) >= 0.5;
  const referenceLabel = market.referenceSource === "COINBASE ESTIMATE" ? "Coinbase opening-reference estimate (paper only)" : "Polymarket reference";
  return {
    action: side,
    tier: locked ? "LOCK" : "ENTRY",
    bias: read.bias,
    biasConfidence: read.confidence,
    confidence,
    fairUp,
    rawModelUp: market.fairUp,
    marketProbabilityUp: marketImpliedProbabilityUp(market),
    modelUncertainty: modelUncertainty(market, stats5m, stats15m, read),
    microScore: read.microScore,
    executableCostProbability: executionCostProbability,
    expectedNetProfitUsd,
    upEdge: priceComparison.upEdge,
    downEdge: priceComparison.downEdge,
    entryPrice: fill.price,
    edge,
    trend5m: trendLabel(stats5m?.score ?? null),
    trend15m: trendLabel(stats15m?.score ?? null),
    score5m: stats5m?.score ?? null,
    score15m: stats15m?.score ?? null,
    rsi5m: stats5m?.rsi ?? null,
    rsi15m: stats15m?.rsi ?? null,
    reason: locked ? `${market.duration} trend, ${referenceLabel}, order-book depth, and the stricter net-edge gate pass. Edge uses the market-anchored probability; the model is not calibrated.` : `${market.duration} trend, ${referenceLabel}, order-book depth, and the net-edge gate pass. Edge uses the market-anchored probability; the model is not calibrated.`,
    estimatedFill: fill,
  };
};

export const bestCandidateFor = (market: LiveMarket, costs: CostConfig, budget = 25, minNetEdge = 0.04) => {
  const signal = analyzeMarketSignal(market, costs, budget, minNetEdge);
  if (signal.action === "PASS" || signal.entryPrice === null || signal.edge === null || signal.fairUp === null || !signal.estimatedFill) return null;
  const fair = signal.action === "UP" ? signal.fairUp : 1 - signal.fairUp;
  return { side: signal.action, fair, ask: signal.entryPrice, edge: signal.edge, estimatedFill: signal.estimatedFill };
};

type BacktestParams = { startingCash: number; minEdge: number; maxTrade: number; feeRate?: number; slippageBps: number };

/**
 * Replay recorded decisions as an event-ordered simulation.
 *
 * - A row trades only with an explicit captured UP/DOWN decision and a valid
 *   recorded probability; nothing is inferred for rows without one.
 * - The edge is recomputed from the simulated fill (side ask plus slippage
 *   plus the fee curve) under the current settings; recorded edges are ignored.
 * - A position settles at its market's expiry (decision time plus remaining
 *   seconds), never on the decision row, so cash committed to an unresolved
 *   market cannot be reused before it resolves.
 * - Fees follow each row's recorded fee coefficient, else `feeRate`
 *   (default: Polymarket's crypto coefficient). Redemption carries no fee.
 */
const replayBacktest = (inputRows: BacktestRow[], params: BacktestParams, feeMultiplier: number) => {
  const rows = [...inputRows].sort((left, right) => left.timestamp - right.timestamp);
  const startingCash = Math.max(1, Number.isFinite(params.startingCash) ? params.startingCash : 1000);
  const minEdge = Math.max(0, Number.isFinite(params.minEdge) ? params.minEdge : 0);
  const maxTrade = Math.max(0, Number.isFinite(params.maxTrade) ? params.maxTrade : 0);
  const defaultFeeRate = Math.max(0, Number.isFinite(params.feeRate) ? params.feeRate! : POLYMARKET_CRYPTO_TAKER_FEE_RATE);
  const slippageMultiplier = 1 + Math.max(0, Number.isFinite(params.slippageBps) ? params.slippageBps : 0) / 10_000;
  const feePerShare = (price: number, rate: number) => rate * feeMultiplier * price * (1 - price);
  const marketKeyFor = (row: BacktestRow) => row.marketId?.trim() || `${row.asset}:${row.duration}:${Math.floor(row.timestamp / (row.duration === "5m" ? 300_000 : 900_000))}`;

  // Final labels are only read at each market's expiry; conflicting labels void the market.
  const outcomes = new Map<string, PaperSide | "CONFLICT">();
  for (const row of rows) {
    if (row.outcome !== "UP" && row.outcome !== "DOWN") continue;
    const key = marketKeyFor(row);
    const previous = outcomes.get(key);
    outcomes.set(key, previous && previous !== row.outcome ? "CONFLICT" : row.outcome);
  }

  type OpenTrade = { tradeIndex: number; shares: number; entryCost: number; fair: number; side: PaperSide; expiresAt: number; marketKey: string };
  let cash = startingCash;
  let committed = 0;
  let realized = 0;
  let peak = startingCash;
  let maxDrawdown = 0;
  let signals = 0;
  let skippedWithoutModel = 0;
  let rejectedRows = 0;
  let settled = 0;
  let wins = 0;
  let losses = 0;
  let edgeSum = 0;
  let brierSum = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve = [startingCash];
  const open: OpenTrade[] = [];
  const traded = new Set<string>();
  const updateEquity = () => {
    const equity = round(cash + committed);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
    equityCurve.push(equity);
  };
  const settleDue = (time: number) => {
    open.sort((left, right) => left.expiresAt - right.expiresAt);
    while (open.length && open[0].expiresAt <= time) {
      const trade = open[0];
      const outcome = outcomes.get(trade.marketKey);
      if (outcome !== "UP" && outcome !== "DOWN") break;
      open.shift();
      const won = outcome === trade.side;
      const payout = won ? trade.shares : 0;
      const pnl = round(payout - trade.entryCost);
      cash = round(cash + payout);
      committed = Math.max(0, round(committed - trade.entryCost));
      realized = round(realized + pnl);
      settled += 1;
      if (won) wins += 1; else losses += 1;
      brierSum += (trade.fair - (won ? 1 : 0)) ** 2;
      trades[trade.tradeIndex] = { ...trades[trade.tradeIndex], status: won ? "SETTLED WIN" : "SETTLED LOSS", pnl };
      updateEquity();
    }
  };

  for (const row of rows) {
    settleDue(row.timestamp);
    const marketKey = marketKeyFor(row);
    if (traded.has(marketKey)) continue;
    if (row.modelAction !== "UP" && row.modelAction !== "DOWN") {
      if (row.modelAction !== "PASS") skippedWithoutModel += 1;
      continue;
    }
    if (row.modelFairUp === null || row.modelFairUp === undefined || !Number.isFinite(row.modelFairUp) || row.modelFairUp <= 0 || row.modelFairUp >= 1) {
      skippedWithoutModel += 1;
      continue;
    }
    const remaining = row.remainingSeconds;
    if (remaining === undefined || !Number.isFinite(remaining) || remaining < 30 || remaining > (row.duration === "5m" ? 300 : 900)
      || outcomes.get(marketKey) === "CONFLICT") {
      rejectedRows += 1;
      continue;
    }
    const side = row.modelAction;
    const ask = side === "UP" ? row.upAsk : row.downAsk;
    if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) { rejectedRows += 1; continue; }
    const fair = side === "UP" ? row.modelFairUp : 1 - row.modelFairUp;
    const rate = row.feeRate !== null && row.feeRate !== undefined && Number.isFinite(row.feeRate) && row.feeRate >= 0 ? row.feeRate : defaultFeeRate;
    const price = ask * slippageMultiplier;
    if (price >= 1) { rejectedRows += 1; continue; }
    const costPerShare = price + feePerShare(price, rate);
    const edge = fair - costPerShare;
    if (edge < minEdge) continue;
    const requestedBudget = row.modelStakeUsd !== null && row.modelStakeUsd !== undefined && Number.isFinite(row.modelStakeUsd) && row.modelStakeUsd > 0
      ? row.modelStakeUsd : maxTrade;
    const entryBudget = Math.min(requestedBudget, maxTrade, cash);
    if (!(entryBudget > 0)) continue;
    const shares = entryBudget / costPerShare;
    const entryCost = round(entryBudget);
    signals += 1;
    edgeSum += edge;
    cash = round(cash - entryCost);
    committed = round(committed + entryCost);
    traded.add(marketKey);
    const tradeIndex = trades.push({ timestamp: row.timestamp, asset: row.asset, duration: row.duration, side, fair, entry: price, edge,
      notional: round(shares * price), status: "UNSETTLED", pnl: null }) - 1;
    open.push({ tradeIndex, shares, entryCost, fair, side, expiresAt: row.timestamp + remaining * 1000, marketKey });
    updateEquity();
  }
  // The replay has ended: every remaining market has expired by now, so settle
  // those with a known outcome; the rest stay unsettled.
  settleDue(Number.POSITIVE_INFINITY);
  return { signals, skippedWithoutModel, rejectedRows, settled, unsettled: open.length, wins, losses, realized, startingCash,
    maxDrawdown, edgeSum, brierSum, trades, equityCurve };
};

export const runBacktest = (inputRows: BacktestRow[], params: BacktestParams): BacktestResult => {
  const base = replayBacktest(inputRows, params, 1);
  const feeSensitivity = [0.5, 1.5].map((feeMultiplier) => {
    const scenario = replayBacktest(inputRows, params, feeMultiplier);
    return { feeMultiplier, netPnl: scenario.settled ? scenario.realized : null };
  });
  return {
    signals: base.signals,
    skippedWithoutModel: base.skippedWithoutModel,
    rejectedRows: base.rejectedRows,
    drawdownBasis: "SETTLEMENT",
    feeSensitivity,
    settled: base.settled,
    unsettled: base.unsettled,
    wins: base.wins,
    losses: base.losses,
    netPnl: base.settled ? base.realized : null,
    roi: base.settled ? base.realized / base.startingCash : null,
    maxDrawdown: base.settled ? base.maxDrawdown : null,
    winRate: base.settled ? base.wins / base.settled : null,
    averageEdge: base.signals ? base.edgeSum / base.signals : null,
    brierScore: base.settled ? base.brierSum / base.settled : null,
    trades: base.trades.slice(-250),
    equityCurve: base.equityCurve,
  };
};

/** Only explicit 5m / 15m horizons are supported; anything else is rejected, not guessed. */
export const parseHorizon = (value: string): Horizon | null => {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (["5m", "5min", "5minute", "5minutes", "300", "300s"].includes(normalized)) return "5m";
  if (["15m", "15min", "15minute", "15minutes", "900", "900s"].includes(normalized)) return "15m";
  return null;
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
    return index >= 0 ? values[index] ?? "" : "";
  };
  // A blank cell is missing data, never zero.
  const numberFor = (values: string[], names: string[]) => {
    const raw = valueFor(values, names).replace(/[$%]/g, "").replace(/,/g, "").trim();
    if (!raw) return null;
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
    const timestampRaw = valueFor(values, ["validation_at_utc", "timestamp", "time", "datetime", "date", "observed_at_utc"]).trim();
    const timestampNumber = timestampRaw ? Number(timestampRaw) : Number.NaN;
    const timestamp = Number.isFinite(timestampNumber) ? (timestampNumber < 10_000_000_000 ? timestampNumber * 1000 : timestampNumber) : Date.parse(timestampRaw);
    const asset = valueFor(values, ["asset", "symbol"]).toUpperCase();
    const duration = parseHorizon(valueFor(values, ["duration", "horizon"]));
    const reference = numberFor(values, ["reference", "reference_price", "strike", "threshold"]);
    const spot = numberFor(values, ["spot", "spot_price", "underlying"]);
    const upAsk = numberFor(values, ["up_ask", "yes_ask", "higher_ask"]);
    const downAsk = numberFor(values, ["down_ask", "no_ask", "lower_ask"]);
    if (!Number.isFinite(timestamp) || !asset || duration === null || reference === null || spot === null || upAsk === null || downAsk === null) { rejected += 1; continue; }
    const rawAction = valueFor(values, ["validation_decision", "model_action", "initial_decision"]).toUpperCase().trim();
    const modelAction: PaperSide | "PASS" | null = rawAction === "UP" || rawAction === "DOWN" || rawAction === "PASS" ? rawAction : null;
    rows.push({
      timestamp,
      asset,
      duration,
      reference,
      spot,
      upAsk,
      downAsk,
      outcome: outcomeFor(values),
      remainingSeconds: numberFor(values, ["remaining_seconds", "seconds_left"]) ?? undefined,
      marketId: valueFor(values, ["market_id", "market"]) || undefined,
      modelFairUp: numberFor(values, ["validation_probability_up", "model_fair_up", "fair_up"]),
      modelAction,
      modelEdge: numberFor(values, ["validation_edge", "model_edge", "selected_edge"]),
      modelEntryPrice: numberFor(values, ["validation_entry_price", "model_entry_price", "entry_price"]),
      modelStakeUsd: numberFor(values, ["validation_stake_usd", "model_stake_usd", "simulated_stake_usd"]),
      feeRate: numberFor(values, ["fee_rate", "validation_fee_rate", "taker_fee_rate"]),
    });
  }
  return { rows, rejected };
};

export const backtestCsvTemplate = "timestamp,asset,duration,market_id,reference,spot,up_ask,down_ask,outcome,remaining_seconds,validation_probability_up,validation_decision,validation_edge,validation_entry_price,validation_stake_usd,fee_rate\n";
