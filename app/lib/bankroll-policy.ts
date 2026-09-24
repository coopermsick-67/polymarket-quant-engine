/**
 * Paper-only bankroll policy. These thresholds are conservative hypotheses, not
 * calibrated return forecasts. An unaffordable exchange minimum is a PASS.
 */
export type BankrollTier = "MICRO" | "SMALL" | "GROWTH" | "STANDARD" | "LARGE";
export type BankrollSide = "UP" | "DOWN";
export type BankrollRiskMode = "NORMAL" | "CAUTIOUS" | "DRAWDOWN" | "RECOVERY" | "HALTED";

export type BankrollProfile = {
  tier: BankrollTier;
  eligible: boolean;
  minEquityUsd: number;
  strategy: string;
  targetStakePct: number;
  maxStakePct: number;
  reservePct: number;
  maxExposurePct: number;
  maxCorrelatedExposurePct: number;
  maxOpenPositions: number;
  maxConsecutiveLosses: number;
  maxDailyLossPct: number;
  maxPeakDrawdownPct: number;
  minNetEdge: number;
  maxSpreadPct: number;
  minExpectedProfitUsd: number;
  minExpectedProfitOnStakePct: number;
  maxDepthShare: number;
  kellyFraction: number;
  minRemainingSeconds: number;
  minEntryPrice: number;
  maxEntryPrice: number;
};

const PROFILE_TABLE: Record<BankrollTier, Omit<BankrollProfile, "eligible">> = {
  MICRO: {
    tier: "MICRO", minEquityUsd: 20, strategy: "5m oracle micro-trend; one selective liquid position",
    targetStakePct: 0.03, maxStakePct: 0.05, reservePct: 0.5,
    maxExposurePct: 0.04, maxCorrelatedExposurePct: 0.04, maxOpenPositions: 1, maxConsecutiveLosses: 3,
    maxDailyLossPct: 0.04, maxPeakDrawdownPct: 0.12,
    minNetEdge: 0.08, maxSpreadPct: 0.02, minExpectedProfitUsd: 0.05,
    minExpectedProfitOnStakePct: 0.1, maxDepthShare: 0.05,
    kellyFraction: 0.08, minRemainingSeconds: 90, minEntryPrice: 0.3, maxEntryPrice: 0.7,
  },
  SMALL: {
    tier: "SMALL", minEquityUsd: 50, strategy: "Cross-horizon confirmed trend; two small positions",
    targetStakePct: 0.025, maxStakePct: 0.04, reservePct: 0.4,
    maxExposurePct: 0.045, maxCorrelatedExposurePct: 0.045, maxOpenPositions: 2, maxConsecutiveLosses: 3,
    maxDailyLossPct: 0.045, maxPeakDrawdownPct: 0.14,
    minNetEdge: 0.07, maxSpreadPct: 0.025, minExpectedProfitUsd: 0.08,
    minExpectedProfitOnStakePct: 0.09, maxDepthShare: 0.05,
    kellyFraction: 0.1, minRemainingSeconds: 90, minEntryPrice: 0.15, maxEntryPrice: 0.85,
  },
  GROWTH: {
    tier: "GROWTH", minEquityUsd: 100, strategy: "Evidence weighted short-horizon entries",
    targetStakePct: 0.02, maxStakePct: 0.03, reservePct: 0.35,
    maxExposurePct: 0.05, maxCorrelatedExposurePct: 0.05, maxOpenPositions: 3, maxConsecutiveLosses: 4,
    maxDailyLossPct: 0.05, maxPeakDrawdownPct: 0.15,
    minNetEdge: 0.06, maxSpreadPct: 0.03, minExpectedProfitUsd: 0.12,
    minExpectedProfitOnStakePct: 0.08, maxDepthShare: 0.05,
    kellyFraction: 0.12, minRemainingSeconds: 75, minEntryPrice: 0.12, maxEntryPrice: 0.88,
  },
  STANDARD: {
    tier: "STANDARD", minEquityUsd: 250, strategy: "Diversified risk capped entries",
    targetStakePct: 0.015, maxStakePct: 0.025, reservePct: 0.3,
    maxExposurePct: 0.05, maxCorrelatedExposurePct: 0.05, maxOpenPositions: 4, maxConsecutiveLosses: 5,
    maxDailyLossPct: 0.05, maxPeakDrawdownPct: 0.16,
    minNetEdge: 0.05, maxSpreadPct: 0.035, minExpectedProfitUsd: 0.2,
    minExpectedProfitOnStakePct: 0.07, maxDepthShare: 0.05,
    kellyFraction: 0.15, minRemainingSeconds: 60, minEntryPrice: 0.1, maxEntryPrice: 0.9,
  },
  LARGE: {
    tier: "LARGE", minEquityUsd: 1_000, strategy: "Depth constrained diversified entries",
    targetStakePct: 0.01, maxStakePct: 0.02, reservePct: 0.25,
    maxExposurePct: 0.05, maxCorrelatedExposurePct: 0.05, maxOpenPositions: 5, maxConsecutiveLosses: 5,
    maxDailyLossPct: 0.05, maxPeakDrawdownPct: 0.18,
    minNetEdge: 0.04, maxSpreadPct: 0.04, minExpectedProfitUsd: 0.4,
    minExpectedProfitOnStakePct: 0.06, maxDepthShare: 0.05,
    kellyFraction: 0.18, minRemainingSeconds: 60, minEntryPrice: 0.08, maxEntryPrice: 0.92,
  },
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const centsDown = (value: number) => Math.floor((value + 1e-9) * 100) / 100;
const centsUp = (value: number) => Math.ceil((value - 1e-9) * 100) / 100;
const round = (value: number, places = 4) => Number(value.toFixed(places));
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;

/** Fee-inclusive share cost should be taken from the depth walk for this price. */
export const minimumExecutableOrderCost = (minimumShares: number, executableCostPerShare: number): number =>
  Number.isFinite(minimumShares) && minimumShares > 0 && Number.isFinite(executableCostPerShare) &&
    executableCostPerShare > 0 && executableCostPerShare < 1
    ? centsUp(minimumShares * executableCostPerShare)
    : Number.POSITIVE_INFINITY;

export const bankrollProfile = (equityUsd: number): BankrollProfile => {
  const equity = nonnegative(equityUsd) ? equityUsd : 0;
  const tier: BankrollTier = equity >= 1_000 ? "LARGE" : equity >= 250 ? "STANDARD" :
    equity >= 100 ? "GROWTH" : equity >= 50 ? "SMALL" : "MICRO";
  return { ...PROFILE_TABLE[tier], eligible: equity >= 20 };
};

export type BankrollRiskInput = {
  equityUsd: number;
  dayStartEquityUsd: number;
  peakEquityUsd: number;
  profile?: BankrollProfile;
  consecutiveLosses?: number;
  recentWinAfterDrawdown?: boolean;
};

export type BankrollRiskState = {
  approved: boolean;
  state: BankrollRiskMode;
  reason: string;
  dayLossPct: number;
  peakDrawdownPct: number;
  drawdownAdjustment: number;
  dailyLossRemainingUsd: number;
};

export const assessBankrollRisk = ({ equityUsd, dayStartEquityUsd, peakEquityUsd, profile = bankrollProfile(equityUsd), consecutiveLosses = 0, recentWinAfterDrawdown = false }: BankrollRiskInput): BankrollRiskState => {
  const readable = nonnegative(equityUsd) && Number.isFinite(dayStartEquityUsd) && dayStartEquityUsd > 0 &&
    Number.isFinite(peakEquityUsd) && peakEquityUsd > 0;
  if (!readable) return { approved: false, state: "HALTED", reason: "Equity or risk baseline is unavailable.", dayLossPct: 1, peakDrawdownPct: 1, drawdownAdjustment: 0, dailyLossRemainingUsd: 0 };
  const dayLossPct = Math.max(0, (dayStartEquityUsd - equityUsd) / dayStartEquityUsd);
  const peakDrawdownPct = Math.max(0, (peakEquityUsd - equityUsd) / peakEquityUsd);
  const losses = Number.isFinite(consecutiveLosses) ? Math.max(0, Math.floor(consecutiveLosses)) : profile.maxConsecutiveLosses;
  const halted = !profile.eligible || dayLossPct >= profile.maxDailyLossPct - 1e-9 ||
    peakDrawdownPct >= profile.maxPeakDrawdownPct - 1e-9;
  const state: BankrollRiskMode = halted ? "HALTED" :
    recentWinAfterDrawdown && peakDrawdownPct >= profile.maxPeakDrawdownPct * 0.25 ? "RECOVERY" :
      losses >= profile.maxConsecutiveLosses || peakDrawdownPct >= profile.maxPeakDrawdownPct * 0.5 ? "DRAWDOWN" :
        losses >= 2 || peakDrawdownPct >= profile.maxPeakDrawdownPct * 0.25 ? "CAUTIOUS" : "NORMAL";
  const stateMultiplier = state === "DRAWDOWN" ? 0.5 : state === "RECOVERY" ? 0.65 : state === "CAUTIOUS" ? 0.75 : state === "HALTED" ? 0 : 1;
  const drawdownAdjustment = clamp(1 - 0.75 * (peakDrawdownPct / profile.maxPeakDrawdownPct), 0.25, 1) * stateMultiplier;
  const reason = !profile.eligible ? "Liquidation equity is below the $20 paper-entry floor." :
    dayLossPct >= profile.maxDailyLossPct - 1e-9 ? "Daily liquidation loss limit reached." :
    peakDrawdownPct >= profile.maxPeakDrawdownPct - 1e-9 ? "Peak-to-current liquidation drawdown limit reached." :
    "Bankroll risk limits pass.";
  return {
    approved: reason === "Bankroll risk limits pass.", state, reason,
    dayLossPct: round(dayLossPct, 6), peakDrawdownPct: round(peakDrawdownPct, 6),
    drawdownAdjustment: round(drawdownAdjustment, 6),
    dailyLossRemainingUsd: round(Math.max(0, equityUsd - dayStartEquityUsd * (1 - profile.maxDailyLossPct))),
  };
};

export type BankrollPosition = {
  marketId: string;
  asset: string;
  side: BankrollSide;
  costUsd: number;
  /** Use a shared group (for example CRYPTO) for assets exposed to the same factor. */
  correlationGroup?: string;
};

export type BankrollSizingInput = {
  /** Cash plus net proceeds from liquidation at currently executable bids. */
  equityUsd: number;
  cashUsd: number;
  dayStartEquityUsd: number;
  peakEquityUsd: number;
  positions: BankrollPosition[];
  marketId: string;
  asset: string;
  side: BankrollSide;
  correlationGroup?: string;
  strategyKey: string;
  /** Chosen-side probability from the signal model. */
  modelProbability: number;
  /** Out-of-sample calibrated probability; used only with sufficient samples. */
  calibratedProbability?: number | null;
  calibrationSampleSize?: number;
  /** Total buy cost divided by executable shares, including fees/slippage/depth. */
  entryPrice: number;
  /** Model probability minus entryPrice, supplied for diagnostic consistency. */
  netEdge: number;
  /** Actual minimum shares times effective entry price, including execution costs. */
  minExecutableOrderUsd: number;
  availableDepthUsd: number;
  spreadPct: number;
  timeRemainingSeconds: number;
  /** Absolute probability-point uncertainty; defaults to 0.02 for uncalibrated models. */
  probabilityUncertainty?: number;
  /** Out-of-sample strategy sample and win rate can only reduce sizing. */
  strategySampleSize?: number;
  strategyWinRate?: number;
  consecutiveLosses?: number;
  recentWinAfterDrawdown?: boolean;
  /** Additional operator caps tighten, never loosen, the tier limits. */
  maxTradeUsd?: number;
  maxExposurePct?: number;
  maxOpenPositions?: number;
  minNetEdge?: number;
  /** Net proceeds at risk of disappearing if current open positions resolve to zero. */
  openPositionRiskUsd?: number;
  /** Optional caller-owned profile for isolated live sizing policies. */
  profile?: BankrollProfile;
};

export type BankrollPortfolioAssessment = {
  existingExposureUsd: number;
  existingCorrelatedExposureUsd: number;
  existingDirectionalExposureUsd: number;
  exposureCapUsd: number;
  correlatedExposureCapUsd: number;
  remainingExposureUsd: number;
  remainingCorrelatedExposureUsd: number;
  openPositionRiskUsd: number;
  remainingDailyRiskUsd: number;
  openPositions: number;
};

export type BankrollSizingDecision = {
  approved: boolean;
  reason: string;
  reasons: string[];
  tier: BankrollTier;
  profile: BankrollProfile;
  strategyKey: string;
  stakeUsd: number;
  targetStakeUsd: number;
  targetStakePct: number;
  maxAllowedStakeUsd: number;
  minimumExecutableOrderUsd: number;
  riskMultiplier: number;
  kellyRaw: number;
  kellyAdjusted: number;
  kellyApplied: boolean;
  liquidityCapUsd: number;
  drawdownAdjustment: number;
  reserveUsd: number;
  usableCashUsd: number;
  expectedNetProfitUsd: number;
  expectedNetProfitOnStakePct: number;
  effectiveProbability: number;
  conservativeEdge: number;
  portfolio: BankrollPortfolioAssessment;
  risk: BankrollRiskState;
};

/** Binary-contract Kelly is computed for auditability, never applied raw. */
export const calculateBankrollAwareStake = (input: BankrollSizingInput): BankrollSizingDecision => {
  const profile = input.profile ?? bankrollProfile(input.equityUsd);
  const risk = assessBankrollRisk({ equityUsd: input.equityUsd, dayStartEquityUsd: input.dayStartEquityUsd, peakEquityUsd: input.peakEquityUsd, profile,
    consecutiveLosses: input.consecutiveLosses, recentWinAfterDrawdown: input.recentWinAfterDrawdown });
  const errors: string[] = [];
  const { equityUsd, cashUsd, entryPrice, modelProbability, minExecutableOrderUsd, availableDepthUsd, spreadPct, timeRemainingSeconds } = input;
  const financialsValid = nonnegative(equityUsd) && nonnegative(cashUsd) && Number.isFinite(entryPrice) && entryPrice > 0 && entryPrice < 1 &&
    Number.isFinite(modelProbability) && modelProbability >= 0 && modelProbability <= 1 && Number.isFinite(input.netEdge) &&
    Number.isFinite(minExecutableOrderUsd) && minExecutableOrderUsd > 0 && nonnegative(availableDepthUsd) &&
    nonnegative(spreadPct) && nonnegative(timeRemainingSeconds) && Array.isArray(input.positions) &&
    input.positions.every((position) => nonnegative(position.costUsd) && Boolean(position.marketId) && Boolean(position.asset) && (position.side === "UP" || position.side === "DOWN"));
  if (!financialsValid) errors.push("Missing or invalid executable market, portfolio, or probability input.");
  if ((input.maxTradeUsd !== undefined && !nonnegative(input.maxTradeUsd)) ||
      (input.maxExposurePct !== undefined && !nonnegative(input.maxExposurePct)) ||
      (input.maxOpenPositions !== undefined && (!Number.isInteger(input.maxOpenPositions) || input.maxOpenPositions < 0)) ||
      (input.minNetEdge !== undefined && !nonnegative(input.minNetEdge)) ||
      (input.openPositionRiskUsd !== undefined && !nonnegative(input.openPositionRiskUsd))) errors.push("An operator risk cap is invalid.");
  if ((input.probabilityUncertainty !== undefined && (!nonnegative(input.probabilityUncertainty) || input.probabilityUncertainty > 0.25)) ||
      (input.strategyWinRate !== undefined && (!nonnegative(input.strategyWinRate) || input.strategyWinRate > 1)) ||
      (input.strategySampleSize !== undefined && (!Number.isInteger(input.strategySampleSize) || input.strategySampleSize < 0))) errors.push("Probability uncertainty or strategy performance evidence is invalid.");
  if (!risk.approved) errors.push(risk.reason);
  if (!input.marketId || !input.asset || !input.strategyKey || (input.side !== "UP" && input.side !== "DOWN")) errors.push("Market identity, side, and strategy are required.");

  const calibrated = Number.isFinite(input.calibratedProbability) && (input.calibrationSampleSize ?? 0) >= 100 &&
    (input.calibratedProbability ?? -1) >= 0 && (input.calibratedProbability ?? 2) <= 1;
  const effectiveProbability = calibrated ? input.calibratedProbability! : (Number.isFinite(modelProbability) ? modelProbability : 0);
  const rawEdge = financialsValid ? Math.min(input.netEdge, effectiveProbability - entryPrice) : 0;
  const riskEdgePremium = risk.state === "DRAWDOWN" ? 0.02 : risk.state === "CAUTIOUS" || risk.state === "RECOVERY" ? 0.01 : 0;
  const minEdge = Math.max(profile.minNetEdge, nonnegative(input.minNetEdge ?? profile.minNetEdge) ? input.minNetEdge ?? 0 : profile.minNetEdge) + riskEdgePremium;
  const uncertainty = clamp(Number.isFinite(input.probabilityUncertainty) ? input.probabilityUncertainty! : (calibrated ? 0.01 : 0.02), 0, 0.25);
  const conservativeEdge = Math.max(0, rawEdge - uncertainty);
  if (financialsValid && rawEdge + 1e-9 < minEdge) errors.push(`Cost-adjusted edge is below the ${(minEdge * 100).toFixed(1)}% tier floor.`);
  if (financialsValid && spreadPct > profile.maxSpreadPct + 1e-9) errors.push("Bid-ask spread exceeds this tier's limit.");
  if (financialsValid && timeRemainingSeconds < profile.minRemainingSeconds) errors.push("Too little time remains for a new entry.");
  if (financialsValid && (entryPrice < profile.minEntryPrice || entryPrice > profile.maxEntryPrice)) errors.push("Entry price is outside this tier's selective range.");

  const positions = Array.isArray(input.positions) ? input.positions : [];
  const correlationGroup = (input.correlationGroup || input.asset || "UNKNOWN").toUpperCase();
  const existingExposureUsd = positions.reduce((sum, position) => sum + (nonnegative(position.costUsd) ? position.costUsd : 0), 0);
  const existingCorrelatedExposureUsd = positions.reduce((sum, position) => sum +
    ((position.correlationGroup || position.asset).toUpperCase() === correlationGroup && nonnegative(position.costUsd) ? position.costUsd : 0), 0);
  const existingDirectionalExposureUsd = positions.reduce((sum, position) => sum +
    ((position.correlationGroup || position.asset).toUpperCase() === correlationGroup && position.side === input.side && nonnegative(position.costUsd) ? position.costUsd : 0), 0);
  const exposurePct = Number.isFinite(input.maxExposurePct) && input.maxExposurePct! >= 0 ? Math.min(profile.maxExposurePct, input.maxExposurePct!) : profile.maxExposurePct;
  const safeEquityUsd = nonnegative(equityUsd) ? equityUsd : 0;
  const safeCashUsd = nonnegative(cashUsd) ? cashUsd : 0;
  const safeDepthUsd = nonnegative(availableDepthUsd) ? availableDepthUsd : 0;
  const exposureCapUsd = safeEquityUsd * exposurePct;
  const correlatedExposureCapUsd = safeEquityUsd * profile.maxCorrelatedExposurePct;
  const remainingExposureUsd = Math.max(0, exposureCapUsd - existingExposureUsd);
  const remainingCorrelatedExposureUsd = Math.max(0, correlatedExposureCapUsd - existingCorrelatedExposureUsd);
  const openPositionRiskUsd = input.openPositionRiskUsd ?? existingExposureUsd;
  const remainingDailyRiskUsd = Math.max(0, risk.dailyLossRemainingUsd - openPositionRiskUsd);
  const portfolio: BankrollPortfolioAssessment = {
    existingExposureUsd: round(existingExposureUsd), existingCorrelatedExposureUsd: round(existingCorrelatedExposureUsd),
    existingDirectionalExposureUsd: round(existingDirectionalExposureUsd), exposureCapUsd: round(exposureCapUsd),
    correlatedExposureCapUsd: round(correlatedExposureCapUsd), remainingExposureUsd: round(remainingExposureUsd),
    remainingCorrelatedExposureUsd: round(remainingCorrelatedExposureUsd), openPositionRiskUsd: round(openPositionRiskUsd),
    remainingDailyRiskUsd: round(remainingDailyRiskUsd), openPositions: positions.length,
  };
  const maxPositions = Number.isInteger(input.maxOpenPositions) && input.maxOpenPositions! >= 0 ? Math.min(profile.maxOpenPositions, input.maxOpenPositions!) : profile.maxOpenPositions;
  if (positions.length >= maxPositions) errors.push("Open-position limit reached.");
  if (positions.some((position) => position.marketId === input.marketId)) errors.push("A position in this market is already open.");

  const reserveUsd = safeEquityUsd * profile.reservePct;
  const usableCashUsd = Math.max(0, safeCashUsd - reserveUsd);
  const liquidityCapUsd = safeDepthUsd * profile.maxDepthShare;
  const kellyRaw = financialsValid ? clamp((effectiveProbability - entryPrice) / (1 - entryPrice), 0, 1) : 0;
  const uncertaintyAdjustment = clamp(1 - uncertainty * 4, 0.5, 1);
  const edgeAdjustment = minEdge > 0 ? clamp(rawEdge / (minEdge * 2), 0.5, 1) : 1;
  const strategyAdjustment = (input.strategySampleSize ?? 0) >= 50 && Number.isFinite(input.strategyWinRate)
    ? clamp((input.strategyWinRate ?? 0) / 0.55, 0.5, 1) : 0.8;
  const riskMultiplier = clamp(risk.drawdownAdjustment * uncertaintyAdjustment * edgeAdjustment * strategyAdjustment, 0, 1);
  const kellyAdjusted = calibrated ? kellyRaw * profile.kellyFraction * riskMultiplier : 0;
  const hardTradeCapUsd = Number.isFinite(input.maxTradeUsd) && input.maxTradeUsd! >= 0 ? Math.min(safeEquityUsd * profile.maxStakePct, input.maxTradeUsd!) : safeEquityUsd * profile.maxStakePct;
  const maxAllowedStakeUsd = Math.max(0, Math.min(hardTradeCapUsd, remainingExposureUsd, remainingCorrelatedExposureUsd, usableCashUsd, liquidityCapUsd,
    remainingDailyRiskUsd,
    calibrated ? safeEquityUsd * kellyAdjusted : Number.POSITIVE_INFINITY));
  if (financialsValid && centsUp(minExecutableOrderUsd) > centsDown(maxAllowedStakeUsd)) {
    const minimumRiskPct = safeEquityUsd > 0 ? minExecutableOrderUsd / safeEquityUsd : 1;
    errors.push(`Minimum executable order risks ${(minimumRiskPct * 100).toFixed(1)}% of equity and exceeds an applicable ${profile.tier} cash, reserve, depth, remaining daily-loss, Kelly, or stake cap (${(profile.maxStakePct * 100).toFixed(1)}% tier maximum).`);
  }
  const uncappedTargetUsd = safeEquityUsd * profile.targetStakePct * riskMultiplier;
  const kellyTargetUsd = calibrated ? Math.min(uncappedTargetUsd, safeEquityUsd * kellyAdjusted) : uncappedTargetUsd;
  const targetStakeUsd = Math.max(0, Math.min(kellyTargetUsd, maxAllowedStakeUsd));
  const minimumCents = financialsValid ? centsUp(minExecutableOrderUsd) : 0;
  const affordable = financialsValid && minimumCents <= centsDown(maxAllowedStakeUsd);
  // A minimum may raise the target only while every hard risk cap still holds.
  const stakeUsd = affordable ? centsDown(Math.max(minimumCents, targetStakeUsd)) : 0;
  const expectedNetProfitUsd = financialsValid && stakeUsd > 0 ? conservativeEdge * (stakeUsd / entryPrice) : 0;
  const expectedNetProfitOnStakePct = stakeUsd > 0 ? expectedNetProfitUsd / stakeUsd : 0;
  if (financialsValid && affordable && expectedNetProfitUsd + 1e-9 < profile.minExpectedProfitUsd) errors.push("Expected net profit after uncertainty is too small for this tier.");
  if (financialsValid && affordable && expectedNetProfitOnStakePct + 1e-9 < profile.minExpectedProfitOnStakePct) errors.push("Expected net profit is too small relative to stake at risk.");
  const approved = errors.length === 0 && stakeUsd > 0;
  const reasons = approved ? [stakeUsd > targetStakeUsd + 0.005 ? "Executable minimum raised the target within all hard caps." : "Target stake is within all hard caps.",
    calibrated ? "Fractional Kelly cap uses at least 100 calibration observations." : "Uncalibrated signal uses conservative tier sizing; Kelly is diagnostic only."] : errors;
  return {
    approved, reason: reasons.join(" "), reasons, tier: profile.tier, profile, strategyKey: input.strategyKey,
    stakeUsd: approved ? stakeUsd : 0, targetStakeUsd: round(targetStakeUsd), targetStakePct: safeEquityUsd > 0 ? round(targetStakeUsd / safeEquityUsd, 6) : 0,
    maxAllowedStakeUsd: round(maxAllowedStakeUsd), minimumExecutableOrderUsd: financialsValid ? round(minExecutableOrderUsd) : 0,
    riskMultiplier: round(riskMultiplier, 6), kellyRaw: round(kellyRaw, 6), kellyAdjusted: round(kellyAdjusted, 6),
    kellyApplied: calibrated, liquidityCapUsd: round(liquidityCapUsd), drawdownAdjustment: risk.drawdownAdjustment,
    reserveUsd: round(reserveUsd), usableCashUsd: round(usableCashUsd), expectedNetProfitUsd: round(expectedNetProfitUsd),
    expectedNetProfitOnStakePct: round(expectedNetProfitOnStakePct, 6), effectiveProbability: round(effectiveProbability, 6),
    conservativeEdge: round(conservativeEdge, 6), portfolio, risk,
  };
};

export const sizeBankrollTrade = calculateBankrollAwareStake;

export type BankrollOpportunityScore = {
  score: number;
  reason: string;
  components: { edge: number; profit: number; spread: number; liquidity: number; uncertainty: number; time: number };
};

/** Explainable ranking heuristic. Weights are policy choices, not trained coefficients. */
export const scoreBankrollOpportunity = (input: {
  sizing: BankrollSizingDecision;
  spreadPct: number;
  availableDepthUsd: number;
  timeRemainingSeconds: number;
  probabilityUncertainty?: number;
}): BankrollOpportunityScore => {
  const { sizing } = input;
  const zero = { edge: 0, profit: 0, spread: 0, liquidity: 0, uncertainty: 0, time: 0 };
  if (!sizing.approved || !nonnegative(input.spreadPct) || !nonnegative(input.availableDepthUsd) || !nonnegative(input.timeRemainingSeconds)) {
    return { score: 0, reason: sizing.approved ? "Invalid ranking inputs." : sizing.reason, components: zero };
  }
  const profile = sizing.profile;
  const components = {
    edge: 35 * clamp(sizing.conservativeEdge / Math.max(0.001, profile.minNetEdge * 2), 0, 1),
    profit: 20 * clamp(sizing.expectedNetProfitUsd / Math.max(0.01, profile.minExpectedProfitUsd * 3), 0, 1),
    spread: 15 * clamp(1 - input.spreadPct / Math.max(0.001, profile.maxSpreadPct), 0, 1),
    liquidity: 15 * clamp(input.availableDepthUsd / Math.max(0.01, sizing.stakeUsd * 40), 0, 1),
    uncertainty: 10 * clamp(1 - (Number.isFinite(input.probabilityUncertainty) ? input.probabilityUncertainty! : 0.02) / 0.1, 0, 1),
    time: 5 * clamp(input.timeRemainingSeconds / Math.max(1, profile.minRemainingSeconds * 3), 0, 1),
  };
  const score = round(Object.values(components).reduce((sum, value) => sum + value, 0), 2);
  return { score, components, reason: `Ranking uses net edge, executable profit, spread, depth, uncertainty, and time; ${profile.tier} policy applies.` };
};
