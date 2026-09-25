import { bankrollProfile, type BankrollProfile } from "./bankroll-policy";

export type LiveBankrollProfile = BankrollProfile & {
  microScoreMinimum: number;
  smallBiasConfidenceMinimum: number;
};

/** Live-only floor and minimum-order accommodation; paper bankroll tiers stay unchanged. */
export const liveBankrollProfile = (equityUsd: number, minimumEquityUsd = 10, smallAccountRiskPct = 0.15,
  duration: "5m" | "15m" = "5m"): LiveBankrollProfile => {
  const profile = bankrollProfile(equityUsd);
  const relaxed: LiveBankrollProfile = {
    ...profile,
    // Moderate live-only threshold reductions: the required net edge stays at
    // or above the engine's 4% floor, and the paper profiles remain unchanged.
    minNetEdge: Math.max(0.04, profile.minNetEdge * 0.75),
    maxSpreadPct: Math.min(0.05, profile.maxSpreadPct + 0.01),
    minRemainingSeconds: Math.min(profile.minRemainingSeconds, duration === "5m" ? 30 : 60),
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
