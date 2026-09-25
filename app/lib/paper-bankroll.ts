import { bankrollProfile, calculateBankrollAwareStake, scoreBankrollOpportunity, type BankrollProfile, type BankrollSizingDecision } from "./bankroll-policy";
import { accountLiquidationEquity, analyzeMarketSignal, estimatePaperExitFill, paperEntryBookEconomics, type CostConfig, type MarketSignal, type PaperAccount } from "./engines";
import type { LiveMarket } from "./polymarket-data";

export type PaperOpportunity = {
  approved: boolean;
  reason: string;
  signal: MarketSignal;
  sizing: BankrollSizingDecision | null;
  score: ReturnType<typeof scoreBankrollOpportunity> | null;
  book: ReturnType<typeof paperEntryBookEconomics> | null;
  stakeUsd: number;
  liquidationEquityUsd: number;
};

/** Same settled-trade streak used by entries and status; resets each UTC day. */
export const paperLossHistory = (account: PaperAccount, now = Date.now()) => {
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const recentTrades = account.closedTrades.filter((trade) => trade.timestamp >= dayStart && trade.timestamp <= now)
    .sort((a, b) => b.timestamp - a.timestamp);
  const firstWin = recentTrades.findIndex((trade) => trade.pnl > 0);
  return {
    consecutiveLosses: firstWin < 0 ? recentTrades.length : firstWin,
    recentWinAfterDrawdown: recentTrades[0]?.pnl > 0 && recentTrades.slice(1, 4).filter((trade) => trade.pnl <= 0).length >= 2,
  };
};

/** One paper decision path shared by the browser and persistent daemon. */
export const evaluatePaperMarket = (input: {
  market: LiveMarket;
  markets: Map<string, LiveMarket>;
  account: PaperAccount;
  costs: CostConfig;
  liquidationEquityUsd?: number;
  dayStartLiquidationEquityUsd?: number;
  peakLiquidationEquityUsd?: number;
  minOrderUsd?: number;
  maxTradeUsd?: number;
  maxExposurePct?: number;
  maxOpenPositions?: number;
  minNetEdge?: number;
  minimumSharesOverride?: number;
  profileOverride?: BankrollProfile;
  strategyThresholds?: { microScoreMinimum?: number; smallBiasConfidenceMinimum?: number };
  now?: number;
}): PaperOpportunity => {
  const { market, markets, account, costs } = input;
  const decisionAt = input.now ?? Date.now();
  const equity = input.liquidationEquityUsd ?? accountLiquidationEquity(account, markets, costs);
  const profile = input.profileOverride ?? bankrollProfile(equity);
  const minOrderUsd = Math.max(1, input.minOrderUsd ?? 1);
  const upBook = paperEntryBookEconomics(market, "UP", costs, minOrderUsd, input.minimumSharesOverride);
  const downBook = paperEntryBookEconomics(market, "DOWN", costs, minOrderUsd, input.minimumSharesOverride);
  const visibleMinimums = [upBook.minimumExecutableOrderUsd, downBook.minimumExecutableOrderUsd].filter((value) => Number.isFinite(value) && value < Number.MAX_SAFE_INTEGER);
  // Reprice at the largest amount this caller is allowed to submit. If the
  // exchange minimum exceeds that cap, the sizing gate below reports it.
  const callerCap = input.maxTradeUsd ?? equity * profile.maxStakePct;
  const inspectBudget = Math.min(10_000, Math.max(minOrderUsd, Math.min(callerCap, Math.max(equity * profile.maxStakePct, ...visibleMinimums))));
  const edgeFloor = Math.max(profile.minNetEdge, input.minNetEdge ?? 0);
  let signal = analyzeMarketSignal(market, costs, inspectBudget, edgeFloor, decisionAt);
  const base = { liquidationEquityUsd: equity, signal, sizing: null, score: null, book: null, stakeUsd: 0 } as const;
  const blockSignal = (reason: string): PaperOpportunity => {
    const blocked: MarketSignal = { ...signal, action: "PASS", tier: "PASS", entryPrice: null, edge: null,
      executableCostProbability: null, expectedNetProfitUsd: null, estimatedFill: null, reason };
    return { ...base, signal: blocked, approved: false, reason };
  };
  if (signal.action === "PASS" || signal.edge === null || signal.fairUp === null || signal.executableCostProbability === null) {
    return { ...base, approved: false, reason: signal.reason };
  }
  const side = signal.action;
  // MICRO accounts use a separate short-window momentum filter: only the most
  // liquid 5m contracts and an aligned live oracle micro-trend can qualify.
  const microScoreMinimum = input.strategyThresholds?.microScoreMinimum ?? 0.45;
  const smallBiasConfidenceMinimum = input.strategyThresholds?.smallBiasConfidenceMinimum ?? 0.58;
  if (profile.tier === "MICRO") {
    if (market.duration !== "5m") return blockSignal("PASS: MICRO strategy only trades 5m markets to limit time and capital exposure.");
    if (signal.microScore === null || Math.abs(signal.microScore) < microScoreMinimum
      || Math.sign(signal.microScore) !== (side === "UP" ? 1 : -1)) {
      return blockSignal("PASS: MICRO strategy requires a strong, aligned live oracle micro-trend.");
    }
  } else if (profile.tier === "SMALL" && (signal.biasConfidence ?? 0) < smallBiasConfidenceMinimum) {
    return blockSignal(`PASS: SMALL strategy requires stronger ${market.duration}-specific directional confidence before using limited balance.`);
  }
  const book = side === "UP" ? upBook : downBook;
  if (!book.minimumSharesKnown) return { ...base, book, approved: false, reason: "PASS: the exchange minimum share size is unavailable from the current order book." };
  if (!book.minimumDepthAvailable) return { ...base, book, approved: false, reason: "PASS: visible asks cannot fill the market's minimum share size." };
  if (book.spreadPct === null) return { ...base, book, approved: false, reason: "PASS: bid-ask spread is unavailable." };

  const dayStart = input.dayStartLiquidationEquityUsd ?? account.riskDayStartEquityUsd ?? account.startingCash;
  const peak = input.peakLiquidationEquityUsd ?? account.peakLiquidationEquityUsd ?? account.startingCash;
  const positions = account.positions.map((position) => ({ marketId: position.marketId, asset: position.asset, side: position.side, costUsd: position.totalCost, correlationGroup: "CRYPTO" }));
  const openPositionRiskUsd = account.positions.reduce((riskUsd, position) => {
    const openMarket = markets.get(position.marketId);
    const liquidation = openMarket ? estimatePaperExitFill(openMarket, position.side, position.shares, costs) : null;
    return riskUsd + (liquidation && liquidation.shares + 1e-8 >= position.shares ? liquidation.totalCost : position.totalCost);
  }, 0);
  const { consecutiveLosses: lossStreak, recentWinAfterDrawdown } = paperLossHistory(account, decisionAt);
  const uncertainty = Math.min(0.1, 0.02 + signal.modelUncertainty * 0.04);
  const size = (currentSignal: MarketSignal, operatorMaxTradeUsd = input.maxTradeUsd) => calculateBankrollAwareStake({
    equityUsd: equity,
    cashUsd: account.cash,
    dayStartEquityUsd: dayStart,
    peakEquityUsd: peak,
    positions,
    marketId: market.id,
    asset: market.asset,
    side,
    correlationGroup: "CRYPTO",
    strategyKey: `${profile.tier}:${market.duration}`,
    modelProbability: side === "UP" ? currentSignal.fairUp! : 1 - currentSignal.fairUp!,
    entryPrice: currentSignal.executableCostProbability!,
    netEdge: currentSignal.edge!,
    minExecutableOrderUsd: book.minimumExecutableOrderUsd,
    availableDepthUsd: book.availableDepthUsd,
    spreadPct: book.spreadPct!,
    timeRemainingSeconds: market.remaining,
    probabilityUncertainty: uncertainty,
    consecutiveLosses: lossStreak,
    recentWinAfterDrawdown,
    maxTradeUsd: operatorMaxTradeUsd,
    maxExposurePct: input.maxExposurePct,
    maxOpenPositions: input.maxOpenPositions,
    minNetEdge: input.minNetEdge,
    openPositionRiskUsd,
    profile,
  });
  let sizing = size(signal);
  if (!sizing.approved) return { ...base, book, sizing, approved: false, reason: `PASS: ${sizing.reason}` };

  // Reprice at the proposed order size. A smaller order can be cheaper, but
  // the second sizing pass may only maintain or reduce the first stake.
  const repriced = analyzeMarketSignal(market, costs, sizing.stakeUsd, edgeFloor, decisionAt);
  if (repriced.action !== side || repriced.edge === null || repriced.executableCostProbability === null) {
    return { ...base, book, sizing, signal: repriced, approved: false, reason: `PASS: proposed-size execution failed signal checks. ${repriced.reason}` };
  }
  signal = repriced;
  sizing = size(signal, Math.min(sizing.stakeUsd, input.maxTradeUsd ?? sizing.stakeUsd));
  if (!sizing.approved) return { ...base, book, sizing, signal, approved: false, reason: `PASS: ${sizing.reason}` };
  const score = scoreBankrollOpportunity({ sizing, spreadPct: book.spreadPct, availableDepthUsd: book.availableDepthUsd,
    timeRemainingSeconds: market.remaining, probabilityUncertainty: uncertainty });
  return { approved: true, reason: `${signal.reason} ${sizing.reason}`, signal, sizing, score, book,
    stakeUsd: sizing.stakeUsd, liquidationEquityUsd: equity };
};
