import {
  replaceLiveMarketBook,
  synchronizedPolymarketTime,
  updateLiveMarketBookLevel,
  type BookLevel,
  type LiveMarket,
  type OrderBook,
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
 * How long a top-of-book mismatch may last before the book counts as drifted.
 * The venue splits one book change (a trade that clears several levels, say)
 * across frames about a millisecond apart, and each frame reports the top of
 * book after the whole change. Recorded live (Sep 25 2026, 8 tokens, 90 s):
 * 58 mismatches, every one healed by later frames within 2 ms, and the derived
 * book matched the venue's next full snapshot 212 times out of 214. Without a
 * grace window each of these threw away a correct book and fired a REST
 * refresh, hundreds of times a minute across the tracked markets.
 */
export const DRIFT_GRACE_MS = 250;

/** Tokens whose derived top of book disagreed with the venue, keyed to when the disagreement began (local ms). */
export type DriftSuspects = ReadonlyMap<string, number>;

/**
 * Apply stream events to the tracked markets. Returns the tokens whose derived
 * book disagreed with the venue's reported top of book: their books are
 * invalidated and the caller must fetch a fresh snapshot.
 *
 * With `driftSuspects`, a mismatch only invalidates the book once it has
 * lasted DRIFT_GRACE_MS; the caller keeps the returned `driftSuspects` for
 * its next call and sweeps quiet ones with expireDriftSuspects. Without it,
 * any mismatch invalidates at once.
 */
export const applyClobStreamEvents = (
  markets: ReadonlyMap<string, LiveMarket>,
  events: readonly ClobStreamEvent[],
  localNow = Date.now(),
  driftSuspects?: DriftSuspects,
): { markets: Map<string, LiveMarket>; desyncedTokens: Set<string>; touched: boolean; driftSuspects: Map<string, number> } => {
  const next = new Map(markets);
  const desyncedTokens = new Set<string>();
  const suspects = new Map(driftSuspects ?? []);
  const graceMs = driftSuspects ? DRIFT_GRACE_MS : 0;
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
        suspects.delete(event.tokenId);
        next.set(id, replaceLiveMarketBook(market, event.tokenId, event.bids, event.asks, event.timestamp ?? serverNow, event.hash, localNow));
        continue;
      }
      // An invalidated book (timestamp null) is only restored by a full snapshot.
      if (desyncedTokens.has(event.tokenId) || stale || (current && current.timestamp === null)) continue;
      if (event.kind === "quote") {
        // A best_bid_ask that agrees with the book is token-specific evidence
        // that the book is still current; one that disagrees may simply have
        // overtaken its price_change, so it is not treated as drift.
        if (current && current.timestamp !== null && quoteMatches(market, event.tokenId, event.bestBid, event.bestAsk)) {
          const confirmedAt = Math.max(current.timestamp, event.timestamp ?? serverNow);
          const book = { ...current, timestamp: confirmedAt };
          next.set(id, event.tokenId === market.upTokenId ? { ...market, upBook: book } : { ...market, downBook: book });
        }
        continue;
      }
      const updated = updateLiveMarketBookLevel(market, event.tokenId, event.side, event.price, event.size, localNow, event.timestamp ?? serverNow);
      if (lastCheckIndex.get(event.tokenId) !== index) {
        next.set(id, updated);
      } else if (quoteMatches(updated, event.tokenId, event.bestBid, event.bestAsk)) {
        suspects.delete(event.tokenId);
        next.set(id, updated);
      } else {
        const since = suspects.get(event.tokenId) ?? localNow;
        if (localNow - since >= graceMs) {
          suspects.delete(event.tokenId);
          desyncedTokens.add(event.tokenId);
          next.set(id, invalidateBook(updated, event.tokenId));
        } else {
          suspects.set(event.tokenId, since);
          next.set(id, updated);
        }
      }
    }
  });
  return { markets: next, desyncedTokens, touched, driftSuspects: suspects };
};

/**
 * Invalidate books whose mismatch has outlasted the grace window without a
 * later frame to confirm or clear it (a token that went quiet mid-change).
 */
export const expireDriftSuspects = (
  markets: ReadonlyMap<string, LiveMarket>,
  driftSuspects: DriftSuspects,
  localNow = Date.now(),
): { markets: Map<string, LiveMarket>; desyncedTokens: Set<string>; driftSuspects: Map<string, number> } => {
  const next = new Map(markets);
  const suspects = new Map(driftSuspects);
  const desyncedTokens = new Set<string>();
  for (const [tokenId, since] of driftSuspects) {
    if (localNow - since < DRIFT_GRACE_MS) continue;
    suspects.delete(tokenId);
    desyncedTokens.add(tokenId);
    for (const [id, market] of next) {
      if (market.upTokenId === tokenId || market.downTokenId === tokenId) next.set(id, invalidateBook(market, tokenId));
    }
  }
  return { markets: next, desyncedTokens, driftSuspects: suspects };
};

/**
 * Tokens whose book has had no token-specific evidence (snapshot, applied
 * change, or matching best bid/ask) for `maxAgeMs`, or was invalidated. A
 * healthy socket is not evidence for a quiet token: a missed frame for one
 * token would otherwise leave a stale price marked current. Callers refresh
 * these from REST snapshots.
 */
export const staleBookTokens = (
  markets: Iterable<LiveMarket>,
  tokens: ReadonlySet<string>,
  localNow = Date.now(),
  maxAgeMs = 5_000,
): string[] => {
  const serverNow = synchronizedPolymarketTime(localNow);
  const stale = new Set<string>();
  for (const market of markets) {
    for (const [tokenId, book] of [[market.upTokenId, market.upBook], [market.downTokenId, market.downBook]] as const) {
      if (!tokens.has(tokenId)) continue;
      if (!book || book.timestamp === null || serverNow - book.timestamp > maxAgeMs) stale.add(tokenId);
    }
  }
  return [...stale];
};

/** Apply a REST snapshot unless the stream already holds newer contents for that book. */
export const applyBookSnapshot = (market: LiveMarket, tokenId: string, snapshot: OrderBook, localNow = Date.now()): LiveMarket => {
  const current = tokenId === market.upTokenId ? market.upBook : tokenId === market.downTokenId ? market.downBook : null;
  if (tokenId !== market.upTokenId && tokenId !== market.downTokenId) return market;
  const currentSequence = current?.updatedAt ?? current?.timestamp ?? null;
  if (current && current.timestamp !== null && snapshot.timestamp !== null && currentSequence !== null && snapshot.timestamp < currentSequence) return market;
  const replaced = replaceLiveMarketBook(market, tokenId, snapshot.bids, snapshot.asks, snapshot.timestamp, snapshot.hash, localNow);
  const book = tokenId === replaced.upTokenId ? replaced.upBook : replaced.downBook;
  if (!book) return replaced;
  const withMeta = { ...book, tickSize: snapshot.tickSize ?? book.tickSize ?? null, minOrderSize: snapshot.minOrderSize ?? book.minOrderSize };
  return tokenId === replaced.upTokenId ? { ...replaced, upBook: withMeta } : { ...replaced, downBook: withMeta };
};

/** Keep stream evidence received while a full REST market refresh was in flight. */
export const preserveNewerStreamBooks = (fresh: LiveMarket, previous: LiveMarket | undefined, localNow = Date.now()): LiveMarket => {
  if (!previous) return fresh;
  let merged = fresh;
  for (const tokenId of [fresh.upTokenId, fresh.downTokenId]) {
    const prior = tokenId === previous.upTokenId ? previous.upBook : tokenId === previous.downTokenId ? previous.downBook : null;
    const snapshot = tokenId === fresh.upTokenId ? fresh.upBook : fresh.downBook;
    if (!prior || prior.timestamp === null || snapshot?.timestamp !== null
      && snapshot?.timestamp !== undefined && prior.timestamp <= snapshot.timestamp) continue;
    merged = replaceLiveMarketBook(merged, tokenId, prior.bids, prior.asks, prior.timestamp, prior.hash, localNow);
    const book = tokenId === merged.upTokenId ? merged.upBook : merged.downBook;
    if (book) {
      const withMeta = { ...book, tickSize: prior.tickSize ?? book.tickSize, minOrderSize: prior.minOrderSize ?? book.minOrderSize };
      merged = tokenId === merged.upTokenId ? { ...merged, upBook: withMeta } : { ...merged, downBook: withMeta };
    }
  }
  return merged;
};
