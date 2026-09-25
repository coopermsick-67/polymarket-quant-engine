import { bidLiquidationValue } from "./live-order-pricing";
import type { LiveMarket, MarketFeeSchedule, OrderBook } from "./polymarket-data";
import { openPositions, type WalletPosition } from "./wallet-positions";

/** The latest executable book for a held token, with its market's fee schedule when known. */
export type PositionBook = { book: OrderBook; feeSchedule?: MarketFeeSchedule };

/**
 * Liquidation equity: cash, plus what each open position would raise by
 * selling into its current bids after fees, plus the fixed value of resolved
 * positions awaiting redemption. A position without a fresh book is valued at
 * zero, never at the Data API's mark, so a thin or missing book cannot inflate
 * equity. Callers must load held positions' books before relying on the
 * figure, or a just-filled position reads as worthless.
 */
export const liquidationEquityUsd = (input: {
  balance: number;
  positions: readonly WalletPosition[];
  books: ReadonlyMap<string, PositionBook>;
  serverNow: number;
  fallbackFeeRate: number;
  maxBookAgeMs: number;
}): number => input.balance + input.positions.reduce((sum, position) => {
  if (position.settled) return sum + position.currentValueUsd;
  const entry = position.tokenID ? input.books.get(position.tokenID) : undefined;
  if (!entry || entry.book.timestamp === null || input.serverNow - entry.book.timestamp > input.maxBookAgeMs) return sum;
  return sum + bidLiquidationValue(entry.book.bids, position.size, entry.feeSchedule, input.fallbackFeeRate);
}, 0);

/** Held tokens with no book in the store; these must be fetched before equity is trusted. */
export const unmarkedHeldTokens = (positions: readonly WalletPosition[], books: ReadonlyMap<string, PositionBook>): string[] =>
  openPositions(positions).flatMap((position) => position.tokenID && !books.has(position.tokenID) ? [position.tokenID] : []);

/** Copy books for held tokens out of the scanned markets, and forget tokens no longer held. */
export const rememberHeldBooks = (books: Map<string, PositionBook>, positions: readonly WalletPosition[], markets: Iterable<LiveMarket>): void => {
  const held = new Set(openPositions(positions).flatMap((position) => position.tokenID ? [position.tokenID] : []));
  for (const market of markets) {
    if (held.has(market.upTokenId) && market.upBook) books.set(market.upTokenId, { book: market.upBook, feeSchedule: market.feeSchedule });
    if (held.has(market.downTokenId) && market.downBook) books.set(market.downTokenId, { book: market.downBook, feeSchedule: market.feeSchedule });
  }
  for (const token of [...books.keys()]) if (!held.has(token)) books.delete(token);
};
