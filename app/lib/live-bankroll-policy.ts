import { bankrollProfile, type BankrollProfile } from "./bankroll-policy";

/** Live-only floor and minimum-order accommodation; paper bankroll tiers stay unchanged. */
export const liveBankrollProfile = (equityUsd: number, minimumEquityUsd = 10, smallAccountRiskPct = 0.15): BankrollProfile => {
  const profile = bankrollProfile(equityUsd);
  if (equityUsd > 100) return profile;
  return {
    ...profile,
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
