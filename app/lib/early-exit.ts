// Early-exit policy settings. The decision itself is `evaluateExit` in
// signal.ts, which sells into the depth-walked bids net of the fee curve and
// compares against the same fair value used for entries.

import { clamp, finiteNumber } from "./num";

export type EarlyExitPolicy = {
  earlyExitEnabled: boolean;
  earlyExitMinProfitUsd: number;
  earlyExitMinProfitPct: number;
  /** Net bid must exceed model fair value by at least this many probability points. */
  earlyExitModelGap: number;
  earlyExitMinRemainingSeconds: number;
  earlyExitConfirmations: number;
};

export const DEFAULT_PAPER_EARLY_EXIT: EarlyExitPolicy = {
  earlyExitEnabled: true,
  earlyExitMinProfitUsd: 1,
  earlyExitMinProfitPct: 0.1,
  earlyExitModelGap: 0.03,
  earlyExitMinRemainingSeconds: 20,
  earlyExitConfirmations: 2,
};

export const DEFAULT_LIVE_EARLY_EXIT: EarlyExitPolicy = { ...DEFAULT_PAPER_EARLY_EXIT, earlyExitEnabled: false, earlyExitMinProfitUsd: 2 };

export const normalizeEarlyExitPolicy = (input: Partial<EarlyExitPolicy> | null | undefined, defaults: EarlyExitPolicy): EarlyExitPolicy => ({
  earlyExitEnabled: typeof input?.earlyExitEnabled === "boolean" ? input.earlyExitEnabled : defaults.earlyExitEnabled,
  earlyExitMinProfitUsd: clamp(finiteNumber(input?.earlyExitMinProfitUsd) ?? defaults.earlyExitMinProfitUsd, 0, 500),
  earlyExitMinProfitPct: clamp(finiteNumber(input?.earlyExitMinProfitPct) ?? defaults.earlyExitMinProfitPct, 0, 2),
  earlyExitModelGap: clamp(finiteNumber(input?.earlyExitModelGap) ?? defaults.earlyExitModelGap, 0.005, 0.25),
  earlyExitMinRemainingSeconds: Math.round(clamp(finiteNumber(input?.earlyExitMinRemainingSeconds) ?? defaults.earlyExitMinRemainingSeconds, 0, 600)),
  earlyExitConfirmations: Math.round(clamp(finiteNumber(input?.earlyExitConfirmations) ?? defaults.earlyExitConfirmations, 1, 5)),
});
