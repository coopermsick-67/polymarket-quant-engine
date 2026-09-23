import { Buffer } from "node:buffer";
import type { RawRecordedMessage, RecordedVenueTick } from "./recording-store";

export const RECORDED_ASSETS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "ZEC"] as const;
export type RecordedAsset = (typeof RECORDED_ASSETS)[number];
export type VenueSource = "binance:spot" | "binance:perp" | "bybit:spot" | "bybit:perp" | "okx:public";

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

type ConnectionSpec = {
  source: VenueSource;
  url: string;
  subscribe?: string;
  heartbeat?: string;
  heartbeatMs?: number;
};

export type VenueFeedOptions = {
  WebSocketImpl?: SocketFactory;
  assets?: readonly string[];
  onRaw: (message: RawRecordedMessage) => void;
  onTick: (tick: RecordedVenueTick) => void;
  onStatus?: (source: VenueSource, status: "CONNECTING" | "LIVE" | "DOWN", detail?: string) => void;
};

const cleanAsset = (symbol: string) =>
  symbol
    .toUpperCase()
    .replace(/[-_](USDT|USD|USDC)(-SWAP)?$/i, "")
    .replace(/(USDT|USDC|USD)$/i, "");
const marketTypeFromSource = (source: string): "spot" | "perp" => (source.endsWith(":perp") ? "perp" : "spot");

export const parseVenueTicks = (source: VenueSource, raw: string, receivedAt: number): RecordedVenueTick[] => {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }
  const venue = source.split(":")[0] as RecordedVenueTick["venue"];
  const defaultMarketType = marketTypeFromSource(source);
  const make = (assetValue: unknown, priceValue: unknown, timestampValue: unknown, marketType = defaultMarketType) => {
    const asset = typeof assetValue === "string" ? cleanAsset(assetValue) : "";
    const price = Number(priceValue);
    const exchangeAt = Number(timestampValue);
    if (!RECORDED_ASSETS.includes(asset as RecordedAsset) || !(price > 0) || !Number.isFinite(exchangeAt)) return null;
    return { receivedAt, exchangeAt, venue, marketType, asset, price } satisfies RecordedVenueTick;
  };

  if (venue === "binance") {
    const trade = (message.data && typeof message.data === "object" ? message.data : message) as Record<string, unknown>;
    const tick = make(trade.s, trade.p, trade.T ?? trade.E);
    return tick ? [tick] : [];
  }

  if (venue === "bybit") {
    const rows = Array.isArray(message.data) ? message.data : [];
    return rows
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const trade = row as Record<string, unknown>;
        return make(trade.s, trade.p, trade.T ?? trade.ts);
      })
      .filter((tick): tick is RecordedVenueTick => tick !== null);
  }

  const arg = message.arg && typeof message.arg === "object" ? (message.arg as Record<string, unknown>) : {};
  const instrument = typeof arg.instId === "string" ? arg.instId : "";
  const marketType = instrument.endsWith("-SWAP") ? "perp" : "spot";
  const rows = Array.isArray(message.data) ? message.data : [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const trade = row as Record<string, unknown>;
      return make(instrument, trade.px, trade.ts, marketType);
    })
    .filter((tick): tick is RecordedVenueTick => tick !== null);
};

const makeSpecs = (assets: readonly string[]): ConnectionSpec[] => {
  const symbols = assets.map((asset) => `${asset.toLowerCase()}usdt`);
  const binanceStreams = symbols.map((symbol) => `${symbol}@trade`).join("/");
  const bybitTopics = assets.map((asset) => `publicTrade.${asset}USDT`);
  const okxArgs = assets.flatMap((asset) => [
    { channel: "trades", instId: `${asset}-USDT` },
    { channel: "trades", instId: `${asset}-USDT-SWAP` },
  ]);
  return [
    { source: "binance:spot", url: `wss://stream.binance.com:9443/stream?streams=${binanceStreams}` },
    { source: "binance:perp", url: `wss://fstream.binance.com/stream?streams=${binanceStreams}` },
    {
      source: "bybit:spot",
      url: "wss://stream.bybit.com/v5/public/spot",
      subscribe: JSON.stringify({ op: "subscribe", args: bybitTopics }),
      heartbeat: JSON.stringify({ op: "ping" }),
      heartbeatMs: 15_000,
    },
    {
      source: "bybit:perp",
      url: "wss://stream.bybit.com/v5/public/linear",
      subscribe: JSON.stringify({ op: "subscribe", args: bybitTopics }),
      heartbeat: JSON.stringify({ op: "ping" }),
      heartbeatMs: 15_000,
    },
    {
      source: "okx:public",
      url: "wss://ws.okx.com:8443/ws/v5/public",
      subscribe: JSON.stringify({ op: "subscribe", args: okxArgs }),
      heartbeat: "ping",
      heartbeatMs: 20_000,
    },
  ];
};

type Connection = {
  spec: ConnectionSpec;
  socket: SocketLike | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  attempt: number;
};

export class VenueFeedRecorder {
  private readonly connections: Connection[];
  private stopped = true;
  private readonly Socket: SocketFactory;

  constructor(private readonly options: VenueFeedOptions) {
    const WebSocketImpl = options.WebSocketImpl ?? (globalThis.WebSocket as unknown as SocketFactory | undefined);
    if (!WebSocketImpl) throw new Error("This Node runtime does not provide WebSocket support.");
    this.Socket = WebSocketImpl;
    const assets = options.assets ?? RECORDED_ASSETS;
    this.connections = makeSpecs(assets).map((spec) => ({ spec, socket: null, retryTimer: null, heartbeatTimer: null, attempt: 0 }));
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    for (const connection of this.connections) this.connect(connection);
  }

  stop() {
    this.stopped = true;
    for (const connection of this.connections) {
      if (connection.retryTimer) clearTimeout(connection.retryTimer);
      if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer);
      connection.retryTimer = null;
      connection.heartbeatTimer = null;
      if (connection.socket) {
        connection.socket.onclose = null;
        connection.socket.close();
        connection.socket = null;
      }
      this.options.onStatus?.(connection.spec.source, "DOWN", "stopped");
    }
  }

  private connect(connection: Connection) {
    if (this.stopped) return;
    const { spec } = connection;
    this.options.onStatus?.(spec.source, "CONNECTING");
    try {
      const socket = new this.Socket(spec.url);
      connection.socket = socket;
      socket.onopen = () => {
        connection.attempt = 0;
        this.options.onStatus?.(spec.source, "LIVE");
        if (spec.subscribe) socket.send(spec.subscribe);
        if (spec.heartbeat && spec.heartbeatMs) {
          connection.heartbeatTimer = setInterval(() => {
            if (socket.readyState === 1) socket.send(spec.heartbeat!);
          }, spec.heartbeatMs);
        }
      };
      socket.onmessage = (event) => {
        const data =
          typeof event.data === "string" ? event.data : event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString("utf8") : String(event.data);
        const receivedAt = Date.now();
        const ticks = parseVenueTicks(spec.source, data, receivedAt);
        this.options.onRaw({
          receivedAt,
          source: spec.source,
          venue: spec.source.split(":")[0],
          channel: spec.source.endsWith(":public") ? "spot+perp" : spec.source.split(":")[1],
          asset: ticks[0]?.asset ?? null,
          payload: data,
        });
        for (const tick of ticks) this.options.onTick(tick);
      };
      socket.onerror = () => this.options.onStatus?.(spec.source, "DOWN", "websocket error");
      socket.onclose = () => {
        if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer);
        connection.heartbeatTimer = null;
        connection.socket = null;
        this.options.onStatus?.(spec.source, "DOWN", "websocket closed");
        this.scheduleReconnect(connection);
      };
    } catch (error) {
      this.options.onStatus?.(spec.source, "DOWN", error instanceof Error ? error.message : String(error));
      this.scheduleReconnect(connection);
    }
  }

  private scheduleReconnect(connection: Connection) {
    if (this.stopped || connection.retryTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(connection.attempt, 5));
    connection.attempt += 1;
    connection.retryTimer = setTimeout(() => {
      connection.retryTimer = null;
      this.connect(connection);
    }, delay);
  }
}
