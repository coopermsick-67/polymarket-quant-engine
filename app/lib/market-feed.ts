// Framework-agnostic market data controller. The browser hook and the headless
// Node runner both use this class, so there is exactly one implementation of
// discovery, book maintenance, settlement-feed capture, and resolution polling.
//
// Sources:
//   Gamma (REST)            market discovery and official resolutions
//   CLOB  (REST + WS)       order books; WS deltas are checked against the
//                           best bid/ask the server reports and resynced on drift
//   RTDS  (WS)              Chainlink TWAP stream (settlement) + Binance prices
//   Coinbase (WS)           primary exchange feed for the underlying
//   crypto-price (REST)     official price to beat, via an injected fetcher

import { deriveFeed, emptyFeed, pushTick, type AssetFeed, type DerivedFeed } from "./feeds";
import {
  buildLiveMarket,
  chainlinkSymbol,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  fetchResolutions,
  officialKey,
  replaceLiveMarketBook,
  updateLiveMarketBookLevel,
  withReference,
  type CandleHistory,
  type LiveMarket,
  type MarketDefinition,
  type OfficialPrice,
  type Resolution,
} from "./polymarket-data";

type SocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
type SocketFactory = new (url: string) => SocketLike;

export type ReferenceRequest = { key: string; asset: string; startTime: number; duration: "5m" | "15m" };
export type ReferenceFetcher = (requests: ReferenceRequest[]) => Promise<Map<string, OfficialPrice>>;

export type FeedStatus = {
  clob: "CONNECTING" | "LIVE" | "DOWN";
  rtds: "CONNECTING" | "LIVE" | "DOWN";
  coinbase: "CONNECTING" | "LIVE" | "DOWN";
  lastRestAt: number | null;
  lastMessageAt: number | null;
  lastError: string;
  bookResyncs: number;
  messages: number;
  discovered: number;
};

export type FeedControllerOptions = {
  referenceFetcher: ReferenceFetcher;
  WebSocketImpl?: SocketFactory;
  restIntervalMs?: number;
  notifyIntervalMs?: number;
  onChange?: () => void;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** Optional raw message tap for exact session replay. */
  onRaw?: (source: "clob" | "rtds" | "coinbase", data: string, receivedAt: number) => void;
};

const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const RTDS_WS = "wss://ws-live-data.polymarket.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";
const OPEN = 1;

export class MarketFeedController {
  definitions = new Map<string, MarketDefinition>();
  markets = new Map<string, LiveMarket>();
  feeds = new Map<string, AssetFeed>();
  official = new Map<string, OfficialPrice>();
  recordedOpens = new Map<string, number>();
  candles = new Map<string, CandleHistory>();
  resolutions = new Map<string, Resolution>();
  status: FeedStatus = {
    clob: "CONNECTING",
    rtds: "CONNECTING",
    coinbase: "CONNECTING",
    lastRestAt: null,
    lastMessageAt: null,
    lastError: "",
    bookResyncs: 0,
    messages: 0,
    discovered: 0,
  };
  version = 0;

  private options: Required<Omit<FeedControllerOptions, "onChange" | "onLog" | "onRaw" | "WebSocketImpl">> & FeedControllerOptions;
  private sockets: { clob: SocketLike | null; rtds: SocketLike | null; coinbase: SocketLike | null } = { clob: null, rtds: null, coinbase: null };
  private timers: ReturnType<typeof setInterval>[] = [];
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = true;
  private dirty = false;
  private refreshing = false;
  private subscribedTokens = "";
  private subscribedAssets = "";
  private watchedResolutions = new Set<string>();
  private resyncQueue = new Set<string>();
  private backoff = { clob: 1_000, rtds: 1_000, coinbase: 1_000 };
  private derivedCache = new Map<string, { at: number; value: DerivedFeed }>();

  constructor(options: FeedControllerOptions) {
    this.options = { restIntervalMs: 15_000, notifyIntervalMs: 250, ...options };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh();
    this.timers.push(setInterval(() => void this.refresh(), this.options.restIntervalMs));
    this.timers.push(setInterval(() => void this.pollResolutions(), 20_000));
    this.timers.push(setInterval(() => void this.resyncBooks(), 2_000));
    this.timers.push(setInterval(() => this.flush(), this.options.notifyIntervalMs));
    this.timers.push(setInterval(() => this.watchdog(), 5_000));
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.timers = [];
    this.retryTimers.clear();
    for (const key of ["clob", "rtds", "coinbase"] as const) {
      this.sockets[key]?.close();
      this.sockets[key] = null;
    }
  }

  /** Mark markets whose official outcome consumers are waiting on. */
  watchResolution(marketIds: Iterable<string>) {
    for (const id of marketIds) if (!this.resolutions.has(id)) this.watchedResolutions.add(id);
  }

  derived(asset: string, now = Date.now()): DerivedFeed {
    const cached = this.derivedCache.get(asset);
    if (cached && now - cached.at < 200) return cached.value;
    const value = deriveFeed(this.feeds.get(asset) ?? emptyFeed(asset), now, { lookbackSeconds: 60, candles: this.candles.get(asset)?.fiveMinute ?? null });
    this.derivedCache.set(asset, { at: now, value });
    return value;
  }

  /** Replace the log sink (lets React hooks update it from an effect). */
  setLogger(onLog: FeedControllerOptions["onLog"]) {
    this.options.onLog = onLog;
  }

  private log(level: "info" | "warn" | "error", message: string) {
    this.options.onLog?.(level, message);
  }

  private touch() {
    this.dirty = true;
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.version += 1;
    this.options.onChange?.();
  }

  private feed(asset: string) {
    let feed = this.feeds.get(asset);
    if (!feed) {
      feed = emptyFeed(asset);
      this.feeds.set(asset, feed);
    }
    return feed;
  }

  async refresh() {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const definitions = await discoverCryptoMarkets();
      const now = Date.now();
      this.status.discovered = definitions.length;
      for (const definition of definitions) this.definitions.set(definition.id, definition);
      for (const [id, definition] of this.definitions) if (definition.endTime < now - 10 * 60_000) this.definitions.delete(id);
      const live = [...this.definitions.values()].filter((definition) => definition.endTime > now - 60_000);
      const tokenIds = live.flatMap((definition) => [definition.upTokenId, definition.downTokenId]);
      const assets = [...new Set(live.map((definition) => definition.asset))];
      const started = live.filter((definition) => definition.startTime <= now);
      const referenceRequests = started
        .filter((definition) => {
          const known = this.official.get(officialKey(definition));
          return !known || known.openPrice === null || (definition.endTime <= now && !known.completed);
        })
        .map((definition) => ({ key: officialKey(definition), asset: definition.asset, startTime: definition.startTime, duration: definition.duration }));
      const uniqueRequests = [...new Map(referenceRequests.map((request) => [request.key, request])).values()];
      // Books, candles, and references fail independently; markets are built from whatever arrived.
      const [booksResult, candlesResult, referencesResult] = await Promise.allSettled([
        fetchOrderBooks(tokenIds),
        fetchCandleHistories(assets),
        uniqueRequests.length ? this.options.referenceFetcher(uniqueRequests) : Promise.resolve(new Map<string, OfficialPrice>()),
      ]);
      const books = booksResult.status === "fulfilled" ? booksResult.value : new Map();
      const candles = candlesResult.status === "fulfilled" ? candlesResult.value : new Map<string, CandleHistory>();
      const references = referencesResult.status === "fulfilled" ? referencesResult.value : new Map<string, OfficialPrice>();
      if (booksResult.status === "rejected") this.log("warn", "Order-book snapshot failed; relying on the WebSocket stream.");
      for (const [asset, history] of candles) this.candles.set(asset, history);
      for (const [key, price] of references) this.official.set(key, price);
      const context = { books, official: this.official, recordedOpens: this.recordedOpens, candles: this.candles };
      const next = new Map<string, LiveMarket>();
      for (const definition of live) next.set(definition.id, buildLiveMarket(definition, context, now, this.markets.get(definition.id) ?? null));
      this.markets = next;
      this.status.lastRestAt = now;
      this.status.lastError = "";
      this.ensureSockets(tokenIds, assets);
      this.touch();
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : "Public data refresh failed.";
      this.log("warn", this.status.lastError);
      this.touch();
    } finally {
      this.refreshing = false;
    }
  }

  private async pollResolutions() {
    const now = Date.now();
    const due = [...this.watchedResolutions].filter((id) => {
      const definition = this.definitions.get(id) ?? this.markets.get(id);
      return !definition || definition.endTime <= now - 5_000;
    });
    if (!due.length) return;
    try {
      const resolved = await fetchResolutions(due.slice(0, 120));
      for (const [id, resolution] of resolved) {
        this.resolutions.set(id, resolution);
        this.watchedResolutions.delete(id);
      }
      if (resolved.size) this.touch();
    } catch (error) {
      this.log("warn", `Resolution poll failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  private async resyncBooks() {
    if (!this.resyncQueue.size) return;
    const tokens = [...this.resyncQueue];
    this.resyncQueue.clear();
    try {
      const books = await fetchOrderBooks(tokens);
      const now = Date.now();
      for (const [id, market] of this.markets) {
        let updated = market;
        for (const [tokenId, book] of books) updated = replaceLiveMarketBook(updated, tokenId, book.bids, book.asks, book.timestamp ?? now, book.hash, now);
        if (updated !== market) this.markets.set(id, updated);
      }
      this.status.bookResyncs += tokens.length;
      this.touch();
    } catch {
      for (const token of tokens) this.resyncQueue.add(token);
    }
  }

  private lastStreamAt: number | null = null;

  private watchdog() {
    const now = Date.now();
    if (this.sockets.rtds && this.lastStreamAt !== null && now - this.lastStreamAt > 15_000) {
      this.log("warn", "Chainlink stream silent for 15s; reconnecting RTDS.");
      this.lastStreamAt = now;
      this.sockets.rtds.close();
    }
    if (this.status.lastMessageAt !== null && now - this.status.lastMessageAt > 30_000 && this.sockets.clob) {
      this.log("warn", "No market data for 30s; reconnecting the order-book stream.");
      this.sockets.clob.close();
    }
  }

  private schedule(fn: () => void, delay: number) {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (!this.stopped) fn();
    }, delay);
    this.retryTimers.add(timer);
  }

  private ensureSockets(tokenIds: string[], assets: string[]) {
    const tokenKey = [...new Set(tokenIds)].sort().join(",");
    const assetKey = [...new Set(assets)].sort().join(",");
    if (tokenKey && tokenKey !== this.subscribedTokens) {
      this.subscribedTokens = tokenKey;
      this.sockets.clob?.close();
      this.connectClob();
    }
    if (assetKey && assetKey !== this.subscribedAssets) {
      this.subscribedAssets = assetKey;
      this.sockets.coinbase?.close();
      this.connectCoinbase();
      if (!this.sockets.rtds) this.connectRtds();
    }
  }

  private open(
    kind: "clob" | "rtds" | "coinbase",
    url: string,
    onOpen: (socket: SocketLike) => void,
    onMessage: (data: string, now: number) => void,
    heartbeat?: string,
  ) {
    const Impl = this.options.WebSocketImpl ?? (globalThis.WebSocket as unknown as SocketFactory | undefined);
    if (!Impl || this.stopped) return;
    let socket: SocketLike;
    try {
      socket = new Impl(url);
    } catch {
      this.schedule(() => this.reopen(kind), this.backoff[kind]);
      return;
    }
    this.sockets[kind] = socket;
    let pinger: ReturnType<typeof setInterval> | null = null;
    socket.onopen = () => {
      this.status[kind] = "LIVE";
      this.backoff[kind] = 1_000;
      onOpen(socket);
      if (heartbeat) pinger = setInterval(() => socket.readyState === OPEN && socket.send(heartbeat), kind === "rtds" ? 5_000 : 10_000);
      this.touch();
    };
    socket.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      const now = Date.now();
      this.status.messages += 1;
      this.options.onRaw?.(kind, data, now);
      try {
        onMessage(data, now);
      } catch {
        /* malformed frames are ignored; REST resync covers gaps */
      }
    };
    socket.onclose = () => {
      if (pinger) clearInterval(pinger);
      if (this.sockets[kind] === socket) this.sockets[kind] = null;
      this.status[kind] = this.stopped ? "DOWN" : "CONNECTING";
      this.touch();
      if (!this.stopped) {
        const delay = this.backoff[kind] + Math.random() * 500;
        this.backoff[kind] = Math.min(15_000, this.backoff[kind] * 2);
        this.schedule(() => this.reopen(kind), delay);
      }
    };
    // Guard against re-entry: in Node's WebSocket, close() on a failing socket fires onerror again.
    let closing = false;
    socket.onerror = () => {
      if (closing) return;
      closing = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    };
  }

  private reopen(kind: "clob" | "rtds" | "coinbase") {
    if (this.sockets[kind]) return;
    if (kind === "clob") this.connectClob();
    else if (kind === "rtds") this.connectRtds();
    else this.connectCoinbase();
  }

  private connectClob() {
    const tokens = this.subscribedTokens ? this.subscribedTokens.split(",") : [];
    if (!tokens.length) return;
    this.open(
      "clob",
      CLOB_WS,
      (socket) => socket.send(JSON.stringify({ type: "market", assets_ids: tokens, custom_feature_enabled: true })),
      (data, now) => {
        if (data === "PONG") return;
        this.status.lastMessageAt = now;
        const packet = JSON.parse(data) as unknown;
        for (const raw of Array.isArray(packet) ? packet : [packet]) this.applyClobEvent(raw as Record<string, unknown>, now);
      },
      "PING",
    );
  }

  private applyClobEvent(event: Record<string, unknown>, now: number) {
    const kind = event.event_type ?? event.type;
    const levels = (value: unknown) =>
      Array.isArray(value)
        ? value.flatMap((level: { price?: unknown; size?: unknown }) => {
            const price = Number(level.price);
            const size = Number(level.size);
            return Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0 ? [{ price, size }] : [];
          })
        : [];
    const timestamp = Number(event.timestamp) || now;
    if (kind === "book") {
      const tokenId = String(event.asset_id ?? "");
      for (const [id, market] of this.markets) {
        if (market.upTokenId !== tokenId && market.downTokenId !== tokenId) continue;
        this.markets.set(
          id,
          replaceLiveMarketBook(market, tokenId, levels(event.bids), levels(event.asks), timestamp, typeof event.hash === "string" ? event.hash : null, now),
        );
      }
      this.touch();
      return;
    }
    if (kind === "price_change") {
      const changes = Array.isArray(event.price_changes) ? (event.price_changes as Record<string, unknown>[]) : [];
      const reported = new Map<string, { bid: number; ask: number }>();
      for (const change of changes) {
        const tokenId = String(change.asset_id ?? "");
        const price = Number(change.price);
        const size = Number(change.size);
        const side = change.side === "BUY" || change.side === "SELL" ? change.side : null;
        if (!side || !Number.isFinite(price) || !Number.isFinite(size)) continue;
        for (const [id, market] of this.markets) {
          if (market.upTokenId !== tokenId && market.downTokenId !== tokenId) continue;
          this.markets.set(id, updateLiveMarketBookLevel(market, tokenId, side, price, size, timestamp, now));
        }
        // The server reports its top of book after each change; the last report per token describes the whole batch.
        reported.set(tokenId, { bid: Number(change.best_bid), ask: Number(change.best_ask) });
      }
      for (const [tokenId, top] of reported) {
        const market = [...this.markets.values()].find((candidate) => candidate.upTokenId === tokenId || candidate.downTokenId === tokenId);
        const book = market ? (tokenId === market.upTokenId ? market.upBook : market.downBook) : null;
        if (!book) continue;
        const bidDrift = Number.isFinite(top.bid) && top.bid > 0 && Math.abs((book.bids[0]?.price ?? 0) - top.bid) > 1e-9;
        const askDrift = Number.isFinite(top.ask) && top.ask > 0 && top.ask < 1 && Math.abs((book.asks[0]?.price ?? 0) - top.ask) > 1e-9;
        if (bidDrift || askDrift) this.resyncQueue.add(tokenId);
      }
      this.touch();
      return;
    }
    if (kind === "tick_size_change") {
      const tokenId = String(event.asset_id ?? "");
      const tick = Number(event.new_tick_size);
      if (!(tick > 0)) return;
      for (const [id, market] of this.markets)
        if (market.upTokenId === tokenId || market.downTokenId === tokenId) this.markets.set(id, { ...market, tickSize: tick });
      this.touch();
    }
  }

  private connectRtds() {
    this.open(
      "rtds",
      RTDS_WS,
      (socket) =>
        socket.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [
              { topic: "crypto_prices_chainlink", type: "*", filters: "" },
              { topic: "crypto_prices", type: "update", filters: "" },
            ],
          }),
        ),
      (data) => {
        if (!data || data[0] !== "{") return;
        const message = JSON.parse(data) as { topic?: string; payload?: { symbol?: string; value?: number; timestamp?: number } };
        const symbol = message.payload?.symbol?.toLowerCase() ?? "";
        const value = Number(message.payload?.value);
        const timestamp = Number(message.payload?.timestamp);
        if (!(value > 0) || !Number.isFinite(timestamp)) return;
        if (message.topic === "crypto_prices_chainlink" && symbol.endsWith("/usd")) {
          const asset = symbol.slice(0, -4).toUpperCase();
          const feed = this.feed(asset);
          feed.stream = pushTick(feed.stream, { timestamp, price: value }, undefined, 0);
          this.lastStreamAt = Date.now();
          if (timestamp % 300_000 === 0) this.recordOpen(asset, timestamp, value);
          this.derivedCache.delete(asset);
          this.touch();
        } else if (message.topic === "crypto_prices" && symbol.endsWith("usdt")) {
          const asset = symbol.slice(0, -4).toUpperCase();
          const feed = this.feed(asset);
          feed.exchangeAlt = pushTick(feed.exchangeAlt, { timestamp, price: value });
          this.derivedCache.delete(asset);
          this.touch();
        }
      },
      "PING",
    );
  }

  /** The stream value printed at a window boundary is exactly that window's official open. */
  private recordOpen(asset: string, timestamp: number, value: number) {
    const key = `${asset}:${timestamp}`;
    if (this.recordedOpens.has(key)) return;
    this.recordedOpens.set(key, value);
    if (this.recordedOpens.size > 2_000) for (const stale of [...this.recordedOpens.keys()].slice(0, 500)) this.recordedOpens.delete(stale);
    for (const [id, market] of this.markets) if (market.asset === asset && market.startTime === timestamp) this.markets.set(id, withReference(market, value));
  }

  private connectCoinbase() {
    const assets = this.subscribedAssets ? this.subscribedAssets.split(",") : [];
    if (!assets.length) return;
    this.open(
      "coinbase",
      COINBASE_WS,
      (socket) => socket.send(JSON.stringify({ type: "subscribe", product_ids: assets.map((asset) => `${asset}-USD`), channels: ["ticker"] })),
      (data, now) => {
        const tick = JSON.parse(data) as { type?: string; product_id?: string; price?: string; time?: string };
        if (tick.type !== "ticker" || !tick.product_id || !tick.price) return;
        const asset = tick.product_id.replace(/-USD$/, "");
        const price = Number(tick.price);
        const timestamp = tick.time ? Date.parse(tick.time) : now;
        if (!(price > 0)) return;
        const feed = this.feed(asset);
        feed.exchange = pushTick(feed.exchange, { timestamp: Number.isFinite(timestamp) ? timestamp : now, price });
        this.derivedCache.delete(asset);
        this.touch();
      },
    );
  }
}

export { chainlinkSymbol };
