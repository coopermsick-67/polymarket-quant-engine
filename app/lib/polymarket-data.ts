export type Horizon = "5m" | "15m";
export type Asset = string;

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

export type MarketDefinition = {
  id: string;
  conditionId: string | null;
  slug: string;
  question: string;
  asset: Asset;
  duration: Horizon;
  startTime: number | null;
  endTime: number;
  reference: number | null;
  upTokenId: string;
  downTokenId: string;
  sourceUrl: string;
};

export type LiveMarket = MarketDefinition & {
  remaining: number;
  spot: number | null;
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
};

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const SPOT_API = "https://api.coinbase.com/v2/prices";
const CRYPTO_TAG_ID = "21";
const GAMMA_PAGE_SIZE = 100;
const GAMMA_MAX_PAGES = 8;
const GAMMA_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;
const DISCOVERY_CACHE_MS = 5_000;
const POLYMARKET_TIME_CACHE_MS = 15_000;
const PUBLIC_REQUEST_TIMEOUT_MS = 15_000;
const CLOB_BATCH_SIZE = 500;

let polymarketClockOffsetMs = 0;
let polymarketClockSyncedAt = 0;

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

const referenceFor = (raw: Record<string, unknown>, text: string): number | null => {
  const directKeys = [
    "referencePrice", "reference_price", "strikePrice", "strike_price", "targetPrice", "target_price",
    "startPrice", "start_price", "priceToBeat", "price_to_beat", "threshold",
  ];
  for (const key of directKeys) {
    const candidate = finiteNumber(raw[key]);
    if (candidate !== null && candidate > 0) return candidate;
  }

  const description = normalizeText(raw.description);
  const searchText = description + " " + text;
  const patterns = [
    /(?:reference|starting|start|threshold|strike|price\s+to\s+beat)[^$0-9]{0,50}\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i,
    /(?:above|below)[^$0-9]{0,24}\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = searchText.match(pattern);
    const candidate = match ? Number(match[1].replace(/,/g, "")) : null;
    if (candidate !== null && Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return null;
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
  const alignedStartTime = startTime ?? endTime - (duration === "5m" ? 300_000 : 900_000);

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
    endTime,
    reference: referenceFor(raw, text),
    upTokenId,
    downTokenId,
    sourceUrl: slug ? `https://polymarket.com/market/${slug}` : "https://polymarket.com",
  };
};

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const timeoutController = new AbortController();
  const timeoutId = globalThis.setTimeout(() => timeoutController.abort(), PUBLIC_REQUEST_TIMEOUT_MS);
  const upstreamSignal = init?.signal;
  const abortRequest = () => timeoutController.abort();
  if (upstreamSignal?.aborted) timeoutController.abort();
  else upstreamSignal?.addEventListener("abort", abortRequest, { once: true });

  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: timeoutController.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json() as Promise<T>;
  } catch (error) {
    if (timeoutController.signal.aborted && !upstreamSignal?.aborted) throw new Error(`Public request timed out after ${PUBLIC_REQUEST_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortRequest);
  }
};

const polymarketNow = () => Date.now() + polymarketClockOffsetMs;

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
  let emptyDefinitionPages = 0;
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
    const pageHasShortMarket = pageRows.some((row) => horizonFor(
      [normalizeText(row.question), normalizeText(row.slug), normalizeText(row.description)].join(" "),
      normalizeText(row.slug),
      row,
      intervalStartFor(row, normalizeText(row.slug)),
      intervalEndFor(row),
    ) !== null);
    emptyDefinitionPages = pageHasShortMarket ? 0 : emptyDefinitionPages + 1;

    const nextCursor = nextCursorFor(payload);
    if (!nextCursor || nextCursor === afterCursor || pageRows.length === 0 || emptyDefinitionPages >= 3) break;
    afterCursor = nextCursor;
  }

  return { rows, now };
};

let discoveryCache: { value: MarketDefinition[]; timestamp: number } | null = null;
let discoveryInFlight: Promise<MarketDefinition[]> | null = null;

const discoverCryptoMarketsFresh = async (signal?: AbortSignal): Promise<MarketDefinition[]> => {
  const { rows: directMarkets, now } = await fetchCryptoMarketRows(signal);
  const seen = new Set<string>();
  return directMarkets
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
};

export async function discoverCryptoMarkets(signal?: AbortSignal): Promise<MarketDefinition[]> {
  if (discoveryCache && Date.now() - discoveryCache.timestamp < DISCOVERY_CACHE_MS) return discoveryCache.value;
  if (!discoveryInFlight) {
    discoveryInFlight = discoverCryptoMarketsFresh(signal)
      .then((value) => {
        discoveryCache = { value, timestamp: Date.now() };
        return value;
      })
      .finally(() => {
        discoveryInFlight = null;
      });
  }
  return discoveryInFlight;
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
      const entries = await Promise.all(chunk.map(async (tokenId) => {
        try {
          const payload = await fetchJson<Record<string, unknown>>(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`, { signal });
          return [tokenId, parseBook(payload, tokenId)] as const;
        } catch {
          return null;
        }
      }));
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

const bestBid = (book: OrderBook | null): number | null => book?.bids.length ? Math.max(...book.bids.map((level) => level.price)) : null;
const bestAsk = (book: OrderBook | null): number | null => book?.asks.length ? Math.min(...book.asks.map((level) => level.price)) : null;
const depthNotional = (book: OrderBook | null): number => book?.asks.slice(0, 8).reduce((sum, level) => sum + level.price * level.size, 0) ?? 0;
const topSize = (book: OrderBook | null): number => (book?.asks[0]?.size ?? 0) + (book?.bids[book.bids.length - 1]?.size ?? 0);

export const estimateFairProbability = (reference: number | null, spot: number | null, remainingSeconds: number): number | null => {
  if (reference === null || spot === null || reference <= 0 || spot <= 0) return null;
  const distance = (spot - reference) / reference;
  const timeScale = Math.sqrt(900 / Math.max(30, remainingSeconds));
  return clamp(0.5 + distance * 12 * timeScale, 0.04, 0.96);
};

export const buildLiveMarket = (
  definition: MarketDefinition,
  books: Map<string, OrderBook>,
  spots: Map<Asset, number>,
  previousSpot: number | null,
  now = Date.now(),
): LiveMarket => {
  const upBook = books.get(definition.upTokenId) ?? null;
  const downBook = books.get(definition.downTokenId) ?? null;
  const spot = spots.get(definition.asset) ?? null;
  const remaining = Math.max(0, Math.ceil((definition.endTime - (now + polymarketClockOffsetMs)) / 1000));
  const fairUp = estimateFairProbability(definition.reference, spot, remaining);
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
  const distance = definition.reference !== null && spot !== null ? (spot - definition.reference) / definition.reference : null;
  const momentum = previousSpot !== null && spot !== null && previousSpot > 0 ? Math.log(spot / previousSpot) : null;
  const regime = definition.reference === null ? "REFERENCE MISSING" : distance === null ? "SPOT MISSING" : Math.abs(distance) < 0.0002 ? "NEUTRAL" : distance > 0 ? "UP MOMENTUM" : "DOWN MOMENTUM";
  return {
    ...definition,
    remaining,
    spot,
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
  };
};

export const orderBookFor = (market: LiveMarket, side: "UP" | "DOWN"): OrderBook | null => side === "UP" ? market.upBook : market.downBook;

export const bestBidFor = (market: LiveMarket, side: "UP" | "DOWN"): number | null => side === "UP" ? market.upBid : market.downBid;

export const bestAskFor = (market: LiveMarket, side: "UP" | "DOWN"): number | null => side === "UP" ? market.upAsk : market.downAsk;

export const sideFairProbability = (market: LiveMarket, side: "UP" | "DOWN"): number | null => market.fairUp === null ? null : side === "UP" ? market.fairUp : 1 - market.fairUp;

export const bookTopSize = (market: LiveMarket, side: "UP" | "DOWN") => topSize(orderBookFor(market, side));
