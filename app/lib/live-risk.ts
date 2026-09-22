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
  requireLock: true,
};

const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

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

export const computeKellySizing = (
  probability: number,
  entryPrice: number,
  balance: number,
  config: LiveRiskConfig,
): KellySizing => {
  const safeBalance = Math.max(0, finite(balance, 0));
  const safeProbability = clamp(finite(probability, 0), 0, 1);
  const safeEntry = clamp(finite(entryPrice, 1), 0.001, 0.999);
  const executionMultiplier = (1 + config.slippageBps / 10_000) * (1 + config.feeRate);
  const effectivePrice = clamp(safeEntry * executionMultiplier, 0.001, 0.999);
  const fullKelly = Math.max(0, (safeProbability - effectivePrice) / (1 - effectivePrice));
  const kellyStakeUsd = safeBalance * fullKelly * config.kellyFraction;
  const baseUnitUsd = safeBalance * config.unitBalancePct;
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
