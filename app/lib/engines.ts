import {
  bestAskFor,
  bestBidFor,
  estimateFairProbability,
  orderBookFor,
  sideFairProbability,
  type Horizon,
  type LiveMarket,
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

export const closeExpiringPaperPositions = (
  account: PaperAccount,
  markets: Map<string, LiveMarket>,
  costs: CostConfig,
  reason: string,
  timestamp = Date.now(),
): { account: PaperAccount; closed: number; skipped: number; realized: number } => {
  const expiring = new Set(account.positions.filter((position) => {
    const market = markets.get(position.marketId);
    return market ? market.remaining <= 15 : position.endTime <= timestamp;
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

export const bestCandidateFor = (market: LiveMarket, costs: CostConfig, budget = 25) => {
  const candidates = [candidateFor(market, "UP", costs, budget), candidateFor(market, "DOWN", costs, budget)].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  return candidates.sort((left, right) => right.edge - left.edge)[0] ?? null;
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
