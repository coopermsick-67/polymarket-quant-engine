import { bankrollProfile, type BankrollProfile } from "./bankroll-policy";

export type LiveBankrollProfile = BankrollProfile & {
  microScoreMinimum: number;
  smallBiasConfidenceMinimum: number;
};

export const LIVE_MIN_EXPECTED_PROFIT_USD = 0.05;
/**
 * Smallest probability uncertainty the sizing layer subtracts from an edge
 * (0.02 + 0.04 x the engine's 0.35 base model uncertainty, see paper-bankroll).
 */
export const MIN_SIZING_UNCERTAINTY = 0.034;

/**
 * The per-stake profit floor may not be stricter than the tier's own edge
 * floor: a trade exactly at the minimum net edge and the tier's highest entry
 * price must be able to pass. Otherwise the two gates contradict each other
 * and the tier can never trade.
 */
const coherentProfitOnStakePct = (profile: BankrollProfile, minNetEdge: number) =>
  Math.min(profile.minExpectedProfitOnStakePct, Math.max(0, minNetEdge - MIN_SIZING_UNCERTAINTY) / profile.maxEntryPrice);

/** Live-only floor and minimum-order accommodation; paper bankroll tiers stay unchanged. */
export const liveBankrollProfile = (equityUsd: number, minimumEquityUsd = 10, smallAccountRiskPct = 0.15,
  duration: "5m" | "15m" = "5m"): LiveBankrollProfile => {
  const profile = bankrollProfile(equityUsd);
  // Moderate live-only threshold reductions: the required net edge stays at
  // or above the engine's 4% floor, and the paper profiles remain unchanged.
  const minNetEdge = Math.max(0.04, profile.minNetEdge * 0.75);
  const relaxed: LiveBankrollProfile = {
    ...profile,
    minNetEdge,
    minExpectedProfitOnStakePct: coherentProfitOnStakePct(profile, minNetEdge),
    maxSpreadPct: Math.min(0.05, profile.maxSpreadPct + 0.01),
    minRemainingSeconds: Math.min(profile.minRemainingSeconds, duration === "5m" ? 30 : 60),
    // Live orders are capped at a few dollars, so a paper tier's dollar profit
    // floor (up to $0.40) was unreachable at any edge; the per-stake floor
    // still applies. The dollar floor only screens out dust trades live.
    minExpectedProfitUsd: Math.min(profile.minExpectedProfitUsd, LIVE_MIN_EXPECTED_PROFIT_USD),
    microScoreMinimum: 0.35,
    smallBiasConfidenceMinimum: 0.54,
  };
  if (equityUsd > 100) return relaxed;
  return {
    ...relaxed,
    minEquityUsd: minimumEquityUsd,
    eligible: Number.isFinite(equityUsd) && equityUsd >= minimumEquityUsd,
    maxStakePct: smallAccountRiskPct,
    maxExposurePct: smallAccountRiskPct,
    maxCorrelatedExposurePct: smallAccountRiskPct,
    maxDailyLossPct: smallAccountRiskPct,
    maxPeakDrawdownPct: smallAccountRiskPct,
    maxDepthShare: 0.5,
  };
};
