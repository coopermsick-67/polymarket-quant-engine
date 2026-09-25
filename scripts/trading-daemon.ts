import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createServer as createNetServer } from "node:net";
import { appendFile, mkdir, open as openFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  anchoredFairUp,
  applyPolymarketPriceTicks,
  buildLiveMarket,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  fetchResolvedMarketOutcomes,
  FORECAST_MODEL_VERSION,
  marketImpliedProbabilityUp,
  synchronizedPolymarketTime,
  updateLiveCandles,
  type LiveMarket,
  type PolymarketPriceTick,
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
  marketStreamingDataFreshnessIssue,
  estimatePaperExitFill,
  settlePaperPositionsByOutcome,
  type PaperAccount,
  type PaperSide,
} from "../app/lib/engines";
import { DEFAULT_PAPER_EARLY_EXIT, evaluatePaperHoldExit } from "../app/lib/early-exit";
import {
  assessBankrollRisk,
  bankrollProfile,
  type BankrollOpportunityScore,
} from "../app/lib/bankroll-policy";
import { evaluatePaperMarket, paperLossHistory, type PaperOpportunity } from "../app/lib/paper-bankroll";
import { subscribePolymarketPrices } from "../app/lib/polymarket-price-stream";
import { StaleRecoveryTracker } from "../app/lib/stale-recovery";
import { applyBookSnapshot, applyClobStreamEvents, preserveNewerStreamBooks, staleBookTokens } from "../app/lib/clob-book-stream";
import { ClobSocketPool } from "../app/lib/clob-socket-pool";
import { modelPriceCeiling } from "../app/lib/live-order-pricing";
import { loadCalibrationFile } from "./calibration-file";
import { cancelPendingPaperOrderOnRestart, type PendingPaperOrder } from "../app/lib/paper-orders";

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
  peakLiquidationEquity: number | null;
  lastEntryByMarket: Record<string, number>;
  tokenIdsByMarket: Record<string, { upTokenId: string; downTokenId: string }>;
  exitObservations: Record<string, ExitObservation>;
  resolutionCheckedAt: Record<string, number>;
  openingPriceTicks: Record<string, PolymarketPriceTick>;
  /** A paper FAK order waiting out its simulated latency; persisted so a restart can cancel it explicitly. */
  pendingPaperOrder?: PendingPaperOrder | null;
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
const resetStartingCashFile = path.join(stateDir, "PAPER_RESET_BALANCE");
const healthPort = 8788;
const stateOperationPort = 8789;
const dashboardOrigins = new Set((process.env.PQE_DASHBOARD_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean));
const pollIntervalMs = integerSetting("POLL_INTERVAL_MS", 15_000, 5_000, 60_000);
const decisionIntervalMs = integerSetting("DECISION_INTERVAL_MS", 1_000, 1_000, 5_000);
const staleAfterMs = integerSetting("DATA_STALE_HALT_MS", 90_000, 30_000, 600_000);
const staleRecoveryCyclesRequired = integerSetting("DATA_STALE_RECOVERY_CYCLES", 3, 2, 10);
// This only confirms that the shared market stream has recovered. Each
// candidate still has to pass its own exact-oracle, quote, and book checks.
const staleRecoveryMinimumMarkets = integerSetting("DATA_STALE_RECOVERY_MIN_MARKETS", 1, 1, 100);
const configuredPaperStartingCash = numberSetting("PAPER_STARTING_CASH", 100, 1, 1_000_000_000);
await mkdir(stateDir, { recursive: true, mode: 0o750 });
const stateOperationLockServer = createNetServer((socket) => socket.destroy());
await new Promise<void>((resolve, reject) => {
  stateOperationLockServer.once("error", (error) => {
    const code = (error as NodeJS.ErrnoException).code;
    reject(code === "EADDRINUSE"
      ? new Error("Another daemon startup or paper reset is using this host.")
      : error);
  });
  stateOperationLockServer.listen({ host: "127.0.0.1", port: stateOperationPort, exclusive: true }, resolve);
});
let requestedPaperStartingCash: number | null = null;
const paperStartingCash = await (async () => {
  try {
    const requested = Number(await readFile(resetStartingCashFile, "utf8"));
    if (!Number.isFinite(requested) || requested < 1 || requested > 1_000_000_000) {
      throw new Error("PAPER_RESET_BALANCE contains an invalid starting balance.");
    }
    requestedPaperStartingCash = requested;
    return requested;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return configuredPaperStartingCash;
    throw error;
  }
})();
const paperMinBetUsd = numberSetting("PAPER_MIN_BET_USD", 1, 1, 100_000);
const paperMaxBetPct = numberSetting("PAPER_MAX_BET_PCT", 0.05, 0.001, 0.1);
const paperMaxExposurePct = numberSetting("PAPER_MAX_EXPOSURE_PCT", 0.15, 0.01, 0.5);
const paperMaxOpenPositions = integerSetting("PAPER_MAX_OPEN_POSITIONS", 5, 1, 100);
const paperMaxDailyLossPct = numberSetting("PAPER_MAX_DAILY_LOSS_PCT", 0.05, 0.001, 0.5);
const paperMinNetEdge = numberSetting("PAPER_MIN_NET_EDGE", 0.04, 0, 0.5);
const costs = {
  feeRate: numberSetting("PAPER_FEE_RATE", 0.02, 0, 0.5),
  slippageBps: numberSetting("PAPER_SLIPPAGE_BPS", 15, 0, 10_000),
};
/**
 * Paper orders are decided on one snapshot and filled against the book this
 * much later, as a FAK limit order, so paper results include the price moves
 * a real order would meet in flight.
 */
const paperFillLatencyMs = integerSetting("PAPER_FILL_LATENCY_MS", 1_000, 0, 10_000);
const observationFile = path.join(stateDir, "observations.jsonl");
const observationIntervalMs = integerSetting("OBSERVATION_INTERVAL_MS", 15_000, 5_000, 300_000);
const calibrationFile = path.resolve(process.env.POLYMARKET_CALIBRATION_FILE || path.join(stateDir, "model-calibration.json"));
const RESOLUTION_RECHECK_MS = 60_000;
// Event-loop stalls starve the order-book socket (the venue closes a slow
// consumer), so they are measured and reported in /status.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
const EXIT_CONFIRMATION_WINDOW_MS = Math.max(20_000, pollIntervalMs * 2 + 5_000);

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

let statePersistenceQueue: Promise<void> = Promise.resolve();
let statePersistenceSequence = 0;

function saveState(state: PersistedState): Promise<void> {
  state.savedAt = Date.now();
  const contents = `${JSON.stringify(state)}\n`;
  const pending = statePersistenceQueue.catch(() => undefined).then(async () => {
    await mkdir(stateDir, { recursive: true, mode: 0o750 });
    const temporary = `${stateFile}.${process.pid}.${Date.now()}.${statePersistenceSequence++}.tmp`;
    const file = await openFile(temporary, "w", 0o640);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, stateFile);
  });
  statePersistenceQueue = pending;
  return pending;
}

function validOpeningPriceTicks(value: unknown, now = Date.now()): Record<string, PolymarketPriceTick> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const ticks: Record<string, PolymarketPriceTick> = {};
  for (const raw of Object.values(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const tick = raw as Partial<PolymarketPriceTick>;
    if (typeof tick.asset !== "string" || !tick.asset || (tick.priceFeed !== "TWAP_60" && tick.priceFeed !== "CHAINLINK_SPOT")
      || !Number.isFinite(tick.timestamp) || tick.timestamp! < now - 24 * 60 * 60_000 || tick.timestamp! > now + 1000
      || !Number.isFinite(tick.price) || tick.price! <= 0) continue;
    ticks[`${tick.asset}:${tick.priceFeed}:${tick.timestamp}`] = tick as PolymarketPriceTick;
  }
  return ticks;
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
      peakLiquidationEquity: Number.isFinite(raw.peakLiquidationEquity) ? raw.peakLiquidationEquity! : raw.account.startingCash,
      lastEntryByMarket: raw.lastEntryByMarket && typeof raw.lastEntryByMarket === "object" ? raw.lastEntryByMarket : {},
      tokenIdsByMarket: raw.tokenIdsByMarket && typeof raw.tokenIdsByMarket === "object" ? raw.tokenIdsByMarket : {},
      exitObservations: raw.exitObservations && typeof raw.exitObservations === "object" ? raw.exitObservations : {},
      resolutionCheckedAt: raw.resolutionCheckedAt && typeof raw.resolutionCheckedAt === "object" ? raw.resolutionCheckedAt : {},
      openingPriceTicks: validOpeningPriceTicks(raw.openingPriceTicks),
      pendingPaperOrder: raw.pendingPaperOrder && typeof raw.pendingPaperOrder === "object" ? raw.pendingPaperOrder : null,
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
      peakLiquidationEquity: paperStartingCash,
      lastEntryByMarket: {},
      tokenIdsByMarket: {},
      exitObservations: {},
      resolutionCheckedAt: {},
      openingPriceTicks: {},
    };
    await saveState(state);
    log("INFO", "Created a new paper account", { startingCash: paperStartingCash });
    return state;
  }
}

const state = await loadState();
if (requestedPaperStartingCash !== null) {
  if (Math.abs(state.account.startingCash - requestedPaperStartingCash) > 0.005) {
    throw new Error("PAPER_RESET_BALANCE does not match the initialized paper ledger; the reset marker has been retained.");
  }
  await saveState(state);
  await rm(resetStartingCashFile, { force: true });
}
let lastCycleInMemory: number | null = null;
let lastMarketRefreshAt = 0;
let marketRefreshInFlight = false;
let resolutionCheckInFlight = false;
let lastDecisionDurationMs = 0;
let lastDecisionIntervalMs: number | null = null;
let decisionCycleOverruns = 0;
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
  maximumAllowedStakeUsd: number;
  minimumExecutableOrderUsd: number | null;
  expectedNetProfitUsd: number | null;
  opportunityScore: number;
  scoreComponents: BankrollOpportunityScore["components"] | null;
  bankrollTier: string;
  strategy: string;
  marketProbability: number | null;
  /** Market-anchored P(UP) that the edge is priced against. */
  fairProbability: number | null;
  /** Unanchored candle-model P(UP). */
  rawModelProbability: number | null;
  spread: number | null;
  availableDepthUsd: number | null;
  smallAccountProtectionActive: boolean;
  entryAllowed: boolean;
  reason: string;
  remainingSeconds: number;
}> = [];
let latestSignalsAt: number | null = null;
let latestMarkets = new Map<string, LiveMarket>();
const PRICE_TICK_BUFFER_MS = 18 * 60_000;
const polymarketPriceTicks = new Map<string, PolymarketPriceTick>();
for (const [key, tick] of Object.entries(state.openingPriceTicks)) polymarketPriceTicks.set(key, tick);
let lastPricePruneAt = 0;
let lastOfficialPriceAt: number | null = null;
let priceStreamConnected = false;
let lastPriceStreamStatus: "CONNECTING" | "CONNECTED" | "DISCONNECTED" | null = null;
let priceSubscriptionKey = "";
let stopPriceStream: (() => void) | null = null;

function cachePolymarketPriceTicks(ticks: readonly PolymarketPriceTick[], now = Date.now()): void {
  const cutoff = now - PRICE_TICK_BUFFER_MS;
  for (const tick of ticks) {
    if (tick.timestamp < cutoff || tick.timestamp > now + 1_000) continue;
    polymarketPriceTicks.set(`${tick.asset}:${tick.priceFeed}:${tick.timestamp}`, tick);
    if ([...latestMarkets.values()].some((market) => market.startTimeVerified && market.asset === tick.asset && market.priceFeed === tick.priceFeed && market.startTime === tick.timestamp)) {
      const key = `${tick.asset}:${tick.priceFeed}:${tick.timestamp}`;
      if (!state.openingPriceTicks[key]) {
        state.openingPriceTicks[key] = tick;
        void saveState(state).catch((error) => log("ERROR", "Could not immediately persist an exact Polymarket opening tick", { error: errorMessage(error) }));
      }
    }
    lastOfficialPriceAt = Math.max(lastOfficialPriceAt ?? 0, tick.timestamp);
  }
  if (now - lastPricePruneAt >= 30_000) {
    for (const [key, tick] of polymarketPriceTicks) {
      if (tick.timestamp < cutoff) polymarketPriceTicks.delete(key);
    }
    for (const [key, tick] of Object.entries(state.openingPriceTicks)) {
      if (tick.timestamp < now - 24 * 60 * 60_000) delete state.openingPriceTicks[key];
    }
    lastPricePruneAt = now;
  }
}
let latestEligibleMarketCount = 0;
let latestMarketDataIssues: Record<string, number> = {};
let lastDataGapWarningAt = 0;
const staleRecoveryTracker = new StaleRecoveryTracker();
let coinbaseSocket: WebSocket | null = null;
let coinbaseConnected = false;
let lastStreamUpdateAt: number | null = null;
let lastClobUpdateAt: number | null = null;
let coinbaseSubscriptionKey = "";
let coinbaseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
const STREAM_RECONNECT_BASE_MS = 1_500;
const STREAM_RECONNECT_MAX_MS = 60_000;
const STREAM_RECONNECT_STABLE_MS = 30_000;
let coinbaseReconnectAttempts = 0;
let coinbaseConnectedAt: number | null = null;
/** Tokens of every market whose book is streamed (whether or not its shard is connected right now). */
let streamedTokens = new Set<string>();
const desyncedClobTokens = new Set<string>();
let desyncRefreshInFlight = false;
let bookDriftCount = 0;
let lastBookDriftLogAt = 0;
/**
 * Order-book streams, one connection per market (see ClobSocketPool). Level
 * changes are checked against the venue's reported top of book; a mismatch
 * means an update was missed, so that book is invalidated and a fresh snapshot
 * is fetched instead of trading on a drifted book.
 */
const clobPool = new ClobSocketPool({
  onEvents: (events) => {
    const now = Date.now();
    const applied = applyClobStreamEvents(latestMarkets, events, now);
    latestMarkets = applied.markets;
    for (const event of events) if (event.kind === "book") desyncedClobTokens.delete(event.tokenId);
    for (const tokenId of applied.desyncedTokens) desyncedClobTokens.add(tokenId);
    if (applied.touched) {
      lastStreamUpdateAt = now;
      lastClobUpdateAt = now;
    }
    if (applied.desyncedTokens.size) {
      bookDriftCount += applied.desyncedTokens.size;
      if (now - lastBookDriftLogAt >= 60_000) {
        log("INFO", "Order-book stream drifted from the venue's top of book; affected books were invalidated and refreshed from snapshots", { driftsSinceLastReport: bookDriftCount });
        lastBookDriftLogAt = now;
        bookDriftCount = 0;
      }
      void repairDesyncedBooks();
    }
  },
  log: (level, message, details) => log(level, message, details),
});

let pendingPaperOrder: PendingPaperOrder | null = null;
{
  // The simulated latency window died with the previous process; there is no
  // honest way to know the book at that moment, so the order is cancelled.
  const restart = cancelPendingPaperOrderOnRestart(state, Date.now());
  if (restart.cancelled) {
    log("WARN", "A paper order pending at shutdown was cancelled on restart; no fill was recorded", {
      marketId: restart.cancelled.marketId, side: restart.cancelled.side, submittedAt: restart.cancelled.submittedAt,
    });
    state.pendingPaperOrder = restart.state.pendingPaperOrder;
    state.lastEntryByMarket = restart.state.lastEntryByMarket;
    await saveState(state);
  }
}
const lastObservationAt = new Map<string, number>();

function reconnectDelay(attempt: number): number {
  return Math.min(STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10));
}

function tradingStateSnapshot(stale: boolean, killed: boolean, paused: boolean, riskHalted: boolean, usableMarkets: number, readiness: string): string {
  if (killed) return "KILLED";
  if (riskHalted) return "RISK_HALT";
  if (stale) return "STALE_DATA_HALT";
  if (paused) return "PAUSED";
  if (state.lastError) return "DEGRADED";
  if (usableMarkets === 0) return "WAITING_FOR_DATA";
  if (readiness !== "READY") return "DEGRADED";
  return "PAPER_RUNNING";
}

async function statusPayload() {
  const [killed, paused, stale, riskHalted] = await Promise.all([
    readFlag(killFile), readFlag(pauseFile), readFlag(staleHaltFile), readFlag(riskHaltFile),
  ]);
  const now = Date.now();
  const cycleAgeMs = lastCycleInMemory === null ? null : Math.max(0, now - lastCycleInMemory);
  const dataAgeMs = state.lastHealthyDataAt === null ? null : Math.max(0, now - state.lastHealthyDataAt);
  const freshUsableMarkets = [...latestMarkets.values()].filter((market) => marketHasFreshInputs(market, now)).length;
  const portfolioMarkable = state.account.positions.every((position) => {
    const positionMarket = latestMarkets.get(position.marketId);
    return Boolean(positionMarket && marketHasFreshStreamingData(positionMarket, now));
  });
  const readiness = freshUsableMarkets === 0 ? "WAITING_FOR_DATA"
    : !killed && !paused && !stale && !riskHalted
      && cycleAgeMs !== null && cycleAgeMs <= Math.max(10_000, decisionIntervalMs * 4)
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
  const liquidationEquity = accountLiquidationEquity(state.account, latestMarkets, costs);
  const riskEquity = portfolioMarkable ? liquidationEquity : null;
  const profile = bankrollProfile(riskEquity ?? equity);
  const recentRiskHistory = paperLossHistory(state.account, now);
  const risk = riskEquity !== null && state.dayStartEquity !== null
    ? assessBankrollRisk({
      equityUsd: riskEquity,
      dayStartEquityUsd: state.dayStartEquity,
      peakEquityUsd: state.peakLiquidationEquity ?? state.account.startingCash,
      profile,
      ...recentRiskHistory,
    })
    : null;
  const deployed = accountDeployed(state.account);
  const exposureByAsset: Record<string, number> = {};
  const exposureByDuration: Record<string, number> = {};
  const directionalExposure = { UP: 0, DOWN: 0 };
  for (const position of state.account.positions) {
    exposureByAsset[position.asset] = (exposureByAsset[position.asset] ?? 0) + position.totalCost;
    exposureByDuration[position.duration] = (exposureByDuration[position.duration] ?? 0) + position.totalCost;
    directionalExposure[position.side] += position.totalCost;
  }
  return {
    service: "polymarket-quant-engine",
    process: "running",
    readiness,
    mode: "paper",
    referencePolicy: "Paper entries require a verified Polymarket 60-second TWAP Price to Beat and a fresh matching current price feed.",
    tradingState: tradingStateSnapshot(stale, killed, paused, riskHalted, freshUsableMarkets, readiness),
    lastCycleAt: state.lastCycleAt,
    decisionIntervalMs,
    marketRefreshIntervalMs: pollIntervalMs,
    lastMarketRefreshAt: lastMarketRefreshAt || null,
    marketRefreshInFlight,
    lastDecisionDurationMs,
    lastDecisionIntervalMs,
    decisionCycleOverruns,
    lastHealthyDataAt: state.lastHealthyDataAt,
    lastError: state.lastError,
    lastHealthyDataAgeMs: state.lastHealthyDataAt === null ? null : Math.max(0, now - state.lastHealthyDataAt),
    marketsTracked: state.marketsTracked,
    usableMarkets: freshUsableMarkets,
    controls: { paused, killed, staleDataHalt: stale, riskHalt: riskHalted },
    paper: {
      startingCash: state.account.startingCash,
      cash: state.account.cash,
      equity,
      liquidationEquity,
      realizedPnl: state.account.realizedPnl,
      unrealizedPnl: accountUnrealized(state.account, latestMarkets),
      totalPnl: equity - state.account.startingCash,
      winRate: accountWinRate(state.account),
      openPositions: state.account.positions.length,
      expiredAwaitingGammaResolution: expiredOpenPositions,
      buyFills: state.account.fills.filter((fill) => fill.action === "BUY").length,
      fees: state.account.fees,
      deployed,
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
      minimumBetPct: 0,
      maximumBetPct: Math.min(paperMaxBetPct, profile.maxStakePct),
      maximumExposurePct: Math.min(paperMaxExposurePct, profile.maxExposurePct),
    },
    bankroll: {
      tier: profile.tier,
      strategy: profile.strategy,
      smallAccountProtectionActive: profile.tier === "MICRO" || profile.tier === "SMALL",
      valuationReady: riskEquity !== null,
      liquidationEquity: riskEquity,
      cashUsd: state.account.cash,
      reserveUsd: riskEquity === null ? null : riskEquity * profile.reservePct,
      cashAboveReserveUsd: riskEquity === null ? null : Math.max(0, state.account.cash - riskEquity * profile.reservePct),
      maximumStakeUsd: riskEquity === null ? null : riskEquity * Math.min(profile.maxStakePct, paperMaxBetPct),
      maximumExposureUsd: riskEquity === null ? null : riskEquity * Math.min(profile.maxExposurePct, paperMaxExposurePct),
      maximumCorrelatedExposureUsd: riskEquity === null ? null : riskEquity * profile.maxCorrelatedExposurePct,
      deployedUsd: deployed,
      correlatedExposureUsd: deployed,
      remainingExposureUsd: riskEquity === null ? null : Math.max(0, riskEquity * Math.min(profile.maxExposurePct, paperMaxExposurePct) - deployed),
      remainingCorrelatedExposureUsd: riskEquity === null ? null : Math.max(0, riskEquity * profile.maxCorrelatedExposurePct - deployed),
      directionalExposureUsd: directionalExposure,
      exposureByAssetUsd: exposureByAsset,
      exposureByDurationUsd: exposureByDuration,
      openPositions: state.account.positions.length,
      maximumOpenPositions: Math.min(profile.maxOpenPositions, paperMaxOpenPositions),
      minimumNetEdge: Math.max(profile.minNetEdge, paperMinNetEdge),
      maximumSpreadPct: profile.maxSpreadPct,
      minimumExpectedProfitUsd: profile.minExpectedProfitUsd,
      dailyLossLimitPct: Math.min(profile.maxDailyLossPct, paperMaxDailyLossPct),
      dayStartLiquidationEquity: state.dayStartEquity,
      peakLiquidationEquity: state.peakLiquidationEquity,
      riskApproved: risk?.approved ?? false,
      riskState: risk?.state ?? "UNAVAILABLE",
      consecutiveLossesToday: recentRiskHistory.consecutiveLosses,
      riskReason: risk?.reason ?? "Fresh executable portfolio marks are unavailable.",
      dailyLossPct: risk?.dayLossPct ?? null,
      dailyLossRemainingUsd: risk?.dailyLossRemainingUsd ?? null,
      peakDrawdownPct: risk?.peakDrawdownPct ?? null,
      drawdownAdjustment: risk?.drawdownAdjustment ?? null,
    },
    streams: {
      coinbaseConnected,
      clobConnected: clobPool.status().connected > 0,
      clobShards: clobPool.status(),
      polymarketPriceConnected: priceStreamConnected,
      lastOfficialPriceAt,
      officialPriceAgeMs: lastOfficialPriceAt === null ? null : Math.max(0, now - lastOfficialPriceAt),
      clobRequired: state.account.positions.some((position) => latestMarkets.has(position.marketId)),
      lastUpdateAt: lastStreamUpdateAt,
      lastUpdateAgeMs: lastStreamUpdateAt === null ? null : Math.max(0, now - lastStreamUpdateAt),
      clobUpdateAgeMs: lastClobUpdateAt === null ? null : Math.max(0, now - lastClobUpdateAt),
    },
    dataQuality: {
      eligibleMarkets: latestEligibleMarketCount,
      usableMarkets: freshUsableMarkets,
      blockers: latestMarketDataIssues,
    },
    staleRecovery: {
      healthyCycles: staleRecoveryTracker.healthyObservations,
      requiredCycles: staleRecoveryCyclesRequired,
      minimumUsableMarkets: staleRecoveryMinimumMarkets,
    },
    reconciliation: "PASS",
    eventLoop: {
      delayP50Ms: Math.round(eventLoopDelay.percentile(50) / 1e6),
      delayP99Ms: Math.round(eventLoopDelay.percentile(99) / 1e6),
      delayMaxMs: Math.round(eventLoopDelay.max / 1e6),
    },
  };
}

const healthServer = createServer(async (request, response) => {
  const origin = request.headers.origin;
  const browserRequest = typeof origin === "string";
  if (browserRequest && !dashboardOrigins.has(origin)) {
    response.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" });
    response.end(JSON.stringify({ ok: false, error: "This browser origin is not allowed to read daemon status." }));
    return;
  }
  const corsHeaders = browserRequest ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Private-Network": "true",
    "Vary": "Origin",
  } : {};
  if (request.method === "OPTIONS" && request.url === "/status" && browserRequest) {
    const requestedMethod = request.headers["access-control-request-method"];
    const requestedHeaders = request.headers["access-control-request-headers"];
    if (requestedMethod !== "GET" || requestedHeaders) {
      response.writeHead(403, { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: false, error: "Only header-free GET requests are allowed." }));
      return;
    }
    response.writeHead(204, {
      ...corsHeaders,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    response.end();
    return;
  }
  if (request.method !== "GET" || !["/healthz", "/readyz", "/livez", "/status"].includes(request.url ?? "")) {
    response.writeHead(404, { ...corsHeaders, "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "Not found." }));
    return;
  }
  const now = Date.now();
  const alive = lastCycleInMemory !== null && now - lastCycleInMemory <= Math.max(10_000, decisionIntervalMs * 4);
  if (request.url === "/livez") {
    response.writeHead(alive ? 200 : 503, { ...corsHeaders, "Cache-Control": "no-store", "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: alive, process: alive ? "running" : "unhealthy", lastCycleAt: state.lastCycleAt }));
    return;
  }
  const payload = await statusPayload();
  const ready = payload.readiness === "READY";
  const isReadinessCheck = request.url === "/healthz" || request.url === "/readyz";
  response.writeHead(isReadinessCheck && !ready ? 503 : 200, {
    ...corsHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(isReadinessCheck ? { ok: ready, liveness: alive, ...payload } : payload));
});

await new Promise<void>((resolve, reject) => {
  healthServer.once("error", reject);
  healthServer.listen(healthPort, "127.0.0.1", () => resolve());
});
log("INFO", "Headless paper daemon started", { mode: "paper", readiness: `http://127.0.0.1:${healthPort}/healthz`, liveness: `http://127.0.0.1:${healthPort}/livez`, decisionIntervalMs, marketRefreshIntervalMs: pollIntervalMs });
const reportCalibration = async () => {
  const status = await loadCalibrationFile(calibrationFile);
  log("INFO", status.active ? "Using fitted stacking calibration for the model weight" : "Using the conservative prior model weight", status.active
    ? { markets: status.active.markets, modelCoefficient: status.active.modelCoefficient, modelCoefficientLower: status.active.modelCoefficientLower }
    : { reason: status.reason });
};
await reportCalibration();
const calibrationTimer = setInterval(() => void reportCalibration(), 10 * 60_000);
calibrationTimer.unref();
const markTimer = setInterval(() => {
  if (latestMarkets.size) state.account = markAccount(state.account, latestMarkets, Date.now());
}, 1000);
markTimer.unref();

async function collectMarkets(): Promise<LiveMarket[]> {
  const signal = shutdownController.signal;
  const definitions = await discoverCryptoMarkets(signal);
  const tokenIds = definitions.flatMap((market) => [market.upTokenId, market.downTokenId]);
  const assets = [...new Set(definitions.map((market) => market.asset))];
  const [books, candles] = await Promise.all([
    fetchOrderBooks(tokenIds, signal),
    fetchCandleHistories(assets, signal),
  ]);
  const now = Date.now();
  const priceTicks = [...polymarketPriceTicks.values()];
  return definitions.map((definition) => applyPolymarketPriceTicks(
    buildLiveMarket(definition, books, new Map(), null, now, candles.get(definition.asset) ?? null), priceTicks, now));
}

async function refreshMarketSnapshot(): Promise<void> {
  if (marketRefreshInFlight || stopping || shutdownController.signal.aborted) return;
  marketRefreshInFlight = true;
  try {
    const refreshed = await collectMarkets();
    if (stopping || shutdownController.signal.aborted) return;
    latestMarkets = new Map(refreshed.map((market) => [market.id, preserveNewerStreamBooks(market, latestMarkets.get(market.id))]));
    // A full snapshot repaired every invalidated book; the merge above keeps
    // newer stream updates that arrived while the REST requests were pending.
    desyncedClobTokens.clear();
    pruneTrackingMaps(refreshed);
    ensureMarketStreams(refreshed);
    lastMarketRefreshAt = Date.now();
    state.lastError = null;
    log("INFO", "Market discovery and REST book refresh completed", { markets: refreshed.length });
  } catch (error) {
    state.lastError = errorMessage(error);
    staleRecoveryTracker.reset();
    log("WARN", "Market-data refresh failed; cached data remains subject to age checks", { error: state.lastError });
  } finally {
    marketRefreshInFlight = false;
  }
}

function scheduleExpiredPositionResolution(now: number): void {
  if (resolutionCheckInFlight || !state.account.positions.some((position) => position.endTime <= now
    && now - (state.resolutionCheckedAt[position.marketId] ?? 0) >= RESOLUTION_RECHECK_MS)) return;
  resolutionCheckInFlight = true;
  void resolveExpiredPositions(now)
    .catch((error) => log("WARN", "Background paper-position resolution failed", { error: errorMessage(error) }))
    .finally(() => { resolutionCheckInFlight = false; });
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
        // Coinbase updates secondary candle context only. It must never
        // overwrite the displayed Polymarket TWAP spot, Price to Beat, or
        // probability inputs used for an entry or an exit.
        latestMarkets.set(id, { ...market, ...candleUpdate });
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

function ensureMarketStreams(markets: LiveMarket[]): void {
  const priceKey = [...new Set(markets.map((market) => market.asset))].sort().join(",");
  if (priceKey !== priceSubscriptionKey) {
    stopPriceStream?.();
    stopPriceStream = null;
    priceStreamConnected = false;
    priceSubscriptionKey = priceKey;
    if (priceKey) {
      stopPriceStream = subscribePolymarketPrices(priceKey.split(","), (ticks) => {
        const now = Date.now();
        cachePolymarketPriceTicks(ticks, now);
        for (const [id, market] of latestMarkets) {
          const updated = applyPolymarketPriceTicks(market, ticks, now);
          if (updated !== market) latestMarkets.set(id, updated);
        }
        lastStreamUpdateAt = now;
      }, (status) => {
        priceStreamConnected = status === "CONNECTED";
        if (status !== lastPriceStreamStatus) {
          lastPriceStreamStatus = status;
          if (status !== "CONNECTING") log(status === "CONNECTED" ? "INFO" : "WARN", `Polymarket oracle-aligned price stream ${status.toLowerCase()}`);
        }
      }, shutdownController.signal);
    }
  }
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
  // Stream books for every market that is trading now or about to, plus any
  // market holding a position; REST snapshots every poll are the fallback.
  const positionMarketIds = new Set(state.account.positions.map((position) => position.marketId));
  const serverNow = synchronizedPolymarketTime();
  const streamedMarkets = markets.filter((market) => positionMarketIds.has(market.id)
    || ((market.startTime === null || market.startTime <= serverNow + 60_000) && market.endTime > serverNow));
  streamedTokens = new Set(streamedMarkets.flatMap((market) => [market.upTokenId, market.downTokenId]).filter(Boolean));
  clobPool.setShards(streamedMarkets.map((market) => [market.upTokenId, market.downTokenId].filter(Boolean)));
}

async function repairDesyncedBooks(): Promise<void> {
  if (desyncRefreshInFlight || !desyncedClobTokens.size) return;
  desyncRefreshInFlight = true;
  try {
    const tokens = [...desyncedClobTokens];
    const books = await fetchOrderBooks(tokens, shutdownController.signal);
    const now = Date.now();
    for (const [tokenId, book] of books) {
      for (const [id, market] of latestMarkets) {
        if (market.upTokenId !== tokenId && market.downTokenId !== tokenId) continue;
        latestMarkets.set(id, applyBookSnapshot(market, tokenId, book, now));
      }
      desyncedClobTokens.delete(tokenId);
    }
  } catch (error) {
    log("WARN", "Could not refresh drifted order books; they stay unusable until a snapshot arrives", { error: errorMessage(error) });
  } finally {
    desyncRefreshInFlight = false;
    // Books that drifted while this repair was in flight get their own pass.
    if (desyncedClobTokens.size && !stopping && !shutdownController.signal.aborted) {
      setTimeout(() => void repairDesyncedBooks(), 1_000).unref();
    }
  }
}

let staleBookRefreshAt = 0;
let staleBookRefreshInFlight = false;

/**
 * Quiet streamed books need their own evidence: fetch REST snapshots for any
 * subscribed token whose book has not been confirmed for 5 s (at most every
 * 2 s, one batched request).
 */
function refreshStaleBooks(now: number): void {
  if (staleBookRefreshInFlight || now - staleBookRefreshAt < 2_000) return;
  const stale = staleBookTokens(latestMarkets.values(), streamedTokens, now);
  if (!stale.length) return;
  staleBookRefreshAt = now;
  staleBookRefreshInFlight = true;
  void fetchOrderBooks(stale, shutdownController.signal)
    .then((books) => {
      const receivedAt = Date.now();
      for (const [tokenId, book] of books) {
        for (const [id, market] of latestMarkets) {
          if (market.upTokenId === tokenId || market.downTokenId === tokenId) latestMarkets.set(id, applyBookSnapshot(market, tokenId, book, receivedAt));
        }
      }
    })
    .catch((error) => log("WARN", "Could not refresh quiet order books", { error: errorMessage(error) }))
    .finally(() => { staleBookRefreshInFlight = false; });
}

/**
 * Record, for every usable market, the decision-time model and book
 * probabilities, the model/feed identity, the fee schedule, and the engine's
 * decision, including PASS. `pnpm run calibrate` pairs them with outcomes; the
 * decision fields form the candidate-level evidence set.
 */
function recordObservations(markets: LiveMarket[], now: number, decisions: ReadonlyMap<string, PaperOpportunity> = new Map()): void {
  const lines: string[] = [];
  for (const market of markets) {
    if (market.fairUp === null) continue;
    const marketUp = marketImpliedProbabilityUp(market);
    if (marketUp === null) continue;
    if (now - (lastObservationAt.get(market.id) ?? 0) < observationIntervalMs) continue;
    lastObservationAt.set(market.id, now);
    const decision = decisions.get(market.id);
    lines.push(JSON.stringify({
      marketId: market.id, upTokenId: market.upTokenId, downTokenId: market.downTokenId, asset: market.asset, duration: market.duration,
      modelVersion: FORECAST_MODEL_VERSION, priceFeed: market.priceFeed, feeRate: market.feeSchedule?.rate ?? null,
      feeSource: market.feeSchedule?.source ?? null, endTime: market.endTime,
      decision: decision ? (decision.approved ? decision.signal.action : "PASS") : null,
      decisionReason: decision ? decision.reason.slice(0, 200) : null,
      signalEdge: decision?.signal.edge ?? null, signalEntryPrice: decision?.signal.entryPrice ?? null, anchoredFairUp: decision?.signal.fairUp ?? null,
      at: now, remainingSeconds: market.remaining, rawModelUp: market.fairUp, marketUp,
      upBid: market.upBid, upAsk: market.upAsk, downBid: market.downBid, downAsk: market.downAsk,
      reference: market.reference, spot: market.spot, settlementPrice: market.settlementPrice ?? null,
    }));
  }
  if (!lines.length) return;
  for (const [id, at] of lastObservationAt) if (now - at > 60 * 60_000) lastObservationAt.delete(id);
  void appendFile(observationFile, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o640 })
    .catch((error) => log("WARN", "Could not append calibration observations", { error: errorMessage(error) }));
}

/** Fill a pending paper order once its simulated latency has elapsed, against the book as it is then. */
function processPendingPaperOrder(marketMap: Map<string, LiveMarket>, now: number): void {
  const order = pendingPaperOrder;
  if (!order || now - order.submittedAt < paperFillLatencyMs) return;
  pendingPaperOrder = null;
  state.pendingPaperOrder = null;
  const market = marketMap.get(order.marketId);
  if (!market || !marketHasFreshInputs(market, now)) {
    log("INFO", "Paper order expired unfilled: its market data was not fresh at fill time", { marketId: order.marketId });
    return;
  }
  // FAK semantics: any positive quantity up to the limit fills, even below the
  // venue minimum (the submitted size met it; the match need not).
  const result = buyPaper(state.account, market, order.side, order.stakeUsd, costs, order.reason, now, order.maxPrice, true);
  if (!result.fill) {
    log("INFO", "Paper FAK order did not fill within its limit after the simulated latency", {
      marketId: order.marketId, side: order.side, limit: order.maxPrice, latencyMs: now - order.submittedAt,
    });
    return;
  }
  state.account = markAccount(result.account, marketMap, now);
  state.tokenIdsByMarket[market.id] = { upTokenId: market.upTokenId, downTokenId: market.downTokenId };
  log("INFO", "Paper fill recorded", {
    asset: market.asset, duration: market.duration, side: order.side, notional: result.fill.totalCost,
    averagePrice: result.fill.price, limit: order.maxPrice, latencyMs: now - order.submittedAt, marketId: market.id,
  });
}

function closeMarketStreams(): void {
  stopPriceStream?.();
  stopPriceStream = null;
  priceStreamConnected = false;
  const coinbase = coinbaseSocket as WebSocket | null;
  coinbaseSocket = null;
  coinbase?.close();
  clobPool.close();
}

function marketHasFreshInputs(market: LiveMarket, now: number): boolean {
  return market.startTime !== null && market.startTime <= now && market.remaining >= 30 &&
    marketHasFreshStreamingData(market, now) && market.referenceVerified && market.referenceSource === "POLYMARKET" &&
    marketDataFreshnessIssue(market, now) === null;
}

function marketHasFreshStreamingData(market: LiveMarket, now: number): boolean {
  return market.upAsk !== null && market.upBid !== null && market.downAsk !== null && market.downBid !== null &&
    marketStreamingDataFreshnessIssue(market, now) === null;
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
  const fullyMarkable = state.account.positions.every((position) => {
    const market = markets.get(position.marketId);
    return Boolean(market && marketHasFreshInputs(market, now));
  });
  const profileEquity = fullyMarkable
    ? accountLiquidationEquity(state.account, markets, costs)
    : state.account.cash + accountDeployed(state.account);
  const profile = bankrollProfile(profileEquity);
  const policy = {
    ...DEFAULT_PAPER_EARLY_EXIT,
    earlyExitMinProfitUsd: Math.min(DEFAULT_PAPER_EARLY_EXIT.earlyExitMinProfitUsd, Math.max(0.02, profile.minExpectedProfitUsd)),
    earlyExitMinProfitPct: Math.min(DEFAULT_PAPER_EARLY_EXIT.earlyExitMinProfitPct, Math.max(0.025, profile.minExpectedProfitOnStakePct / 2)),
  };
  const confirmedExits: Array<{ id: string; reason: string; advantageUsd: number; proceedsUsd: number }> = [];
  for (const position of state.account.positions) {
    const market = markets.get(position.marketId);
    const fairUp = market ? anchoredFairUp(market) : null;
    if (!market || fairUp === null || !marketHasFreshInputs(market, now)) {
      delete state.exitObservations[position.id];
      continue;
    }
    const exitFill = estimatePaperExitFill(market, position.side, position.shares, costs);
    const fairProbability = position.side === "UP" ? fairUp : 1 - fairUp;
    if (!exitFill || exitFill.shares + 0.00000001 < position.shares) {
      delete state.exitObservations[position.id];
      continue;
    }
    const modelRead = analyzeMarketSignal(market, costs, Math.max(paperMinBetUsd, position.totalCost), 0.04);
    const opposite = position.side === "UP" ? "DOWN" : "UP";
    const directionalReversal = modelRead.bias === opposite && (modelRead.biasConfidence ?? 0) >= 0.6 && fairProbability < 0.45;
    const evaluation = evaluatePaperHoldExit({
      policy,
      entryCostUsd: position.totalCost,
      originalShares: position.shares,
      filledShares: exitFill.shares,
      netExitProceedsUsd: exitFill.totalCost,
      sideFairProbability: fairProbability,
      remainingSeconds: market.remaining,
      directionalReversal,
      reversalMarginPct: profile.tier === "MICRO" ? 0.005 : 0.01,
    });
    if (!evaluation.shouldExit) {
      delete state.exitObservations[position.id];
      continue;
    }
    const previous = state.exitObservations[position.id];
    const count = previous && now - previous.lastSeen <= EXIT_CONFIRMATION_WINDOW_MS ? previous.count + 1 : 1;
    state.exitObservations[position.id] = { count, lastSeen: now };
    if (count >= policy.earlyExitConfirmations) confirmedExits.push({
      id: position.id,
      reason: evaluation.reason,
      advantageUsd: evaluation.exitAdvantageUsd,
      proceedsUsd: evaluation.netExitProceedsUsd,
    });
  }
  for (const exit of confirmedExits) {
    const closed = closePaperPositions(state.account, markets, costs, `bankroll-aware paper cashout; ${exit.reason}`, now, new Set([exit.id]));
    if (closed.closed) {
      state.account = closed.account;
      delete state.exitObservations[exit.id];
      log("INFO", "Bankroll-aware paper cashout", {
        reason: exit.reason,
        realized: closed.realized,
        exitAdvantageUsd: exit.advantageUsd,
        netExitProceedsUsd: exit.proceedsUsd,
        tier: profile.tier,
      });
    }
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

async function recoverStaleDataHaltAfterFreshCycles(freshMarkets: number, portfolioMarkable: boolean, observationSignature: string): Promise<void> {
  const haltLatched = await readFlag(staleHaltFile);
  const healthyObservations = staleRecoveryTracker.observe({
    haltLatched,
    freshMarketCount: freshMarkets,
    minimumFreshMarkets: staleRecoveryMinimumMarkets,
    portfolioMarkable,
    hasError: state.lastError !== null,
    signature: observationSignature,
  });
  if (!haltLatched || healthyObservations < staleRecoveryCyclesRequired) return;

  await rm(staleHaltFile, { force: true });
  log("WARN", "Stale-data halt recovered after consecutive fresh market snapshots; other safety latches remain active.", {
    healthyCycles: healthyObservations,
    freshMarkets,
    minimumFreshMarkets: staleRecoveryMinimumMarkets,
  });
  staleRecoveryTracker.reset();
}

async function runCycle(): Promise<void> {
  const cycleStartedAt = Date.now();
  try {
    // Check before attempting recovery so a successful fetch cannot erase evidence
    // that the last complete snapshot was already stale.
    await latchStaleDataIfNeeded(cycleStartedAt);
    if (stopping || shutdownController.signal.aborted) return;
    const now = Date.now();
    refreshStaleBooks(now);
    const allMarkets = [...latestMarkets.values()];
    await latchStaleDataIfNeeded(now);
    const markets = allMarkets.filter((market) => market.endTime > now);
    pruneTrackingMaps(markets);
    const freshDataMarkets = markets.filter((market) => marketHasFreshStreamingData(market, now));
    const usableMarkets = markets.filter((market) => marketHasFreshInputs(market, now));
    const eligibleMarkets = markets.filter((market) => market.startTime !== null && market.startTime <= now && market.remaining >= 30);
    const blockerCounts: Record<string, number> = {};
    for (const market of eligibleMarkets) {
      const issue = marketDataFreshnessIssue(market, now) ??
        (marketHasFreshInputs(market, now) ? null : "Verified Polymarket TWAP Price to Beat, current price, or executable book is unavailable.");
      if (issue) blockerCounts[issue] = (blockerCounts[issue] ?? 0) + 1;
    }
    latestEligibleMarketCount = eligibleMarkets.length;
    latestMarketDataIssues = blockerCounts;
    if (eligibleMarkets.length > 0 && usableMarkets.length === 0 && now - lastDataGapWarningAt >= 60_000) {
      lastDataGapWarningAt = now;
      log("WARN", "No eligible paper market has a complete fresh snapshot.", {
        eligibleMarkets: eligibleMarkets.length,
        blockers: blockerCounts,
      });
    }
    const marketMap = new Map(markets.map((market) => [market.id, market]));
    ensureMarketStreams(markets);
    latestSignals = [];
    latestSignalsAt = now;
    state.marketsTracked = markets.length;
    state.usableMarkets = usableMarkets.length;
    if (freshDataMarkets.length) {
      const observedAt = Math.max(...freshDataMarkets.flatMap((market) => [market.spotUpdatedAt, market.upBook?.timestamp ?? null,
        market.downBook?.timestamp ?? null, market.chartUpdatedAt].filter((value): value is number => value !== null && value <= now + 1000)));
      if (Number.isFinite(observedAt)) state.lastHealthyDataAt = Math.max(state.lastHealthyDataAt ?? 0, Math.min(now, observedAt));
    }
    for (const position of state.account.positions) {
      const activeMarket = marketMap.get(position.marketId);
      if (activeMarket) {
        state.tokenIdsByMarket[position.marketId] = {
          upTokenId: activeMarket.upTokenId,
          downTokenId: activeMarket.downTokenId,
        };
      }
    }
    scheduleExpiredPositionResolution(now);
    if (stopping || shutdownController.signal.aborted) return;

    const recoveryPortfolioMarkable = state.account.positions.every((position) => {
      const positionMarket = marketMap.get(position.marketId);
      return Boolean(positionMarket && marketHasFreshStreamingData(positionMarket, now));
    });
    const recoveryObservationSignature = freshDataMarkets.slice(0, Math.max(1, staleRecoveryMinimumMarkets))
      .map((market) => [market.id, market.spotUpdatedAt, market.upBook?.timestamp, market.downBook?.timestamp, market.chartUpdatedAt].join(":"))
      .join("|");
    await recoverStaleDataHaltAfterFreshCycles(freshDataMarkets.length, recoveryPortfolioMarkable, recoveryObservationSignature);

    if (usableMarkets.length || (state.account.positions.length > 0 && recoveryPortfolioMarkable)) {
      processPendingPaperOrder(marketMap, now);
      state.account = markAccount(state.account, marketMap, now);
      applyEarlyExits(marketMap, now);
      state.account = markAccount(state.account, marketMap, now);

      const portfolioMarkable = state.account.positions.every((position) => {
        const positionMarket = marketMap.get(position.marketId);
        return Boolean(positionMarket && marketHasFreshStreamingData(positionMarket, now));
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
      if (currentLiquidationEquity !== null) {
        state.peakLiquidationEquity = Math.max(state.peakLiquidationEquity ?? state.account.startingCash, currentLiquidationEquity);
        const profile = bankrollProfile(currentLiquidationEquity);
        const dailyLossLimitPct = Math.min(profile.maxDailyLossPct, paperMaxDailyLossPct);
        if (!await readFlag(riskHaltFile) && state.dayStartEquity !== null &&
            currentLiquidationEquity <= state.dayStartEquity * (1 - dailyLossLimitPct)) {
          await latchFile(riskHaltFile, `Paper daily liquidation loss limit reached (${(dailyLossLimitPct * 100).toFixed(1)}% ${profile.tier} cap).`);
        }
        if (!await readFlag(riskHaltFile) && state.peakLiquidationEquity > 0 &&
            currentLiquidationEquity <= state.peakLiquidationEquity * (1 - profile.maxPeakDrawdownPct)) {
          await latchFile(riskHaltFile, `Paper peak-to-current liquidation drawdown limit reached (${(profile.maxPeakDrawdownPct * 100).toFixed(1)}% ${profile.tier} cap).`);
        }
      }

      const [killed, paused, stale, riskHalted] = await Promise.all([
        readFlag(killFile), readFlag(pauseFile), readFlag(staleHaltFile), readFlag(riskHaltFile),
      ]);
      if (stopping || shutdownController.signal.aborted) return;
      const opportunities: Array<{ market: LiveMarket; opportunity: PaperOpportunity }> = currentLiquidationEquity === null ? [] : usableMarkets
        .map((market) => ({
          market,
          opportunity: evaluatePaperMarket({
            market,
            markets: marketMap,
            account: state.account,
            costs,
            liquidationEquityUsd: currentLiquidationEquity,
            dayStartLiquidationEquityUsd: state.dayStartEquity ?? undefined,
            peakLiquidationEquityUsd: state.peakLiquidationEquity ?? undefined,
            minOrderUsd: paperMinBetUsd,
            maxTradeUsd: currentLiquidationEquity * paperMaxBetPct,
            maxExposurePct: paperMaxExposurePct,
            maxOpenPositions: paperMaxOpenPositions,
            minNetEdge: paperMinNetEdge,
          }),
        }))
        .sort((left, right) => Number(right.opportunity.approved) - Number(left.opportunity.approved)
          || (right.opportunity.score?.score ?? 0) - (left.opportunity.score?.score ?? 0)
          || (right.opportunity.signal.edge ?? -1) - (left.opportunity.signal.edge ?? -1));
      recordObservations(usableMarkets, now, new Map(opportunities.map(({ market, opportunity }) => [market.id, opportunity])));
      const controlBlocker = killed ? "kill switch active" : paused ? "paper trading paused" :
        stale ? "stale-data halt active" : riskHalted ? "risk halt active" : state.lastError ? "market-data refresh or decision error" : null;
      latestSignals = opportunities.slice(0, 20).map(({ market, opportunity }) => {
        const { signal, sizing, score, book } = opportunity;
        const profile = sizing?.profile ?? bankrollProfile(currentLiquidationEquity!);
        const entryAllowed = opportunity.approved && controlBlocker === null;
        return {
          marketId: market.id,
          marketLabel: `${market.asset} ${market.duration}`,
          asset: market.asset,
          duration: market.duration,
          action: entryAllowed ? signal.action : "PASS" as const,
          edge: signal.edge,
          confidence: signal.confidence,
          entryPrice: signal.entryPrice,
          targetBetUsd: opportunity.stakeUsd,
          targetBetPct: currentLiquidationEquity! > 0 ? opportunity.stakeUsd / currentLiquidationEquity! : 0,
          maximumAllowedStakeUsd: sizing?.maxAllowedStakeUsd ?? 0,
          minimumExecutableOrderUsd: book && book.minimumExecutableOrderUsd < Number.MAX_SAFE_INTEGER ? book.minimumExecutableOrderUsd : null,
          expectedNetProfitUsd: sizing?.expectedNetProfitUsd ?? signal.expectedNetProfitUsd,
          opportunityScore: score?.score ?? 0,
          scoreComponents: score?.components ?? null,
          bankrollTier: profile.tier,
          strategy: profile.strategy,
          marketProbability: signal.marketProbabilityUp,
          fairProbability: signal.fairUp,
          rawModelProbability: signal.rawModelUp,
          spread: book?.spreadPct ?? null,
          availableDepthUsd: book?.availableDepthUsd ?? null,
          smallAccountProtectionActive: profile.tier === "MICRO" || profile.tier === "SMALL",
          entryAllowed,
          reason: opportunity.approved && controlBlocker ? `PASS: ${controlBlocker}. ${opportunity.reason}` : opportunity.reason,
          remainingSeconds: market.remaining,
        };
      });
      const canEnter = !stopping && !shutdownController.signal.aborted && !killed && !paused && !stale && !riskHalted
        && state.lastError === null && portfolioMarkable
        && state.account.positions.length + (pendingPaperOrder ? 1 : 0) < paperMaxOpenPositions;
      if (canEnter && pendingPaperOrder === null && state.account.cash >= paperMinBetUsd && state.account.positions.length < paperMaxOpenPositions) {
        const candidate = opportunities.find(({ opportunity }) => opportunity.approved && opportunity.signal.action !== "PASS");
        if (candidate) {
          const lastEntryAt = state.lastEntryByMarket[candidate.market.id] ?? 0;
          const side = candidate.opportunity.signal.action as PaperSide;
          const fairUp = candidate.opportunity.signal.fairUp;
          // Limit price: the highest price at which every share still clears
          // the edge floor after fees and the slippage buffer.
          const maxPrice = fairUp === null ? null : modelPriceCeiling({
            fairProbability: side === "UP" ? fairUp : 1 - fairUp, minEdge: paperMinNetEdge, tickSize: 0.01,
            slippageBps: costs.slippageBps, feeSchedule: candidate.market.feeSchedule, fallbackFeeRate: costs.feeRate,
          });
          if (maxPrice !== null && !stopping && !shutdownController.signal.aborted && now - lastEntryAt >= 15_000 &&
              marketHasFreshInputs(candidate.market, Date.now())) {
            const referenceLabel = "verified Polymarket 60-second TWAP opening reference";
            pendingPaperOrder = state.pendingPaperOrder = {
              marketId: candidate.market.id, side, stakeUsd: candidate.opportunity.stakeUsd, maxPrice, submittedAt: now,
              reason: `headless bankroll-aware paper engine; ${candidate.opportunity.sizing?.tier ?? "UNKNOWN"}; ${referenceLabel}; score ${candidate.opportunity.score?.score ?? 0}; FAK limit ${maxPrice.toFixed(2)} after ${paperFillLatencyMs} ms`,
            };
            state.lastEntryByMarket[candidate.market.id] = now;
            log("INFO", "Paper FAK order submitted", {
              asset: candidate.market.asset, duration: candidate.market.duration, side, stakeUsd: candidate.opportunity.stakeUsd,
              limit: maxPrice, edge: candidate.opportunity.signal.edge, tier: candidate.opportunity.sizing?.tier,
              opportunityScore: candidate.opportunity.score?.score, latencyMs: paperFillLatencyMs, marketId: candidate.market.id,
            });
            if (paperFillLatencyMs === 0) processPendingPaperOrder(marketMap, now);
          }
        }
      }
    }

    ensureMarketStreams([...latestMarkets.values()]);
    assertPaperAccount(state.account);
  } catch (error) {
    state.lastError = errorMessage(error);
    // Recovery requires uninterrupted complete cycles; a late failure must
    // invalidate any healthy snapshots accumulated earlier in the streak.
    staleRecoveryTracker.reset();
    log("WARN", "Paper trading cycle failed; no new entries were considered", { error: state.lastError });
  } finally {
    state.lastCycleAt = Date.now();
    try {
      await latchStaleDataIfNeeded(state.lastCycleAt);
      assertPaperAccount(state.account);
      await saveState(state);
    } catch (error) {
      log("ERROR", "Paper-state reconciliation or persistence failed", { error: errorMessage(error) });
      process.exitCode = 1;
      stopping = true;
    }
    const cycleCompletedAt = Date.now();
    state.lastCycleAt = cycleCompletedAt;
    lastDecisionIntervalMs = lastCycleInMemory === null ? null : cycleCompletedAt - lastCycleInMemory;
    lastDecisionDurationMs = cycleCompletedAt - cycleStartedAt;
    if (lastDecisionDurationMs > decisionIntervalMs) decisionCycleOverruns += 1;
    lastCycleInMemory = cycleCompletedAt;
  }
}

process.once("SIGTERM", () => { stopping = true; shutdownController.abort(); });
process.once("SIGINT", () => { stopping = true; shutdownController.abort(); });

void refreshMarketSnapshot();
const marketRefreshTimer = setInterval(() => { void refreshMarketSnapshot(); }, pollIntervalMs);

while (!stopping) {
  const cycleStartedAt = Date.now();
  await runCycle();
  const elapsed = Date.now() - cycleStartedAt;
  if (!stopping && elapsed < decisionIntervalMs) await new Promise((resolve) => setTimeout(resolve, decisionIntervalMs - elapsed));
}

clearInterval(marketRefreshTimer);
clearInterval(markTimer);
if (coinbaseReconnectTimer) clearTimeout(coinbaseReconnectTimer);
closeMarketStreams();
await new Promise<void>((resolve) => healthServer.close(() => resolve()));
await new Promise<void>((resolve) => stateOperationLockServer.close(() => resolve()));
log("INFO", "Headless paper daemon stopped");
