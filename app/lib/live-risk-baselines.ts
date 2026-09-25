export type RiskBaselines = { riskDayKey: string | null; riskDayStartEquityUsd: number | null; peakLiquidationEquityUsd: number | null };

/**
 * The daily-loss baseline rolls at UTC midnight; the peak used for drawdown
 * does not. Resetting the peak every day let a drawdown vanish overnight.
 */
export const updateRiskBaselines = (state: RiskBaselines, equityUsd: number, now: number) => {
  if (!Number.isFinite(equityUsd) || equityUsd < 0) return;
  const dayKey = new Date(now).toISOString().slice(0, 10);
  if (state.riskDayKey !== dayKey || !state.riskDayStartEquityUsd || state.riskDayStartEquityUsd <= 0) {
    state.riskDayKey = dayKey;
    state.riskDayStartEquityUsd = Math.max(1, equityUsd);
  }
  state.peakLiquidationEquityUsd = Math.max(state.peakLiquidationEquityUsd ?? 0, 1, equityUsd);
};
