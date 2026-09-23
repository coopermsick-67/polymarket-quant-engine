// Live risk policy: sizing, portfolio limits, and account-state parsing. Pure
// functions so the server route and the tests share them.

import { DEFAULT_LIVE_EARLY_EXIT, normalizeEarlyExitPolicy, type EarlyExitPolicy } from "./early-exit";
import { clamp, finiteNumber, round } from "./num";
import { DEFAULT_SIGNAL_PARAMS, normalizeSignalParams, type Horizon, type Side, type SignalParams } from "./signal";

export type LiveRiskConfig = EarlyExitPolicy & {
  signal: SignalParams;
  unitBalancePct: number;
  unitsPerTrade: number;
  kellyFraction: number;
  maxTradeUsd: number;
  /** Cap on total open cost basis as a share of equity. */
  maxOpenExposurePct: number;
  /** Positions allowed in the same window on the same side (crypto is highly correlated). */
  maxSameWindowSameSide: number;
  /** Halt new entries once equity is down this much from the trading-day open. */
  dailyLossPct: number;
  /** Never take more than this share of the depth available under the limit price. */
  maxDepthFraction: number;
  maxOrdersPerMinute: number;
  allowedDurations: Horizon[];
  allowedAssets: string[];
  requireLock: boolean;
};

export const DEFAULT_LIVE_RISK: LiveRiskConfig = {
  ...DEFAULT_LIVE_EARLY_EXIT,
  signal: { ...DEFAULT_SIGNAL_PARAMS, minEdge: 0.04, modelWeight: 0.5 },
  unitBalancePct: 0.01,
  unitsPerTrade: 1,
  kellyFraction: 0.25,
  maxTradeUsd: 25,
  maxOpenExposurePct: 0.2,
  maxSameWindowSameSide: 2,
  dailyLossPct: 0.05,
  maxDepthFraction: 0.5,
  maxOrdersPerMinute: 6,
  allowedDurations: ["5m", "15m"],
  allowedAssets: ["BTC", "ETH", "SOL", "XRP"],
  requireLock: true,
};

const num = (value: unknown, fallback: number, min: number, max: number) => clamp(finiteNumber(value) ?? fallback, min, max);

export const normalizeLiveRiskConfig = (input: Partial<LiveRiskConfig> | null | undefined): LiveRiskConfig => {
  const d = DEFAULT_LIVE_RISK;
  const durations = Array.isArray(input?.allowedDurations)
    ? input.allowedDurations.filter((value): value is Horizon => value === "5m" || value === "15m")
    : d.allowedDurations;
  const assets = Array.isArray(input?.allowedAssets)
    ? input.allowedAssets.filter((value): value is string => typeof value === "string" && /^[A-Z0-9]{2,10}$/.test(value))
    : d.allowedAssets;
  return {
    ...normalizeEarlyExitPolicy(input, DEFAULT_LIVE_EARLY_EXIT),
    signal: normalizeSignalParams({ ...d.signal, ...(input?.signal ?? {}) }),
    unitBalancePct: num(input?.unitBalancePct, d.unitBalancePct, 0.0025, 0.05),
    unitsPerTrade: num(input?.unitsPerTrade, d.unitsPerTrade, 0.25, 5),
    kellyFraction: num(input?.kellyFraction, d.kellyFraction, 0.05, 0.5),
    maxTradeUsd: num(input?.maxTradeUsd, d.maxTradeUsd, 1, 500),
    maxOpenExposurePct: num(input?.maxOpenExposurePct, d.maxOpenExposurePct, 0.01, 0.5),
    maxSameWindowSameSide: Math.round(num(input?.maxSameWindowSameSide, d.maxSameWindowSameSide, 1, 8)),
    dailyLossPct: num(input?.dailyLossPct, d.dailyLossPct, 0.005, 0.5),
    maxDepthFraction: num(input?.maxDepthFraction, d.maxDepthFraction, 0.05, 1),
    maxOrdersPerMinute: Math.round(num(input?.maxOrdersPerMinute, d.maxOrdersPerMinute, 1, 60)),
    allowedDurations: durations.length ? durations : d.allowedDurations,
    allowedAssets: assets.length ? assets : d.allowedAssets,
    requireLock: typeof input?.requireLock === "boolean" ? input.requireLock : d.requireLock,
  };
};

export type KellySizing = {
  balance: number;
  probability: number;
  costPerShare: number;
  fullKelly: number;
  kellyStakeUsd: number;
  unitCapUsd: number;
  depthCapUsd: number;
  stakeUsd: number;
  approved: boolean;
  reason: string;
};

/**
 * Binary-contract Kelly on the all-in cost per share c (price + slippage + fee):
 * f* = (p - c) / (1 - c). Capped by fractional Kelly, unit size, max trade,
 * the depth available under the limit, and the balance.
 */
export const computeKellySizing = (
  probability: number,
  costPerShare: number,
  balance: number,
  depthNotionalUnderLimit: number,
  config: LiveRiskConfig,
): KellySizing => {
  const safeBalance = Math.max(0, finiteNumber(balance) ?? 0);
  const p = clamp(finiteNumber(probability) ?? 0, 0, 1);
  const c = clamp(finiteNumber(costPerShare) ?? 1, 0.001, 0.999);
  const fullKelly = Math.max(0, (p - c) / (1 - c));
  const kellyStakeUsd = safeBalance * fullKelly * config.kellyFraction;
  const unitCapUsd = Math.min(safeBalance * config.unitBalancePct * config.unitsPerTrade, config.maxTradeUsd);
  const depthCapUsd = Math.max(0, depthNotionalUnderLimit) * config.maxDepthFraction;
  const stakeUsd = round(Math.max(0, Math.min(kellyStakeUsd, unitCapUsd, depthCapUsd, safeBalance)), 2);
  const approved = safeBalance >= 1 && fullKelly > 0 && stakeUsd >= 1;
  const reason =
    safeBalance < 1
      ? "Available collateral is below the $1 minimum."
      : fullKelly <= 0
        ? "Kelly is zero: the all-in cost is not below the probability."
        : stakeUsd < 1
          ? "Capped stake is below the $1 minimum (Kelly, unit, or depth cap)."
          : "Fractional Kelly, unit, depth, and balance caps pass.";
  return {
    balance: round(safeBalance, 4),
    probability: round(p, 6),
    costPerShare: round(c, 6),
    fullKelly: round(fullKelly, 6),
    kellyStakeUsd: round(kellyStakeUsd, 4),
    unitCapUsd: round(unitCapUsd, 4),
    depthCapUsd: round(depthCapUsd, 4),
    stakeUsd,
    approved,
    reason,
  };
};

/**
 * CLOB collateral balances are integer micro-USDC strings (6 decimals). A value
 * with a decimal point is already in dollars. No magnitude guessing.
 */
export const parseCollateralBalance = (value: unknown): number | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) / 1_000_000;
    if (/^\d*\.\d+$/.test(trimmed)) return Number(trimmed);
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Number.isInteger(value) ? value / 1_000_000 : value;
  return null;
};

export type LivePosition = {
  tokenId: string | null;
  conditionId: string | null;
  slug: string | null;
  title: string;
  outcome: string;
  size: number;
  averagePrice: number | null;
  initialValue: number | null;
  currentValue: number | null;
  /** Parsed from `<asset>-updown-<5m|15m>-<start>` slugs. */
  endTime: number | null;
  side: Side | null;
};

const SLUG = /^[a-z0-9]+-updown-(5m|15m)-(\d{10})$/;

export const parseLivePosition = (source: Record<string, unknown>): LivePosition | null => {
  const text = (key: string) => (typeof source[key] === "string" ? (source[key] as string).trim() : "") || null;
  const size = finiteNumber(source.size ?? source.current_size ?? source.total_size);
  if (size === null || size <= 0) return null;
  const slug = text("slug") ?? text("eventSlug");
  const match = slug?.toLowerCase().match(SLUG);
  const outcome = text("outcome") ?? "";
  return {
    tokenId: text("asset") ?? text("asset_id") ?? text("token_id"),
    conditionId: text("conditionId") ?? text("condition_id"),
    slug,
    title: text("title") ?? "Untitled market",
    outcome,
    size,
    averagePrice: finiteNumber(source.avgPrice ?? source.avg_price),
    initialValue: finiteNumber(source.initialValue),
    currentValue: finiteNumber(source.currentValue),
    endTime: match ? Number(match[2]) * 1000 + (match[1] === "5m" ? 300_000 : 900_000) : null,
    side: /^up$/i.test(outcome) ? "UP" : /^down$/i.test(outcome) ? "DOWN" : null,
  };
};

export type DayState = { dayKey: string; startEquity: number; orders: { key: string; at: number }[] };

export const equityOf = (balance: number, positions: LivePosition[]) =>
  balance + positions.reduce((sum, position) => sum + (position.currentValue ?? (position.averagePrice ?? 0) * position.size), 0);

/** Every portfolio-level check that must pass before a new live entry. */
export const checkPortfolioRisk = (input: {
  config: LiveRiskConfig;
  positions: LivePosition[];
  balance: number;
  day: DayState;
  now: number;
  candidate: { conditionId: string | null; tokenIds: string[]; endTime: number; side: Side; stakeUsd: number; requestKey: string };
}): { approved: boolean; reason: string } => {
  const { config, positions, candidate } = input;
  const equity = equityOf(input.balance, positions);
  if (input.day.startEquity > 0 && (equity - input.day.startEquity) / input.day.startEquity <= -config.dailyLossPct) {
    return { approved: false, reason: `Daily loss limit hit: equity ${equity.toFixed(2)} vs ${input.day.startEquity.toFixed(2)} at the day open.` };
  }
  if (input.day.orders.some((order) => order.key === candidate.requestKey))
    return { approved: false, reason: "Duplicate request id; this order was already attempted." };
  const lastMinute = input.day.orders.filter((order) => input.now - order.at < 60_000).length;
  if (lastMinute >= config.maxOrdersPerMinute) return { approved: false, reason: `Order rate limit: ${lastMinute} orders in the last minute.` };
  const held = positions.some(
    (position) =>
      (position.tokenId && candidate.tokenIds.includes(position.tokenId)) || (candidate.conditionId && position.conditionId === candidate.conditionId),
  );
  if (held) return { approved: false, reason: "A position in this market already exists." };
  const openCost = positions
    .filter((position) => position.endTime === null || position.endTime > input.now)
    .reduce((sum, position) => sum + (position.initialValue ?? (position.averagePrice ?? 0) * position.size), 0);
  if (openCost + candidate.stakeUsd > equity * config.maxOpenExposurePct) {
    return {
      approved: false,
      reason: `Open exposure ${(openCost + candidate.stakeUsd).toFixed(2)} would exceed ${(config.maxOpenExposurePct * 100).toFixed(0)}% of equity.`,
    };
  }
  const correlated = positions.filter(
    (position) => position.endTime !== null && Math.abs(position.endTime - candidate.endTime) < 1_000 && position.side === candidate.side,
  ).length;
  if (correlated >= config.maxSameWindowSameSide)
    return { approved: false, reason: `Already ${correlated} ${candidate.side} position(s) settling in this window.` };
  return { approved: true, reason: "Portfolio limits pass." };
};
