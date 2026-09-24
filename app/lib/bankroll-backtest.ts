import type { BacktestRow, PaperSide } from "./engines";
import { ACTIVE_MODEL_VERSION, type RecordedAskLevel } from "./decision-ledger";
import { bankrollProfile, sizeBankrollTrade, type BankrollPosition, type BankrollTier } from "./bankroll-policy";
import { walkForwardCalibration, type WalkForwardCalibration } from "./bankroll-calibration";

export const BANKROLL_REPLAY_BALANCES = [20, 25, 50, 75, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;
export const bankrollBacktestCsvTemplate = "timestamp,asset,duration,market_id,reference,spot,up_ask,down_ask,up_bid,down_bid,up_depth_usd,down_depth_usd,up_bid_depth_usd,down_bid_depth_usd,min_order_shares,min_order_usd,validation_up_ask_levels_json,validation_down_ask_levels_json,remaining_seconds,validation_probability_up,validation_decision,validation_micro_score,bias_confidence,model_version,outcome,outcome_at_utc\n";

/** Recorded order-book fields are required for a validated executable replay. */
export type BankrollBacktestRow = Omit<BacktestRow, "reference" | "spot" | "upAsk" | "downAsk"> & {
  reference?: number | null;
  spot?: number | null;
  upAsk?: number | null;
  downAsk?: number | null;
  upBid?: number | null;
  downBid?: number | null;
  upDepthUsd?: number | null;
  downDepthUsd?: number | null;
  upBidDepthUsd?: number | null;
  downBidDepthUsd?: number | null;
  upAskLevels?: RecordedAskLevel[] | null;
  downAskLevels?: RecordedAskLevel[] | null;
  minOrderShares?: number | null;
  minOrderUsd?: number | null;
  outcomeAt?: number | null;
  modelVersion?: string | null;
  probabilityUncertainty?: number | null;
  microScore?: number | null;
  biasConfidence?: number | null;
};

export type BankrollReplayOptions = {
  balances?: readonly number[];
  /** Conservative flat approximation; recorded market-specific fees are preferable. */
  feeRate?: number;
  slippageBps?: number;
  /** Explicit venue/account minimum; absent row-level and option-level minimum blocks a replayed entry. */
  minimumOrderUsd?: number;
  /** Explicit research assumptions are labelled in the output. */
  assumedDepthUsd?: number;
  assumedSpreadPct?: number;
  minNetEdge?: number;
  maxTradeUsd?: number;
  modelVersion?: string;
  severeDrawdownPct?: number;
};

export type BankrollReplayTrade = {
  marketId: string;
  timestamp: number;
  resolvedAt: number | null;
  asset: string;
  duration: "5m" | "15m";
  side: PaperSide;
  predictedWinProbability: number;
  entryCostPerShare: number;
  stakeUsd: number;
  shares: number;
  entryFeeUsd: number;
  slippageUsd: number;
  predictedNetEdge: number;
  outcome: PaperSide | null;
  pnlUsd: number | null;
};

export type BankrollReplayAccountResult = {
  startingBalanceUsd: number;
  /** Bankroll tier at the start of the replay. */
  tier: BankrollTier;
  /** Bankroll tier at the end, based on current liquidation equity. */
  endingTier: BankrollTier;
  endingEquityUsd: number | null;
  endingCashUsd: number;
  openCostBasisUsd: number;
  realizedNetProfitUsd: number;
  totalReturn: number | null;
  maxDrawdown: number | null;
  minimumEquityUsd: number | null;
  observedSevereDrawdown: boolean | null;
  severeDrawdownProbability: null;
  largestSingleLossUsd: number | null;
  trades: number;
  settled: number;
  unsettled: number;
  winRate: number | null;
  brierScore: number | null;
  logLoss: number | null;
  averagePredictedEdge: number | null;
  averageRealizedEdge: number | null;
  profitFactor: number | null;
  averageTradeUsd: number | null;
  feesUsd: number;
  slippageUsd: number;
  turnover: number;
  averageExposurePct: number | null;
  maximumExposurePct: number;
  passRate: number | null;
  minimumOrderRejectRate: number | null;
  minimumOrderRejects: number;
  decisionRows: number;
  sizingEvaluations: number;
  passesByReason: Record<string, number>;
  tradeDetails: BankrollReplayTrade[];
};

export type MultiBankrollReplayResult = {
  dataRows: number;
  recordedPredictions: number;
  excludedModelVersionRows: number;
  entryRowsWithAskLadders: number;
  entryRowsUsingFixedPriceFallback: number;
  resolvedMarkets: number;
  /** Historical labels are never synthesized. */
  datasetHasSettledOutcomes: boolean;
  assumptions: string[];
  limitations: string[];
  calibration: WalkForwardCalibration;
  accounts: BankrollReplayAccountResult[];
};

type OutcomeRecord = { outcome: PaperSide | null; resolvedAt: number | null; conflict: boolean };
type OpenTrade = { trade: BankrollReplayTrade; costUsd: number };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const round = (value: number, places = 6) => Number(value.toFixed(places));
const marketKeyFor = (row: BankrollBacktestRow) => row.marketId?.trim() || `${row.asset}:${row.duration}:${Math.floor(row.timestamp / (row.duration === "5m" ? 300_000 : 900_000))}`;
const durationSeconds = (row: BankrollBacktestRow) => row.duration === "5m" ? 300 : 900;
const resolutionTime = (row: BankrollBacktestRow) => finite(row.outcomeAt) ? row.outcomeAt :
  positive(row.remainingSeconds) ? row.timestamp + row.remainingSeconds * 1000 : null;

type ReplayFill = { costUsd: number; shares: number; feeUsd: number; slippageUsd: number; entryCostPerShare: number };

/** Spend an all-in budget against a recorded ask ladder (fees included). */
const estimateAskFill = (budgetUsd: number, levels: RecordedAskLevel[], feeRate: number): ReplayFill | null => {
  if (!positive(budgetUsd) || !levels.length) return null;
  const bestAsk = levels[0].price;
  let remaining = budgetUsd;
  let costUsd = 0;
  let shares = 0;
  let feeUsd = 0;
  let slippageUsd = 0;
  for (const level of levels) {
    if (!positive(level.price) || level.price >= 1 || !positive(level.size)) continue;
    const allInPerShare = level.price * (1 + feeRate);
    const levelShares = Math.min(level.size, remaining / allInPerShare);
    if (!positive(levelShares)) continue;
    const levelNotional = levelShares * level.price;
    const levelFee = levelNotional * feeRate;
    const levelCost = levelNotional + levelFee;
    shares += levelShares;
    costUsd += levelCost;
    feeUsd += levelFee;
    slippageUsd += levelShares * Math.max(0, level.price - bestAsk);
    remaining = Math.max(0, remaining - levelCost);
    if (remaining <= 1e-8) break;
  }
  if (!positive(shares) || !positive(costUsd)) return null;
  return { costUsd, shares, feeUsd, slippageUsd, entryCostPerShare: costUsd / shares };
};

const validAskLevels = (levels: RecordedAskLevel[] | null | undefined, fallbackAsk: number) => {
  const cleaned = (levels ?? []).filter((level) => positive(level.price) && level.price < 1 && positive(level.size))
    .slice().sort((left, right) => left.price - right.price);
  // Reject a malformed/stale ladder rather than pretending its first quote is executable.
  if (cleaned.length && Math.abs(cleaned[0].price - fallbackAsk) > 0.02) return [];
  return cleaned;
};

const outcomeIndexFor = (rows: BankrollBacktestRow[]) => {
  const outcomes = new Map<string, OutcomeRecord>();
  for (const row of rows) {
    if (row.outcome !== "UP" && row.outcome !== "DOWN") continue;
    const key = marketKeyFor(row);
    const previous = outcomes.get(key);
    const at = resolutionTime(row);
    if (!previous) outcomes.set(key, { outcome: row.outcome, resolvedAt: at, conflict: false });
    else if (previous.outcome !== row.outcome || (previous.resolvedAt !== null && at !== null && Math.abs(previous.resolvedAt - at) > 60_000)) {
      outcomes.set(key, { outcome: null, resolvedAt: null, conflict: true });
    } else if (previous.resolvedAt === null && at !== null) previous.resolvedAt = at;
  }
  return outcomes;
};

const metricsFor = (trades: BankrollReplayTrade[]) => {
  const settled = trades.filter((trade): trade is BankrollReplayTrade & { pnlUsd: number; outcome: PaperSide } => trade.pnlUsd !== null && trade.outcome !== null);
  const scored = settled.filter((trade) => Number.isFinite(trade.predictedWinProbability));
  const wins = settled.filter((trade) => trade.pnlUsd > 0).length;
  const gains = settled.reduce((sum, trade) => sum + Math.max(0, trade.pnlUsd), 0);
  const losses = settled.reduce((sum, trade) => sum + Math.max(0, -trade.pnlUsd), 0);
  return {
    settled: settled.length,
    winRate: settled.length ? wins / settled.length : null,
    brierScore: scored.length ? scored.reduce((sum, trade) => sum + (trade.predictedWinProbability - (trade.side === trade.outcome ? 1 : 0)) ** 2, 0) / scored.length : null,
    logLoss: scored.length ? scored.reduce((sum, trade) => {
      const p = Math.min(1 - 1e-6, Math.max(1e-6, trade.predictedWinProbability));
      return sum - Math.log(trade.side === trade.outcome ? p : 1 - p);
    }, 0) / scored.length : null,
    averageRealizedEdge: settled.length ? settled.reduce((sum, trade) => sum + ((trade.side === trade.outcome ? 1 : 0) - trade.entryCostPerShare), 0) / settled.length : null,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? null : null,
    largestSingleLossUsd: settled.length ? Math.max(0, ...settled.map((trade) => -trade.pnlUsd)) : null,
  };
};

export const runMultiBankrollBacktest = (
  inputRows: BankrollBacktestRow[],
  options: BankrollReplayOptions = {},
): MultiBankrollReplayResult => {
  const rows = inputRows.filter((row) => finite(row.timestamp) && row.timestamp > 0 && Boolean(row.asset) && (row.duration === "5m" || row.duration === "15m"))
    .slice().sort((left, right) => left.timestamp - right.timestamp || marketKeyFor(left).localeCompare(marketKeyFor(right)));
  const modelVersion = options.modelVersion ?? ACTIVE_MODEL_VERSION;
  const feeRate = finite(options.feeRate) && options.feeRate >= 0 ? options.feeRate : 0.02;
  const slippageBps = finite(options.slippageBps) && options.slippageBps >= 0 ? options.slippageBps : 25;
  // Paper execution enforces a $1 minimum even when a source row or option
  // records a smaller nominal amount.
  const minimumOrderUsd = Math.max(1, positive(options.minimumOrderUsd) ? options.minimumOrderUsd : 1);
  const severeDrawdownPct = finite(options.severeDrawdownPct) && options.severeDrawdownPct > 0 ? options.severeDrawdownPct : 0.2;
  const outcomes = outcomeIndexFor(rows);
  const firstPredictions = new Map<string, BankrollBacktestRow>();
  for (const row of rows) {
    const key = marketKeyFor(row);
    if (!firstPredictions.has(key) && row.modelVersion === modelVersion
      && (row.modelAction === "UP" || row.modelAction === "DOWN") && finite(row.modelFairUp) && row.modelFairUp > 0 && row.modelFairUp < 1) firstPredictions.set(key, row);
  }
  const calibration = walkForwardCalibration([...firstPredictions].flatMap(([marketId, row]) => {
    const result = outcomes.get(marketId);
    return result?.outcome && result.resolvedAt ? [{ marketId, observedAt: row.timestamp, resolvedAt: result.resolvedAt,
      fairUp: row.modelFairUp!, outcome: result.outcome, modelVersion: row.modelVersion ?? modelVersion }] : [];
  }), { modelVersion });
  const calibratedByMarket = new Map(calibration.points.map((point) => [point.marketId, point]));
  const assumptions = [`Flat entry and estimated exit fee ${(feeRate * 100).toFixed(2)}% of notional.`, `Ask slippage ${slippageBps} bps when no recorded fill is supplied.`];
  assumptions.push(`Paper execution minimum is $${minimumOrderUsd.toFixed(2)}; recorded venue minimums and share sizes can raise it.`);
  if (positive(options.assumedDepthUsd)) assumptions.push(`Unrecorded ask depth assumed to be $${options.assumedDepthUsd.toFixed(2)} (research-only).`);
  if (finite(options.assumedSpreadPct) && options.assumedSpreadPct >= 0) assumptions.push(`Unrecorded spread assumed to be ${(options.assumedSpreadPct * 100).toFixed(2)}% (research-only).`);
  const limitations = [
    "Replay liquidation marks use each recorded top bid and bid depth, apply the flat exit-fee approximation, and value unrecorded executable bid depth at zero.",
    "The supplied rows may be sparse; available bid marks cannot reproduce a full order-book liquidation or continuous intramarket drawdown.",
    "A single historical path cannot estimate the probability of severe drawdown.",
    "Recorded ask ladders are consumed by stake at each bankroll size; sparse or truncated ladders can still understate execution cost and cannot reproduce queue priority.",
    "Flat fee/slippage inputs are approximations; full order-book snapshots are needed for high-fidelity fills and early exits.",
    "Recorded model decisions are required; a spot/reference baseline is not substituted for the live candle model.",
  ];
  if (rows.some((row) => !positive(row.upDepthUsd) && !positive(row.downDepthUsd))) limitations.push("Some rows lack ask depth; those entries PASS unless an explicit depth assumption is supplied.");
  if (rows.some((row) => !finite(row.upBid) && !finite(row.downBid))) limitations.push("Some rows lack bids; those entries PASS unless an explicit spread assumption is supplied.");
  if (!calibration.adjustedOutOfSample.samples) limitations.push("No walk-forward calibrated predictions met the minimum sample thresholds; raw probabilities remain uncalibrated.");
  const excludedModelVersionRows = rows.filter((row) => row.modelVersion !== modelVersion).length;
  if (excludedModelVersionRows) limitations.push(`${excludedModelVersionRows} rows without an explicit matching ${modelVersion} model_version were excluded from predictions and entries.`);
  const entryRows = rows.filter((row) => row.modelVersion === modelVersion && (row.modelAction === "UP" || row.modelAction === "DOWN"));
  const entryRowsWithAskLadders = entryRows.filter((row) => validAskLevels(row.modelAction === "UP" ? row.upAskLevels : row.downAskLevels,
    (row.modelAction === "UP" ? row.upAsk : row.downAsk) ?? Number.NaN).length > 0).length;
  const entryRowsUsingFixedPriceFallback = entryRows.length - entryRowsWithAskLadders;
  if (entryRowsUsingFixedPriceFallback) limitations.push(`${entryRowsUsingFixedPriceFallback} directional decision rows use a fixed recorded entry price (or top ask plus configured slippage) because no valid ask ladder was recorded; price impact across bankroll sizes cannot be inferred for those rows.`);

  const accounts = (options.balances ?? BANKROLL_REPLAY_BALANCES).filter((balance) => positive(balance)).map((startingBalanceUsd): BankrollReplayAccountResult => {
    let cash = startingBalanceUsd;
    let dayStartEquity = startingBalanceUsd;
    let currentDay = rows.length ? Math.floor(rows[0].timestamp / 86_400_000) : 0;
    let peakEquity = startingBalanceUsd;
    let minimumEquity = startingBalanceUsd;
    let maxDrawdown = 0;
    let fees = 0;
    let slippage = 0;
    let turnoverUsd = 0;
    let decisionRows = 0;
    let sizingEvaluations = 0;
    let passRows = 0;
    let minimumOrderRejects = 0;
    let maximumExposurePct = 0;
    let exposureArea = 0;
    let elapsedMs = 0;
    let lastTime = rows[0]?.timestamp ?? 0;
    const open = new Map<string, OpenTrade>();
    const latestRowsByMarket = new Map<string, BankrollBacktestRow>();
    const completed = new Set<string>();
    const trades: BankrollReplayTrade[] = [];
    const settledTradesForRisk: Array<{ timestamp: number; pnlUsd: number }> = [];
    const passesByReason: Record<string, number> = {};
    const openCost = () => [...open.values()].reduce((sum, value) => sum + value.costUsd, 0);
    // Unexecutable historical positions contribute zero to liquidation equity.
    const markedProceeds = (marketId: string, item: OpenTrade) => {
      const mark = latestRowsByMarket.get(marketId);
      if (!mark) return 0;
      const bid = item.trade.side === "UP" ? mark.upBid : mark.downBid;
      const depthUsd = item.trade.side === "UP" ? mark.upBidDepthUsd : mark.downBidDepthUsd;
      if (!positive(bid) || bid >= 1 || !positive(depthUsd)) return 0;
      return Math.min(item.trade.shares * bid, depthUsd) * (1 - feeRate);
    };
    const liquidationValue = () => [...open].reduce((sum, [id, item]) => sum + markedProceeds(id, item), 0);
    const openPositionRiskReserve = () => [...open].reduce((riskUsd, [id, item]) => {
      const mark = latestRowsByMarket.get(id);
      const bid = item.trade.side === "UP" ? mark?.upBid : mark?.downBid;
      const depthUsd = item.trade.side === "UP" ? mark?.upBidDepthUsd : mark?.downBidDepthUsd;
      const fullyExecutable = positive(bid) && bid < 1 && positive(depthUsd)
        && depthUsd + 1e-8 >= item.trade.shares * bid;
      return riskUsd + (fullyExecutable ? item.trade.shares * bid * (1 - feeRate) : item.costUsd);
    }, 0);
    const bookEquity = () => cash + liquidationValue();
    const exposurePct = () => bookEquity() > 0 ? openCost() / bookEquity() : 0;
    const trackEquity = () => {
      const equity = bookEquity();
      peakEquity = Math.max(peakEquity, equity);
      minimumEquity = Math.min(minimumEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0);
      maximumExposurePct = Math.max(maximumExposurePct, exposurePct());
    };
    const advanceTo = (timestamp: number) => {
      const interval = Math.max(0, timestamp - lastTime);
      exposureArea += exposurePct() * interval;
      elapsedMs += interval;
      lastTime = Math.max(lastTime, timestamp);
    };
    const settle = (marketId: string, outcome: PaperSide, resolvedAt: number) => {
      const item = open.get(marketId);
      if (!item) return;
      advanceTo(resolvedAt);
      const proceeds = item.trade.side === outcome ? item.trade.shares : 0;
      item.trade.outcome = outcome;
      item.trade.pnlUsd = round(proceeds - item.costUsd);
      settledTradesForRisk.push({ timestamp: resolvedAt, pnlUsd: item.trade.pnlUsd });
      cash = round(cash + proceeds);
      open.delete(marketId);
      completed.add(marketId);
      trackEquity();
    };
    const settleThrough = (timestamp: number) => {
      const due = [...open.keys()].map((key) => ({ key, result: outcomes.get(key) }))
        .filter((item): item is { key: string; result: { outcome: PaperSide; resolvedAt: number; conflict: boolean } } => Boolean(item.result?.outcome && item.result.resolvedAt !== null && item.result.resolvedAt < timestamp))
        .sort((left, right) => left.result.resolvedAt - right.result.resolvedAt);
      for (const item of due) settle(item.key, item.result.outcome, item.result.resolvedAt);
    };
    const pass = (reason: string) => { passRows += 1; passesByReason[reason] = (passesByReason[reason] ?? 0) + 1; };

    for (const row of rows) {
      settleThrough(row.timestamp);
      advanceTo(row.timestamp);
      const day = Math.floor(row.timestamp / 86_400_000);
      if (day !== currentDay) { currentDay = day; dayStartEquity = bookEquity(); }
      const todaySettled = settledTradesForRisk.filter((trade) => Math.floor(trade.timestamp / 86_400_000) === day && trade.timestamp <= row.timestamp)
        .sort((left, right) => right.timestamp - left.timestamp);
      const firstWin = todaySettled.findIndex((trade) => trade.pnlUsd > 0);
      const consecutiveLosses = firstWin < 0 ? todaySettled.length : firstWin;
      const recentWinAfterDrawdown = todaySettled[0]?.pnlUsd > 0 && todaySettled.slice(1, 4).filter((trade) => trade.pnlUsd <= 0).length >= 2;
      const marketId = marketKeyFor(row);
      latestRowsByMarket.set(marketId, row);
      if (open.has(marketId)) trackEquity();
      if (open.has(marketId) || completed.has(marketId)) continue;
      if (row.modelVersion !== modelVersion) continue;
      decisionRows += 1;
      if (row.modelAction !== "UP" && row.modelAction !== "DOWN") { pass("NO_RECORDED_ENTRY"); continue; }
      if (!finite(row.modelFairUp) || row.modelFairUp <= 0 || row.modelFairUp >= 1) { pass("NO_RECORDED_PROBABILITY"); continue; }
      if (!finite(row.remainingSeconds) || row.remainingSeconds <= 0 || row.remainingSeconds > durationSeconds(row)) { pass("MISSING_OR_INVALID_REMAINING_TIME"); continue; }
      const outcomeRecord = outcomes.get(marketId);
      if (outcomeRecord?.conflict) { pass("CONFLICTING_OUTCOME"); continue; }
      if (finite(outcomeRecord?.resolvedAt) && outcomeRecord.resolvedAt <= row.timestamp) { pass("ALREADY_RESOLVED"); continue; }
      const side = row.modelAction;
      const tier = bankrollProfile(bookEquity()).tier;
      if (tier === "MICRO" && row.duration !== "5m") { pass("MICRO_ONLY_5M"); continue; }
      if (tier === "MICRO" && (!finite(row.microScore) || Math.abs(row.microScore) < 0.45
        || Math.sign(row.microScore) !== (side === "UP" ? 1 : -1))) { pass("MICRO_TREND_FILTER"); continue; }
      if (tier === "SMALL" && (!finite(row.biasConfidence) || row.biasConfidence < 0.58)) { pass("SMALL_CONFLUENCE_FILTER"); continue; }
      const ask = side === "UP" ? row.upAsk : row.downAsk;
      const askLevels = validAskLevels(side === "UP" ? row.upAskLevels : row.downAskLevels, ask ?? Number.NaN);
      const bid = side === "UP" ? row.upBid : row.downBid;
      const depth = side === "UP" ? row.upDepthUsd : row.downDepthUsd;
      if (!positive(ask) || ask >= 1) { pass("INVALID_ASK"); continue; }
      const spreadPct = finite(bid) && bid >= 0 && bid <= ask ? (ask - bid) / ask : options.assumedSpreadPct;
      if (!finite(spreadPct) || spreadPct < 0) { pass("MISSING_BID_OR_SPREAD"); continue; }
      const depthUsd = positive(depth) ? depth : options.assumedDepthUsd;
      if (!positive(depthUsd)) { pass("MISSING_ASK_DEPTH"); continue; }
      const recordedEntry = row.modelEntryPrice;
      // A recorded ladder is the executable source for every replay bankroll;
      // a legacy modeled VWAP must not gate a smaller account before repricing.
      const slippedPrice = askLevels.length ? askLevels[0].price
        : positive(recordedEntry) && recordedEntry < 1 ? recordedEntry : ask * (1 + slippageBps / 10_000);
      const entryCostPerShare = slippedPrice * (1 + feeRate);
      if (!positive(entryCostPerShare) || entryCostPerShare >= 1) { pass("COST_EXCEEDS_PAYOUT"); continue; }
      const rawProbability = side === "UP" ? row.modelFairUp : 1 - row.modelFairUp;
      const point = calibratedByMarket.get(marketId);
      const calibratedProbability = point?.observedAt === row.timestamp && point.calibrated
        ? side === "UP" ? point.adjustedProbabilityUp : 1 - point.adjustedProbabilityUp : null;
      if (!positive(row.minOrderShares)) { pass("MISSING_MINIMUM_ORDER"); continue; }
      const minimumExecutableOrderUsd = Math.max(minimumOrderUsd, positive(row.minOrderUsd) ? row.minOrderUsd : 0,
        row.minOrderShares * entryCostPerShare);
      const positionList: BankrollPosition[] = [...open].map(([id, item]) => ({ marketId: id, asset: item.trade.asset, side: item.trade.side, costUsd: item.costUsd, correlationGroup: "CRYPTO" }));
      sizingEvaluations += 1;
      const sizingInput = {
        equityUsd: bookEquity(), cashUsd: cash, dayStartEquityUsd: dayStartEquity, peakEquityUsd: peakEquity,
        positions: positionList, openPositionRiskUsd: openPositionRiskReserve(), marketId, asset: row.asset, side, correlationGroup: "CRYPTO", strategyKey: row.duration,
        modelProbability: rawProbability, calibratedProbability, calibrationSampleSize: point?.trainingSamples ?? 0,
        entryPrice: entryCostPerShare, netEdge: rawProbability - entryCostPerShare,
        minExecutableOrderUsd: minimumExecutableOrderUsd, availableDepthUsd: depthUsd, spreadPct,
        timeRemainingSeconds: row.remainingSeconds, probabilityUncertainty: finite(row.probabilityUncertainty) ? row.probabilityUncertainty : undefined,
        consecutiveLosses, recentWinAfterDrawdown, minNetEdge: options.minNetEdge, maxTradeUsd: options.maxTradeUsd,
      };
      let decision = sizeBankrollTrade(sizingInput);
      if (!decision.approved) {
        const reason = decision.reasons.some((message) => message.startsWith("Minimum executable order")) ? "MINIMUM_ORDER_TOO_RISKY" : decision.reasons[0] ?? "POLICY_PASS";
        if (reason === "MINIMUM_ORDER_TOO_RISKY") minimumOrderRejects += 1;
        pass(reason);
        continue;
      }
      let replayFill: ReplayFill | null = null;
      if (askLevels.length) {
        // Re-size against the actual VWAP for each bankroll. Each iteration may only
        // lower the spend cap, so book impact can never increase a trade's stake.
        let spendCap = decision.stakeUsd;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          replayFill = estimateAskFill(spendCap, askLevels, feeRate);
          if (!replayFill || replayFill.costUsd + 0.01 < minimumExecutableOrderUsd) break;
          const repriced = sizeBankrollTrade({
            ...sizingInput,
            entryPrice: replayFill.entryCostPerShare,
            netEdge: rawProbability - replayFill.entryCostPerShare,
            minExecutableOrderUsd: minimumExecutableOrderUsd,
            maxTradeUsd: Math.min(options.maxTradeUsd ?? Number.POSITIVE_INFINITY, spendCap),
          });
          if (!repriced.approved) { decision = repriced; break; }
          decision = repriced;
          const nextCap = Math.min(spendCap, decision.stakeUsd);
          if (Math.abs(nextCap - spendCap) < 0.005) break;
          spendCap = nextCap;
        }
        if (!decision.approved) {
          const reason = decision.reasons.some((message) => message.startsWith("Minimum executable order")) ? "MINIMUM_ORDER_TOO_RISKY" : decision.reasons[0] ?? "POLICY_PASS";
          if (reason === "MINIMUM_ORDER_TOO_RISKY") minimumOrderRejects += 1;
          pass(reason);
          continue;
        }
        if (!replayFill || replayFill.costUsd + 0.01 < minimumExecutableOrderUsd
          || Math.abs(replayFill.costUsd - decision.stakeUsd) > 0.01
          || replayFill.shares + 1e-8 < row.minOrderShares) {
          pass("RECORDED_ASK_LADDER_TOO_SHALLOW");
          continue;
        }
      } else {
        const sharesAtMinimum = row.minOrderShares;
        const impact = Math.max(0, slippedPrice - ask);
        replayFill = {
          costUsd: decision.stakeUsd,
          shares: decision.stakeUsd / entryCostPerShare,
          feeUsd: (decision.stakeUsd / entryCostPerShare) * slippedPrice * feeRate,
          slippageUsd: (decision.stakeUsd / entryCostPerShare) * impact,
          entryCostPerShare,
        };
        if (sharesAtMinimum > replayFill.shares + 1e-8) { pass("MINIMUM_ORDER_TOO_RISKY"); continue; }
      }
      const stakeUsd = replayFill.costUsd;
      const shares = replayFill.shares;
      const entryFeeUsd = replayFill.feeUsd;
      const slippageUsd = replayFill.slippageUsd;
      const actualEntryCostPerShare = replayFill.entryCostPerShare;
      const trade: BankrollReplayTrade = {
        marketId, timestamp: row.timestamp, resolvedAt: outcomeRecord?.resolvedAt ?? null, asset: row.asset, duration: row.duration,
        side, predictedWinProbability: decision.effectiveProbability, entryCostPerShare: actualEntryCostPerShare, stakeUsd, shares,
        entryFeeUsd, slippageUsd, predictedNetEdge: decision.effectiveProbability - actualEntryCostPerShare,
        outcome: null, pnlUsd: null,
      };
      cash = round(cash - stakeUsd);
      fees += entryFeeUsd;
      slippage += slippageUsd;
      turnoverUsd += stakeUsd;
      open.set(marketId, { trade, costUsd: stakeUsd });
      trades.push(trade);
      trackEquity();
    }
    const dueAtEnd = [...open.keys()].map((key) => ({ key, result: outcomes.get(key) }))
      .filter((item): item is { key: string; result: { outcome: PaperSide; resolvedAt: number; conflict: boolean } } => Boolean(item.result?.outcome && item.result.resolvedAt !== null))
      .sort((left, right) => left.result.resolvedAt - right.result.resolvedAt);
    for (const item of dueAtEnd) settle(item.key, item.result.outcome, Math.max(lastTime, item.result.resolvedAt));
    const metrics = metricsFor(trades);
    const openCostBasisUsd = openCost();
    const endingEquityUsd = open.size ? null : round(cash);
    const realizedNetProfitUsd = round(trades.reduce((sum, trade) => sum + (trade.pnlUsd ?? 0), 0));
    return {
      startingBalanceUsd, tier: bankrollProfile(startingBalanceUsd).tier, endingTier: bankrollProfile(bookEquity()).tier,
      endingEquityUsd, endingCashUsd: round(cash), openCostBasisUsd: round(openCostBasisUsd),
      realizedNetProfitUsd, totalReturn: endingEquityUsd === null ? null : round((endingEquityUsd - startingBalanceUsd) / startingBalanceUsd),
      maxDrawdown: trades.length ? round(maxDrawdown) : null,
      minimumEquityUsd: trades.length ? round(minimumEquity) : null,
      observedSevereDrawdown: metrics.settled ? maxDrawdown >= severeDrawdownPct : null,
      severeDrawdownProbability: null, largestSingleLossUsd: metrics.largestSingleLossUsd,
      trades: trades.length, settled: metrics.settled, unsettled: open.size, winRate: metrics.winRate,
      brierScore: metrics.brierScore, logLoss: metrics.logLoss,
      averagePredictedEdge: trades.length ? trades.reduce((sum, trade) => sum + trade.predictedNetEdge, 0) / trades.length : null,
      averageRealizedEdge: metrics.averageRealizedEdge, profitFactor: metrics.profitFactor,
      averageTradeUsd: trades.length ? turnoverUsd / trades.length : null,
      feesUsd: round(fees), slippageUsd: round(slippage), turnover: round(turnoverUsd / startingBalanceUsd),
      averageExposurePct: elapsedMs > 0 ? round(exposureArea / elapsedMs) : null, maximumExposurePct: round(maximumExposurePct),
      passRate: decisionRows ? passRows / decisionRows : null, minimumOrderRejectRate: sizingEvaluations ? minimumOrderRejects / sizingEvaluations : null,
      minimumOrderRejects, decisionRows, sizingEvaluations, passesByReason, tradeDetails: trades,
    };
  });
  return {
    dataRows: rows.length, recordedPredictions: firstPredictions.size, excludedModelVersionRows,
    entryRowsWithAskLadders, entryRowsUsingFixedPriceFallback,
    resolvedMarkets: [...outcomes.values()].filter((result) => result.outcome !== null && result.resolvedAt !== null && !result.conflict).length,
    datasetHasSettledOutcomes: [...outcomes.values()].some((result) => result.outcome !== null && result.resolvedAt !== null),
    assumptions, limitations, calibration, accounts,
  };
};

/** CSV parser for the extended recorded-decision / order-book replay schema. */
export const parseBankrollBacktestCsv = (text: string): { rows: BankrollBacktestRow[]; rejected: number } => {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { record.push(field.trim()); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field.trim()); field = "";
      if (record.some(Boolean)) records.push(record);
      record = [];
    } else field += char;
  }
  record.push(field.trim());
  if (record.some(Boolean)) records.push(record);
  if (records.length < 2) return { rows: [], rejected: 0 };
  const headers = records[0].map((header) => header.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  const cell = (values: string[], ...names: string[]) => {
    for (const name of names) {
      const index = headers.indexOf(name);
      if (index >= 0 && values[index]?.trim()) return values[index].trim();
    }
    return "";
  };
  const num = (values: string[], ...names: string[]) => {
    const raw = cell(values, ...names).replace(/[$,%]/g, "");
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const levels = (values: string[], ...names: string[]): RecordedAskLevel[] | null => {
    const raw = cell(values, ...names);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const valid = parsed.flatMap((item): RecordedAskLevel[] => {
        if (!item || typeof item !== "object") return [];
        const level = item as { price?: unknown; size?: unknown };
        return positive(level.price) && level.price < 1 && positive(level.size) ? [{ price: level.price, size: level.size }] : [];
      }).sort((left, right) => left.price - right.price);
      return valid.length ? valid : null;
    } catch { return null; }
  };
  const rows: BankrollBacktestRow[] = [];
  let rejected = 0;
  for (const values of records.slice(1)) {
    const timeText = cell(values, "validation_at_utc", "timestamp", "observed_at_utc", "time");
    const timeNumber = Number(timeText);
    const timestamp = timeText && Number.isFinite(timeNumber) ? timeNumber < 10_000_000_000 ? timeNumber * 1000 : timeNumber : Date.parse(timeText);
    const asset = cell(values, "asset", "symbol").toUpperCase();
    const durationText = cell(values, "duration", "horizon").toLowerCase();
    const duration = durationText.includes("15") ? "15m" : "5m";
    // Decision-ledger exports have a mutable latest spot/reference plus frozen
    // validation columns. If the frozen fields are absent (legacy rows), keep
    // them missing rather than silently pairing later prices with old decisions.
    const decisionLedgerSchema = headers.includes("observed_at_utc") && headers.includes("validation_at_utc");
    const reference = decisionLedgerSchema
      ? num(values, "validation_reference")
      : num(values, "validation_reference", "reference", "reference_price", "strike");
    const spot = decisionLedgerSchema
      ? num(values, "validation_spot")
      : num(values, "validation_spot", "spot", "spot_price", "underlying");
    const upAsk = num(values, "validation_up_ask", "up_ask", "yes_ask");
    const downAsk = num(values, "validation_down_ask", "down_ask", "no_ask");
    if (!finite(timestamp) || timestamp <= 0 || !asset) { rejected += 1; continue; }
    const outcomeText = cell(values, "outcome", "winner", "settled_outcome").toUpperCase();
    const actionText = cell(values, "validation_decision", "model_action", "initial_decision").toUpperCase();
    const outcome = outcomeText === "UP" || outcomeText === "DOWN" ? outcomeText : null;
    const modelAction = actionText === "UP" || actionText === "DOWN" || actionText === "PASS" ? actionText : null;
    const outcomeAtText = cell(values, "outcome_at_utc", "resolved_at_utc");
    const outcomeAtNumber = num(values, "outcome_at", "resolved_at");
    const outcomeAt = outcomeAtText ? Date.parse(outcomeAtText) : finite(outcomeAtNumber)
      ? outcomeAtNumber < 10_000_000_000 ? outcomeAtNumber * 1000 : outcomeAtNumber : null;
    rows.push({
      timestamp, asset, duration, reference, spot, upAsk, downAsk, outcome, modelAction,
      marketId: cell(values, "market_id", "market") || undefined,
      remainingSeconds: num(values, "remaining_seconds", "seconds_left") ?? undefined,
      modelFairUp: num(values, "validation_probability_up", "model_fair_up", "fair_up"),
      modelEdge: num(values, "validation_edge", "model_edge", "selected_edge"),
      modelEntryPrice: num(values, "validation_entry_price", "model_entry_price", "entry_price"),
      modelStakeUsd: num(values, "validation_stake_usd", "model_stake_usd"),
      upBid: num(values, "validation_up_bid", "up_bid", "yes_bid"), downBid: num(values, "validation_down_bid", "down_bid", "no_bid"),
      upAskLevels: levels(values, "validation_up_ask_levels_json", "up_ask_levels_json", "up_asks"),
      downAskLevels: levels(values, "validation_down_ask_levels_json", "down_ask_levels_json", "down_asks"),
      upDepthUsd: num(values, "validation_up_depth_usd", "up_depth_usd", "yes_depth_usd"), downDepthUsd: num(values, "validation_down_depth_usd", "down_depth_usd", "no_depth_usd"),
      upBidDepthUsd: num(values, "validation_up_bid_depth_usd", "up_bid_depth_usd", "yes_bid_depth_usd"), downBidDepthUsd: num(values, "validation_down_bid_depth_usd", "down_bid_depth_usd", "no_bid_depth_usd"),
      minOrderShares: num(values, "validation_min_order_shares", "min_order_shares", "minimum_shares"), minOrderUsd: num(values, "validation_min_order_usd", "min_order_usd", "minimum_order_usd"),
      microScore: num(values, "validation_micro_score", "micro_score"),
      biasConfidence: num(values, "validation_bias_confidence", "bias_confidence"),
      outcomeAt: finite(outcomeAt) ? outcomeAt : null,
      modelVersion: cell(values, "model_version") || null,
      probabilityUncertainty: num(values, "probability_uncertainty"),
    });
  }
  return { rows, rejected };
};
