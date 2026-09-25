import type { Horizon } from "./polymarket-data";
import {
  DEFAULT_LIVE_EARLY_EXIT,
  normalizeEarlyExitPolicy,
  type EarlyExitPolicy,
} from "./early-exit";

export type LiveRiskConfig = EarlyExitPolicy & {
  unitBalancePct: number;
  unitsPerTrade: number;
  kellyFraction: number;
  maxTradeUsd: number;
  maxExposurePct: number;
  minEdge: number;
  feeRate: number;
  slippageBps: number;
  allowedDurations: Horizon[];
  requireLock: boolean;
};

export type KellySizing = {
  balance: number;
  entryPrice: number;
  effectivePrice: number;
  probability: number;
  fullKelly: number;
  kellyFraction: number;
  kellyStakeUsd: number;
  baseUnitUsd: number;
  requestedStakeUsd: number;
  exposureCapUsd: number;
  stakeUsd: number;
  units: number;
  approved: boolean;
  reason: string;
};

export type LiveExposureAssessment = {
  existingExposureUsd: number;
  proposedExposureUsd: number;
  aggregateExposureUsd: number;
  exposureCapUsd: number;
  remainingExposureUsd: number;
  approved: boolean;
  reason: string;
};

export const DEFAULT_LIVE_RISK: LiveRiskConfig = {
  ...DEFAULT_LIVE_EARLY_EXIT,
  unitBalancePct: 0.01,
  unitsPerTrade: 1,
  kellyFraction: 0.25,
  maxTradeUsd: 25,
  maxExposurePct: 0.1,
  minEdge: 0.04,
  feeRate: 0.02,
  slippageBps: 15,
  allowedDurations: ["5m", "15m"],
  requireLock: false,
};

const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

/**
 * Applies the configured exposure ceiling to all currently open positions plus
 * the proposed order. Inputs are expected to be reconciled USD cost basis; bad
 * inputs fail closed instead of silently treating unreadable positions as zero.
 */
export const assessLiveExposure = (
  balance: number,
  existingExposureUsd: number,
  proposedExposureUsd: number,
  config: LiveRiskConfig,
): LiveExposureAssessment => {
  const valuesAreReadable = [balance, existingExposureUsd, proposedExposureUsd].every(Number.isFinite)
    && balance >= 0
    && existingExposureUsd >= 0
    && proposedExposureUsd >= 0;
  const safeBalance = valuesAreReadable ? balance : 0;
  const safeExisting = valuesAreReadable ? existingExposureUsd : 0;
  const safeProposed = valuesAreReadable ? proposedExposureUsd : 0;
  const exposureCapUsd = safeBalance * config.maxExposurePct;
  const aggregateExposureUsd = safeExisting + safeProposed;
  const remainingExposureUsd = Math.max(0, exposureCapUsd - safeExisting);
  const approved = valuesAreReadable && aggregateExposureUsd <= exposureCapUsd + 1e-8;
  const reason = !valuesAreReadable
    ? "Existing portfolio exposure could not be established; live entry is blocked."
    : approved
      ? "Aggregate portfolio exposure remains within the configured cap."
      : "The proposed order would exceed the configured aggregate exposure cap.";
  return {
    existingExposureUsd: round(safeExisting),
    proposedExposureUsd: round(safeProposed),
    aggregateExposureUsd: round(aggregateExposureUsd),
    exposureCapUsd: round(exposureCapUsd),
    remainingExposureUsd: round(remainingExposureUsd),
    approved,
    reason,
  };
};

export const normalizeLiveRiskConfig = (input: Partial<LiveRiskConfig> | null | undefined): LiveRiskConfig => {
  const allowed = Array.isArray(input?.allowedDurations)
    ? input.allowedDurations.filter((value): value is Horizon => value === "5m" || value === "15m")
    : DEFAULT_LIVE_RISK.allowedDurations;
  return {
    ...normalizeEarlyExitPolicy(input, DEFAULT_LIVE_EARLY_EXIT),
    unitBalancePct: clamp(finite(input?.unitBalancePct, DEFAULT_LIVE_RISK.unitBalancePct), 0.0025, 0.05),
    unitsPerTrade: clamp(finite(input?.unitsPerTrade, DEFAULT_LIVE_RISK.unitsPerTrade), 0.25, 5),
    kellyFraction: clamp(finite(input?.kellyFraction, DEFAULT_LIVE_RISK.kellyFraction), 0.05, 0.5),
    maxTradeUsd: clamp(finite(input?.maxTradeUsd, DEFAULT_LIVE_RISK.maxTradeUsd), 1, 500),
    maxExposurePct: clamp(finite(input?.maxExposurePct, DEFAULT_LIVE_RISK.maxExposurePct), 0.01, 0.25),
    minEdge: clamp(finite(input?.minEdge, DEFAULT_LIVE_RISK.minEdge), 0.01, 0.25),
    feeRate: clamp(finite(input?.feeRate, DEFAULT_LIVE_RISK.feeRate), 0, 0.1),
    slippageBps: clamp(finite(input?.slippageBps, DEFAULT_LIVE_RISK.slippageBps), 0, 100),
    allowedDurations: allowed.length ? allowed : DEFAULT_LIVE_RISK.allowedDurations,
    requireLock: input?.requireLock ?? DEFAULT_LIVE_RISK.requireLock,
  };
};

/**
 * Server-side live limits. The browser may tighten these settings, but it cannot
 * weaken the minimum edge, maximum size, portfolio cap, execution price buffer,
 * or repeated-confirmation requirements enforced by the live route.
 */
export const enforceLiveExecutionRisk = (input: Partial<LiveRiskConfig> | null | undefined): LiveRiskConfig => {
  const risk = normalizeLiveRiskConfig(input);
  return {
    ...risk,
    unitBalancePct: Math.min(risk.unitBalancePct, 0.01),
    unitsPerTrade: Math.min(risk.unitsPerTrade, 1),
    kellyFraction: Math.min(risk.kellyFraction, 0.25),
    maxTradeUsd: Math.min(risk.maxTradeUsd, 5),
    maxExposurePct: Math.min(risk.maxExposurePct, 0.1),
    minEdge: Math.max(risk.minEdge, 0.04),
    feeRate: Math.max(risk.feeRate, 0.05),
    slippageBps: Math.min(risk.slippageBps, 25),
    // The terminal trader and the web route apply the same edge floor; LOCK is
    // an optional extra filter the operator can require, not a hidden override.
    requireLock: risk.requireLock,
    earlyExitMinProfitUsd: Math.max(risk.earlyExitMinProfitUsd, DEFAULT_LIVE_RISK.earlyExitMinProfitUsd),
    earlyExitMinProfitPct: Math.max(risk.earlyExitMinProfitPct, DEFAULT_LIVE_RISK.earlyExitMinProfitPct),
    earlyExitModelGap: Math.max(risk.earlyExitModelGap, DEFAULT_LIVE_RISK.earlyExitModelGap),
    earlyExitMinRemainingSeconds: Math.max(risk.earlyExitMinRemainingSeconds, DEFAULT_LIVE_RISK.earlyExitMinRemainingSeconds),
    earlyExitConfirmations: Math.max(risk.earlyExitConfirmations, DEFAULT_LIVE_RISK.earlyExitConfirmations),
    earlyExitTakeProfitPct: risk.earlyExitTakeProfitPct,
    // Zero keeps the fixed stop-loss off; a configured stop-loss is kept between 5% and 50%.
    earlyExitStopLossPct: risk.earlyExitStopLossPct <= 0 ? 0 : Math.min(Math.max(risk.earlyExitStopLossPct, 0.05), 0.5),
    earlyExitStopLossMinRemainingSeconds: Math.max(5,
      Math.min(risk.earlyExitStopLossMinRemainingSeconds, 30)),
  };
};

/** A $1 micro-account unit supports the venue minimum while keeping entries small. */
export const liveUnitUsd = (balance: number, config: LiveRiskConfig): number => {
  const safeBalance = Math.max(0, finite(balance, 0));
  const percentUnit = safeBalance <= 100 ? Math.min(1, safeBalance * 0.05) : safeBalance * config.unitBalancePct;
  return Math.min(percentUnit, config.maxTradeUsd, safeBalance * config.maxExposurePct, safeBalance);
};

export const computeKellySizing = (
  probability: number,
  allInCostPerShare: number,
  balance: number,
  config: LiveRiskConfig,
): KellySizing => {
  const safeBalance = Math.max(0, finite(balance, 0));
  const safeProbability = clamp(finite(probability, 0), 0, 1);
  // Callers supply the already walked, fee-inclusive, slippage-adjusted cost.
  // Applying config costs again here double-counted execution costs and made
  // the Kelly stake disagree with the net edge shown by the signal engine.
  const safeEntry = clamp(finite(allInCostPerShare, 1), 0.001, 0.999);
  const effectivePrice = safeEntry;
  const fullKelly = Math.max(0, (safeProbability - effectivePrice) / (1 - effectivePrice));
  const kellyStakeUsd = safeBalance * fullKelly * config.kellyFraction;
  const baseUnitUsd = liveUnitUsd(safeBalance, config);
  const requestedStakeUsd = Math.min(baseUnitUsd * config.unitsPerTrade, config.maxTradeUsd);
  const exposureCapUsd = safeBalance * config.maxExposurePct;
  const stakeUsd = Math.max(0, Math.min(kellyStakeUsd, requestedStakeUsd, exposureCapUsd, safeBalance));
  const units = baseUnitUsd > 0 ? stakeUsd / baseUnitUsd : 0;
  const approved = safeBalance >= 1 && stakeUsd >= 1 && fullKelly > 0;
  const reason = safeBalance < 1
    ? "Available collateral is below the $1 minimum live stake."
    : fullKelly <= 0
      ? "Kelly allocation is zero because the cost-adjusted probability is not positive."
      : stakeUsd < 1
        ? "The capped Kelly allocation is below the $1 minimum live stake."
        : "Fractional Kelly, unit size, and exposure caps pass.";
  return {
    balance: round(safeBalance),
    entryPrice: round(safeEntry),
    effectivePrice: round(effectivePrice),
    probability: round(safeProbability),
    fullKelly: round(fullKelly, 6),
    kellyFraction: config.kellyFraction,
    kellyStakeUsd: round(kellyStakeUsd),
    baseUnitUsd: round(baseUnitUsd),
    requestedStakeUsd: round(requestedStakeUsd),
    exposureCapUsd: round(exposureCapUsd),
    stakeUsd: round(stakeUsd),
    units: round(units, 3),
    approved,
    reason,
  };
};
