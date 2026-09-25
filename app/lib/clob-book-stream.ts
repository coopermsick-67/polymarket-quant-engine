import {
  replaceLiveMarketBook,
  synchronizedPolymarketTime,
  updateLiveMarketBookLevel,
  type BookLevel,
  type LiveMarket,
} from "./polymarket-data";

/** Normalized CLOB market-channel event. */
export type ClobStreamEvent =
  | { kind: "book"; tokenId: string; bids: BookLevel[]; asks: BookLevel[]; timestamp: number | null; hash: string | null }
  | { kind: "level"; tokenId: string; side: "BUY" | "SELL"; price: number; size: number; bestBid?: number | null; bestAsk?: number | null; timestamp: number | null }
  | { kind: "quote"; tokenId: string; bestBid?: number | null; bestAsk?: number | null; timestamp: number | null };

const epochMs = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
};

const optionalPrice = (value: unknown): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

export const parseBookLevels = (value: unknown): BookLevel[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const level = raw as { price?: unknown; size?: unknown };
    const price = Number(level.price);
    const size = Number(level.size);
    return Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0 ? [{ price, size }] : [];
  });
};

/** Parse one websocket frame (a single event or an array of events). */
export const parseClobStreamMessage = (data: unknown): ClobStreamEvent[] => {
  const text = String(data);
  if (!text || text === "PONG") return [];
  let packet: unknown;
  try { packet = JSON.parse(text); } catch { return []; }
  const rawEvents = Array.isArray(packet) ? packet : [packet];
  const events: ClobStreamEvent[] = [];
  for (const rawEvent of rawEvents) {
    if (!rawEvent || typeof rawEvent !== "object") continue;
    const wrapper = rawEvent as Record<string, unknown>;
    const event = wrapper.payload && typeof wrapper.payload === "object"
      ? { ...(wrapper.payload as Record<string, unknown>), event_type: wrapper.type }
      : wrapper;
    const kind = event.event_type ?? event.type;
    const timestamp = epochMs(event.timestamp);
    if (kind === "book") {
      const tokenId = String(event.asset_id ?? event.token_id ?? event.tokenId ?? "");
      if (!tokenId) continue;
      events.push({ kind: "book", tokenId, bids: parseBookLevels(event.bids), asks: parseBookLevels(event.asks), timestamp,
        hash: typeof event.hash === "string" && event.hash ? event.hash : null });
      continue;
    }
    if (kind === "price_change") {
      const changes = event.price_changes ?? event.priceChanges;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        if (!change || typeof change !== "object") continue;
        const update = change as Record<string, unknown>;
        const tokenId = String(update.asset_id ?? update.token_id ?? update.tokenId ?? "");
        const price = Number(update.price);
        const size = Number(update.size);
        if (!tokenId || (update.side !== "BUY" && update.side !== "SELL") || !Number.isFinite(price) || !Number.isFinite(size)) continue;
        events.push({ kind: "level", tokenId, side: update.side, price, size, timestamp,
          bestBid: optionalPrice(update.best_bid ?? update.bestBid), bestAsk: optionalPrice(update.best_ask ?? update.bestAsk) });
      }
      continue;
    }
    if (kind === "best_bid_ask") {
      const tokenId = String(event.asset_id ?? event.token_id ?? "");
      if (!tokenId) continue;
      events.push({ kind: "quote", tokenId, timestamp, bestBid: optionalPrice(event.best_bid ?? event.bestBid),
        bestAsk: optionalPrice(event.best_ask ?? event.bestAsk) });
    }
  }
  return events;
};

const bestOf = (levels: BookLevel[], side: "bid" | "ask"): number | null => levels.length
  ? side === "bid" ? Math.max(...levels.map((level) => level.price)) : Math.min(...levels.map((level) => level.price))
  : null;

/** The venue's own best bid/ask must match the book we derived; otherwise an update was missed. */
const quoteMatches = (market: LiveMarket, tokenId: string, bestBid: number | null | undefined, bestAsk: number | null | undefined): boolean => {
  const book = tokenId === market.upTokenId ? market.upBook : tokenId === market.downTokenId ? market.downBook : null;
  if (!book) return true;
  // The venue reports an empty side as best_bid "0" and best_ask "1".
  const same = (expected: number | null | undefined, derived: number | null, side: "bid" | "ask") => {
    if (expected === undefined) return true;
    const empty = expected === null || (side === "bid" ? expected <= 0 : expected >= 1);
    return empty ? derived === null : derived !== null && Math.abs(expected - derived) < 1e-9;
  };
  return same(bestBid, bestOf(book.bids, "bid"), "bid") && same(bestAsk, bestOf(book.asks, "ask"), "ask");
};

/** Mark one side's book unusable until a fresh snapshot arrives. */
export const invalidateBook = (market: LiveMarket, tokenId: string): LiveMarket => {
  if (tokenId === market.upTokenId && market.upBook) return { ...market, upBook: { ...market.upBook, timestamp: null } };
  if (tokenId === market.downTokenId && market.downBook) return { ...market, downBook: { ...market.downBook, timestamp: null } };
  return market;
};

/**
 * Apply stream events to the tracked markets. Returns the tokens whose derived
 * book disagreed with the venue's reported top of book: their books are
 * invalidated and the caller must fetch a fresh snapshot.
 */
export const applyClobStreamEvents = (
  markets: ReadonlyMap<string, LiveMarket>,
  events: readonly ClobStreamEvent[],
  localNow = Date.now(),
): { markets: Map<string, LiveMarket>; desyncedTokens: Set<string>; touched: boolean } => {
  const next = new Map(markets);
  const desyncedTokens = new Set<string>();
  let touched = false;
  const serverNow = synchronizedPolymarketTime(localNow);
  // A frame can carry several level changes for one token; the reported top
  // of book is compared once, after the token's last change in the frame.
  const lastCheckIndex = new Map<string, number>();
  // Only level changes carry a post-change top of book. Separate best_bid_ask
  // events can arrive before the price_change they summarize (seen live), so
  // they are not a reliable checksum and are not compared.
  events.forEach((event, index) => { if (event.kind === "level") lastCheckIndex.set(event.tokenId, index); });
  events.forEach((event, index) => {
    for (const [id, market] of next) {
      if (market.upTokenId !== event.tokenId && market.downTokenId !== event.tokenId) continue;
      touched = true;
      const current = event.tokenId === market.upTokenId ? market.upBook : market.downBook;
      const currentSequence = current?.updatedAt ?? current?.timestamp ?? null;
      // Frames are not strictly ordered against REST snapshots: anything older
      // than the contents we already hold would roll the book backwards.
      const stale = event.timestamp !== null && currentSequence !== null && event.timestamp < currentSequence;
      if (event.kind === "book") {
        if (stale && current?.timestamp !== null) continue;
        desyncedTokens.delete(event.tokenId);
        next.set(id, replaceLiveMarketBook(market, event.tokenId, event.bids, event.asks, event.timestamp ?? serverNow, event.hash, localNow));
        continue;
      }
      // An invalidated book (timestamp null) is only restored by a full snapshot.
      if (desyncedTokens.has(event.tokenId) || stale || (current && current.timestamp === null)) continue;
      const updated = event.kind === "level"
        ? updateLiveMarketBookLevel(market, event.tokenId, event.side, event.price, event.size, localNow, event.timestamp ?? serverNow)
        : market;
      if (lastCheckIndex.get(event.tokenId) === index && !quoteMatches(updated, event.tokenId, event.bestBid, event.bestAsk)) {
        desyncedTokens.add(event.tokenId);
        next.set(id, invalidateBook(updated, event.tokenId));
      } else {
        next.set(id, updated);
      }
    }
  });
  return { markets: next, desyncedTokens, touched };
};

/**
 * While the stream is connected and in sync, an unchanged book is still the
 * current book: re-stamp it so quiet markets stay executable. Books that were
 * invalidated (timestamp null) are left alone until a snapshot repairs them.
 */
export const confirmStreamedBooks = (
  markets: ReadonlyMap<string, LiveMarket>,
  streamedTokens: ReadonlySet<string>,
  localNow = Date.now(),
): Map<string, LiveMarket> => {
  const serverNow = synchronizedPolymarketTime(localNow);
  const next = new Map<string, LiveMarket>();
  for (const [id, market] of markets) {
    const confirm = (book: LiveMarket["upBook"], tokenId: string) =>
      book && book.timestamp !== null && streamedTokens.has(tokenId) && book.timestamp < serverNow ? { ...book, timestamp: serverNow } : book;
    const upBook = confirm(market.upBook, market.upTokenId);
    const downBook = confirm(market.downBook, market.downTokenId);
    next.set(id, upBook === market.upBook && downBook === market.downBook ? market : { ...market, upBook, downBook });
  }
  return next;
};
