export type Horizon = "5m" | "15m";
export type Asset = string;

export const isVerifiedMarketStartTime = (startTime: number | null, endTime: number, duration: Horizon): boolean =>
  startTime !== null && Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > 0
  && Math.abs(startTime - (endTime - (duration === "5m" ? 300_000 : 900_000))) <= 1_000;

export type BookLevel = {
  price: number;
  size: number;
};

export type OrderBook = {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  timestamp: number | null;
  minOrderSize: number | null;
  hash: string | null;
};

export type MarketCandle = {
  timestamp: number;
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
};

export type MarketPriceTick = { timestamp: number; price: number };

/** An observation from Polymarket's oracle-aligned RTDS feed. */
export type PolymarketPriceTick = MarketPriceTick & {
  asset: Asset;
  priceFeed: "TWAP_60" | "CHAINLINK_SPOT";
};

export type CandleHistory = {
  fiveMinute: MarketCandle[];
  fifteenMinute: MarketCandle[];
  updatedAt: number;
};

export type MarketFeeSchedule = {
  /** CLOB fee coefficient for (price * (1 - price)) ** exponent. */
  rate: number;
  exponent: number;
  feesEnabled: boolean;
  source: "CLOB" | "CONSERVATIVE_FALLBACK";
};

/** Used for short-dated crypto markets when the CLOB fee schedule cannot be read. */
export const CONSERVATIVE_CRYPTO_FEE_SCHEDULE: MarketFeeSchedule = {
  rate: 0.1,
  exponent: 1,
  feesEnabled: true,
  source: "CONSERVATIVE_FALLBACK",
};

export type MarketDefinition = {
  id: string;
  conditionId: string | null;
  slug: string;
  question: string;
  asset: Asset;
  duration: Horizon;
  startTime: number | null;
  /** True only when Gamma or the market slug supplied a start boundary we can verify. */
  startTimeVerified: boolean;
  endTime: number;
  reference: number | null;
  referenceSource: "POLYMARKET" | "COINBASE ESTIMATE" | "MISSING";
  /** The oracle series named by this market's own resolution configuration. */
  priceFeed: "TWAP_60" | "CHAINLINK_SPOT" | "UNSUPPORTED";
  upTokenId: string;
  downTokenId: string;
  sourceUrl: string;
  feeSchedule?: MarketFeeSchedule;
};

export type LiveMarket = MarketDefinition & {
  remaining: number;
  countdownEndsAt: number;
  spot: number | null;
  spotSource: "POLYMARKET" | "MISSING";
  spotUpdatedAt: number | null;
  referenceUpdatedAt: number | null;
  referenceVerified: boolean;
  upBook: OrderBook | null;
  downBook: OrderBook | null;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  fairUp: number | null;
  edgeUp: number | null;
  edgeDown: number | null;
  spread: number | null;
  liquidity: number;
  imbalance: number | null;
  momentum: number | null;
  distance: number | null;
  regime: string;
  sourceTimestamp: number;
  chart5m: MarketCandle[];
  chart15m: MarketCandle[];
  chartUpdatedAt: number | null;
  spotHistory?: MarketPriceTick[];
};

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const SPOT_API = "https://api.coinbase.com/v2/prices";
const COINBASE_CANDLES_API = "https://api.exchange.coinbase.com/products";
const CRYPTO_TAG_ID = "21";
const GAMMA_PAGE_SIZE = 100;
const GAMMA_MAX_PAGES = 12;
const GAMMA_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;
const DISCOVERY_CACHE_MS = 60_000;
const DISCOVERY_STALE_FALLBACK_MS = 120_000;
const POLYMARKET_TIME_CACHE_MS = 15_000;
const PUBLIC_REQUEST_TIMEOUT_MS = 15_000;
const PUBLIC_REQUEST_RETRIES = 2;
const PUBLIC_RETRY_AFTER_MAX_MS = 20_000;
const CLOB_BATCH_SIZE = 500;
const CLOB_FEE_LOOKUP_CONCURRENCY = 8;
const CLOB_SINGLE_BOOK_FALLBACK_LIMIT = 32;
const CLOB_SINGLE_BOOK_FALLBACK_CONCURRENCY = 4;
const CANDLE_CACHE_MS = 60_000;
const CANDLE_LOOKBACK_BARS = 100;
const CLOB_FEE_CACHE_MS = 5 * 60_000;
const CLOB_FEE_FALLBACK_CACHE_MS = CLOB_FEE_CACHE_MS;

let polymarketClockOffsetMs = 0;
let polymarketClockSyncedAt = 0;
const candleHistoryCache = new Map<Asset, CandleHistory>();
const clobFeeScheduleCache = new Map<string, { schedule: MarketFeeSchedule; expiresAt: number }>();
const clobFeeScheduleInFlight = new Map<string, Promise<MarketFeeSchedule>>();

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const jsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
  }
};

const epochMs = (value: unknown): number | null => {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const normalizeText = (value: unknown) => (typeof value === "string" ? value : "");

const assetAliases: Record<string, Asset> = {
  ada: "ADA",
  aave: "AAVE",
  arb: "ARB",
  atom: "ATOM",
  avax: "AVAX",
  bitcoin: "BTC",
  bnb: "BNB",
  btc: "BTC",
  bonk: "BONK",
  doge: "DOGE",
  dogecoin: "DOGE",
  dot: "DOT",
  eth: "ETH",
  ethereum: "ETH",
  fil: "FIL",
  hype: "HYPE",
  hyperliquid: "HYPE",
  inj: "INJ",
  link: "LINK",
  ltc: "LTC",
  near: "NEAR",
  op: "OP",
  pepe: "PEPE",
  pol: "POL",
  polygon: "POL",
  matic: "POL",
  ripple: "XRP",
  shib: "SHIB",
  sol: "SOL",
  solana: "SOL",
  sui: "SUI",
  trx: "TRX",
  ton: "TON",
  uni: "UNI",
  xrp: "XRP",
  wif: "WIF",
  zcash: "ZEC",
  zec: "ZEC",
};

const assetFor = (text: string, slug: string): Asset | null => {
  const shortSlug = slug.toLowerCase().match(/^([a-z0-9]+)-(?:updown|up-or-down)(?:-|$)/);
  const slugAsset = shortSlug ? assetAliases[shortSlug[1]] ?? shortSlug[1].toUpperCase() : null;
  if (slugAsset) return slugAsset;

  const value = text.toLowerCase();
  for (const [alias, asset] of Object.entries(assetAliases)) {
    if (new RegExp(`\\b${alias}\\b`, "i").test(value)) return asset;
  }
  return null;
};

const horizonFromValue = (value: unknown): Horizon | null => {
  const numeric = finiteNumber(value);
  if (numeric !== null) {
    if (numeric >= 240 && numeric <= 360) return "5m";
    if (numeric >= 840 && numeric <= 960) return "15m";
  }
  const normalized = normalizeText(value).toLowerCase();
  if (/^5\s*(?:m|min|minute|minutes)$/.test(normalized)) return "5m";
  if (/^15\s*(?:m|min|minute|minutes)$/.test(normalized)) return "15m";
  return null;
};

const clockRangeDuration = (text: string): number | null => {
  const match = text.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!match) return null;
  const startMeridiem = match[3]?.replace(/\./g, "").toLowerCase();
  const endMeridiem = match[6]?.replace(/\./g, "").toLowerCase() || startMeridiem;
  if (!startMeridiem && !endMeridiem) return null;
  const toMinutes = (hourValue: string, minuteValue: string | undefined, meridiem: string | undefined) => {
    let hour = Number(hourValue);
    const minute = Number(minuteValue ?? "0");
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 12 || minute > 59) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return hour * 60 + minute;
  };
  const start = toMinutes(match[1], match[2], startMeridiem || endMeridiem);
  const end = toMinutes(match[4], match[5], endMeridiem);
  if (start === null || end === null) return null;
  const minutes = (end - start + 24 * 60) % (24 * 60);
  return minutes > 0 ? minutes * 60 : null;
};

const horizonFor = (text: string, slug: string, raw: Record<string, unknown>, startTime: number | null, endTime: number | null): Horizon | null => {
  const explicitSlug = slug.match(/(?:updown|up-or-down)[-_](5m|15m)(?:[-_]|$)/i)?.[1]?.toLowerCase();
  if (explicitSlug === "5m" || explicitSlug === "15m") return explicitSlug;

  for (const key of ["duration", "durationSeconds", "duration_seconds", "marketDuration", "market_duration", "eventDuration", "event_duration"]) {
    const duration = horizonFromValue(raw[key]);
    if (duration) return duration;
  }

  const range = clockRangeDuration(text);
  if (range !== null) {
    if (range >= 240 && range <= 360) return "5m";
    if (range >= 840 && range <= 960) return "15m";
  }

  const duration = startTime !== null && endTime !== null ? (endTime - startTime) / 1000 : null;
  if (duration !== null && duration >= 240 && duration <= 360) return "5m";
  if (duration !== null && duration >= 840 && duration <= 960) return "15m";
  return null;
};

const priceFeedFor = (raw: Record<string, unknown>): MarketDefinition["priceFeed"] => {
  const event = firstEventFor(raw);
  const rawConfig = raw.cryptoMarketConfig ?? raw.crypto_market_config
    ?? event.cryptoMarketConfig ?? event.crypto_market_config;
  const config = rawConfig && typeof rawConfig === "object"
    ? rawConfig as Record<string, unknown>
    : null;
  const source = normalizeText(raw.resolutionSource || raw.resolution_source
    || event.resolutionSource || event.resolution_source).toLowerCase();
  const twapEnabled = config?.twapEnabled ?? config?.twap_enabled;
  const twapSeconds = finiteNumber(config?.twapLookbackSeconds ?? config?.twap_lookback_seconds);
  if (flagIsTrue(twapEnabled)) return twapSeconds === 60 ? "TWAP_60" : "UNSUPPORTED";
  if (twapSeconds !== null && twapSeconds !== 0) return "UNSUPPORTED";
  if (/chain\.link\/streams\/[a-z0-9-]+-twap-60s-streams(?:\/?|$)/.test(source)) return "TWAP_60";
  if (source.includes("twap")) return "UNSUPPORTED";
  if (/chain\.link\/streams\/[a-z0-9-]+(?:\/?|$)/.test(source)) return "CHAINLINK_SPOT";
  return "UNSUPPORTED";
};

const rawMarkets = (payload: unknown): Record<string, unknown>[] => {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["markets", "items", "data"]) {
    if (Array.isArray(record[key])) return record[key].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  }
  return [];
};

const flagIsTrue = (value: unknown) => value === true || value === 1 || value === "1" || (typeof value === "string" && value.toLowerCase() === "true");
const flagIsFalse = (value: unknown) => value === false || value === 0 || value === "0" || (typeof value === "string" && value.toLowerCase() === "false");

const tokenIdsFor = (raw: Record<string, unknown>): string[] => {
  const direct = jsonArray(raw.clobTokenIds || raw.clob_token_ids || raw.tokenIds || raw.token_ids);
  if (direct.length >= 2) return direct;

  const outcomes = raw.outcomes;
  if (outcomes && typeof outcomes === "object" && !Array.isArray(outcomes)) {
    const outcomeRecord = outcomes as Record<string, unknown>;
    const preferred = ["yes", "no", "up", "down", "higher", "lower", "above", "below"];
    const ordered = preferred.flatMap((key) => {
      const candidate = outcomeRecord[key];
      if (!candidate || typeof candidate !== "object") return [];
      const record = candidate as Record<string, unknown>;
      const token = normalizeText(record.tokenId || record.token_id || record.assetId || record.asset_id);
      return token ? [token] : [];
    });
    if (ordered.length >= 2) return ordered;
  }

  return jsonArray(raw.tokens).slice(0, 2);
};

const outcomeLabelsFor = (raw: Record<string, unknown>): string[] => {
  if (Array.isArray(raw.outcomes) || typeof raw.outcomes === "string") return jsonArray(raw.outcomes);
  if (!raw.outcomes || typeof raw.outcomes !== "object") return [];
  return Object.keys(raw.outcomes as Record<string, unknown>);
};

const firstEventFor = (raw: Record<string, unknown>): Record<string, unknown> => {
  const events = raw.events;
  if (!Array.isArray(events)) return {};
  const event = events.find((item) => item && typeof item === "object" && !Array.isArray(item));
  return event && typeof event === "object" ? event as Record<string, unknown> : {};
};

const intervalStartFor = (raw: Record<string, unknown>, slug: string): number | null => {
  const event = firstEventFor(raw);
  const explicit = epochMs(
    raw.startTime || raw.start_time || raw.eventStartTime || raw.event_start_time
      || event.startTime || event.start_time || event.eventStartTime || event.event_start_time,
  );
  if (explicit !== null) return explicit;
  const slugTimestamp = slug.match(/(?:^|[-_])(\d{10})(?:$|[-_])/);
  const fromSlug = epochMs(slugTimestamp?.[1]);
  if (fromSlug !== null) return fromSlug;
  return epochMs(raw.startDate || raw.start_date);
};

const intervalEndFor = (raw: Record<string, unknown>): number | null => {
  const event = firstEventFor(raw);
  return epochMs(
    raw.endTime || raw.end_time || raw.eventEndTime || raw.event_end_time
      || event.endTime || event.end_time || event.eventEndTime || event.event_end_time
      || raw.endDate || raw.end_date,
  );
};

const normalizeMarket = (raw: Record<string, unknown>, now = Date.now()): MarketDefinition | null => {
  const question = normalizeText(raw.question || raw.title || raw.eventTitle || raw.description);
  const slug = normalizeText(raw.slug || raw.marketSlug || raw.market_slug || raw.id);
  const text = [question, slug, normalizeText(raw.description), normalizeText(raw.outcomes), normalizeText(raw.eventTitle), normalizeText(raw.eventSlug)].join(" ");
  const asset = assetFor(text, slug);
  if (!asset) return null;

  const startTime = intervalStartFor(raw, slug);
  const endTime = intervalEndFor(raw);
  if (!endTime || endTime <= now) return null;
  const duration = horizonFor(text, slug, raw, startTime, endTime);
  if (!duration) return null;
  // Exact oracle opening ticks are meaningful only at the market interval
  // boundary; a nearby scheduled timestamp is not sufficient provenance.
  const expectedStartTime = endTime - (duration === "5m" ? 300_000 : 900_000);
  const startTimeVerified = isVerifiedMarketStartTime(startTime, endTime, duration);
  const alignedStartTime = startTimeVerified ? startTime : expectedStartTime;

  const outcomes = outcomeLabelsFor(raw);
  const tokenIds = tokenIdsFor(raw);
  if (tokenIds.length < 2) return null;
  const lowerOutcomes = outcomes.map((outcome) => outcome.toLowerCase());
  const upIndex = lowerOutcomes.findIndex((outcome) => /^(up|yes|higher|above)$/.test(outcome));
  const downIndex = lowerOutcomes.findIndex((outcome) => /^(down|no|lower|below)$/.test(outcome));
  const upTokenId = tokenIds[upIndex >= 0 ? upIndex : 0];
  const downTokenId = tokenIds[downIndex >= 0 ? downIndex : 1];
  if (!upTokenId || !downTokenId || upTokenId === downTokenId) return null;

  const active = !flagIsFalse(raw.active) && !flagIsTrue(raw.closed) && !flagIsTrue(raw.archived);
  if (!active) return null;

  const id = normalizeText(raw.id || raw.conditionId || raw.condition_id || slug);
  if (!id) return null;
  return {
    id,
    conditionId: normalizeText(raw.conditionId || raw.condition_id) || null,
    slug,
    question: question || slug,
    asset,
    duration,
    startTime: alignedStartTime,
    startTimeVerified,
    endTime,
    reference: null,
    referenceSource: "MISSING",
    priceFeed: priceFeedFor(raw),
    upTokenId,
    downTokenId,
    sourceUrl: slug ? `https://polymarket.com/market/${slug}` : "https://polymarket.com",
  };
};

class PublicApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PublicApiError";
  }
}

const publicEndpoint = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.split("?", 1)[0];
  }
};

const retryAfterMs = (value: string | null): number | null => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
};

const waitForRetry = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason ?? new Error("Public request aborted"));
    return;
  }
  const timer = globalThis.setTimeout(() => {
    signal?.removeEventListener("abort", abort);
    resolve();
  }, milliseconds);
  const abort = () => {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    reject(signal?.reason ?? new Error("Public request aborted"));
  };
  signal?.addEventListener("abort", abort, { once: true });
});

const mapInBatches = async <T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += concurrency) {
    results.push(...await Promise.all(items.slice(index, index + concurrency).map(mapper)));
  }
  return results;
};

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const upstreamSignal = init?.signal ?? undefined;
  const endpoint = publicEndpoint(url);
  for (let attempt = 0; ; attempt += 1) {
    const timeoutController = new AbortController();
    const timeoutId = globalThis.setTimeout(() => timeoutController.abort(), PUBLIC_REQUEST_TIMEOUT_MS);
    const abortRequest = () => timeoutController.abort();
    if (upstreamSignal?.aborted) timeoutController.abort();
    else upstreamSignal?.addEventListener("abort", abortRequest, { once: true });

    try {
      const response = await fetch(url, { ...init, cache: "no-store", signal: timeoutController.signal });
      if (response.ok) return await response.json() as T;

      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
      const serverDelay = retryAfterMs(response.headers.get("Retry-After"));
      if (retryable && attempt < PUBLIC_REQUEST_RETRIES && (serverDelay === null || serverDelay <= PUBLIC_RETRY_AFTER_MAX_MS)) {
        const delay = serverDelay ?? Math.round(350 * 2 ** attempt * (0.75 + Math.random() * 0.5));
        await response.body?.cancel().catch(() => undefined);
        globalThis.clearTimeout(timeoutId);
        upstreamSignal?.removeEventListener("abort", abortRequest);
        await waitForRetry(delay, upstreamSignal);
        continue;
      }
      throw new PublicApiError(`${response.status} ${response.statusText} from ${endpoint}`, response.status);
    } catch (error) {
      if (timeoutController.signal.aborted && !upstreamSignal?.aborted) {
        throw new Error(`Public request timed out after ${PUBLIC_REQUEST_TIMEOUT_MS / 1000}s (${endpoint})`);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeoutId);
      upstreamSignal?.removeEventListener("abort", abortRequest);
    }
  }
};

const conservativeCryptoFeeSchedule = (): MarketFeeSchedule => ({ ...CONSERVATIVE_CRYPTO_FEE_SCHEDULE });

const parseClobFeeSchedule = (payload: unknown): MarketFeeSchedule | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const market = payload as Record<string, unknown>;
  const feeData = market.fd ?? market.fee_data ?? market.feeData ?? market.feeSchedule;
  if (feeData && typeof feeData === "object" && !Array.isArray(feeData)) {
    const record = feeData as Record<string, unknown>;
    const rate = finiteNumber(record.r ?? record.rate);
    const exponent = finiteNumber(record.e ?? record.exponent);
    if (rate !== null && exponent !== null && rate >= 0 && rate <= 1 && exponent >= 0 && exponent <= 8) {
      return { rate, exponent, feesEnabled: rate > 0, source: "CLOB" };
    }
  }

  const feesEnabled = market.feesEnabled ?? market.fees_enabled;
  if (feesEnabled !== undefined && flagIsFalse(feesEnabled)) {
    return { rate: 0, exponent: 1, feesEnabled: false, source: "CLOB" };
  }
  return null;
};

const fetchClobFeeSchedule = (conditionId: string | null, signal?: AbortSignal): Promise<MarketFeeSchedule> => {
  if (!conditionId) return Promise.resolve(conservativeCryptoFeeSchedule());
  const cached = clobFeeScheduleCache.get(conditionId);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.schedule);
  const inFlight = clobFeeScheduleInFlight.get(conditionId);
  if (inFlight) return inFlight;

  const request = fetchJson<unknown>(`${CLOB_API}/clob-markets/${encodeURIComponent(conditionId)}`, { signal })
    .then((payload) => parseClobFeeSchedule(payload) ?? conservativeCryptoFeeSchedule())
    .catch((error) => {
      if (signal?.aborted) throw error;
      return conservativeCryptoFeeSchedule();
    })
    .then((schedule) => {
      clobFeeScheduleCache.set(conditionId, {
        schedule,
        expiresAt: Date.now() + (schedule.source === "CLOB" ? CLOB_FEE_CACHE_MS : CLOB_FEE_FALLBACK_CACHE_MS),
      });
      return schedule;
    })
    .finally(() => clobFeeScheduleInFlight.delete(conditionId));
  clobFeeScheduleInFlight.set(conditionId, request);
  return request;
};

const polymarketNow = () => Date.now() + polymarketClockOffsetMs;

/** Convert a local clock reading to Polymarket's synchronized event time. */
export const synchronizedPolymarketTime = (localTime = Date.now()): number => localTime + polymarketClockOffsetMs;

const fetchPolymarketNow = async (signal?: AbortSignal): Promise<number> => {
  if (Date.now() - polymarketClockSyncedAt < POLYMARKET_TIME_CACHE_MS) return polymarketNow();
  try {
    const payload = await fetchJson<unknown>(`${CLOB_API}/time`, { signal });
    const serverTime = epochMs(payload);
    if (serverTime !== null) {
      polymarketClockOffsetMs = serverTime - Date.now();
      polymarketClockSyncedAt = Date.now();
      return serverTime;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return polymarketNow();
};

const nextCursorFor = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const cursor = normalizeText(record.next_cursor || record.nextCursor);
  return cursor && cursor !== "LTE=" ? cursor : null;
};

const fetchCryptoMarketRows = async (signal?: AbortSignal): Promise<{ rows: Record<string, unknown>[]; now: number }> => {
  const rows: Record<string, unknown>[] = [];
  let afterCursor: string | null = null;
  const now = await fetchPolymarketNow(signal);

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
    const pageRows = rawMarkets(payload);
    rows.push(...pageRows);

    const nextCursor = nextCursorFor(payload);
    if (!nextCursor || nextCursor === afterCursor || pageRows.length === 0) break;
    afterCursor = nextCursor;
  }

  return { rows, now };
};

let discoveryCache: { value: MarketDefinition[]; timestamp: number } | null = null;
let discoveryInFlight: Promise<MarketDefinition[]> | null = null;

const discoverCryptoMarketsFresh = async (signal?: AbortSignal): Promise<MarketDefinition[]> => {
  const { rows: directMarkets, now } = await fetchCryptoMarketRows(signal);
  const seen = new Set<string>();
  const definitions = directMarkets
    .map((row) => normalizeMarket(row, now))
    .filter((market): market is MarketDefinition => Boolean(market))
    .filter((market) => {
      if (seen.has(market.id)) return false;
      seen.add(market.id);
      return true;
    })
    .sort((left, right) => {
      const leftStart = left.startTime ?? left.endTime;
      const rightStart = right.startTime ?? right.endTime;
      const leftPhase = left.startTime !== null && left.startTime <= now && left.endTime > now ? 0 : left.startTime !== null && left.startTime > now ? 1 : 2;
      const rightPhase = right.startTime !== null && right.startTime <= now && right.endTime > now ? 0 : right.startTime !== null && right.startTime > now ? 1 : 2;
      if (leftPhase !== rightPhase) return leftPhase - rightPhase;
      return leftStart - rightStart || left.endTime - right.endTime || left.asset.localeCompare(right.asset) || left.id.localeCompare(right.id);
    });
  return mapInBatches(definitions, CLOB_FEE_LOOKUP_CONCURRENCY, async (definition) => ({
    ...definition,
    feeSchedule: await fetchClobFeeSchedule(definition.conditionId, signal),
  }));
};

export async function discoverCryptoMarkets(signal?: AbortSignal): Promise<MarketDefinition[]> {
  if (discoveryCache && Date.now() - discoveryCache.timestamp < DISCOVERY_CACHE_MS) return discoveryCache.value;
  if (!discoveryInFlight) {
    const cachedFallback = discoveryCache && Date.now() - discoveryCache.timestamp <= DISCOVERY_STALE_FALLBACK_MS
      ? discoveryCache
      : null;
    discoveryInFlight = discoverCryptoMarketsFresh(signal)
      .then((value) => {
        discoveryCache = { value, timestamp: Date.now() };
        return value;
      })
      .catch((error) => {
        if (signal?.aborted || !cachedFallback) throw error;
        console.warn(JSON.stringify({
          at: new Date().toISOString(),
          level: "WARN",
          message: "Gamma market discovery failed; using recent cached definitions while refreshing live inputs.",
          error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
          cacheAgeMs: Date.now() - cachedFallback.timestamp,
        }));
        return cachedFallback.value;
      })
      .finally(() => {
        discoveryInFlight = null;
      });
  }
  return discoveryInFlight;
}

export async function fetchResolvedMarketOutcomes(
  markets: Array<Pick<MarketDefinition, "id"> & Partial<Pick<MarketDefinition, "upTokenId" | "downTokenId">>>,
  signal?: AbortSignal,
): Promise<Map<string, "UP" | "DOWN">> {
  const resolved = new Map<string, "UP" | "DOWN">();
  await Promise.all(markets.map(async (market) => {
    try {
      const raw = await fetchJson<Record<string, unknown>>(`${GAMMA_API}/markets/${encodeURIComponent(market.id)}`, { signal });
      if (!flagIsTrue(raw.closed)) return;
      const tokenIds = jsonArray(raw.clobTokenIds || raw.clob_token_ids || raw.tokenIds || raw.token_ids);
      const prices = jsonArray(raw.outcomePrices || raw.outcome_prices).map((value) => finiteNumber(value));
      if (tokenIds.length !== prices.length || tokenIds.length < 2) return;
      const winningIndexes = prices.flatMap((price, index) => price !== null && price >= 0.999 ? [index] : []);
      const losingIndexes = prices.flatMap((price, index) => price !== null && price <= 0.001 ? [index] : []);
      if (winningIndexes.length !== 1 || losingIndexes.length !== tokenIds.length - 1) return;
      const winningToken = tokenIds[winningIndexes[0]];
      if (market.upTokenId && winningToken === market.upTokenId) resolved.set(market.id, "UP");
      else if (market.downTokenId && winningToken === market.downTokenId) resolved.set(market.id, "DOWN");
      else {
        const labels = outcomeLabelsFor(raw).map((label) => label.toLowerCase().trim());
        const upIndex = labels.findIndex((label) => /^(up|yes|higher|above)$/.test(label));
        const downIndex = labels.findIndex((label) => /^(down|no|lower|below)$/.test(label));
        if (winningIndexes[0] === upIndex) resolved.set(market.id, "UP");
        else if (winningIndexes[0] === downIndex) resolved.set(market.id, "DOWN");
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }));
  return resolved;
}

const parseBook = (raw: Record<string, unknown>, tokenId: string): OrderBook => {
  const levels = (value: unknown): BookLevel[] => {
    if (!Array.isArray(value)) return [];
    return value.map((level) => {
      const record = level && typeof level === "object" ? level as Record<string, unknown> : {};
      return { price: finiteNumber(record.price) ?? 0, size: finiteNumber(record.size) ?? 0 };
    }).filter((level) => level.price > 0 && level.size > 0);
  };
  return {
    tokenId,
    bids: levels(raw.bids).sort((left, right) => left.price - right.price),
    asks: levels(raw.asks).sort((left, right) => left.price - right.price),
    timestamp: epochMs(raw.timestamp),
    minOrderSize: finiteNumber(raw.min_order_size || raw.minOrderSize),
    hash: normalizeText(raw.hash) || null,
  };
};

export async function fetchOrderBooks(tokenIds: string[], signal?: AbortSignal): Promise<Map<string, OrderBook>> {
  const uniqueTokenIds = [...new Set(tokenIds)].filter(Boolean);
  if (!uniqueTokenIds.length) return new Map();
  const chunks = Array.from({ length: Math.ceil(uniqueTokenIds.length / CLOB_BATCH_SIZE) }, (_, index) => uniqueTokenIds.slice(index * CLOB_BATCH_SIZE, (index + 1) * CLOB_BATCH_SIZE));
  const books = new Map<string, OrderBook>();

  await Promise.all(chunks.map(async (chunk) => {
    try {
      const payload = await fetchJson<unknown>(`${CLOB_API}/books`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((tokenId) => ({ token_id: tokenId }))),
      });
      const records = Array.isArray(payload) ? payload : [];
      for (const record of records) {
        const item = record && typeof record === "object" ? record as Record<string, unknown> : {};
        const tokenId = normalizeText(item.asset_id || item.token_id);
        if (tokenId) books.set(tokenId, parseBook(item, tokenId));
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!(error instanceof PublicApiError) || ![400, 404, 405, 415, 422].includes(error.status)) {
        console.warn(JSON.stringify({
          at: new Date().toISOString(),
          level: "WARN",
          message: "CLOB batch book request failed; skipped single-book fallback to avoid a request burst.",
          error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
          tokenCount: chunk.length,
        }));
        return;
      }
      const fallbackTokenIds = chunk.slice(0, CLOB_SINGLE_BOOK_FALLBACK_LIMIT);
      const entries = await mapInBatches(fallbackTokenIds, CLOB_SINGLE_BOOK_FALLBACK_CONCURRENCY, async (tokenId) => {
        try {
          const payload = await fetchJson<Record<string, unknown>>(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`, { signal });
          return [tokenId, parseBook(payload, tokenId)] as const;
        } catch {
          return null;
        }
      });
      for (const entry of entries) if (entry) books.set(entry[0], entry[1]);
    }
  }));

  return books;
}

export async function fetchSpotPrices(assets: Asset[], signal?: AbortSignal): Promise<Map<Asset, number>> {
  const results = await Promise.all(assets.map(async (asset) => {
    try {
      const payload = await fetchJson<{ data?: { amount?: string } }>(`${SPOT_API}/${asset}-USD/spot`, { signal });
      const price = finiteNumber(payload.data?.amount);
      return price !== null && price > 0 ? ([asset, price] as const) : null;
    } catch {
      return null;
    }
  }));
  return new Map(results.filter((result): result is readonly [Asset, number] => Boolean(result)));
}

const candleProductsFor = (asset: Asset): string[] => {
  const aliases: Record<string, string[]> = {
    POL: ["POL", "MATIC"],
  };
  return aliases[asset] ?? [asset];
};

const fetchCoinbaseCandles = async (asset: Asset, granularity: 300 | 900, signal?: AbortSignal): Promise<MarketCandle[]> => {
  const now = Math.floor(Date.now() / 1000);
  const start = now - granularity * CANDLE_LOOKBACK_BARS;

  for (const product of candleProductsFor(asset)) {
    const url = new URL(`${COINBASE_CANDLES_API}/${encodeURIComponent(`${product}-USD`)}/candles`);
    url.searchParams.set("granularity", String(granularity));
    url.searchParams.set("start", new Date(start * 1000).toISOString());
    url.searchParams.set("end", new Date(now * 1000).toISOString());
    try {
      const payload = await fetchJson<unknown>(url.toString(), { signal });
      if (!Array.isArray(payload)) continue;
      const candles = payload.flatMap((row): MarketCandle[] => {
        if (!Array.isArray(row) || row.length < 5) return [];
        const [timeValue, lowValue, highValue, openValue, closeValue, volumeValue] = row;
        const timestampSeconds = finiteNumber(timeValue);
        const low = finiteNumber(lowValue);
        const high = finiteNumber(highValue);
        const open = finiteNumber(openValue);
        const close = finiteNumber(closeValue);
        const volume = finiteNumber(volumeValue) ?? 0;
        if (timestampSeconds === null || low === null || high === null || open === null || close === null) return [];
        if (Math.min(low, high, open, close) <= 0 || high < low || volume < 0) return [];
        return [{ timestamp: timestampSeconds * 1000, low, high, open, close, volume }];
      });
      return candles.sort((left, right) => left.timestamp - right.timestamp);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return [];
};

export async function fetchCandleHistories(assets: Asset[], signal?: AbortSignal): Promise<Map<Asset, CandleHistory>> {
  const uniqueAssets = [...new Set(assets)].filter(Boolean);
  const histories = new Map<Asset, CandleHistory>();
  const now = Date.now();
  const missing: Asset[] = [];

  for (const asset of uniqueAssets) {
    const cached = candleHistoryCache.get(asset);
    if (cached && now - cached.updatedAt < CANDLE_CACHE_MS) histories.set(asset, cached);
    else missing.push(asset);
  }

  for (let index = 0; index < missing.length; index += 4) {
    const chunk = missing.slice(index, index + 4);
    const fetched = await Promise.all(chunk.map(async (asset) => {
      const [fiveMinute, fifteenMinute] = await Promise.all([
        fetchCoinbaseCandles(asset, 300, signal),
        fetchCoinbaseCandles(asset, 900, signal),
      ]);
      const history = { fiveMinute, fifteenMinute, updatedAt: Date.now() };
      candleHistoryCache.set(asset, history);
      return [asset, history] as const;
    }));
    for (const [asset, history] of fetched) histories.set(asset, history);
  }

  return histories;
}

const bestBid = (book: OrderBook | null): number | null => book?.bids.length ? Math.max(...book.bids.map((level) => level.price)) : null;
const bestAsk = (book: OrderBook | null): number | null => book?.asks.length ? Math.min(...book.asks.map((level) => level.price)) : null;
const depthNotional = (book: OrderBook | null): number => book?.asks.slice(0, 8).reduce((sum, level) => sum + level.price * level.size, 0) ?? 0;
const topSize = (book: OrderBook | null): number => (book?.asks[0]?.size ?? 0) + (book?.bids[book.bids.length - 1]?.size ?? 0);

const withUpdatedBooks = (market: LiveMarket, upBook: OrderBook | null, downBook: OrderBook | null, now: number): LiveMarket => {
  const upBid = bestBid(upBook); const upAsk = bestAsk(upBook);
  const downBid = bestBid(downBook); const downAsk = bestAsk(downBook);
  const spreads = [upBid !== null && upAsk !== null ? upAsk - upBid : null, downBid !== null && downAsk !== null ? downAsk - downBid : null].filter((value): value is number => value !== null);
  const upDepth = depthNotional(upBook); const downDepth = depthNotional(downBook); const total = upDepth + downDepth;
  const spread = spreads.length ? Math.max(...spreads) : null;
  return { ...market, upBook, downBook, upBid, upAsk, downBid, downAsk, spread, liquidity: total, imbalance: total > 0 ? (upDepth - downDepth) / total : null, edgeUp: market.fairUp !== null && upAsk !== null ? market.fairUp - upAsk : null, edgeDown: market.fairUp !== null && downAsk !== null ? 1 - market.fairUp - downAsk : null, sourceTimestamp: now };
};

export const replaceLiveMarketBook = (market: LiveMarket, tokenId: string, bids: BookLevel[], asks: BookLevel[], timestamp: number | null, hash: string | null, now = Date.now()): LiveMarket => {
  const existing = tokenId === market.upTokenId ? market.upBook ?? { tokenId, bids: [], asks: [], timestamp: null, minOrderSize: null, hash: null } : tokenId === market.downTokenId ? market.downBook ?? { tokenId, bids: [], asks: [], timestamp: null, minOrderSize: null, hash: null } : null;
  if (!existing) return market;
  const book: OrderBook = { ...existing, bids: bids.filter((level) => level.price > 0 && level.size > 0).sort((left, right) => right.price - left.price), asks: asks.filter((level) => level.price > 0 && level.size > 0).sort((left, right) => left.price - right.price), timestamp, hash };
  return tokenId === market.upTokenId ? withUpdatedBooks(market, book, market.downBook, now) : withUpdatedBooks(market, market.upBook, book, now);
};

export const updateLiveMarketBookLevel = (market: LiveMarket, tokenId: string, side: "BUY" | "SELL", price: number, size: number, now = Date.now()): LiveMarket => {
  const existing = tokenId === market.upTokenId ? market.upBook ?? { tokenId, bids: [], asks: [], timestamp: null, minOrderSize: null, hash: null } : tokenId === market.downTokenId ? market.downBook ?? { tokenId, bids: [], asks: [], timestamp: null, minOrderSize: null, hash: null } : null;
  if (!existing || price <= 0 || !Number.isFinite(price) || !Number.isFinite(size)) return market;
  const sideKey = side === "BUY" ? "bids" : "asks";
  const levels = existing[sideKey].filter((level) => level.price !== price);
  if (size > 0) levels.push({ price, size });
  const book = { ...existing, [sideKey]: levels.sort((left, right) => side === "BUY" ? right.price - left.price : left.price - right.price), timestamp: now };
  return tokenId === market.upTokenId ? withUpdatedBooks(market, book, market.downBook, now) : withUpdatedBooks(market, market.upBook, book, now);
};

const normalCdf = (value: number): number => {
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = 0.3989422804014327 * Math.exp(-0.5 * absolute * absolute);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value >= 0 ? 1 - tail : tail;
};

const returnVolatility = (closes: number[]): number | null => {
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  if (returns.length < 12) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const volatility = Math.sqrt(variance);
  return Number.isFinite(volatility) && volatility > 0 ? volatility : null;
};

/**
 * Per-bar volatility. A calm 20-bar stretch understates the moves that decide
 * these markets, so use the larger of the recent and the longer (up to 80-bar)
 * estimate. Underestimated volatility is what turns a small spot lead into a
 * falsely confident probability.
 */
const candleVolatility = (candles: MarketCandle[], durationSeconds: number, now: number): number | null => {
  const completed = candles.filter((candle) => candle.timestamp + durationSeconds * 1000 <= now && candle.close > 0);
  if (completed.length < 20) return null;
  const closes = completed.map((candle) => candle.close);
  const recent = returnVolatility(closes.slice(-21));
  const longer = returnVolatility(closes.slice(-81));
  if (recent === null) return longer;
  return longer === null ? recent : Math.max(recent, longer);
};

export const chartFairProbability = (
  reference: number | null,
  spot: number | null,
  remainingSeconds: number,
  duration: Horizon,
  candles: MarketCandle[],
  now: number,
): number | null => {
  if (reference === null || spot === null || reference <= 0 || spot <= 0) return null;
  const barSeconds = duration === "5m" ? 300 : 900;
  const volatility = candleVolatility(candles, barSeconds, now);
  if (volatility === null) return null;
  const remainingBars = Math.max(1 / 60, remainingSeconds / barSeconds);
  const sigmaRemaining = volatility * Math.sqrt(remainingBars);
  if (!Number.isFinite(sigmaRemaining) || sigmaRemaining <= 0) return null;
  const zScore = Math.log(spot / reference) / sigmaRemaining;
  return clamp(normalCdf(zScore), 0.01, 0.99);
};

export const estimateFairProbability = (reference: number | null, spot: number | null, remainingSeconds: number): number | null => {
  if (reference === null || spot === null || reference <= 0 || spot <= 0) return null;
  const distance = (spot - reference) / reference;
  const timeScale = Math.sqrt(900 / Math.max(30, remainingSeconds));
  return clamp(0.5 + distance * 12 * timeScale, 0.04, 0.96);
};

export const buildLiveMarket = (
  definition: MarketDefinition,
  books: Map<string, OrderBook>,
  _spots: Map<Asset, number>,
  _previousSpot: number | null,
  now = Date.now(),
  candleHistory: CandleHistory | null = null,
): LiveMarket => {
  const upBook = books.get(definition.upTokenId) ?? null;
  const downBook = books.get(definition.downTokenId) ?? null;
  // Coinbase spot and candle opens are useful for volatility research, but
  // cannot be compared with a Chainlink TWAP target. Wait for the market's
  // configured Polymarket feed before calculating an entry probability.
  const spot = null;
  const marketNow = synchronizedPolymarketTime(now);
  const remaining = Math.max(0, Math.ceil((definition.endTime - marketNow) / 1000));
  const chart5m = candleHistory?.fiveMinute ?? [];
  const chart15m = candleHistory?.fifteenMinute ?? [];
  const reference = definition.priceFeed !== "UNSUPPORTED" ? definition.reference : null;
  const referenceSource = reference !== null ? definition.referenceSource : "MISSING";
  const targetCandles = definition.duration === "5m" ? chart5m : chart15m;
  const fairUp = chartFairProbability(reference, spot, remaining, definition.duration, targetCandles, marketNow);
  const upBid = bestBid(upBook);
  const upAsk = bestAsk(upBook);
  const downBid = bestBid(downBook);
  const downAsk = bestAsk(downBook);
  const edgeUp = fairUp !== null && upAsk !== null ? fairUp - upAsk : null;
  const edgeDown = fairUp !== null && downAsk !== null ? 1 - fairUp - downAsk : null;
  const spreadValues = [upBid !== null && upAsk !== null ? upAsk - upBid : null, downBid !== null && downAsk !== null ? downAsk - downBid : null].filter((value): value is number => value !== null);
  const spread = spreadValues.length ? Math.max(...spreadValues) : null;
  const upDepth = depthNotional(upBook);
  const downDepth = depthNotional(downBook);
  const totalDepth = upDepth + downDepth;
  const imbalance = totalDepth > 0 ? (upDepth - downDepth) / totalDepth : null;
  const distance = reference !== null && spot !== null ? (spot - reference) / reference : null;
  const momentum = null;
  const regime = reference === null ? "REFERENCE MISSING" : distance === null ? "SPOT MISSING" : Math.abs(distance) < 0.0002 ? "NEUTRAL" : distance > 0 ? "UP MOMENTUM" : "DOWN MOMENTUM";
  return {
    ...definition,
    remaining,
    countdownEndsAt: definition.endTime - polymarketClockOffsetMs,
    reference,
    referenceSource,
    spot,
    spotSource: "MISSING",
    spotUpdatedAt: null,
    referenceUpdatedAt: reference !== null ? definition.startTime : null,
    referenceVerified: reference !== null && definition.referenceSource === "POLYMARKET",
    upBook,
    downBook,
    upBid,
    upAsk,
    downBid,
    downAsk,
    fairUp,
    edgeUp,
    edgeDown,
    spread,
    liquidity: upDepth + downDepth,
    imbalance,
    momentum,
    distance,
    regime,
    sourceTimestamp: now,
    chart5m,
    chart15m,
    chartUpdatedAt: candleHistory?.updatedAt ?? null,
  };
};

/** Apply observations only from the oracle feed specified by this market. */
export const applyPolymarketPriceTicks = (
  market: LiveMarket,
  ticks: readonly PolymarketPriceTick[],
  now = Date.now(),
): LiveMarket => {
  if (market.priceFeed === "UNSUPPORTED") return market;
  const marketNow = synchronizedPolymarketTime(now);
  const matching = ticks.filter((tick) => tick.asset === market.asset && tick.priceFeed === market.priceFeed
    && Number.isFinite(tick.price) && tick.price > 0 && Number.isFinite(tick.timestamp)
    && tick.timestamp <= marketNow + 1000 && tick.timestamp <= market.endTime
    && (market.startTime === null || tick.timestamp >= market.startTime));
  let reference = market.referenceVerified && market.referenceSource === "POLYMARKET" ? market.reference : null;
  let referenceUpdatedAt = reference !== null ? market.referenceUpdatedAt : null;
  if (reference === null && market.startTimeVerified && market.startTime !== null) {
    // The market rules compare the oracle reading at the beginning of the
    // named window. A nearby reading is not the published price to beat.
    const opening = matching.find((tick) => tick.timestamp === market.startTime);
    if (opening) {
      reference = opening.price;
      referenceUpdatedAt = opening.timestamp;
    }
  }
  const latest = matching.filter((tick) => tick.timestamp >= marketNow - 10_000)
    .reduce<PolymarketPriceTick | null>((current, tick) => !current || tick.timestamp > current.timestamp ? tick : current, null);
  const priorSpotFresh = market.spotSource === "POLYMARKET" && market.spotUpdatedAt !== null
    && market.spotUpdatedAt >= marketNow - 10_000 && market.spotUpdatedAt <= marketNow + 1000;
  const useLatest = latest !== null && (!priorSpotFresh || latest.timestamp >= market.spotUpdatedAt!);
  const spot = useLatest ? latest.price : priorSpotFresh ? market.spot : null;
  const spotUpdatedAt = useLatest ? latest.timestamp : priorSpotFresh ? market.spotUpdatedAt : null;
  const remaining = Math.max(0, Math.ceil((market.endTime - marketNow) / 1000));
  const fairUp = chartFairProbability(reference, spot, remaining, market.duration,
    market.duration === "5m" ? market.chart5m : market.chart15m, marketNow);
  const distance = reference !== null && spot !== null ? (spot - reference) / reference : null;
  const momentum = spot !== null && market.spot !== null && market.spot > 0
    ? Math.log(spot / market.spot) : null;
  const spotHistory = [...(market.spotHistory ?? []), ...matching]
    .filter((tick) => tick.timestamp >= marketNow - 120_000 && tick.timestamp <= marketNow + 1000)
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter((tick, index, points) => index === points.length - 1 || tick.timestamp !== points[index + 1].timestamp)
    .slice(-180);
  const regime = reference === null ? "REFERENCE MISSING" : spot === null ? "SPOT MISSING" :
    Math.abs(distance!) < 0.0002 ? "NEUTRAL" : distance! > 0 ? "UP MOMENTUM" : "DOWN MOMENTUM";
  if (spot === market.spot && spotUpdatedAt === market.spotUpdatedAt && reference === market.reference
    && referenceUpdatedAt === market.referenceUpdatedAt && market.remaining === remaining
    && spotHistory.length === (market.spotHistory ?? []).length
    && spotHistory.at(-1)?.timestamp === market.spotHistory?.at(-1)?.timestamp) return market;
  return {
    ...market,
    reference,
    referenceSource: reference !== null ? "POLYMARKET" : "MISSING",
    referenceUpdatedAt,
    referenceVerified: reference !== null,
    spot,
    spotSource: spot !== null ? "POLYMARKET" : "MISSING",
    spotUpdatedAt,
    spotHistory,
    remaining,
    fairUp,
    edgeUp: fairUp !== null && market.upAsk !== null ? fairUp - market.upAsk : null,
    edgeDown: fairUp !== null && market.downAsk !== null ? 1 - fairUp - market.downAsk : null,
    distance,
    momentum,
    regime,
    sourceTimestamp: spotUpdatedAt ?? market.sourceTimestamp,
  };
};

export const updateLiveCandles = (market: LiveMarket, spot: number, now = Date.now()): Pick<LiveMarket, "chart5m" | "chart15m"> => {
  const update = (history: MarketCandle[], seconds: 300 | 900): MarketCandle[] => {
    const start = Math.floor(now / (seconds * 1000)) * seconds * 1000;
    const current = history[history.length - 1];
    if (current?.timestamp === start) {
      return [...history.slice(0, -1), { ...current, high: Math.max(current.high, spot), low: Math.min(current.low, spot), close: spot }];
    }
    if (current && current.timestamp > start) return history;
    const open = current?.close ?? spot;
    return [...history, { timestamp: start, low: Math.min(open, spot), high: Math.max(open, spot), open, close: spot, volume: 0 }].slice(-CANDLE_LOOKBACK_BARS);
  };
  return { chart5m: update(market.chart5m, 300), chart15m: update(market.chart15m, 900) };
};

export const orderBookFor = (market: LiveMarket, side: "UP" | "DOWN"): OrderBook | null => side === "UP" ? market.upBook : market.downBook;

export const bestBidFor = (market: LiveMarket, side: "UP" | "DOWN"): number | null => side === "UP" ? market.upBid : market.downBid;

export const bestAskFor = (market: LiveMarket, side: "UP" | "DOWN"): number | null => side === "UP" ? market.upAsk : market.downAsk;

/**
 * Weight on the candle model in log-odds space; the order book gets the rest.
 * Recorded paper runs showed the unanchored model calling long shots 20+ points
 * underpriced, and 14 of the 15 entries it took below 30c lost. Until settled
 * outcomes fit a stacking weight (outcome ~ logit(model) + logit(market)),
 * treat the model as a small adjustment to the market price, not a replacement.
 */
export const MODEL_LOGIT_WEIGHT = 0.25;

const PROBABILITY_FLOOR = 0.01;
const logit = (probability: number) => {
  const bounded = clamp(probability, PROBABILITY_FLOOR, 1 - PROBABILITY_FLOOR);
  return Math.log(bounded / (1 - bounded));
};
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

const bookMid = (bid: number | null, ask: number | null): number | null =>
  bid !== null && ask !== null && Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask < 1 && ask >= bid
    ? (bid + ask) / 2 : null;

/** P(UP) implied by the two order books' midpoints; null when neither book has a two-sided quote. */
export const marketImpliedProbabilityUp = (market: Pick<LiveMarket, "upBid" | "upAsk" | "downBid" | "downAsk">): number | null => {
  const upMid = bookMid(market.upBid, market.upAsk);
  const downMid = bookMid(market.downBid, market.downAsk);
  if (upMid !== null && downMid !== null) return (upMid + 1 - downMid) / 2;
  if (upMid !== null) return upMid;
  return downMid !== null ? 1 - downMid : null;
};

/** Pool the model and market probabilities in log-odds space. */
export const anchorProbability = (modelUp: number, marketUp: number, modelWeight = MODEL_LOGIT_WEIGHT): number => {
  const weight = clamp(Number.isFinite(modelWeight) ? modelWeight : MODEL_LOGIT_WEIGHT, 0, 1);
  return sigmoid(weight * logit(modelUp) + (1 - weight) * logit(marketUp));
};

/**
 * The probability every edge, entry, and exit decision should use: the raw
 * candle model pulled toward the live order book. Without a two-sided quote
 * there is nothing to anchor to, so no probability is claimed.
 */
export const anchoredFairUp = (market: LiveMarket): number | null => {
  if (market.fairUp === null) return null;
  const marketUp = marketImpliedProbabilityUp(market);
  return marketUp === null ? null : anchorProbability(market.fairUp, marketUp);
};

export const sideFairProbability = (market: LiveMarket, side: "UP" | "DOWN"): number | null => {
  const fairUp = anchoredFairUp(market);
  return fairUp === null ? null : side === "UP" ? fairUp : 1 - fairUp;
};

export const bookTopSize = (market: LiveMarket, side: "UP" | "DOWN") => topSize(orderBookFor(market, side));
