import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLiveMarket,
  chartFairProbability,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  fetchResolvedMarketOutcomes,
  fetchSpotPrices,
  replaceLiveMarketBook,
  updateLiveCandles,
  updateLiveMarketBookLevel,
  type LiveMarket,
} from "../app/lib/polymarket-data";
import {
  accountDeployed,
  accountEquity,
  accountLiquidationEquity,
  accountUnrealized,
  accountWinRate,
  analyzeMarketSignal,
  buyPaper,
  closePaperPositions,
  createPaperAccount,
  markAccount,
  marketDataFreshnessIssue,
  paperStakeUsd,
  settlePaperPositionsByOutcome,
  type PaperAccount,
  type PaperSide,
} from "../app/lib/engines";
import { DEFAULT_PAPER_EARLY_EXIT, evaluateModelAwareExit } from "../app/lib/early-exit";

type ExitObservation = { count: number; lastSeen: number };
type PersistedState = {
  schemaVersion: 1;
  mode: "paper";
  startedAt: number;
  savedAt: number;
  account: PaperAccount;
  lastCycleAt: number | null;
  lastHealthyDataAt: number | null;
  lastError: string | null;
  marketsTracked: number;
  usableMarkets: number;
  utcDay: string;
  dayStartEquity: number | null;
  lastEntryByMarket: Record<string, number>;
  tokenIdsByMarket: Record<string, { upTokenId: string; downTokenId: string }>;
  exitObservations: Record<string, ExitObservation>;
  resolutionCheckedAt: Record<string, number>;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if ((process.env.TRADING_MODE ?? "paper").trim().toLowerCase() !== "paper") {
  throw new Error("This headless daemon is paper-only. TRADING_MODE must be paper; live execution is not implemented here.");
}
const stateDir = path.resolve(process.env.STATE_DIR || path.join(projectRoot, "var"));
const stateFile = path.join(stateDir, "paper-state.json");
const killFile = path.join(stateDir, "KILL_SWITCH");
const pauseFile = path.join(stateDir, "PAUSED");
const staleHaltFile = path.join(stateDir, "STALE_DATA_HALT");
const riskHaltFile = path.join(stateDir, "RISK_HALT");
const healthPort = 8788;
const pollIntervalMs = integerSetting("POLL_INTERVAL_MS", 15_000, 5_000, 60_000);
const staleAfterMs = integerSetting("DATA_STALE_HALT_MS", 90_000, 30_000, 600_000);
const paperStartingCash = numberSetting("PAPER_STARTING_CASH", 1_000, 1, 1_000_000_000);
const paperMinBetUsd = numberSetting("PAPER_MIN_BET_USD", 1, 1, 100_000);
const paperMinBetPct = numberSetting("PAPER_MIN_BET_PCT", 0.005, 0.005, 0.03);
const paperMaxBetPct = numberSetting("PAPER_MAX_BET_PCT", 0.03, paperMinBetPct, 0.03);
const paperMaxExposurePct = numberSetting("PAPER_MAX_EXPOSURE_PCT", 0.09, 0.01, 0.5);
const paperMaxOpenPositions = integerSetting("PAPER_MAX_OPEN_POSITIONS", 3, 1, 100);
const paperMaxDailyLossPct = numberSetting("PAPER_MAX_DAILY_LOSS_PCT", 0.05, 0.001, 0.5);
const paperMinNetEdge = numberSetting("PAPER_MIN_NET_EDGE", 0.04, 0, 0.5);
const costs = {
  feeRate: numberSetting("PAPER_FEE_RATE", 0.02, 0, 0.5),
  slippageBps: numberSetting("PAPER_SLIPPAGE_BPS", 15, 0, 10_000),
};
const RESOLUTION_RECHECK_MS = 60_000;
const EXIT_CONFIRMATION_WINDOW_MS = 20_000;

function numberSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const value = numberSetting(name, fallback, min, max);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
  return value;
}

function paperBetSize(bankroll: number, availableCash: number) {
  const usd = paperStakeUsd(bankroll, availableCash, paperMinBetPct, paperMaxBetPct, paperMinBetUsd);
  return { usd, fraction: bankroll > 0 ? usd / bankroll : 0 };
}

function log(level: "INFO" | "WARN" | "ERROR", message: string, details?: Record<string, unknown>) {
  const record = { at: new Date().toISOString(), level, message, ...details };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function assertPaperAccount(account: PaperAccount): void {
  const scalars = [account.startingCash, account.cash, account.realizedPnl, account.fees, account.openOrders];
  if (!scalars.every(Number.isFinite) || account.startingCash <= 0 || account.cash < -0.01 || account.fees < 0 || account.openOrders !== 0) {
    throw new Error("Paper account reconciliation failed: invalid cash, fees, balance, or open-order count.");
  }
  const openCost = account.positions.reduce((total, position) => total + position.totalCost, 0);
  const reconciledEquity = account.startingCash + account.realizedPnl;
  const ledgerEquity = account.cash + openCost;
  // Engine balances are rounded to cents at each simulated fill. Allow one
  // cent per retained fill/closed trade for accumulated rounding differences.
  const roundingTolerance = Math.max(0.05, (account.fills.length + account.closedTrades.length) * 0.01);
  if (Math.abs(ledgerEquity - reconciledEquity) > roundingTolerance) {
    throw new Error(`Paper account reconciliation failed: cash plus open cost differs from starting cash plus realized P&L by $${(ledgerEquity - reconciledEquity).toFixed(2)}.`);
  }
  const positionIds = new Set<string>();
  const positionMarkets = new Set<string>();
  for (const position of account.positions) {
    const key = `${position.marketId}:${position.side}`;
    if (positionIds.has(position.id) || positionMarkets.has(key)) throw new Error("Paper account reconciliation failed: duplicate position.");
    positionIds.add(position.id);
    positionMarkets.add(key);
    if (!Number.isFinite(position.shares) || position.shares <= 0 || !Number.isFinite(position.totalCost) || position.totalCost <= 0 ||
        !Number.isFinite(position.avgEntry) || position.avgEntry <= 0 || !Number.isFinite(position.endTime)) {
      throw new Error(`Paper account reconciliation failed: invalid position ${position.id}.`);
    }
  }
  for (const fill of account.fills) {
    if (!Number.isFinite(fill.timestamp) || !Number.isFinite(fill.shares) || fill.shares <= 0 ||
        !Number.isFinite(fill.price) || fill.price < 0 || fill.price > 2 || !Number.isFinite(fill.notional) || fill.notional < 0 ||
        !Number.isFinite(fill.fee) || fill.fee < 0) {
      throw new Error(`Paper account reconciliation failed: invalid fill ${fill.id}.`);
    }
  }
}

async function readFlag(filename: string): Promise<boolean> {
  try {
    await readFile(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function saveState(state: PersistedState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o750 });
  state.savedAt = Date.now();
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o640 });
  await rename(temporary, stateFile);
}

async function loadState(): Promise<PersistedState> {
  await mkdir(stateDir, { recursive: true, mode: 0o750 });
  try {
    const raw = JSON.parse(await readFile(stateFile, "utf8")) as Partial<PersistedState>;
    if (raw.schemaVersion !== 1 || raw.mode !== "paper" || !raw.account || !Array.isArray(raw.account.positions) || !Array.isArray(raw.account.fills)) {
      throw new Error("Unsupported or incomplete persisted paper state; refusing to reset it.");
    }
    assertPaperAccount(raw.account);
    return {
      schemaVersion: 1,
      mode: "paper",
      startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt! : Date.now(),
      savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt! : Date.now(),
      account: raw.account,
      lastCycleAt: Number.isFinite(raw.lastCycleAt) ? raw.lastCycleAt! : null,
      lastHealthyDataAt: Number.isFinite(raw.lastHealthyDataAt) ? raw.lastHealthyDataAt! : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
      marketsTracked: Number.isFinite(raw.marketsTracked) ? raw.marketsTracked! : 0,
      usableMarkets: Number.isFinite(raw.usableMarkets) ? raw.usableMarkets! : 0,
      utcDay: typeof raw.utcDay === "string" ? raw.utcDay : new Date().toISOString().slice(0, 10),
      dayStartEquity: Number.isFinite(raw.dayStartEquity) ? raw.dayStartEquity! : null,
      lastEntryByMarket: raw.lastEntryByMarket && typeof raw.lastEntryByMarket === "object" ? raw.lastEntryByMarket : {},
      tokenIdsByMarket: raw.tokenIdsByMarket && typeof raw.tokenIdsByMarket === "object" ? raw.tokenIdsByMarket : {},
      exitObservations: raw.exitObservations && typeof raw.exitObservations === "object" ? raw.exitObservations : {},
      resolutionCheckedAt: raw.resolutionCheckedAt && typeof raw.resolutionCheckedAt === "object" ? raw.resolutionCheckedAt : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const now = Date.now();
    const state: PersistedState = {
      schemaVersion: 1,
      mode: "paper",
      startedAt: now,
      savedAt: now,
      account: createPaperAccount(paperStartingCash, now),
      lastCycleAt: null,
      lastHealthyDataAt: null,
      lastError: null,
      marketsTracked: 0,
      usableMarkets: 0,
      utcDay: new Date(now).toISOString().slice(0, 10),
      dayStartEquity: paperStartingCash,
      lastEntryByMarket: {},
      tokenIdsByMarket: {},
      exitObservations: {},
      resolutionCheckedAt: {},
    };
    await saveState(state);
    log("INFO", "Created a new paper account", { startingCash: paperStartingCash });
    return state;
  }
}

const state = await loadState();
let lastCycleInMemory: number | null = state.lastCycleAt;
let stopping = false;
const shutdownController = new AbortController();

function pruneRecord<T>(record: Record<string, T>, retainedKeys: Set<string>): void {
  for (const key of Object.keys(record)) {
    if (!retainedKeys.has(key)) delete record[key];
  }
}

function pruneTrackingMaps(markets: LiveMarket[]): void {
  const activeMarketIds = new Set(markets.map((market) => market.id));
  const openPositionIds = new Set(state.account.positions.map((position) => position.id));
  const openPositionMarketIds = new Set(state.account.positions.map((position) => position.marketId));
  const marketsNeedingTokens = new Set([...activeMarketIds, ...openPositionMarketIds]);

  pruneRecord(state.lastEntryByMarket, activeMarketIds);
  pruneRecord(state.tokenIdsByMarket, marketsNeedingTokens);
  pruneRecord(state.exitObservations, openPositionIds);
  pruneRecord(state.resolutionCheckedAt, openPositionMarketIds);
}
let latestSignals: Array<{
  marketId: string;
  marketLabel: string;
  asset: string;
  duration: LiveMarket["duration"];
  action: "UP" | "DOWN" | "PASS";
  edge: number | null;
  confidence: number | null;
  entryPrice: number | null;
  targetBetUsd: number;
  targetBetPct: number;
  reason: string;
  remainingSeconds: number;
}> = [];
let latestSignalsAt: number | null = null;
let latestMarkets = new Map<string, LiveMarket>();
let coinbaseSocket: WebSocket | null = null;
let clobSocket: WebSocket | null = null;
let coinbaseConnected = false;
let clobConnected = false;
let lastStreamUpdateAt: number | null = null;
let lastClobUpdateAt: number | null = null;
let coinbaseSubscriptionKey = "";
let clobSubscriptionKey = "";
let coinbaseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let clobReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let clobHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
const STREAM_RECONNECT_BASE_MS = 1_500;
const STREAM_RECONNECT_MAX_MS = 60_000;
const STREAM_RECONNECT_STABLE_MS = 30_000;
let coinbaseReconnectAttempts = 0;
let clobReconnectAttempts = 0;
let coinbaseConnectedAt: number | null = null;
let clobConnectedAt: number | null = null;

function reconnectDelay(attempt: number): number {
  return Math.min(STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10));
}

function tradingStateSnapshot(stale: boolean, killed: boolean, paused: boolean, riskHalted: boolean): string {
  if (killed) return "KILLED";
  if (riskHalted) return "RISK_HALT";
  if (stale) return "STALE_DATA_HALT";
  if (paused) return "PAUSED";
  if (state.lastError) return "DEGRADED";
  if (state.usableMarkets === 0) return "WAITING_FOR_DATA";
  return "PAPER_RUNNING";
}

async function statusPayload() {
  const [killed, paused, stale, riskHalted] = await Promise.all([
    readFlag(killFile), readFlag(pauseFile), readFlag(staleHaltFile), readFlag(riskHaltFile),
  ]);
  const now = Date.now();
  const cycleAgeMs = lastCycleInMemory === null ? null : Math.max(0, now - lastCycleInMemory);
  const dataAgeMs = state.lastHealthyDataAt === null ? null : Math.max(0, now - state.lastHealthyDataAt);
  const portfolioMarkable = state.account.positions.every((position) => {
    const positionMarket = latestMarkets.get(position.marketId);
    return Boolean(positionMarket && marketHasFreshInputs(positionMarket, now));
  });
  const readiness = cycleAgeMs !== null && cycleAgeMs <= Math.max(60_000, pollIntervalMs * 4)
    && state.lastError === null && dataAgeMs !== null && dataAgeMs <= staleAfterMs && portfolioMarkable
    ? "READY"
    : "DEGRADED";
  const expiredOpenPositions = state.account.positions.filter((position) => position.endTime <= now).length;
  const positions = state.account.positions.map((position) => {
    const mark = position.mark ?? position.avgEntry;
    return {
      id: position.id,
      marketId: position.marketId,
      marketLabel: position.marketLabel,
      asset: position.asset,
      duration: position.duration,
      side: position.side,
      shares: position.shares,
      avgEntry: position.avgEntry,
      totalCost: position.totalCost,
      mark,
      markValue: mark * position.shares,
      unrealizedPnl: (mark - position.avgEntry) * position.shares,
      openedAt: position.openedAt,
      lastUpdated: position.lastUpdated,
      endTime: position.endTime,
      secondsRemaining: Math.max(0, Math.round((position.endTime - now) / 1000)),
    };
  });
  const equity = accountEquity(state.account, latestMarkets);
  return {
    service: "polymarket-quant-engine",
    process: "running",
    readiness,
    mode: "paper",
    tradingState: tradingStateSnapshot(stale, killed, paused, riskHalted),
    lastCycleAt: state.lastCycleAt,
    lastHealthyDataAt: state.lastHealthyDataAt,
    lastError: state.lastError,
    lastHealthyDataAgeMs: state.lastHealthyDataAt === null ? null : Math.max(0, now - state.lastHealthyDataAt),
    marketsTracked: state.marketsTracked,
    usableMarkets: state.usableMarkets,
    controls: { paused, killed, staleDataHalt: stale, riskHalt: riskHalted },
    paper: {
      startingCash: state.account.startingCash,
      cash: state.account.cash,
      equity,
      liquidationEquity: accountLiquidationEquity(state.account, latestMarkets, costs),
      realizedPnl: state.account.realizedPnl,
      unrealizedPnl: accountUnrealized(state.account, latestMarkets),
      totalPnl: equity - state.account.startingCash,
      winRate: accountWinRate(state.account),
      openPositions: state.account.positions.length,
      expiredAwaitingGammaResolution: expiredOpenPositions,
      buyFills: state.account.fills.filter((fill) => fill.action === "BUY").length,
      fees: state.account.fees,
      deployed: accountDeployed(state.account),
      totalFills: state.account.fills.length,
      closedTrades: state.account.closedTrades.length,
      positions,
      recentFills: state.account.fills.slice(0, 12),
      recentClosedTrades: state.account.closedTrades.slice(0, 12),
      equityHistory: state.account.equityHistory.slice(-40),
    },
    signalsUpdatedAt: latestSignalsAt,
    topSignals: latestSignals.slice(0, 8),
    betSizing: {
      minimumBetUsd: paperMinBetUsd,
      minimumBetPct: paperMinBetPct,
      maximumBetPct: paperMaxBetPct,
      maximumExposurePct: paperMaxExposurePct,
    },
    streams: {
      coinbaseConnected,
      clobConnected,
      clobRequired: state.account.positions.some((position) => latestMarkets.has(position.marketId)),
      lastUpdateAt: lastStreamUpdateAt,
      lastUpdateAgeMs: lastStreamUpdateAt === null ? null : Math.max(0, now - lastStreamUpdateAt),
      clobUpdateAgeMs: lastClobUpdateAt === null ? null : Math.max(0, now - lastClobUpdateAt),
    },
    reconciliation: "PASS",
  };
}

const healthServer = createServer(async (request, response) => {
  if (request.method !== "GET" || (request.url !== "/healthz" && request.url !== "/status")) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "Not found." }));
    return;
  }
  const payload = await statusPayload();
  const healthy = lastCycleInMemory !== null && Date.now() - lastCycleInMemory <= Math.max(60_000, pollIntervalMs * 4);
  response.writeHead(request.url === "/healthz" && !healthy ? 503 : 200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(request.url === "/healthz" ? { ok: healthy, ...payload } : payload));
});

await new Promise<void>((resolve, reject) => {
  healthServer.once("error", reject);
  healthServer.listen(healthPort, "127.0.0.1", () => resolve());
});
log("INFO", "Headless paper daemon started", { mode: "paper", health: `http://127.0.0.1:${healthPort}/healthz`, pollIntervalMs });
const markTimer = setInterval(() => {
  if (latestMarkets.size) state.account = markAccount(state.account, latestMarkets, Date.now());
}, 1000);
markTimer.unref();

async function collectMarkets(): Promise<LiveMarket[]> {
  const signal = shutdownController.signal;
  const definitions = await discoverCryptoMarkets(signal);
  const tokenIds = definitions.flatMap((market) => [market.upTokenId, market.downTokenId]);
  const assets = [...new Set(definitions.map((market) => market.asset))];
  const [books, spots, candles] = await Promise.all([
    fetchOrderBooks(tokenIds, signal),
    fetchSpotPrices(assets, signal),
    fetchCandleHistories(assets, signal),
  ]);
  const now = Date.now();
  return definitions.map((definition) => buildLiveMarket(definition, books, spots, null, now, candles.get(definition.asset) ?? null));
}

function parseBookLevels(value: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const level = raw as { price?: unknown; size?: unknown };
    const price = Number(level.price);
    const size = Number(level.size);
    return Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0 ? [{ price, size }] : [];
  });
}

function scheduleCoinbaseReconnect(key: string): void {
  if (stopping) return;
  if (coinbaseReconnectTimer) clearTimeout(coinbaseReconnectTimer);
  if (coinbaseConnectedAt !== null && Date.now() - coinbaseConnectedAt >= STREAM_RECONNECT_STABLE_MS) {
    coinbaseReconnectAttempts = 0;
  }
  coinbaseConnectedAt = null;
  const delay = reconnectDelay(coinbaseReconnectAttempts);
  coinbaseReconnectAttempts = Math.min(coinbaseReconnectAttempts + 1, 10);
  coinbaseReconnectTimer = setTimeout(() => {
    coinbaseReconnectTimer = null;
    if (coinbaseSubscriptionKey === key) connectCoinbase(key);
  }, delay);
}

function scheduleClobReconnect(key: string): void {
  if (stopping) return;
  if (clobReconnectTimer) clearTimeout(clobReconnectTimer);
  if (clobConnectedAt !== null && Date.now() - clobConnectedAt >= STREAM_RECONNECT_STABLE_MS) {
    clobReconnectAttempts = 0;
  }
  clobConnectedAt = null;
  const delay = reconnectDelay(clobReconnectAttempts);
  clobReconnectAttempts = Math.min(clobReconnectAttempts + 1, 10);
  clobReconnectTimer = setTimeout(() => {
    clobReconnectTimer = null;
    if (clobSubscriptionKey === key) connectClob(key);
  }, delay);
}

function connectCoinbase(key: string): void {
  if (stopping || coinbaseSubscriptionKey !== key || coinbaseSocket) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket("wss://ws-feed.exchange.coinbase.com");
  } catch (error) {
    log("WARN", "Coinbase stream connection failed", { error: errorMessage(error) });
    scheduleCoinbaseReconnect(key);
    return;
  }
  coinbaseSocket = socket;
  socket.onopen = () => {
    if (coinbaseSocket !== socket) return;
    coinbaseConnected = true;
    coinbaseConnectedAt = Date.now();
    socket.send(JSON.stringify({
      type: "subscribe",
      product_ids: key.split(","),
      channels: ["ticker"],
    }));
    log("INFO", "Coinbase spot stream connected", { products: key.split(",").length });
  };
  socket.onmessage = (message) => {
    if (coinbaseSocket !== socket) return;
    try {
      const event = JSON.parse(String(message.data)) as { type?: string; product_id?: string; price?: string | number };
      if (event.type !== "ticker" || !event.product_id) return;
      const asset = event.product_id.replace(/-USD$/, "");
      const spot = Number(event.price);
      const now = Date.now();
      if (!Number.isFinite(spot) || spot <= 0) return;
      let updated = false;
      for (const [id, market] of latestMarkets) {
        if (market.asset !== asset) continue;
        const candleUpdate = updateLiveCandles(market, spot, now);
        const openingCandle = market.startTime === null ? null : candleUpdate.chart5m
          .find((candle) => Math.abs(candle.timestamp - market.startTime!) <= 60_000) ?? null;
        const reference = market.reference ?? openingCandle?.open ?? null;
        const referenceSource = market.reference !== null ? market.referenceSource : openingCandle ? "COINBASE ESTIMATE" : "MISSING";
        const remaining = Math.max(0, (market.countdownEndsAt - now) / 1000);
        const spotHistory = market.spotHistory ?? [];
        const lastPoint = spotHistory[spotHistory.length - 1];
        const nextHistory = !lastPoint || now - lastPoint.timestamp >= 1000
          ? [...spotHistory, { timestamp: now, price: spot }].filter((point) => now - point.timestamp <= 120_000).slice(-180)
          : spotHistory;
        const fairUp = chartFairProbability(reference, spot, remaining, market.duration,
          market.duration === "5m" ? candleUpdate.chart5m : candleUpdate.chart15m, now);
        const distance = reference !== null ? (spot - reference) / reference : null;
        latestMarkets.set(id, {
          ...market,
          ...candleUpdate,
          spotHistory: nextHistory,
          reference,
          referenceSource,
          remaining,
          spot,
          fairUp,
          distance,
          momentum: market.spot ? Math.log(spot / market.spot) : market.momentum,
          edgeUp: fairUp !== null && market.upAsk !== null ? fairUp - market.upAsk : null,
          edgeDown: fairUp !== null && market.downAsk !== null ? 1 - fairUp - market.downAsk : null,
          regime: reference === null ? "REFERENCE MISSING" : distance === null ? "SPOT MISSING" : Math.abs(distance) < 0.0002 ? "NEUTRAL" : distance > 0 ? "UP MOMENTUM" : "DOWN MOMENTUM",
          sourceTimestamp: now,
        });
        updated = true;
      }
      if (updated) lastStreamUpdateAt = now;
    } catch (error) {
      log("WARN", "Ignoring an invalid Coinbase stream message", { error: errorMessage(error) });
    }
  };
  socket.onclose = () => {
    if (coinbaseSocket !== socket) return;
    coinbaseSocket = null;
    coinbaseConnected = false;
    log("WARN", "Coinbase spot stream disconnected");
    scheduleCoinbaseReconnect(key);
  };
  socket.onerror = () => socket.close();
}

function connectClob(key: string): void {
  if (stopping || clobSubscriptionKey !== key || clobSocket) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
  } catch (error) {
    log("WARN", "Polymarket book stream connection failed", { error: errorMessage(error) });
    scheduleClobReconnect(key);
    return;
  }
  clobSocket = socket;
  socket.onopen = () => {
    if (clobSocket !== socket) return;
    clobConnected = true;
    clobConnectedAt = Date.now();
    const tokenIds = key.split(",");
    const batches: string[][] = [];
    for (let index = 0; index < tokenIds.length; index += 100) batches.push(tokenIds.slice(index, index + 100));
    const [firstBatch, ...remainingBatches] = batches;
    socket.send(JSON.stringify({ type: "market", assets_ids: firstBatch ?? [], custom_feature_enabled: true }));
    for (const batch of remainingBatches) {
      socket.send(JSON.stringify({ operation: "subscribe", assets_ids: batch, custom_feature_enabled: true }));
    }
    if (clobHeartbeatTimer) clearInterval(clobHeartbeatTimer);
    clobHeartbeatTimer = setInterval(() => {
      if (clobSocket === socket && socket.readyState === WebSocket.OPEN) socket.send("PING");
    }, 10_000);
    log("INFO", "Polymarket order-book stream connected", { tokens: tokenIds.length, subscriptionFrames: batches.length });
  };
  socket.onmessage = (message) => {
    if (clobSocket !== socket) return;
    if (String(message.data) === "PONG") return;
    try {
      const packet = JSON.parse(String(message.data));
      const events = Array.isArray(packet) ? packet : [packet];
      const now = Date.now();
      for (const raw of events) {
        if (!raw || typeof raw !== "object") continue;
        const event = raw.payload && typeof raw.payload === "object"
          ? { ...raw.payload, event_type: raw.type }
          : raw;
        const kind = event.event_type ?? event.type;
        if (kind === "book") {
          const tokenId = String(event.asset_id ?? event.token_id ?? event.tokenId ?? "");
          if (!tokenId) continue;
          const bids = parseBookLevels(event.bids);
          const asks = parseBookLevels(event.asks);
          const rawBookTimestamp = Number(event.timestamp);
          const bookTimestamp = Number.isFinite(rawBookTimestamp) && rawBookTimestamp > 0
            ? rawBookTimestamp < 10_000_000_000 ? rawBookTimestamp * 1000 : rawBookTimestamp
            : now;
          for (const [id, market] of latestMarkets) {
            if (market.upTokenId === tokenId || market.downTokenId === tokenId) {
              latestMarkets.set(id, replaceLiveMarketBook(market, tokenId, bids, asks,
                bookTimestamp, String(event.hash ?? "") || null, now));
              lastStreamUpdateAt = now;
              lastClobUpdateAt = now;
            }
          }
          continue;
        }
        const updates = kind === "price_change" ? (event.price_changes ?? event.priceChanges ?? []) : [event];
        if (!Array.isArray(updates)) continue;
        for (const update of updates) {
          const tokenId = String(update.asset_id ?? update.token_id ?? update.tokenId ?? "");
          if (!tokenId) continue;
          const bidValue = update.best_bid ?? update.bestBid;
          const askValue = update.best_ask ?? update.bestAsk;
          const bid = bidValue === null || bidValue === undefined ? null : Number(bidValue);
          const ask = askValue === null || askValue === undefined ? null : Number(askValue);
          const price = Number(update.price);
          const size = Number(update.size);
          for (const [id, market] of latestMarkets) {
            if (market.upTokenId !== tokenId && market.downTokenId !== tokenId) continue;
            let changed: LiveMarket;
            if (kind === "price_change" && (update.side === "BUY" || update.side === "SELL") && Number.isFinite(price) && Number.isFinite(size)) {
              changed = updateLiveMarketBookLevel(market, tokenId, update.side, price, size, now);
            } else {
              const isUp = market.upTokenId === tokenId;
              const upBid = isUp && bidValue !== undefined ? (bid !== null && Number.isFinite(bid) ? bid : null) : market.upBid;
              const upAsk = isUp && askValue !== undefined ? (ask !== null && Number.isFinite(ask) ? ask : null) : market.upAsk;
              const downBid = !isUp && bidValue !== undefined ? (bid !== null && Number.isFinite(bid) ? bid : null) : market.downBid;
              const downAsk = !isUp && askValue !== undefined ? (ask !== null && Number.isFinite(ask) ? ask : null) : market.downAsk;
              const fairUp = market.fairUp;
              const spreads = [upBid !== null && upAsk !== null ? upAsk - upBid : null, downBid !== null && downAsk !== null ? downAsk - downBid : null].filter((value): value is number => value !== null);
              changed = { ...market, upBid, upAsk, downBid, downAsk, spread: spreads.length ? Math.max(...spreads) : null,
                edgeUp: fairUp !== null && upAsk !== null ? fairUp - upAsk : null,
                edgeDown: fairUp !== null && downAsk !== null ? 1 - fairUp - downAsk : null, sourceTimestamp: now };
            }
            latestMarkets.set(id, changed);
            lastStreamUpdateAt = now;
            lastClobUpdateAt = now;
          }
        }
      }
    } catch (error) {
      log("WARN", "Ignoring an invalid Polymarket stream message", { error: errorMessage(error) });
    }
  };
  socket.onclose = (event) => {
    if (clobSocket !== socket) return;
    clobSocket = null;
    clobConnected = false;
    if (clobHeartbeatTimer) clearInterval(clobHeartbeatTimer);
    clobHeartbeatTimer = null;
    log("WARN", "Polymarket order-book stream disconnected", { code: event.code, reason: event.reason || "none", wasClean: event.wasClean });
    scheduleClobReconnect(key);
  };
  socket.onerror = () => socket.close();
}

function ensureMarketStreams(markets: LiveMarket[]): void {
  const coinbaseKey = [...new Set(markets.map((market) => `${market.asset}-USD`))].sort().join(",");
  if (coinbaseKey !== coinbaseSubscriptionKey) {
    coinbaseSubscriptionKey = coinbaseKey;
    coinbaseReconnectAttempts = 0;
    coinbaseConnectedAt = null;
    if (coinbaseReconnectTimer) clearTimeout(coinbaseReconnectTimer);
    coinbaseReconnectTimer = null;
    if (coinbaseSocket) {
      const previous = coinbaseSocket;
      coinbaseSocket = null;
      coinbaseConnected = false;
      previous.close();
    }
    if (coinbaseKey) connectCoinbase(coinbaseKey);
  }
  const positionMarketIds = new Set(state.account.positions.map((position) => position.marketId));
  const marketsWithPositions = markets.filter((market) => positionMarketIds.has(market.id));
  const clobKey = [...new Set(marketsWithPositions.flatMap((market) => [market.upTokenId, market.downTokenId]).filter(Boolean))].sort().join(",");
  if (clobKey !== clobSubscriptionKey) {
    clobSubscriptionKey = clobKey;
    clobReconnectAttempts = 0;
    clobConnectedAt = null;
    if (clobReconnectTimer) clearTimeout(clobReconnectTimer);
    clobReconnectTimer = null;
    if (clobHeartbeatTimer) clearInterval(clobHeartbeatTimer);
    clobHeartbeatTimer = null;
    if (clobSocket) {
      const previous = clobSocket;
      clobSocket = null;
      clobConnected = false;
      previous.close();
    }
    if (clobKey) connectClob(clobKey);
  }
}

function closeMarketStreams(): void {
  const coinbase = coinbaseSocket as WebSocket | null;
  const clob = clobSocket as WebSocket | null;
  coinbaseSocket = null;
  clobSocket = null;
  coinbase?.close();
  clob?.close();
}

function marketHasFreshInputs(market: LiveMarket, now: number): boolean {
  return market.startTime !== null && market.startTime <= now && market.remaining >= 30 &&
    market.upAsk !== null && market.upBid !== null && market.downAsk !== null && market.downBid !== null &&
    marketDataFreshnessIssue(market, now) === null;
}

async function resolveExpiredPositions(now: number): Promise<void> {
  const expired = state.account.positions.filter((position) => position.endTime <= now &&
    now - (state.resolutionCheckedAt[position.marketId] ?? 0) >= RESOLUTION_RECHECK_MS);
  if (!expired.length) return;
  for (const position of expired) state.resolutionCheckedAt[position.marketId] = now;
  const unique = new Map(expired.map((position) => [position.marketId, {
    id: position.marketId,
    upTokenId: "",
    downTokenId: "",
  }]));
  // Store token IDs separately because closed-market discovery may no longer
  // return the market definition needed to map Gamma's final outcome.
  const tokensByMarket = new Map<string, { upTokenId: string; downTokenId: string }>();
  for (const position of expired) {
    const cached = state.tokenIdsByMarket[position.marketId];
    if (cached) tokensByMarket.set(position.marketId, cached);
  }
  const inputs = [...unique.values()].map((market) => {
    const tokens = tokensByMarket.get(market.id);
    return tokens?.upTokenId && tokens.downTokenId ? { ...market, ...tokens } : market;
  });
  if (inputs.some((market) => !market.upTokenId || !market.downTokenId)) {
    log("WARN", "Some expired paper positions have no saved token IDs; checking Gamma by market outcome labels instead.", {
      markets: inputs.filter((market) => !market.upTokenId || !market.downTokenId).map((market) => market.id),
    });
  }
  try {
    const outcomes = await fetchResolvedMarketOutcomes(inputs, shutdownController.signal);
    if (!outcomes.size) return;
    const settled = settlePaperPositionsByOutcome(state.account, outcomes, "market resolution", now);
    if (settled.closed) {
      state.account = settled.account;
      for (const marketId of outcomes.keys()) {
        if (!state.account.positions.some((position) => position.marketId === marketId)) delete state.tokenIdsByMarket[marketId];
      }
      assertPaperAccount(state.account);
      log("INFO", "Paper positions settled from final Gamma outcomes", { closed: settled.closed, realized: settled.realized });
    }
  } catch (error) {
    log("WARN", "Final market outcome check failed; expired paper positions remain pending", { error: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
}

function applyEarlyExits(markets: Map<string, LiveMarket>, now: number): void {
  const exitIds = new Set<string>();
  for (const position of state.account.positions) {
    const market = markets.get(position.marketId);
    if (!market || market.fairUp === null) {
      delete state.exitObservations[position.id];
      continue;
    }
    const currentPrice = position.side === "UP" ? market.upBid : market.downBid;
    const fairProbability = position.side === "UP" ? market.fairUp : 1 - market.fairUp;
    if (currentPrice === null) {
      delete state.exitObservations[position.id];
      continue;
    }
    const evaluation = evaluateModelAwareExit({
      policy: DEFAULT_PAPER_EARLY_EXIT,
      entryPrice: position.avgEntry,
      currentPrice,
      fairProbability,
      shares: position.shares,
      feeRate: costs.feeRate,
      remainingSeconds: market.remaining,
    });
    if (!evaluation.shouldExit) {
      delete state.exitObservations[position.id];
      continue;
    }
    const previous = state.exitObservations[position.id];
    const count = previous && now - previous.lastSeen <= EXIT_CONFIRMATION_WINDOW_MS ? previous.count + 1 : 1;
    state.exitObservations[position.id] = { count, lastSeen: now };
    if (count >= DEFAULT_PAPER_EARLY_EXIT.earlyExitConfirmations) exitIds.add(position.id);
  }
  if (!exitIds.size) return;
  const closed = closePaperPositions(state.account, markets, costs, "model-aware paper cashout", now, exitIds);
  if (closed.closed) {
    state.account = closed.account;
    for (const id of exitIds) delete state.exitObservations[id];
    log("INFO", "Model-aware paper cashout", { closed: closed.closed, realized: closed.realized });
  }
}

async function latchFile(filename: string, reason: string): Promise<void> {
  if (await readFlag(filename)) return;
  await writeFile(filename, `${new Date().toISOString()} ${reason}\n`, { flag: "wx", mode: 0o640 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  log("ERROR", reason);
}

async function latchStaleDataIfNeeded(now: number): Promise<void> {
  const lastHealthyOrStarted = state.lastHealthyDataAt ?? state.startedAt;
  const staleForMs = now - lastHealthyOrStarted;
  if (staleForMs >= staleAfterMs) {
    await latchFile(staleHaltFile, `No complete fresh market snapshot for ${Math.round(staleForMs / 1000)} seconds.`);
  }
}

async function runCycle(): Promise<void> {
  const now = Date.now();
  try {
    // Check before attempting recovery so a successful fetch cannot erase evidence
    // that the last complete snapshot was already stale.
    await latchStaleDataIfNeeded(now);
    const allMarkets = await collectMarkets();
    if (stopping || shutdownController.signal.aborted) return;
    await latchStaleDataIfNeeded(Date.now());
    const markets = allMarkets.filter((market) => market.endTime > now);
    pruneTrackingMaps(markets);
    const usableMarkets = markets.filter((market) => marketHasFreshInputs(market, now));
    const marketMap = new Map(markets.map((market) => [market.id, market]));
    latestMarkets = marketMap;
    ensureMarketStreams(markets);
    const sizingEquity = accountEquity(state.account, marketMap);
    latestSignals = usableMarkets
      .map((market) => {
        const preliminary = analyzeMarketSignal(market, costs, paperMinBetUsd, paperMinNetEdge);
        const stake = paperBetSize(sizingEquity, state.account.cash);
        const signal = stake.usd >= paperMinBetUsd
          ? analyzeMarketSignal(market, costs, stake.usd, paperMinNetEdge)
          : preliminary;
        return {
          marketId: market.id,
          marketLabel: `${market.asset} ${market.duration}`,
          asset: market.asset,
          duration: market.duration,
          action: signal.action,
          edge: signal.edge,
          confidence: signal.confidence,
          entryPrice: signal.entryPrice,
          targetBetUsd: stake.usd,
          targetBetPct: sizingEquity > 0 ? stake.usd / sizingEquity : 0,
          reason: signal.reason,
          remainingSeconds: market.remaining,
        };
      })
      .sort((left, right) => (right.edge ?? -1) - (left.edge ?? -1))
      .slice(0, 20);
    latestSignalsAt = now;
    state.marketsTracked = markets.length;
    state.usableMarkets = usableMarkets.length;
    state.lastError = null;

    if (usableMarkets.length) state.lastHealthyDataAt = now;
    for (const position of state.account.positions) {
      const activeMarket = marketMap.get(position.marketId);
      if (activeMarket) {
        state.tokenIdsByMarket[position.marketId] = {
          upTokenId: activeMarket.upTokenId,
          downTokenId: activeMarket.downTokenId,
        };
      }
    }
    await resolveExpiredPositions(now);
    if (stopping || shutdownController.signal.aborted) return;

    if (usableMarkets.length) {
      state.account = markAccount(state.account, marketMap, now);
      applyEarlyExits(marketMap, now);
      state.account = markAccount(state.account, marketMap, now);

      const currentEquity = accountEquity(state.account, marketMap);
      const portfolioMarkable = state.account.positions.every((position) => {
        const positionMarket = marketMap.get(position.marketId);
        return Boolean(positionMarket && marketHasFreshInputs(positionMarket, now));
      });
      const currentLiquidationEquity = portfolioMarkable ? accountLiquidationEquity(state.account, marketMap, costs) : null;
      const utcDay = new Date(now).toISOString().slice(0, 10);
      if (state.utcDay !== utcDay) {
        state.utcDay = utcDay;
        state.dayStartEquity = currentLiquidationEquity;
      } else if (state.dayStartEquity === null && currentLiquidationEquity !== null) {
        state.dayStartEquity = currentLiquidationEquity;
      }
      if (await readFlag(path.join(stateDir, "RESET_RISK_DAY"))) {
        state.utcDay = utcDay;
        state.dayStartEquity = currentLiquidationEquity;
        await rm(path.join(stateDir, "RESET_RISK_DAY"), { force: true });
        log("WARN", "Operator reset the daily paper-loss baseline", { liquidationEquity: currentLiquidationEquity });
      }
      if (!await readFlag(riskHaltFile) && state.dayStartEquity !== null &&
          currentLiquidationEquity !== null && currentLiquidationEquity <= state.dayStartEquity * (1 - paperMaxDailyLossPct)) {
        await latchFile(riskHaltFile, `Paper daily loss limit reached (${paperMaxDailyLossPct * 100}%).`);
      }

      const [killed, paused, stale, riskHalted] = await Promise.all([
        readFlag(killFile), readFlag(pauseFile), readFlag(staleHaltFile), readFlag(riskHaltFile),
      ]);
      if (stopping || shutdownController.signal.aborted) return;
      const maximumExposureUsd = Math.max(paperMinBetUsd, currentEquity * paperMaxExposurePct);
      const canEnter = !stopping && !shutdownController.signal.aborted && !killed && !paused && !stale && !riskHalted && portfolioMarkable;
      if (canEnter && state.account.cash >= paperMinBetUsd && state.account.positions.length < paperMaxOpenPositions) {
        const candidates = usableMarkets
          .filter((market) => !state.account.positions.some((position) => position.marketId === market.id))
          .map((market) => {
            const preliminary = analyzeMarketSignal(market, costs, paperMinBetUsd, paperMinNetEdge);
            const stake = paperBetSize(currentEquity, state.account.cash);
            const signal = stake.usd >= paperMinBetUsd
              ? analyzeMarketSignal(market, costs, stake.usd, paperMinNetEdge)
              : preliminary;
            return { market, signal, stakeUsd: stake.usd, stakePct: currentEquity > 0 ? stake.usd / currentEquity : 0 };
          })
          .filter((item) => item.signal.action !== "PASS" && item.signal.edge !== null && item.signal.edge >= paperMinNetEdge &&
            item.stakeUsd >= paperMinBetUsd && item.signal.estimatedFill !== null && item.market.liquidity >= item.stakeUsd &&
            accountDeployed(state.account) + item.stakeUsd <= maximumExposureUsd)
          .sort((left, right) => (right.signal.edge ?? -1) - (left.signal.edge ?? -1));
        const candidate = candidates[0];
        if (candidate) {
          const lastEntryAt = state.lastEntryByMarket[candidate.market.id] ?? 0;
          if (!stopping && !shutdownController.signal.aborted && now - lastEntryAt >= 15_000) {
            const result = buyPaper(state.account, candidate.market, candidate.signal.action as PaperSide, candidate.stakeUsd, costs, "headless paper auto engine", now);
            if (result.fill) {
              state.account = markAccount(result.account, marketMap, now);
              state.lastEntryByMarket[candidate.market.id] = now;
              state.tokenIdsByMarket[candidate.market.id] = {
                upTokenId: candidate.market.upTokenId,
                downTokenId: candidate.market.downTokenId,
              };
              log("INFO", "Paper fill recorded", {
                asset: candidate.market.asset,
                duration: candidate.market.duration,
                side: candidate.signal.action,
                notional: result.fill.totalCost,
                targetBetPct: candidate.stakePct,
                edge: candidate.signal.edge,
                marketId: candidate.market.id,
              });
            }
          }
        }
      }
    }

    ensureMarketStreams([...latestMarkets.values()]);
    assertPaperAccount(state.account);
  } catch (error) {
    state.lastError = errorMessage(error);
    log("WARN", "Paper trading cycle failed; no new entries were considered", { error: state.lastError });
  } finally {
    state.lastCycleAt = Date.now();
    lastCycleInMemory = state.lastCycleAt;
    try {
      await latchStaleDataIfNeeded(state.lastCycleAt);
      assertPaperAccount(state.account);
      await saveState(state);
    } catch (error) {
      log("ERROR", "Paper-state reconciliation or persistence failed", { error: errorMessage(error) });
      process.exitCode = 1;
      stopping = true;
    }
  }
}

process.once("SIGTERM", () => { stopping = true; shutdownController.abort(); });
process.once("SIGINT", () => { stopping = true; shutdownController.abort(); });

while (!stopping) {
  const cycleStartedAt = Date.now();
  await runCycle();
  const elapsed = Date.now() - cycleStartedAt;
  if (!stopping && elapsed < pollIntervalMs) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs - elapsed));
}

clearInterval(markTimer);
if (coinbaseReconnectTimer) clearTimeout(coinbaseReconnectTimer);
if (clobReconnectTimer) clearTimeout(clobReconnectTimer);
if (clobHeartbeatTimer) clearInterval(clobHeartbeatTimer);
closeMarketStreams();
await new Promise<void>((resolve) => healthServer.close(() => resolve()));
log("INFO", "Headless paper daemon stopped");
