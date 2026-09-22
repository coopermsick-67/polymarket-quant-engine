export type EarlyExitPolicy = {
  earlyExitEnabled: boolean;
  earlyExitMinProfitUsd: number;
  earlyExitMinProfitPct: number;
  earlyExitModelGap: number;
  earlyExitMinRemainingSeconds: number;
  earlyExitConfirmations: number;
};

export const DEFAULT_PAPER_EARLY_EXIT: EarlyExitPolicy = {
  earlyExitEnabled: true,
  earlyExitMinProfitUsd: 1,
  earlyExitMinProfitPct: 0.1,
  earlyExitModelGap: 0.03,
  earlyExitMinRemainingSeconds: 30,
  earlyExitConfirmations: 2,
};

export const DEFAULT_LIVE_EARLY_EXIT: EarlyExitPolicy = {
  earlyExitEnabled: false,
  earlyExitMinProfitUsd: 2,
  earlyExitMinProfitPct: 0.1,
  earlyExitModelGap: 0.03,
  earlyExitMinRemainingSeconds: 30,
  earlyExitConfirmations: 2,
};

export type EarlyExitEvaluation = {
  shouldExit: boolean;
  reason: string;
  currentPrice: number;
  fairProbability: number;
  modelGap: number;
  netProfit: number;
  profitPct: number;
  entryCost: number;
  exitFee: number;
};

const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 6) => Number(value.toFixed(digits));

export const normalizeEarlyExitPolicy = (
  input: Partial<EarlyExitPolicy> | null | undefined,
  defaults: EarlyExitPolicy,
): EarlyExitPolicy => ({
  earlyExitEnabled: input?.earlyExitEnabled ?? defaults.earlyExitEnabled,
  earlyExitMinProfitUsd: clamp(finite(input?.earlyExitMinProfitUsd, defaults.earlyExitMinProfitUsd), 0, 500),
  earlyExitMinProfitPct: clamp(finite(input?.earlyExitMinProfitPct, defaults.earlyExitMinProfitPct), 0, 2),
  earlyExitModelGap: clamp(finite(input?.earlyExitModelGap, defaults.earlyExitModelGap), 0.005, 0.25),
  earlyExitMinRemainingSeconds: clamp(Math.round(finite(input?.earlyExitMinRemainingSeconds, defaults.earlyExitMinRemainingSeconds)), 0, 600),
  earlyExitConfirmations: clamp(Math.round(finite(input?.earlyExitConfirmations, defaults.earlyExitConfirmations)), 1, 5),
});

export const evaluateModelAwareExit = (input: {
  policy: EarlyExitPolicy;
  entryPrice: number;
  currentPrice: number;
  fairProbability: number;
  shares: number;
  feeRate: number;
  remainingSeconds: number;
}): EarlyExitEvaluation => {
  const entryPrice = clamp(finite(input.entryPrice, 0), 0, 1);
  const currentPrice = clamp(finite(input.currentPrice, 0), 0, 1);
  const fairProbability = clamp(finite(input.fairProbability, 0), 0, 1);
  const shares = Math.max(0, finite(input.shares, 0));
  const feeRate = Math.max(0, finite(input.feeRate, 0));
  const entryCost = entryPrice * shares;
  const exitFee = currentPrice * shares * feeRate;
  const netProfit = (currentPrice - entryPrice) * shares - exitFee;
  const profitPct = entryCost > 0 ? netProfit / entryCost : 0;
  const modelGap = currentPrice - fairProbability;
  const rounded = {
    currentPrice: round(currentPrice),
    fairProbability: round(fairProbability),
    modelGap: round(modelGap),
    netProfit: round(netProfit, 4),
    profitPct: round(profitPct),
    entryCost: round(entryCost, 4),
    exitFee: round(exitFee, 4),
  };

  if (!input.policy.earlyExitEnabled) return { shouldExit: false, reason: "Model-aware early exits are disabled.", ...rounded };
  if (shares <= 0 || entryPrice <= 0 || currentPrice <= 0) return { shouldExit: false, reason: "Position pricing or size is unavailable.", ...rounded };
  if (input.remainingSeconds < input.policy.earlyExitMinRemainingSeconds) return { shouldExit: false, reason: "Too little time remains for an early exit decision.", ...rounded };
  if (modelGap < input.policy.earlyExitModelGap) return { shouldExit: false, reason: "The current bid is not sufficiently above the model fair probability.", ...rounded };
  if (netProfit < input.policy.earlyExitMinProfitUsd) return { shouldExit: false, reason: "The modeled cashout profit is below the configured dollar threshold.", ...rounded };
  if (profitPct < input.policy.earlyExitMinProfitPct) return { shouldExit: false, reason: "The modeled cashout profit is below the configured percentage threshold.", ...rounded };

  return {
    shouldExit: true,
    reason: `Cash out: ${round(netProfit, 2).toFixed(2)} net profit with the bid ${round(modelGap * 100, 1).toFixed(1)}¢ above model fair value.`,
    ...rounded,
  };
};
