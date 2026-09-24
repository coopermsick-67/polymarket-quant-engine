import type { Asset, PolymarketPriceTick } from "./polymarket-data";

export type PolymarketPriceStreamStatus = "CONNECTING" | "CONNECTED" | "DISCONNECTED";

const RTDS_URL = "wss://ws-live-data.polymarket.com";
const HEARTBEAT_MS = 5_000;
const WATCHDOG_CHECK_MS = 2_000;
const TICK_STALE_MS = 8_000;
const STABLE_HEALTH_MS = 30_000;
const MAX_RECONNECT_MS = 10_000;

const feedForTopic = (topic: unknown): PolymarketPriceTick["priceFeed"] | null => {
  if (topic === "crypto_prices_twap_sixty") return "TWAP_60";
  if (topic === "crypto_prices_chainlink") return "CHAINLINK_SPOT";
  return null;
};

/** Decode both RTDS historical snapshots and subsequent live observations. */
export const parsePolymarketPriceMessage = (raw: unknown): PolymarketPriceTick[] => {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    message = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const priceFeed = feedForTopic(message.topic);
  if (!priceFeed || (message.type !== "subscribe" && message.type !== "update")) return [];
  const payload = message.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  if (typeof record.symbol !== "string" || !/^[a-z0-9]+\/usd$/i.test(record.symbol)) return [];
  if (priceFeed === "TWAP_60" && Number(record.window_s ?? record.windowSeconds) !== 60) return [];
  const asset = record.symbol.split("/")[0].toUpperCase();
  const rows = message.type === "subscribe" ? record.data : [record];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): PolymarketPriceTick[] => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const point = row as Record<string, unknown>;
    const timestamp = Number(point.timestamp);
    const fullAccuracy = point.full_accuracy_value ?? point.fullAccuracyValue;
    // Legacy RTDS publishes full_accuracy_value as an integer scaled by 1e18.
    // Prefer that value for a precise decimal parse, but never interpret the
    // encoded integer itself as a USD price. The `value` field is the fallback.
    const exactPrice = typeof fullAccuracy === "string" && /^\d+$/.test(fullAccuracy)
      ? Number(`${fullAccuracy.slice(0, -18) || "0"}.${fullAccuracy.slice(-18).padStart(18, "0")}`)
      : Number.NaN;
    const price = Number.isFinite(exactPrice) ? exactPrice : Number(point.value);
    if (!Number.isSafeInteger(timestamp) || timestamp < 1_500_000_000_000
      || !Number.isFinite(price) || price <= 0) return [];
    return [{ asset, priceFeed, timestamp, price }];
  });
};

/**
 * Subscribe to the public Polymarket RTDS oracle feeds. The caller should keep
 * opening observations until its active markets expire. Snapshot history is
 * delivered as one batch and live updates as single-observation batches.
 */
export const subscribePolymarketPrices = (
  assets: readonly Asset[],
  onTicks: (ticks: PolymarketPriceTick[]) => void,
  onStatus?: (status: PolymarketPriceStreamStatus) => void,
  signal?: AbortSignal,
): (() => void) => {
  const symbols = [...new Set(assets.map((asset) => asset.toLowerCase()).filter((asset) => /^[a-z0-9]+$/.test(asset)))];
  if (!symbols.length || signal?.aborted) return () => undefined;
  let closed = false;
  let socket: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let openedAt = 0;
  let lastTickAt = 0;

  const clearTimers = () => {
    if (heartbeat !== null) clearInterval(heartbeat);
    if (watchdog !== null) clearInterval(watchdog);
    if (reconnect !== null) clearTimeout(reconnect);
    heartbeat = null;
    watchdog = null;
    reconnect = null;
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimers();
    signal?.removeEventListener("abort", stop);
    socket?.close();
    socket = null;
    onStatus?.("DISCONNECTED");
  };
  const connect = () => {
    if (closed || signal?.aborted) return;
    onStatus?.("CONNECTING");
    let ws: WebSocket;
    try {
      ws = new WebSocket(RTDS_URL);
    } catch {
      onStatus?.("DISCONNECTED");
      const delay = Math.min(MAX_RECONNECT_MS, 500 * 2 ** Math.min(attempt, 5));
      attempt += 1;
      reconnect = setTimeout(connect, delay);
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (closed || socket !== ws) return;
      openedAt = Date.now();
      lastTickAt = 0;
      ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: symbols.flatMap((symbol) => ([
          { topic: "crypto_prices_twap_sixty", type: "*", filters: JSON.stringify({ symbol: `${symbol}/usd` }) },
          { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: `${symbol}/usd` }) },
        ])),
      }));
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, HEARTBEAT_MS);
      watchdog = setInterval(() => {
        if (closed || socket !== ws) return;
        const lastHealthyAt = lastTickAt || openedAt;
        if (Date.now() - lastHealthyAt > TICK_STALE_MS) ws.close();
      }, WATCHDOG_CHECK_MS);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (closed || socket !== ws) return;
      const ticks = parsePolymarketPriceMessage(event.data);
      if (!ticks.length) return;
      const receivedAt = Date.now();
      lastTickAt = receivedAt;
      if (receivedAt - openedAt >= STABLE_HEALTH_MS) attempt = 0;
      onTicks(ticks);
      onStatus?.("CONNECTED");
    };
    ws.onerror = () => {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (heartbeat !== null) clearInterval(heartbeat);
      if (watchdog !== null) clearInterval(watchdog);
      heartbeat = null;
      watchdog = null;
      onStatus?.("DISCONNECTED");
      if (!closed && !signal?.aborted) {
        const delay = Math.min(MAX_RECONNECT_MS, 500 * 2 ** Math.min(attempt, 5));
        attempt += 1;
        reconnect = setTimeout(connect, delay);
      }
    };
  };
  signal?.addEventListener("abort", stop, { once: true });
  connect();
  return stop;
};

/** Collect a bounded snapshot for a single server-side order preflight. */
export const readPolymarketPriceTicks = (
  markets: readonly { asset: Asset; priceFeed: PolymarketPriceTick["priceFeed"]; startTime: number }[],
  timeoutMs = 3_000,
  signal?: AbortSignal,
): Promise<PolymarketPriceTick[]> => {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Oracle read aborted."));
  if (!markets.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const ticks = new Map<string, PolymarketPriceTick>();
    let stop: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let complete = false;
    const finish = (error?: unknown) => {
      if (complete) return;
      complete = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      stop();
      if (error) reject(error);
      else resolve([...ticks.values()]);
    };
    const abort = () => finish(signal?.reason ?? new Error("Oracle read aborted."));
    timer = setTimeout(() => finish(), Math.max(500, timeoutMs));
    signal?.addEventListener("abort", abort, { once: true });
    stop = subscribePolymarketPrices([...new Set(markets.map((market) => market.asset))], (batch) => {
      for (const tick of batch) ticks.set(`${tick.asset}:${tick.priceFeed}:${tick.timestamp}`, tick);
      const now = Date.now();
      const ready = markets.every((market) => {
        const rows = [...ticks.values()].filter((tick) => tick.asset === market.asset && tick.priceFeed === market.priceFeed);
        const opening = rows.some((tick) => tick.timestamp === market.startTime);
        const current = rows.some((tick) => tick.timestamp >= now - 10_000 && tick.timestamp <= now + 1_000);
        return opening && current;
      });
      if (ready) finish();
    }, undefined, signal);
  });
};
