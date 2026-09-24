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
