import { parseClobStreamMessage, type ClobStreamEvent } from "./clob-book-stream";

const CLOB_MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const HEARTBEAT_MS = 10_000;
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_STABLE_MS = 30_000;

type Shard = {
  key: string;
  tokens: string[];
  socket: WebSocket | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  reconnect: ReturnType<typeof setTimeout> | null;
  attempts: number;
  connectedAt: number | null;
  connected: boolean;
};

export type ClobPoolLog = (level: "INFO" | "WARN", message: string, details?: Record<string, unknown>) => void;

/**
 * One market-channel connection per shard (normally one market's two tokens).
 * At market boundaries the venue sends thousands of frames a second; on one
 * shared connection that overflowed its per-connection send buffer and it
 * closed the socket ("1013 slow consumer"). Small shards keep each connection
 * well inside that limit and isolate reconnects to the affected market.
 */
export class ClobSocketPool {
  private readonly shards = new Map<string, Shard>();
  private closed = false;

  constructor(private readonly options: {
    onEvents: (events: ClobStreamEvent[], shardTokens: readonly string[]) => void;
    onShardClosed?: (shardTokens: readonly string[]) => void;
    log?: ClobPoolLog;
    url?: string;
  }) {}

  /** Replace the shard set; unchanged shards keep their connection. */
  setShards(shardTokens: readonly (readonly string[])[]): void {
    if (this.closed) return;
    const wanted = new Map(shardTokens.filter((tokens) => tokens.length).map((tokens) => {
      const sorted = [...new Set(tokens)].sort();
      return [sorted.join(","), sorted] as const;
    }));
    for (const [key, shard] of this.shards) {
      if (!wanted.has(key)) {
        this.stopShard(shard);
        this.shards.delete(key);
      }
    }
    for (const [key, tokens] of wanted) {
      if (this.shards.has(key)) continue;
      const shard: Shard = { key, tokens, socket: null, heartbeat: null, reconnect: null, attempts: 0, connectedAt: null, connected: false };
      this.shards.set(key, shard);
      this.connect(shard);
    }
  }

  /** Tokens whose shard is currently connected. */
  connectedTokens(): Set<string> {
    const tokens = new Set<string>();
    for (const shard of this.shards.values()) if (shard.connected) for (const token of shard.tokens) tokens.add(token);
    return tokens;
  }

  status() {
    const shards = [...this.shards.values()];
    return { shards: shards.length, connected: shards.filter((shard) => shard.connected).length };
  }

  close(): void {
    this.closed = true;
    for (const shard of this.shards.values()) this.stopShard(shard);
    this.shards.clear();
  }

  private stopShard(shard: Shard) {
    if (shard.heartbeat) clearInterval(shard.heartbeat);
    if (shard.reconnect) clearTimeout(shard.reconnect);
    shard.heartbeat = null;
    shard.reconnect = null;
    shard.connected = false;
    const socket = shard.socket;
    shard.socket = null;
    socket?.close();
  }

  private scheduleReconnect(shard: Shard) {
    if (this.closed || this.shards.get(shard.key) !== shard) return;
    if (shard.connectedAt !== null && Date.now() - shard.connectedAt >= RECONNECT_STABLE_MS) shard.attempts = 0;
    shard.connectedAt = null;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(shard.attempts, 10));
    shard.attempts = Math.min(shard.attempts + 1, 10);
    shard.reconnect = setTimeout(() => {
      shard.reconnect = null;
      this.connect(shard);
    }, delay);
  }

  private connect(shard: Shard) {
    if (this.closed || shard.socket || this.shards.get(shard.key) !== shard) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url ?? CLOB_MARKET_WS);
    } catch (error) {
      this.options.log?.("WARN", "Order-book stream connection failed", { error: error instanceof Error ? error.message : String(error) });
      this.scheduleReconnect(shard);
      return;
    }
    shard.socket = socket;
    socket.onopen = () => {
      if (shard.socket !== socket) return;
      shard.connected = true;
      shard.connectedAt = Date.now();
      socket.send(JSON.stringify({ type: "market", assets_ids: shard.tokens, custom_feature_enabled: true }));
      shard.heartbeat = setInterval(() => { if (shard.socket === socket && socket.readyState === WebSocket.OPEN) socket.send("PING"); }, HEARTBEAT_MS);
    };
    socket.onmessage = (message: MessageEvent) => {
      if (shard.socket !== socket) return;
      const events = parseClobStreamMessage(message.data);
      if (events.length) this.options.onEvents(events, shard.tokens);
    };
    socket.onclose = (event: CloseEvent) => {
      if (shard.socket !== socket) return;
      shard.socket = null;
      shard.connected = false;
      if (shard.heartbeat) clearInterval(shard.heartbeat);
      shard.heartbeat = null;
      this.options.onShardClosed?.(shard.tokens);
      this.options.log?.("WARN", "Order-book stream shard disconnected", { tokens: shard.tokens.length, code: event.code, reason: event.reason || "none" });
      this.scheduleReconnect(shard);
    };
    socket.onerror = () => socket.close();
  }
}
