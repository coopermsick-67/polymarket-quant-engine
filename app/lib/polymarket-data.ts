// Market discovery, order books, official references, resolutions, and
// exchange candles. Everything a signal needs is carried on `LiveMarket`, and
// `snapshotFromLiveMarket` converts it into the pure `MarketSnapshot` the
// decision function consumes.

import { z } from "zod";
import { clamp, epochMs, finiteNumber, jsonArray, text } from "./num";
import type { DerivedFeed } from "./feeds";
import { DEFAULT_FEE_SCHEDULE, type Candle, type FeeSchedule, type PriceTick } from "./pricing";
import type { BookLevel, Horizon, MarketSnapshot, ReferenceSource, Side } from "./signal";

export type { BookLevel, Horizon } from "./signal";
export type Asset = string;
export type MarketCandle = Candle;
export type MarketPriceTick = PriceTick;

export type OrderBook = {
  tokenId: string;
  /** Sorted best (highest) first. */
  bids: BookLevel[];
  /** Sorted best (lowest) first. */
  asks: BookLevel[];
  timestamp: number | null;
  minOrderSize: number | null;
  tickSize: number | null;
  hash: string | null;
};

export type CandleHistory = { fiveMinute: MarketCandle[]; fifteenMinute: MarketCandle[]; updatedAt: number };

export type MarketDefinition = {
  id: string;
  conditionId: string | null;
  slug: string;
  question: string;
  asset: Asset;
  duration: Horizon;
  startTime: number;
  endTime: number;
  upTokenId: string;
  downTokenId: string;
  sourceUrl: string;
  twapLookbackSeconds: number;
  feeSchedule: FeeSchedule;
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
};

export type OfficialPrice = { openPrice: number | null; closePrice: number | null; completed: boolean; fetchedAt: number };

export type LiveMarket = MarketDefinition & {
  remaining: number;
  reference: number | null;
  referenceSource: ReferenceSource;
  officialClose: number | null;
  upBook: OrderBook | null;
  downBook: OrderBook | null;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  spread: number | null;
  liquidity: number;
  imbalance: number | null;
  sourceTimestamp: number;
  chart5m: MarketCandle[];
  chart15m: MarketCandle[];
  chartUpdatedAt: number | null;
};

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const EXCHANGE_API = "https://api.exchange.coinbase.com/products";
export const OFFICIAL_PRICE_API = "https://polymarket.com/api/crypto/crypto-price";
const CRYPTO_TAG_ID = "21";
const GAMMA_PAGE_SIZE = 100;
const GAMMA_MAX_PAGES = 12;
const GAMMA_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;
const DISCOVERY_CACHE_MS = 15_000;
const POLYMARKET_TIME_CACHE_MS = 15_000;
const PUBLIC_REQUEST_TIMEOUT_MS = 12_000;
const CLOB_BATCH_SIZE = 100;
const CANDLE_CACHE_MS = 60_000;
const CANDLE_LOOKBACK_BARS = 100;

let polymarketClockOffsetMs = 0;
let polymarketClockSyncedAt = 0;
const candleHistoryCache = new Map<Asset, CandleHistory>();

// ---------------------------------------------------------------------------
// Payload schemas. Gamma is loose, so parse only the fields the engine uses and
// reject rows that are missing the ones it cannot trade without.

const numberish = z.union([z.number(), z.string()]).transform((value, context) => {
  const parsed = finiteNumber(value);
  if (parsed === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "not a number" });
    return z.NEVER;
  }
  return parsed;
});

const feeScheduleSchema = z
  .object({ rate: numberish, exponent: numberish, takerOnly: z.boolean().optional(), rebateRate: numberish.optional() })
  .transform((value): FeeSchedule => ({ rate: value.rate, exponent: value.exponent, takerOnly: value.takerOnly ?? true, rebateRate: value.rebateRate ?? 0 }));

const cryptoConfigSchema = z
  .object({
    asset: z.string().optional(),
    duration: z.string().optional(),
    twapEnabled: z.boolean().optional(),
    twapLookbackSeconds: numberish.optional(),
  })
  .passthrough();

export const gammaMarketSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    conditionId: z.string().nullish(),
    slug: z.string(),
    question: z.string().nullish(),
    clobTokenIds: z.unknown(),
    outcomes: z.unknown(),
    outcomePrices: z.unknown().optional(),
    endDate: z.string().nullish(),
    eventStartTime: z.string().nullish(),
    active: z.boolean().nullish(),
    closed: z.boolean().nullish(),
    archived: z.boolean().nullish(),
    acceptingOrders: z.boolean().nullish(),
    negRisk: z.boolean().nullish(),
    orderPriceMinTickSize: numberish.nullish(),
    orderMinSize: numberish.nullish(),
    feeSchedule: z.unknown().optional(),
    cryptoMarketConfig: z.unknown().optional(),
  })
  .passthrough();

export type GammaMarket = z.infer<typeof gammaMarketSchema>;

export const officialPriceSchema = z
  .object({
    openPrice: numberish.nullish(),
    closePrice: numberish.nullish(),
    completed: z.boolean().nullish(),
  })
  .passthrough();

// ---------------------------------------------------------------------------

const assetAliases: Record<string, Asset> = {
  btc: "BTC",
  bitcoin: "BTC",
  eth: "ETH",
  ethereum: "ETH",
  sol: "SOL",
  solana: "SOL",
  xrp: "XRP",
  ripple: "XRP",
  doge: "DOGE",
  dogecoin: "DOGE",
  bnb: "BNB",
  hype: "HYPE",
  hyperliquid: "HYPE",
  zec: "ZEC",
  zcash: "ZEC",
};

const SLUG_PATTERN = /^([a-z0-9]+)-updown-(5m|15m)-(\d{10})$/;

/** Parse one Gamma row into a tradable 5m/15m Up/Down market, or null. */
export const normalizeMarket = (raw: unknown, now = Date.now()): MarketDefinition | null => {
  const parsed = gammaMarketSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  const slugMatch = row.slug.toLowerCase().match(SLUG_PATTERN);
  if (!slugMatch) return null;
  const asset = assetAliases[slugMatch[1]] ?? slugMatch[1].toUpperCase();
  const duration = slugMatch[2] as Horizon;
  const durationMs = duration === "5m" ? 300_000 : 900_000;
  const slugStart = Number(slugMatch[3]) * 1000;
  const endTime = epochMs(row.endDate) ?? slugStart + durationMs;
  if (!(endTime > now)) return null;
  const eventStart = epochMs(row.eventStartTime);
  const startTime = eventStart !== null && Math.abs(eventStart - (endTime - durationMs)) <= 15_000 ? eventStart : endTime - durationMs;
  if (row.active === false || row.closed === true || row.archived === true) return null;

  const outcomes = jsonArray(row.outcomes).map((outcome) => outcome.toLowerCase());
  const tokenIds = jsonArray(row.clobTokenIds);
  if (tokenIds.length < 2 || outcomes.length !== tokenIds.length) return null;
  const upIndex = outcomes.findIndex((outcome) => outcome === "up");
  const downIndex = outcomes.findIndex((outcome) => outcome === "down");
  if (upIndex < 0 || downIndex < 0) return null;
  const upTokenId = tokenIds[upIndex];
  const downTokenId = tokenIds[downIndex];
  if (!upTokenId || !downTokenId || upTokenId === downTokenId) return null;

  const config = cryptoConfigSchema.safeParse(row.cryptoMarketConfig);
  const twapLookbackSeconds = config.success && config.data.twapEnabled ? clamp(config.data.twapLookbackSeconds ?? 60, 0, 3_600) : 0;
  const fee = feeScheduleSchema.safeParse(row.feeSchedule);

  return {
    id: row.id,
    conditionId: row.conditionId ?? null,
    slug: row.slug,
    question: row.question || row.slug,
    asset,
    duration,
    startTime,
    endTime,
    upTokenId,
    downTokenId,
    sourceUrl: `https://polymarket.com/event/${row.slug}`,
    twapLookbackSeconds,
    feeSchedule: fee.success ? fee.data : DEFAULT_FEE_SCHEDULE,
    tickSize: row.orderPriceMinTickSize && row.orderPriceMinTickSize > 0 ? row.orderPriceMinTickSize : 0.01,
    minOrderSize: row.orderMinSize && row.orderMinSize > 0 ? row.orderMinSize : 5,
    negRisk: row.negRisk === true,
  };
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const fetchJson = async <T>(url: string, init?: RequestInit, fetcher: Fetcher = fetch): Promise<T> => {
  const timeoutController = new AbortController();
  const timeoutId = globalThis.setTimeout(() => timeoutController.abort(), PUBLIC_REQUEST_TIMEOUT_MS);
  const upstreamSignal = init?.signal;
  const abortRequest = () => timeoutController.abort();
  if (upstreamSignal?.aborted) timeoutController.abort();
  else upstreamSignal?.addEventListener("abort", abortRequest, { once: true });
  try {
    const response = await fetcher(url, { ...init, cache: "no-store", signal: timeoutController.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${new URL(url).hostname}`);
    return (await response.json()) as T;
  } catch (error) {
    if (timeoutController.signal.aborted && !upstreamSignal?.aborted) throw new Error(`Public request timed out after ${PUBLIC_REQUEST_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortRequest);
  }
};

export const polymarketNow = () => Date.now() + polymarketClockOffsetMs;
export const polymarketClockOffset = () => polymarketClockOffsetMs;

const syncPolymarketClock = async (signal?: AbortSignal): Promise<number> => {
  if (Date.now() - polymarketClockSyncedAt < POLYMARKET_TIME_CACHE_MS) return polymarketNow();
  try {
    const sentAt = Date.now();
    const payload = await fetchJson<unknown>(`${CLOB_API}/time`, { signal });
    const serverTime = epochMs(payload);
    if (serverTime !== null) {
      // Assume symmetric latency: the server stamped halfway through the round trip.
      polymarketClockOffsetMs = serverTime + (Date.now() - sentAt) / 2 - Date.now();
      polymarketClockSyncedAt = Date.now();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return polymarketNow();
};

const fetchCryptoMarketRows = async (signal?: AbortSignal): Promise<{ rows: unknown[]; now: number }> => {
  const rows: unknown[] = [];
  let afterCursor: string | null = null;
  const now = await syncPolymarketClock(signal);
  for (let page = 0; page < GAMMA_MAX_PAGES; page += 1) {
    const url = new URL(`${GAMMA_API}/markets/keyset`);
    url.searchParams.set("tag_id", CRYPTO_TAG_ID);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("archived", "false");
    url.searchParams.set("title_search", "Up or Down");
    url.searchParams.set("end_date_min", new Date(now).toISOString());
    url.searchParams.set("end_date_max", new Date(now + GAMMA_LOOKAHEAD_MS).toISOString());
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "true");
    url.searchParams.set("limit", String(GAMMA_PAGE_SIZE));
    if (afterCursor) url.searchParams.set("after_cursor", afterCursor);
    const payload = await fetchJson<unknown>(url.toString(), { signal });
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const pageRows = Array.isArray(payload) ? payload : Array.isArray(record.markets) ? record.markets : [];
    rows.push(...pageRows);
    const nextCursor = text(record.next_cursor);
    if (!nextCursor || nextCursor === "LTE=" || nextCursor === afterCursor || pageRows.length === 0) break;
    afterCursor = nextCursor;
  }
  return { rows, now };
};

let discoveryCache: { value: MarketDefinition[]; timestamp: number } | null = null;
let discoveryInFlight: Promise<MarketDefinition[]> | null = null;

export async function discoverCryptoMarkets(signal?: AbortSignal): Promise<MarketDefinition[]> {
  if (discoveryCache && Date.now() - discoveryCache.timestamp < DISCOVERY_CACHE_MS) return discoveryCache.value;
  if (!discoveryInFlight) {
    discoveryInFlight = fetchCryptoMarketRows(signal)
      .then(({ rows, now }) => {
        const seen = new Set<string>();
        const value = rows
          .map((row) => normalizeMarket(row, now))
          .filter((market): market is MarketDefinition => market !== null && !seen.has(market.id) && Boolean(seen.add(market.id)))
          .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime || left.asset.localeCompare(right.asset));
        discoveryCache = { value, timestamp: Date.now() };
        return value;
      })
      .finally(() => {
        discoveryInFlight = null;
      });
  }
  return discoveryInFlight;
}

/** Fetch one market directly by Gamma id (used by the live route; no discovery scan). */
export async function fetchMarketById(id: string, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<MarketDefinition | null> {
  const payload = await fetchJson<unknown>(`${GAMMA_API}/markets?id=${encodeURIComponent(id)}`, { signal }, fetcher);
  const rows = Array.isArray(payload) ? payload : [];
  for (const row of rows) {
    const market = normalizeMarket(row, polymarketNow());
    if (market && market.id === id) return market;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolutions: official Up/Down outcomes from closed Gamma markets.

export type Resolution = { marketId: string; outcome: Side; resolvedAt: number };

export const parseResolution = (raw: unknown): Resolution | null => {
  const parsed = gammaMarketSchema.safeParse(raw);
  if (!parsed.success || parsed.data.closed !== true) return null;
  const outcomes = jsonArray(parsed.data.outcomes).map((outcome) => outcome.toLowerCase());
  const prices = jsonArray(parsed.data.outcomePrices).map(Number);
  if (outcomes.length !== prices.length || outcomes.length < 2) return null;
  const winner = prices.findIndex((price) => price >= 0.999);
  const loserCount = prices.filter((price) => price <= 0.001).length;
  if (winner < 0 || loserCount !== prices.length - 1) return null;
  const label = outcomes[winner];
  if (label !== "up" && label !== "down") return null;
  const closedTime = epochMs((parsed.data as Record<string, unknown>).closedTime);
  return { marketId: parsed.data.id, outcome: label === "up" ? "UP" : "DOWN", resolvedAt: closedTime ?? Date.now() };
};

export async function fetchResolutions(marketIds: string[], signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<Map<string, Resolution>> {
  const resolutions = new Map<string, Resolution>();
  const unique = [...new Set(marketIds)].filter(Boolean);
  for (let index = 0; index < unique.length; index += 40) {
    const chunk = unique.slice(index, index + 40);
    // Gamma pages at 20 rows by default; without an explicit limit half of a 40-id query is silently dropped.
    const url = `${GAMMA_API}/markets?closed=true&limit=${chunk.length}&${chunk.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`;
    const payload = await fetchJson<unknown>(url, { signal }, fetcher);
    for (const row of Array.isArray(payload) ? payload : []) {
      const resolution = parseResolution(row);
      if (resolution) resolutions.set(resolution.marketId, resolution);
    }
  }
  return resolutions;
}

// ---------------------------------------------------------------------------
// Official price to beat: the Chainlink TWAP-stream value at the window start.

export const officialPriceUrl = (asset: string, startTime: number, duration: Horizon, base = OFFICIAL_PRICE_API) => {
  const url = new URL(base, "https://polymarket.com");
  url.searchParams.set("symbol", asset.toUpperCase());
  url.searchParams.set("eventStartTime", new Date(startTime).toISOString().replace(".000Z", "Z"));
  url.searchParams.set("variant", duration === "5m" ? "fiveminute" : "fifteen");
  url.searchParams.set("endDate", new Date(startTime + (duration === "5m" ? 300_000 : 900_000)).toISOString().replace(".000Z", "Z"));
  return url.toString();
};

export const parseOfficialPrice = (payload: unknown, fetchedAt = Date.now()): OfficialPrice | null => {
  const parsed = officialPriceSchema.safeParse(payload);
  if (!parsed.success) return null;
  const openPrice = parsed.data.openPrice ?? null;
  const closePrice = parsed.data.closePrice ?? null;
  if (openPrice !== null && !(openPrice > 0)) return null;
  return { openPrice, closePrice: closePrice !== null && closePrice > 0 ? closePrice : null, completed: parsed.data.completed === true, fetchedAt };
};

export async function fetchOfficialPrice(
  asset: string,
  startTime: number,
  duration: Horizon,
  options: { signal?: AbortSignal; fetcher?: Fetcher; base?: string } = {},
): Promise<OfficialPrice | null> {
  const payload = await fetchJson<unknown>(officialPriceUrl(asset, startTime, duration, options.base), { signal: options.signal }, options.fetcher);
  return parseOfficialPrice(payload);
}

// ---------------------------------------------------------------------------
// Order books.

const sortBook = (bids: BookLevel[], asks: BookLevel[]) => ({
  bids: bids.filter((level) => level.price > 0 && level.size > 0).sort((left, right) => right.price - left.price),
  asks: asks.filter((level) => level.price > 0 && level.size > 0).sort((left, right) => left.price - right.price),
});

const parseLevels = (value: unknown): BookLevel[] =>
  Array.isArray(value)
    ? value.flatMap((level) => {
        const item = level && typeof level === "object" ? (level as Record<string, unknown>) : {};
        const price = finiteNumber(item.price);
        const size = finiteNumber(item.size);
        return price !== null && size !== null && price > 0 && size > 0 ? [{ price, size }] : [];
      })
    : [];

export const parseBook = (raw: Record<string, unknown>, tokenId: string): OrderBook => ({
  tokenId,
  ...sortBook(parseLevels(raw.bids), parseLevels(raw.asks)),
  timestamp: epochMs(raw.timestamp),
  minOrderSize: finiteNumber(raw.min_order_size ?? raw.minOrderSize),
  tickSize: finiteNumber(raw.tick_size ?? raw.tickSize),
  hash: text(raw.hash) || null,
});

export async function fetchOrderBooks(tokenIds: string[], signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<Map<string, OrderBook>> {
  const uniqueTokenIds = [...new Set(tokenIds)].filter(Boolean);
  const books = new Map<string, OrderBook>();
  const chunks = Array.from({ length: Math.ceil(uniqueTokenIds.length / CLOB_BATCH_SIZE) }, (_, index) =>
    uniqueTokenIds.slice(index * CLOB_BATCH_SIZE, (index + 1) * CLOB_BATCH_SIZE),
  );
  // Each chunk fails independently: one bad batch must not blank every market.
  const results = await Promise.allSettled(
    chunks.map((chunk) =>
      fetchJson<unknown>(
        `${CLOB_API}/books`,
        { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(chunk.map((tokenId) => ({ token_id: tokenId }))) },
        fetcher,
      ),
    ),
  );
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const item of Array.isArray(result.value) ? result.value : []) {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const tokenId = text(record.asset_id) || text(record.token_id);
      if (tokenId) books.set(tokenId, parseBook(record, tokenId));
    }
  }
  if (signal?.aborted) throw new Error("aborted");
  return books;
}

/** Prefer whichever book is newer, so a REST refresh never clobbers fresher WebSocket state. */
export const newerBook = (current: OrderBook | null, incoming: OrderBook | null): OrderBook | null => {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.timestamp !== null && incoming.timestamp !== null && current.timestamp > incoming.timestamp) return current;
  return incoming;
};

// ---------------------------------------------------------------------------
// Exchange data (cold-start volatility and divergence checks only).

export async function fetchExchangeSpots(assets: Asset[], signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<Map<Asset, PriceTick>> {
  const results = await Promise.all(
    assets.map(async (asset) => {
      try {
        const payload = await fetchJson<{ price?: string; time?: string }>(`${EXCHANGE_API}/${asset}-USD/ticker`, { signal }, fetcher);
        const price = finiteNumber(payload.price);
        const timestamp = epochMs(payload.time) ?? Date.now();
        return price !== null && price > 0 ? ([asset, { price, timestamp }] as const) : null;
      } catch {
        return null;
      }
    }),
  );
  return new Map(results.filter((result): result is readonly [Asset, PriceTick] => result !== null));
}

const fetchCoinbaseCandles = async (asset: Asset, granularity: 300 | 900, signal?: AbortSignal): Promise<MarketCandle[]> => {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(`${EXCHANGE_API}/${encodeURIComponent(`${asset}-USD`)}/candles`);
  url.searchParams.set("granularity", String(granularity));
  url.searchParams.set("start", new Date((now - granularity * CANDLE_LOOKBACK_BARS) * 1000).toISOString());
  url.searchParams.set("end", new Date(now * 1000).toISOString());
  try {
    const payload = await fetchJson<unknown>(url.toString(), { signal });
    if (!Array.isArray(payload)) return [];
    return payload
      .flatMap((row): MarketCandle[] => {
        if (!Array.isArray(row) || row.length < 5) return [];
        const [time, low, high, open, close, volume] = row.map((value) => finiteNumber(value));
        if (time === null || low === null || high === null || open === null || close === null) return [];
        if (Math.min(low, high, open, close) <= 0 || high < low) return [];
        return [{ timestamp: time * 1000, low, high, open, close, volume: volume ?? 0 }];
      })
      .sort((left, right) => left.timestamp - right.timestamp);
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
};

export async function fetchCandleHistories(assets: Asset[], signal?: AbortSignal): Promise<Map<Asset, CandleHistory>> {
  const histories = new Map<Asset, CandleHistory>();
  const now = Date.now();
  const missing: Asset[] = [];
  for (const asset of [...new Set(assets)].filter(Boolean)) {
    const cached = candleHistoryCache.get(asset);
    if (cached && now - cached.updatedAt < CANDLE_CACHE_MS) histories.set(asset, cached);
    else missing.push(asset);
  }
  for (let index = 0; index < missing.length; index += 4) {
    const fetched = await Promise.all(
      missing.slice(index, index + 4).map(async (asset) => {
        const [fiveMinute, fifteenMinute] = await Promise.all([fetchCoinbaseCandles(asset, 300, signal), fetchCoinbaseCandles(asset, 900, signal)]);
        const history = { fiveMinute, fifteenMinute, updatedAt: Date.now() };
        candleHistoryCache.set(asset, history);
        return [asset, history] as const;
      }),
    );
    for (const [asset, history] of fetched) histories.set(asset, history);
  }
  return histories;
}

// ---------------------------------------------------------------------------
// LiveMarket assembly and incremental updates.

const bestBidOf = (book: OrderBook | null) => book?.bids[0]?.price ?? null;
const bestAskOf = (book: OrderBook | null) => book?.asks[0]?.price ?? null;
const depthNotional = (book: OrderBook | null) => book?.asks.slice(0, 8).reduce((sum, level) => sum + level.price * level.size, 0) ?? 0;

export const withBooks = (market: LiveMarket, upBook: OrderBook | null, downBook: OrderBook | null, now: number): LiveMarket => {
  const upBid = bestBidOf(upBook);
  const upAsk = bestAskOf(upBook);
  const downBid = bestBidOf(downBook);
  const downAsk = bestAskOf(downBook);
  const spreads = [upBid !== null && upAsk !== null ? upAsk - upBid : null, downBid !== null && downAsk !== null ? downAsk - downBid : null].filter(
    (value): value is number => value !== null,
  );
  const upDepth = depthNotional(upBook);
  const downDepth = depthNotional(downBook);
  const total = upDepth + downDepth;
  return {
    ...market,
    upBook,
    downBook,
    upBid,
    upAsk,
    downBid,
    downAsk,
    spread: spreads.length ? Math.max(...spreads) : null,
    liquidity: total,
    imbalance: total > 0 ? (upDepth - downDepth) / total : null,
    sourceTimestamp: now,
  };
};

export type MarketContext = {
  books: Map<string, OrderBook>;
  official: Map<string, OfficialPrice>;
  /** Stream values recorded at window starts, keyed by `openKey`. */
  recordedOpens?: Map<string, number>;
  candles: Map<Asset, CandleHistory>;
};

/** Official-price cache key; includes duration because 5m and 15m windows share an open but not a close. */
export const officialKey = (market: Pick<MarketDefinition, "asset" | "startTime" | "duration">) => `${market.asset}:${market.duration}:${market.startTime}`;
/** Recorded stream opens are duration-independent. */
export const openKey = (market: Pick<MarketDefinition, "asset" | "startTime">) => `${market.asset}:${market.startTime}`;

export const buildLiveMarket = (
  definition: MarketDefinition,
  context: MarketContext,
  now = polymarketNow(),
  previous: LiveMarket | null = null,
): LiveMarket => {
  const official = context.official.get(officialKey(definition)) ?? null;
  const recorded = context.recordedOpens?.get(openKey(definition)) ?? null;
  const candles = context.candles.get(definition.asset) ?? null;
  const reference = official?.openPrice ?? recorded ?? previous?.reference ?? null;
  const base: LiveMarket = {
    ...definition,
    remaining: Math.max(0, (definition.endTime - now) / 1000),
    reference,
    referenceSource: reference !== null ? "CHAINLINK" : "MISSING",
    officialClose: official?.completed ? official.closePrice : (previous?.officialClose ?? null),
    upBook: null,
    downBook: null,
    upBid: null,
    upAsk: null,
    downBid: null,
    downAsk: null,
    spread: null,
    liquidity: 0,
    imbalance: null,
    sourceTimestamp: now,
    chart5m: candles?.fiveMinute ?? previous?.chart5m ?? [],
    chart15m: candles?.fifteenMinute ?? previous?.chart15m ?? [],
    chartUpdatedAt: candles?.updatedAt ?? previous?.chartUpdatedAt ?? null,
  };
  const upBook = newerBook(previous?.upBook ?? null, context.books.get(definition.upTokenId) ?? null);
  const downBook = newerBook(previous?.downBook ?? null, context.books.get(definition.downTokenId) ?? null);
  return withBooks(base, upBook, downBook, now);
};

/** Attach a verified reference (official API or our own recorded stream tick at the start). */
export const withReference = (market: LiveMarket, reference: number | null): LiveMarket =>
  reference === null || market.reference !== null ? market : { ...market, reference, referenceSource: "CHAINLINK" };

const emptyBook = (tokenId: string): OrderBook => ({ tokenId, bids: [], asks: [], timestamp: null, minOrderSize: null, tickSize: null, hash: null });

export const replaceLiveMarketBook = (
  market: LiveMarket,
  tokenId: string,
  bids: BookLevel[],
  asks: BookLevel[],
  timestamp: number | null,
  hash: string | null,
  now = Date.now(),
): LiveMarket => {
  const isUp = tokenId === market.upTokenId;
  if (!isUp && tokenId !== market.downTokenId) return market;
  const existing = (isUp ? market.upBook : market.downBook) ?? emptyBook(tokenId);
  const book: OrderBook = { ...existing, ...sortBook(bids, asks), timestamp: timestamp ?? now, hash };
  return isUp ? withBooks(market, book, market.downBook, now) : withBooks(market, market.upBook, book, now);
};

export const updateLiveMarketBookLevel = (
  market: LiveMarket,
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  timestamp: number | null,
  now = Date.now(),
): LiveMarket => {
  const isUp = tokenId === market.upTokenId;
  if ((!isUp && tokenId !== market.downTokenId) || !(price > 0) || !Number.isFinite(size)) return market;
  const existing = (isUp ? market.upBook : market.downBook) ?? emptyBook(tokenId);
  const key = side === "BUY" ? "bids" : "asks";
  const levels = existing[key].filter((level) => level.price !== price);
  if (size > 0) levels.push({ price, size });
  const sorted = key === "bids" ? sortBook(levels, existing.asks) : sortBook(existing.bids, levels);
  const book: OrderBook = { ...existing, ...sorted, timestamp: timestamp ?? now };
  return isUp ? withBooks(market, book, market.downBook, now) : withBooks(market, market.upBook, book, now);
};

export const snapshotFromLiveMarket = (market: LiveMarket, feed: DerivedFeed | null, now = polymarketNow()): MarketSnapshot => ({
  marketId: market.id,
  asset: market.asset,
  duration: market.duration,
  startTime: market.startTime,
  endTime: market.endTime,
  now,
  reference: market.reference,
  referenceSource: market.referenceSource,
  spot: feed?.spot ?? null,
  spotTimestamp: feed?.spotTimestamp ?? null,
  spotSource: feed?.spotSource ?? "MISSING",
  basisBps: feed?.basisBps ?? null,
  ticks: (feed?.ticks ?? []).filter(
    (tick) => tick.timestamp > market.endTime - Math.max(60, market.twapLookbackSeconds) * 1000 - 5_000 && tick.timestamp <= now,
  ),
  sigmaPerSqrtSecond: feed?.sigmaPerSqrtSecond ?? null,
  volSamples: feed?.volSamples ?? 0,
  twapLookbackSeconds: market.twapLookbackSeconds,
  feeSchedule: market.feeSchedule,
  tickSize: market.tickSize,
  minOrderSize: market.minOrderSize,
  up: { bids: market.upBook?.bids ?? [], asks: market.upBook?.asks ?? [], timestamp: market.upBook?.timestamp ?? null },
  down: { bids: market.downBook?.bids ?? [], asks: market.downBook?.asks ?? [], timestamp: market.downBook?.timestamp ?? null },
});

export const bestBidFor = (market: LiveMarket, side: Side) => (side === "UP" ? market.upBid : market.downBid);
export const bestAskFor = (market: LiveMarket, side: Side) => (side === "UP" ? market.upAsk : market.downAsk);
export const orderBookFor = (market: LiveMarket, side: Side) => (side === "UP" ? market.upBook : market.downBook);
export const tokenFor = (market: MarketDefinition, side: Side) => (side === "UP" ? market.upTokenId : market.downTokenId);

/** Symbol used by Polymarket RTDS for Chainlink prices, e.g. "btc/usd". */
export const chainlinkSymbol = (asset: string) => `${asset.toLowerCase()}/usd`;
