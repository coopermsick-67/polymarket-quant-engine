/**
 * Durable order state for the terminal live trader.
 *
 * An order is SUBMITTING from just before it is posted until the CLOB response
 * is recorded. If the process dies in that window the outcome is unknown, and a
 * restart must halt for manual reconciliation. Once the CLOB has returned an
 * order ID the order is SETTLING: a CLOB match is not final (trades move
 * MATCHED -> MINED -> CONFIRMED, and can be RETRYING or FAILED), and the Data
 * API wallet view can lag. The order stays reserved, blocking new orders and
 * counting its worst-case cost as exposure, until every trade is terminal and
 * the wallet shows the confirmed quantity. A restart resumes that
 * reconciliation instead of halting.
 */
export type OrderPhase = "SUBMITTING" | "SETTLING";

export type JournalOrder = {
  requestId: string;
  marketId: string;
  tokenID: string;
  action: "BUY" | "SELL";
  requestedShares: number;
  limitPrice: number;
  /** Worst-case cash committed by a BUY (price plus fee); zero for a SELL. */
  reservedUsd: number;
  /** Wallet size of this token immediately before submission. */
  baselineShares: number;
  phase: OrderPhase;
  submittedAt: number;
  orderID?: string;
  tradeIds?: string[];
};

export type TradeObservation = { id: string; status: string; size: number };

export type SettlementDecision =
  | { kind: "SETTLED"; filledShares: number; failedShares: number }
  | { kind: "WAIT"; reason: string }
  | { kind: "HALT"; reason: string };

/** How long an order may stay unreconciled before the trader stops for a human. */
export const MAX_SETTLEMENT_WAIT_MS = 10 * 60_000;
const SHARE_TOLERANCE = 0.01;
export const settlementTimedOut = (order: JournalOrder, now: number) => now - order.submittedAt > MAX_SETTLEMENT_WAIT_MS;

const TERMINAL_SUCCESS = new Set(["CONFIRMED"]);
const TERMINAL_FAILURE = new Set(["FAILED"]);

export const isValidJournalOrder = (value: unknown): value is JournalOrder => {
  if (!value || typeof value !== "object") return false;
  const order = value as Partial<JournalOrder>;
  return typeof order.requestId === "string" && typeof order.marketId === "string" && typeof order.tokenID === "string"
    && (order.action === "BUY" || order.action === "SELL") && (order.phase === "SUBMITTING" || order.phase === "SETTLING")
    && [order.requestedShares, order.limitPrice, order.reservedUsd, order.baselineShares, order.submittedAt]
      .every((entry) => typeof entry === "number" && Number.isFinite(entry))
    && (order.phase !== "SETTLING" || typeof order.orderID === "string");
};

/** What the wallet shows as filled for this order: shares gained (BUY) or shed (SELL) since submission. */
export const walletFilledShares = (order: JournalOrder, walletShares: number) =>
  Math.max(0, order.action === "BUY" ? walletShares - order.baselineShares : order.baselineShares - walletShares);

/**
 * Decide whether a SETTLING order has reached a final, reconciled state.
 * `matchedShares` is the CLOB order's size_matched; `trades` are its
 * associated trades with their current status.
 */
export const decideSettlement = (input: {
  order: JournalOrder;
  matchedShares: number | null;
  orderStillOpen: boolean;
  trades: readonly TradeObservation[];
  walletShares: number;
  now: number;
}): SettlementDecision => {
  const { order, matchedShares, trades } = input;
  const walletFilled = walletFilledShares(order, input.walletShares);
  const wait = (reason: string): SettlementDecision => settlementTimedOut(order, input.now)
    ? { kind: "HALT", reason: `Order ${order.orderID ?? order.requestId} has not reconciled within ${MAX_SETTLEMENT_WAIT_MS / 60_000} minutes: ${reason}` }
    : { kind: "WAIT", reason };
  if (matchedShares === null) return wait("The CLOB order record is not readable yet.");
  if (input.orderStillOpen) return wait("A FAK remainder is still reported open.");
  if (matchedShares <= SHARE_TOLERANCE) {
    if (walletFilled > SHARE_TOLERANCE) return { kind: "HALT", reason: "The wallet moved although the CLOB reports no match; something else traded this token." };
    return { kind: "SETTLED", filledShares: 0, failedShares: 0 };
  }
  const tradedShares = trades.reduce((sum, trade) => sum + trade.size, 0);
  if (trades.length === 0 || tradedShares + SHARE_TOLERANCE < matchedShares) {
    return wait("The order's trades are not all visible yet.");
  }
  const unknown = trades.filter((trade) => !TERMINAL_SUCCESS.has(trade.status.toUpperCase()) && !TERMINAL_FAILURE.has(trade.status.toUpperCase()));
  if (unknown.length) return wait(`Trades still settling: ${unknown.map((trade) => trade.status).join(", ")}.`);
  const confirmed = trades.filter((trade) => TERMINAL_SUCCESS.has(trade.status.toUpperCase())).reduce((sum, trade) => sum + trade.size, 0);
  const failed = trades.filter((trade) => TERMINAL_FAILURE.has(trade.status.toUpperCase())).reduce((sum, trade) => sum + trade.size, 0);
  if (walletFilled > confirmed + Math.max(SHARE_TOLERANCE, confirmed * 0.02)) {
    return { kind: "HALT", reason: "The wallet shows more shares than the order's confirmed trades; something else traded this token." };
  }
  if (walletFilled + Math.max(SHARE_TOLERANCE, confirmed * 0.02) < confirmed) {
    return wait("Trades are confirmed but the wallet view has not caught up yet.");
  }
  return { kind: "SETTLED", filledShares: confirmed, failedShares: failed };
};

/** Cash an in-flight order must be assumed to use when sizing anything else. */
export const reservedExposureUsd = (order: JournalOrder | null) => order && order.action === "BUY" ? order.reservedUsd : 0;
