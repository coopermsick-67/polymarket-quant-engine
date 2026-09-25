export type FakFillResult = { status: "FULL" | "PARTIAL" | "NO_FILL" | "UNCERTAIN"; filledShares: number };

const classifyFakFill = (requestedShares: number, walletFilledShares: number, accepted: boolean): FakFillResult => {
  if (!Number.isFinite(requestedShares) || requestedShares <= 0 || !Number.isFinite(walletFilledShares) || walletFilledShares < 0) {
    return { status: "UNCERTAIN", filledShares: 0 };
  }
  if (walletFilledShares <= 1e-6) return { status: accepted ? "UNCERTAIN" : "NO_FILL", filledShares: 0 };
  return {
    status: walletFilledShares + 1e-6 >= requestedShares ? "FULL" : "PARTIAL",
    filledShares: walletFilledShares,
  };
};

/** Position deltas are authoritative; CLOB acceptance alone is never treated as a fill. */
export const reconcileFakBuyFill = (input: {
  requestedShares: number;
  walletPositionDelta: number;
  responseShares: number;
  accepted: boolean;
}): FakFillResult => {
  const { requestedShares, walletPositionDelta, responseShares, accepted } = input;
  if (!Number.isFinite(responseShares) || responseShares < 0) return { status: "UNCERTAIN", filledShares: 0 };
  if (responseShares > 1e-6 && walletPositionDelta > 1e-6
    && Math.abs(responseShares - walletPositionDelta) > Math.max(0.05, walletPositionDelta * 0.02)) {
    return { status: "UNCERTAIN", filledShares: walletPositionDelta };
  }
  return classifyFakFill(requestedShares, walletPositionDelta, accepted);
};

/** A sell response's takingAmount is cash, so reconcile sold quantity from wallet shares. */
export const reconcileFakSellFill = (input: {
  requestedShares: number;
  walletSharesSold: number;
  accepted: boolean;
}): FakFillResult => classifyFakFill(input.requestedShares, input.walletSharesSold, input.accepted);

/**
 * Prefer the CLOB's own record of the order (`size_matched` from getOrder):
 * it is final as soon as the FAK completes, while the Data API wallet view can
 * lag by several seconds. The wallet view is still a cross-check: seeing more
 * shares than the order matched means something else traded, so the result is
 * UNCERTAIN. Without a CLOB record, fall back to the wallet-only rules.
 */
export const reconcileFakWithOrderStatus = (input: {
  side: "BUY" | "SELL";
  requestedShares: number;
  clobMatchedShares: number | null;
  walletShares: number;
  responseShares: number;
  accepted: boolean;
}): FakFillResult & { source: "CLOB" | "WALLET" } => {
  const { requestedShares, clobMatchedShares, walletShares } = input;
  if (clobMatchedShares !== null && Number.isFinite(clobMatchedShares) && clobMatchedShares >= 0
    && Number.isFinite(requestedShares) && requestedShares > 0) {
    const tolerance = Math.max(0.05, clobMatchedShares * 0.02);
    if (Number.isFinite(walletShares) && walletShares > clobMatchedShares + tolerance) {
      return { status: "UNCERTAIN", filledShares: walletShares, source: "CLOB" };
    }
    if (clobMatchedShares <= 1e-6) return { status: "NO_FILL", filledShares: 0, source: "CLOB" };
    return {
      status: clobMatchedShares + 1e-6 >= requestedShares ? "FULL" : "PARTIAL",
      filledShares: clobMatchedShares,
      source: "CLOB",
    };
  }
  const fallback = input.side === "BUY"
    ? reconcileFakBuyFill({ requestedShares, walletPositionDelta: walletShares, responseShares: input.responseShares, accepted: input.accepted })
    : reconcileFakSellFill({ requestedShares, walletSharesSold: walletShares, accepted: input.accepted });
  return { ...fallback, source: "WALLET" };
};
