import type { PaperSide } from "./engines";

/** A paper FAK order waiting out its simulated latency. */
export type PendingPaperOrder = { marketId: string; side: PaperSide; stakeUsd: number; maxPrice: number; submittedAt: number; reason: string };

type RestartState = { pendingPaperOrder?: PendingPaperOrder | null; lastEntryByMarket: Record<string, number> };

/**
 * On restart a persisted pending paper order is cancelled, never filled: the
 * book it would have met during its latency window is unknowable. The market's
 * entry clock is reset so it is not immediately resubmitted.
 */
export const cancelPendingPaperOrderOnRestart = <T extends RestartState>(state: T, now: number): { state: T; cancelled: PendingPaperOrder | null } => {
  const cancelled = state.pendingPaperOrder ?? null;
  if (!cancelled) return { state, cancelled: null };
  return {
    cancelled,
    state: { ...state, pendingPaperOrder: null, lastEntryByMarket: { ...state.lastEntryByMarket, [cancelled.marketId]: now } },
  };
};
