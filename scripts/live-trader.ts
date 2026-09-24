import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AssetType, Chain, ClobClient, OrderType, Side, SignatureTypeV2, type ApiKeyCreds, type TickSize } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  applyPolymarketPriceTicks,
  buildLiveMarket,
  CONSERVATIVE_CRYPTO_FEE_SCHEDULE,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  anchoredFairUp,
  type Asset,
  type CandleHistory,
  type LiveMarket,
  type OrderBook,
  type PolymarketPriceTick,
} from "../app/lib/polymarket-data";
import { subscribePolymarketPrices, type PolymarketPriceStreamStatus } from "../app/lib/polymarket-price-stream";
import { analyzeMarketSignal, estimatePaperExitFill, marketDataFreshnessIssue, type ClosedPaperTrade, type PaperAccount, type PaperPosition } from "../app/lib/engines";
import { enforceLiveExecutionRisk } from "../app/lib/live-risk";
import { DEFAULT_LIVE_EARLY_EXIT, evaluatePaperHoldExit } from "../app/lib/early-exit";
import { bankrollProfile, type BankrollProfile } from "../app/lib/bankroll-policy";
import { evaluatePaperMarket, type PaperOpportunity } from "../app/lib/paper-bankroll";
import { sdkMarketBuyShares } from "../app/lib/live-order-sizing";

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const STORE_DIR = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "PolymarketQuantEngine");
const STATE_PATH = join(STORE_DIR, "live-trader-state.json");
const LOCK_PATH = join(STORE_DIR, "live-trader.lock");
const SCAN_MS = 1_000;
const DISCOVERY_MS = 15_000;
const LIVE_ENTRY_RISK_PCT = 0.15;
const LIVE_MINIMUM_SHARES = 5;
const LIVE_MINIMUM_ORDER_USD = 1;
const RETRY_NO_FILL_MS = 20_000;
const CLOSED_HISTORY_REFRESH_MS = 60_000;
const CLOSED_HISTORY_MAX_AGE_MS = 90_000;
const RISK = enforceLiveExecutionRisk({ feeRate: 0.05, slippageBps: 25, minEdge: 0.04, requireLock: true });
const LIVE_MINIMUM_ALL_IN_USD = Math.ceil((LIVE_MINIMUM_ORDER_USD * (1 + RISK.feeRate) - 1e-9) * 100) / 100;

type PositionRow = { tokenID: string | null; conditionId: string | null; slug: string | null; outcome: "UP" | "DOWN" | null; size: number; averagePrice: number | null; exposureUsd: number; currentValueUsd: number };
type TraderState = {
  version: 3;
  attemptedMarkets: string[];
  retryAfter: Record<string, number>;
  riskDayKey: string | null;
  riskDayStartEquityUsd: number | null;
  peakLiquidationEquityUsd: number | null;
  closedTrades: ClosedPaperTrade[];
  closedTradesAt: number | null;
  managedPositionTokens: string[];
  managedPositionSince: Record<string, number>;
  exitConfirmations: Record<string, { count: number; lastSeen: number }>;
  pending: { requestId: string; marketId: string; at: number; action: "BUY" | "SELL"; tokenID: string; shares: number } | null;
};

const emptyState = (): TraderState => ({ version: 3, attemptedMarkets: [], retryAfter: {}, riskDayKey: null,
  riskDayStartEquityUsd: null, peakLiquidationEquityUsd: null, closedTrades: [], closedTradesAt: null,
  managedPositionTokens: [], managedPositionSince: {}, exitConfirmations: {}, pending: null });

const number = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const money = (value: number) => `$${value.toFixed(2)}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const marketCycleKey = (market: { id: string; endTime: number }) => `${market.id}:${market.endTime}`;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const scrubError = (error: unknown, privateKey: string) => {
  const raw = error instanceof Error ? error.message : "Polymarket request failed.";
  const withoutPrivateKey = privateKey ? raw.replaceAll(privateKey, "[redacted]") : raw;
  return withoutPrivateKey.replace(/0x[a-fA-F0-9]{40,}/g, "[redacted]").slice(0, 240);
};

const ask = async (prompt: string) => {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Run this setup in a real terminal so the private key can stay hidden.");
  const readline = createInterface({ input: stdin, output: stdout });
  try { return (await readline.question(prompt)).trim(); }
  finally { readline.close(); }
};

const askSecret = async (prompt: string) => {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") throw new Error("A terminal with hidden input is required for the private key prompt.");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const restore = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          restore();
          reject(new Error("Setup cancelled."));
          return;
        }
        if (byte === 10 || byte === 13) {
          restore();
          resolve(value.trim());
          return;
        }
        if (byte === 8 || byte === 127) {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (byte >= 32 && byte <= 126) {
          value += String.fromCharCode(byte);
          stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
};

const readState = async (): Promise<TraderState> => {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as Omit<Partial<TraderState>, "version"> & { version?: number };
    if (![1, 2, 3].includes(state.version ?? -1) || !Array.isArray(state.attemptedMarkets) || (state.pending !== null && state.pending !== undefined)) {
      if (state.pending) throw new Error("A prior order request has an uncertain outcome. Check wallet positions, open orders, and activity before restarting. The pending marker is in the local trader state file.");
      throw new Error("The saved trader state is invalid; it will not be overwritten.");
    }
    if (state.version === 1) {
      // Old markers included known no-fills. Current wallet positions are checked
      // before every order, so retaining those markers would suppress valid retries.
      return emptyState();
    }
    const retryAfter = state.retryAfter && typeof state.retryAfter === "object" ? Object.fromEntries(
      Object.entries(state.retryAfter).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
    ) : {};
    const closedTrades = Array.isArray(state.closedTrades) ? state.closedTrades.filter((trade): trade is ClosedPaperTrade => Boolean(trade
      && typeof trade.id === "string" && typeof trade.timestamp === "number" && Number.isFinite(trade.timestamp)
      && typeof trade.marketId === "string" && typeof trade.marketLabel === "string"
      && (trade.side === "UP" || trade.side === "DOWN") && Number.isFinite(trade.pnl))) : [];
    const exitConfirmations = state.exitConfirmations && typeof state.exitConfirmations === "object" ? Object.fromEntries(
      Object.entries(state.exitConfirmations).filter((entry): entry is [string, { count: number; lastSeen: number }] => Boolean(entry[1]
        && Number.isInteger(entry[1].count) && entry[1].count > 0 && Number.isFinite(entry[1].lastSeen))),
    ) : {};
    const managedPositionSince = state.managedPositionSince && typeof state.managedPositionSince === "object" ? Object.fromEntries(
      Object.entries(state.managedPositionSince).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
    ) : {};
    return {
      version: 3,
      attemptedMarkets: state.attemptedMarkets.filter((entry): entry is string => typeof entry === "string").slice(-300),
      retryAfter,
      riskDayKey: typeof state.riskDayKey === "string" ? state.riskDayKey : null,
      riskDayStartEquityUsd: number(state.riskDayStartEquityUsd),
      peakLiquidationEquityUsd: number(state.peakLiquidationEquityUsd),
      closedTrades: closedTrades.slice(-500),
      closedTradesAt: number(state.closedTradesAt),
      managedPositionTokens: Array.isArray(state.managedPositionTokens) ? state.managedPositionTokens.filter((token): token is string => typeof token === "string").slice(-100) : [],
      managedPositionSince,
      exitConfirmations,
      pending: null,
    };
  } catch (error) {
    if (error instanceof Error && !("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    return emptyState();
  }
};

const writeState = async (state: TraderState) => {
  const temp = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  await rename(temp, STATE_PATH);
};

const acquireLock = async () => {
  await mkdir(STORE_DIR, { recursive: true });
  try {
    const handle = await open(LOCK_PATH, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return async () => { await handle.close().catch(() => undefined); await rm(LOCK_PATH, { force: true }).catch(() => undefined); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Another trader process may be running. If it is stopped, remove ${LOCK_PATH} after checking its process first.`);
    throw error;
  }
};

const readPositions = async (wallet: string): Promise<PositionRow[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${DATA_API}/v2/positions?user=${encodeURIComponent(wallet)}&limit=100`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Polymarket position lookup returned ${response.status}.`);
    const payload = await response.json() as unknown;
    const rows = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data) ? (payload as { data: unknown[] }).data : null;
    if (!rows || rows.length >= 100) throw new Error("The complete position list could not be established; live orders are blocked.");
    return rows.map((row): PositionRow => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("A position row was unreadable; live orders are blocked.");
      const source = row as Record<string, unknown>;
      const tokenID = typeof (source.asset ?? source.asset_id ?? source.token_id) === "string" ? String(source.asset ?? source.asset_id ?? source.token_id) : null;
      const conditionId = typeof (source.conditionId ?? source.condition_id ?? source.market) === "string" ? String(source.conditionId ?? source.condition_id ?? source.market) : null;
      const slug = typeof (source.slug ?? source.eventSlug ?? source.event_slug) === "string" ? String(source.slug ?? source.eventSlug ?? source.event_slug) : null;
      const rawOutcome = typeof source.outcome === "string" ? source.outcome.trim().toUpperCase() : "";
      const outcome = rawOutcome === "UP" ? "UP" : rawOutcome === "DOWN" ? "DOWN" : null;
      const size = number(source.current_size ?? source.size ?? source.total_size);
      const averagePrice = number(source.avgPrice ?? source.avg_price ?? source.average_price);
      const initialValue = number(source.initialValue ?? source.initial_value ?? source.costBasis ?? source.cost_basis);
      const currentValue = number(source.currentValue ?? source.current_value ?? source.current_value_usd ?? source.value);
      if (size === null || size < 0) throw new Error("Position size was unreadable; live orders are blocked.");
      if (size > 0 && !tokenID) throw new Error("A position has no exact token ID; live orders are blocked until wallet positions are fully readable.");
      const basis = averagePrice !== null && averagePrice > 0 && averagePrice <= 1 ? size * averagePrice : initialValue;
      if (size > 0 && (basis === null || basis <= 0)) throw new Error("Position cost basis was unreadable; live orders are blocked.");
      const exposureUsd = size > 0 ? Math.max(size * (averagePrice ?? 0), initialValue ?? 0) : 0;
      return { tokenID, conditionId, slug, outcome, size, averagePrice, exposureUsd, currentValueUsd: size > 0 ? Math.max(0, currentValue ?? exposureUsd) : 0 };
    }).filter((position) => position.size > 0);
  } finally { clearTimeout(timer); }
};

const readClosedTrades = async (wallet: string, now: number): Promise<ClosedPaperTrade[]> => {
  const dayStartSeconds = Math.floor(now / 86_400_000) * 86_400;
  const url = new URL(`${DATA_API}/v2/positions`);
  url.searchParams.set("user", wallet);
  url.searchParams.set("status", "CLOSED");
  url.searchParams.set("start", String(dayStartSeconds));
  url.searchParams.set("end", String(Math.floor(now / 1_000)));
  url.searchParams.set("sort_by", "TIMESTAMP");
  url.searchParams.set("sort_direction", "DESC");
  url.searchParams.set("limit", "100");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Polymarket closed-position history returned ${response.status}.`);
    const payload = await response.json() as unknown;
    const rows = Array.isArray(payload) ? payload : payload && typeof payload === "object"
      && Array.isArray((payload as Record<string, unknown>).data) ? (payload as { data: unknown[] }).data : null;
    if (!rows) throw new Error("Polymarket closed-position history was unreadable; the live model cannot apply its loss-streak controls.");
    const trades = rows.map((value): ClosedPaperTrade => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A closed-position history row was malformed; live loss-streak controls cannot be applied.");
      const row = value as Record<string, unknown>;
      const timestampValue = number(row.last_event_at ?? row.timestamp);
      const pnl = number(row.realized_pnl ?? row.realizedPnl);
      const tokenID = typeof row.token_id === "string" ? row.token_id : null;
      const conditionID = typeof row.condition_id === "string" ? row.condition_id : null;
      const id = tokenID ?? conditionID;
      if (timestampValue === null || pnl === null || !id) throw new Error("A closed-position history row omitted its timestamp, realized P&L, or market ID; live loss-streak controls cannot be applied.");
      const timestamp = timestampValue < 10_000_000_000 ? timestampValue * 1_000 : timestampValue;
      const outcome = typeof row.outcome === "string" && row.outcome.trim().toUpperCase() === "DOWN" ? "DOWN" : "UP";
      const shares = number(row.total_size ?? row.current_size) ?? 0;
      const entryCost = number(row.total_cost_usdc ?? row.entry_cost_usdc) ?? 0;
      const entry = shares > 0 && entryCost > 0 ? entryCost / shares : number(row.avg_price) ?? 0;
      return { id: `wallet-closed:${id}:${timestamp}`, timestamp, marketId: conditionID ?? id,
        marketLabel: String(row.title ?? row.name ?? "Closed Polymarket position"), asset: "CRYPTO", duration: "5m", side: outcome,
        shares, entry, exit: number(row.current_price) ?? 0, pnl, reason: "Polymarket closed-position history" };
    });
    return trades.filter((trade) => trade.timestamp >= dayStartSeconds * 1_000 && trade.timestamp <= now)
      .sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
  } finally { clearTimeout(timer); }
};

const readBalance = async (client: ClobClient) => {
  const payload = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const raw = number(payload.balance);
  if (raw === null || raw < 0) return null;
  return raw >= 1_000_000 ? raw / 1_000_000 : raw;
};

const liveEquity = (balance: number, positions: PositionRow[]) => balance + positions.reduce((sum, position) => sum + position.currentValueUsd, 0);

const updateRiskBaselines = (state: TraderState, equityUsd: number, now: number) => {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  if (state.riskDayKey !== dayKey || !state.riskDayStartEquityUsd || state.riskDayStartEquityUsd <= 0
    || !state.peakLiquidationEquityUsd || state.peakLiquidationEquityUsd <= 0) {
    state.riskDayKey = dayKey;
    state.riskDayStartEquityUsd = Math.max(1, equityUsd);
    state.peakLiquidationEquityUsd = Math.max(1, equityUsd);
  } else {
    state.peakLiquidationEquityUsd = Math.max(state.peakLiquidationEquityUsd, equityUsd);
  }
};

const liveProfileFor = (equityUsd: number): BankrollProfile => {
  const profile = bankrollProfile(equityUsd);
  if (equityUsd > 100) return profile;
  // The five-share venue minimum can exceed normal MICRO/SMALL sizing. Keep the
  // other tier filters and let the live-specific 15% ceiling bound that minimum.
  return { ...profile, maxStakePct: LIVE_ENTRY_RISK_PCT, maxExposurePct: LIVE_ENTRY_RISK_PCT,
    maxCorrelatedExposurePct: LIVE_ENTRY_RISK_PCT, maxDailyLossPct: LIVE_ENTRY_RISK_PCT,
    maxPeakDrawdownPct: LIVE_ENTRY_RISK_PCT, maxDepthShare: 0.5 };
};

const liveExitPolicyFor = (equityUsd: number) => {
  const profile = bankrollProfile(equityUsd);
  return {
    ...DEFAULT_LIVE_EARLY_EXIT,
    earlyExitEnabled: true,
    earlyExitMinProfitUsd: Math.min(DEFAULT_LIVE_EARLY_EXIT.earlyExitMinProfitUsd, Math.max(0.02, profile.minExpectedProfitUsd)),
    earlyExitMinProfitPct: Math.min(DEFAULT_LIVE_EARLY_EXIT.earlyExitMinProfitPct, Math.max(0.025, profile.minExpectedProfitOnStakePct / 2)),
  };
};

const evaluateLiveHoldExit = (market: LiveMarket, position: PositionRow, side: "UP" | "DOWN", now: number, equityUsd: number) => {
  const requestedShares = Math.floor(position.size * 100 + 1e-8) / 100;
  const sideBook = side === "UP" ? market.upBook : market.downBook;
  const venueMinimum = sideBook?.minOrderSize;
  const minimumShares = Math.max(LIVE_MINIMUM_SHARES,
    venueMinimum !== null && venueMinimum !== undefined && Number.isFinite(venueMinimum) && venueMinimum > 0 ? venueMinimum : 0);
  if (requestedShares < minimumShares) return null;
  const fairUp = anchoredFairUp(market);
  if (fairUp === null) return null;
  const fill = estimatePaperExitFill(market, side, requestedShares, { feeRate: RISK.feeRate, slippageBps: RISK.slippageBps }, now);
  if (!fill || fill.shares + 1e-8 < requestedShares) return null;
  const fairProbability = side === "UP" ? fairUp : 1 - fairUp;
  const modelRead = analyzeMarketSignal(market, { feeRate: RISK.feeRate, slippageBps: RISK.slippageBps }, Math.max(1, position.exposureUsd), 0.04, now);
  const opposite = side === "UP" ? "DOWN" : "UP";
  const directionalReversal = modelRead.bias === opposite && (modelRead.biasConfidence ?? 0) >= 0.6 && fairProbability < 0.45;
  const evaluation = evaluatePaperHoldExit({
    policy: liveExitPolicyFor(equityUsd),
    entryCostUsd: position.exposureUsd * (requestedShares / position.size),
    originalShares: requestedShares,
    filledShares: requestedShares,
    netExitProceedsUsd: fill.totalCost,
    sideFairProbability: fairProbability,
    remainingSeconds: market.remaining,
    directionalReversal,
    reversalMarginPct: bankrollProfile(equityUsd).tier === "MICRO" ? 0.005 : 0.01,
  });
  return { evaluation, requestedShares, fairProbability, modelRead };
};

const liveSellQuote = (market: LiveMarket, side: "UP" | "DOWN", shares: number, tickSize: number, now: number) => {
  const sourceBook = side === "UP" ? market.upBook : market.downBook;
  if (!sourceBook?.bids.length || shares <= 0) return null;
  const bids = [...sourceBook.bids].sort((left, right) => right.price - left.price);
  const bestBid = bids[0].price;
  const minimumPrice = bestBid * (1 - RISK.slippageBps / 10_000);
  // SELL prices are minimum acceptable proceeds, so round the limit up to a
  // valid tick. Rounding down could exceed the configured slippage bound.
  const roundedLimit = Number((Math.ceil((minimumPrice - 1e-10) / tickSize) * tickSize).toFixed(Math.max(0, (String(tickSize).split(".")[1] ?? "").length)));
  if (!Number.isFinite(roundedLimit) || roundedLimit <= 0 || roundedLimit > bestBid + 1e-8 || roundedLimit >= 1) return null;
  const executableBids = bids.filter((level) => level.price + 1e-8 >= roundedLimit);
  if (executableBids.reduce((sum, level) => sum + level.size, 0) + 1e-8 < shares) return null;
  const limitedBook = { ...sourceBook, bids: executableBids };
  const executionMarket = side === "UP" ? { ...market, upBook: limitedBook } : { ...market, downBook: limitedBook };
  const estimatedFill = estimatePaperExitFill(executionMarket, side, shares, { feeRate: RISK.feeRate, slippageBps: RISK.slippageBps }, now);
  return estimatedFill && estimatedFill.shares + 1e-8 >= shares ? { limitPrice: roundedLimit, executionMarket, estimatedFill } : null;
};

const buildPaperAccount = (balance: number, rows: PositionRow[], markets: Map<string, LiveMarket>, timestamp: number, dayStart: number,
  closedTrades: ClosedPaperTrade[] = []): PaperAccount => {
  const positions: PaperPosition[] = rows.map((row) => {
    const market = [...markets.values()].find((candidate) => candidate.upTokenId === row.tokenID || candidate.downTokenId === row.tokenID
      || Boolean(candidate.conditionId && row.conditionId && candidate.conditionId.toLowerCase() === row.conditionId.toLowerCase())
      || candidate.slug.toLowerCase() === row.slug?.toLowerCase());
    const tokenSide = market && row.tokenID === market.downTokenId ? "DOWN" : market && row.tokenID === market.upTokenId ? "UP" : null;
    const side = tokenSide ?? row.outcome;
    if (!side) throw new Error("A wallet position could not be assigned to an exact UP or DOWN token; live entries are blocked.");
    const marketId = market?.id ?? row.conditionId ?? row.slug ?? row.tokenID ?? `unmapped:${row.size}`;
    const avgEntry = row.averagePrice && row.averagePrice > 0 && row.averagePrice <= 1 ? row.averagePrice : row.exposureUsd / row.size;
    return {
      id: row.tokenID ?? marketId,
      marketId,
      marketLabel: market ? `${market.asset} ${market.duration}` : row.slug ?? "Existing Polymarket position",
      asset: market?.asset ?? "CRYPTO",
      duration: market?.duration ?? "5m",
      side,
      shares: row.size,
      avgEntry,
      totalCost: row.exposureUsd,
      mark: null,
      endTime: market?.endTime ?? timestamp,
      openedAt: timestamp,
      lastUpdated: timestamp,
    };
  });
  return {
    startingCash: Math.max(1, dayStart),
    cash: balance,
    realizedPnl: 0,
    fees: 0,
    openOrders: 0,
    positions,
    fills: [],
    closedTrades,
    equityHistory: [{ timestamp, equity: liveEquity(balance, rows) }],
    riskDayKey: new Date(timestamp).toISOString().slice(0, 10),
    riskDayStartEquityUsd: dayStart,
    peakLiquidationEquityUsd: Math.max(dayStart, liveEquity(balance, rows)),
  };
};

const parseBookLevels = (value: unknown) => Array.isArray(value) ? value.flatMap((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const level = raw as Record<string, unknown>;
  const price = number(level.price);
  const size = number(level.size);
  return price !== null && size !== null && price > 0 && price < 1 && size > 0 ? [{ price, size }] : [];
}) : [];

const withFreshExecutionBook = (market: LiveMarket, tokenID: string, rawBook: unknown, receivedAt: number): LiveMarket => {
  if (!rawBook || typeof rawBook !== "object" || Array.isArray(rawBook)) throw new Error("The CLOB returned an unreadable execution book.");
  const source = rawBook as Record<string, unknown>;
  const bids = parseBookLevels(source.bids).sort((left, right) => right.price - left.price);
  const asks = parseBookLevels(source.asks).sort((left, right) => left.price - right.price);
  const orderBook: OrderBook = {
    tokenId: tokenID,
    bids,
    asks,
    timestamp: receivedAt,
    minOrderSize: number(source.min_order_size ?? source.minOrderSize)
      ?? (tokenID === market.upTokenId ? market.upBook?.minOrderSize : market.downBook?.minOrderSize) ?? null,
    hash: typeof source.hash === "string" ? source.hash : null,
  };
  if (tokenID === market.upTokenId) return { ...market, upBook: orderBook, upBid: bids[0]?.price ?? null, upAsk: asks[0]?.price ?? null };
  if (tokenID === market.downTokenId) return { ...market, downBook: orderBook, downBid: bids[0]?.price ?? null, downAsk: asks[0]?.price ?? null };
  throw new Error("The refreshed order book did not match the selected market token.");
};

type MinimumShareOrder = { minimumShares: number; requestedShares: number; limitPrice: number; amountUsd: number; worstTotalCostUsd: number };

const minimumShareOrder = (market: LiveMarket, side: "UP" | "DOWN", tickSize: number, fairProbability: number): MinimumShareOrder | null => {
  const book = side === "UP" ? market.upBook : market.downBook;
  if (!book || book.minOrderSize === null || !Number.isFinite(book.minOrderSize) || book.minOrderSize <= 0 || !book.asks.length) return null;
  const minimumShares = Math.max(LIVE_MINIMUM_SHARES, book.minOrderSize);
  const asks = [...book.asks].sort((left, right) => left.price - right.price);
  const bestAsk = asks[0].price;
  let cumulativeShares = 0;
  let priceForMinimum = 0;
  for (const askLevel of asks) {
    cumulativeShares += askLevel.size;
    if (cumulativeShares + 1e-8 >= minimumShares) { priceForMinimum = askLevel.price; break; }
  }
  if (priceForMinimum <= 0) return null;
  const slippagePriceCeiling = bestAsk * (1 + RISK.slippageBps / 10_000);
  const modelPriceCeiling = (fairProbability - RISK.minEdge) / (1 + RISK.feeRate);
  const rawLimit = Math.min(priceForMinimum, slippagePriceCeiling, modelPriceCeiling);
  const limitPrice = Math.floor((rawLimit + 1e-10) / tickSize) * tickSize;
  const priceDecimals = Math.max(0, (String(tickSize).split(".")[1] ?? "").length);
  const roundedLimit = Number(limitPrice.toFixed(priceDecimals));
  if (!Number.isFinite(roundedLimit) || roundedLimit < bestAsk || roundedLimit >= 1) return null;
  const executableShares = asks.filter((level) => level.price <= roundedLimit + tickSize * 1e-6).reduce((sum, level) => sum + level.size, 0);
  const amountUsd = Math.max(1, Math.ceil((minimumShares * roundedLimit - 1e-9) * 100) / 100);
  // The SDK expresses BUY market-order size in dollars and converts that to
  // shares at the limit price. Check the rounded request, which can be slightly
  // larger than the nominal venue minimum, against visible executable depth.
  const requestedShares = sdkMarketBuyShares(amountUsd, roundedLimit, String(tickSize));
  if (requestedShares + 1e-8 < minimumShares) return null;
  if (executableShares + 1e-8 < requestedShares) return null;
  const feeSchedule = market.feeSchedule ?? CONSERVATIVE_CRYPTO_FEE_SCHEDULE;
  const worstFeeRate = asks.filter((level) => level.price <= roundedLimit + tickSize * 1e-6).reduce((worst, level) => {
    const marketFee = feeSchedule.feesEnabled
      ? feeSchedule.rate * Math.pow(level.price * (1 - level.price), feeSchedule.exponent)
      : 0;
    return Math.max(worst, RISK.feeRate, marketFee / roundedLimit);
  }, RISK.feeRate);
  const worstTotalCostUsd = Math.ceil((amountUsd * (1 + worstFeeRate) + 1e-9) * 100) / 100;
  return { minimumShares, requestedShares, limitPrice: roundedLimit, amountUsd, worstTotalCostUsd };
};

const evaluateLiveOpportunity = (input: {
  market: LiveMarket;
  markets: Map<string, LiveMarket>;
  balance: number;
  positions: PositionRow[];
  state: TraderState;
  now: number;
}): PaperOpportunity => {
  const equity = liveEquity(input.balance, input.positions);
  const dayStart = input.state.riskDayStartEquityUsd ?? equity;
  const profile = liveProfileFor(equity);
  const maxTradeUsd = Math.min(RISK.maxTradeUsd, input.balance * profile.maxStakePct, equity * profile.maxStakePct);
  const account = buildPaperAccount(input.balance, input.positions, input.markets, input.now, dayStart, input.state.closedTrades);
  const opportunity = evaluatePaperMarket({ market: input.market, markets: input.markets, account,
    costs: { feeRate: RISK.feeRate, slippageBps: RISK.slippageBps }, liquidationEquityUsd: equity,
    dayStartLiquidationEquityUsd: dayStart, peakLiquidationEquityUsd: input.state.peakLiquidationEquityUsd ?? equity,
    minOrderUsd: LIVE_MINIMUM_ALL_IN_USD, maxTradeUsd, maxExposurePct: profile.maxExposurePct, minimumSharesOverride: LIVE_MINIMUM_SHARES,
    profileOverride: profile, minNetEdge: RISK.minEdge, now: input.now });
  if (input.state.closedTradesAt === null || input.now - input.state.closedTradesAt > CLOSED_HISTORY_MAX_AGE_MS) {
    return { ...opportunity, approved: false, reason: "PASS: recent realized P&L history is unavailable or stale, so live loss-streak controls cannot be applied." };
  }
  return opportunity;
};

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("The live trader requires an interactive terminal.");
  console.log("\nPOLYMARKET LIVE TRADER · TERMINAL SETUP\n");
  console.log("This connects to the real CLOB. The private key is requested with hidden input, kept in memory only, and never saved by this program. FOK orders require the full minimum share quantity or do not fill. The model is uncalibrated and does not guarantee profit.\n");
  const walletAddress = await ask("Polymarket wallet address: ");
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) throw new Error("Enter a valid 0x wallet address.");
  console.log("\nSignature type: 0 EOA · 1 Polymarket Proxy · 2 Gnosis Safe · 3 contract wallet / deposit wallet.");
  const signatureInput = await ask("Signature type (0-3): ");
  const signatureType = Number(signatureInput);
  if (!Number.isInteger(signatureType) || signatureType < 0 || signatureType > 3) throw new Error("Choose one of the listed signature types.");
  const privateKey = await askSecret("Signer private key (input hidden): ");
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(privateKey)) throw new Error("The key must be exactly 32 bytes in hexadecimal format.");

  const unlock = await acquireLock();
  let stopStream: () => void = () => undefined;
  let exitListener: ((line: string) => void) | undefined;
  let inputInterface: ReturnType<typeof createInterface> | null = null;
  let stopSignalListener: (() => void) | undefined;
  try {
    const state = await readState();
    if (state.pending) throw new Error("A previous live order outcome remains unresolved. Reconcile the wallet before restarting.");
    const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`);
    if (signatureType === SignatureTypeV2.EOA && account.address.toLowerCase() !== walletAddress.toLowerCase()) throw new Error("Signature type 0 requires the wallet address to match the private-key signer.");
    const signer = createWalletClient({ account, chain: polygon, transport: http() });
    // createOrDeriveApiKey needs API error responses to fall back to deriving an existing key.
    const bootstrap = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer, signatureType: signatureType as SignatureTypeV2, funderAddress: walletAddress, useServerTime: true, retryOnError: false, throwOnError: false });
    console.log("\nConnecting to Polymarket and reading your balance…");
    const rawCredentials = await bootstrap.createOrDeriveApiKey();
    const credentials = rawCredentials as ApiKeyCreds;
    if (!credentials.key || !credentials.secret || !credentials.passphrase) throw new Error("Polymarket returned incomplete account credentials.");
    const client = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer, creds: credentials, signatureType: signatureType as SignatureTypeV2, funderAddress: walletAddress, useServerTime: true, retryOnError: false, throwOnError: true });
    const [balance, orders, positions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
    if (balance === null) throw new Error("Polymarket did not return a readable collateral balance.");
    console.log(`\nWallet: ${walletAddress}`);
    console.log(`Signer: ${account.address} · signature type ${signatureType}`);
    console.log(`Available USDC: ${money(balance)}`);
    console.log(`Open positions: ${positions.length} · open orders: ${orders.length}`);
    if (positions.length) console.log(`Existing exposure: ${money(positions.reduce((sum, position) => sum + position.exposureUsd, 0))}`);
    if (orders.length) throw new Error("Open orders exist. Reconcile or cancel them in Polymarket, then restart the terminal trader.");
    if (balance < 1) throw new Error("Available USDC is below the $1 minimum executable stake.");

    updateRiskBaselines(state, liveEquity(balance, positions), Date.now());
    state.closedTrades = await readClosedTrades(walletAddress, Date.now());
    state.closedTradesAt = Date.now();
    await writeState(state);

    console.log("\nLive guardrails: full shared model and bankroll filters · LOCK signals only · minimum 4% net edge · five-share minimum · FOK execution · 5% fee estimate · 25 bps slippage.");
    console.log("For balances up to $100, an entry may use up to 15% of equity to meet the five-share minimum, with a $5 per-order cap and 15% position, daily-loss, and drawdown limits. Larger balances keep their tier limits.");
    const enableModelExits = (await ask("Enable model-aware auto-exits for positions opened by this trader? Type YES to enable, or press Enter to hold to settlement: ")).toUpperCase() === "YES";
    console.log(enableModelExits ? "Model-aware exits are enabled for positions opened by this trader; all other wallet positions remain unmanaged." : "Model-aware exits are off; the trader will hold its entries to market settlement unless you manage them manually.");
    const answer = await ask("Type YES to arm live trading: ");
    if (answer.toUpperCase() !== "YES") {
      console.log("Not armed. No order was placed.");
      return;
    }

    const priceTicks = new Map<string, PolymarketPriceTick>();
    const streamHealth: { status: PolymarketPriceStreamStatus } = { status: "CONNECTING" };
    let lastDiscoveryAt = 0;
    let definitions: Awaited<ReturnType<typeof discoverCryptoMarkets>> = [];
    let histories = new Map<Asset, CandleHistory>();
    let cycle = 0;
    const controller = new AbortController();
    const input = createInterface({ input: stdin, output: stdout, terminal: true });
    inputInterface = input;
    exitListener = (line: string) => {
      if (line.trim().toLowerCase() === "q" || line.trim().toLowerCase() === "quit") controller.abort(new Error("Stop requested."));
    };
    input.on("line", exitListener);
    stopSignalListener = () => controller.abort(new Error("Stop requested."));
    process.once("SIGINT", stopSignalListener);
    console.log("\nLIVE TRADER ARMED · scanning once per second · type Q and press Enter to stop.\n");
    let subscribedAssets = "";
    let lastKnownBalance = balance;
    let lastKnownPositions = positions;
    let lastStateWriteAt = Date.now();
    let lastPortfolioRefreshAt = Date.now();

    while (!controller.signal.aborted) {
      if (state.pending) {
        console.error(`Trader halted with unresolved ${state.pending.action} order ${state.pending.requestId}; reconcile the wallet before continuing.`);
        return;
      }
      const now = Date.now();
      for (const [marketKey, retryAt] of Object.entries(state.retryAfter)) if (retryAt <= now) delete state.retryAfter[marketKey];
      if (state.closedTradesAt === null || now - state.closedTradesAt >= CLOSED_HISTORY_REFRESH_MS) {
        try {
          state.closedTrades = await readClosedTrades(walletAddress, now);
          state.closedTradesAt = now;
          await writeState(state);
          lastStateWriteAt = now;
        } catch (error) {
          console.log(`[${new Date().toLocaleTimeString()}] Realized trade history refresh held: ${scrubError(error, privateKey)}`);
        }
      }
      if (now - lastDiscoveryAt >= DISCOVERY_MS || !definitions.length) {
        try {
          const next = await discoverCryptoMarkets(controller.signal);
          const assets = [...new Set(next.map((market) => market.asset))].sort().join(",");
          if (assets !== subscribedAssets) {
            stopStream();
            subscribedAssets = assets;
            stopStream = subscribePolymarketPrices(next.map((market) => market.asset), (ticks) => {
              for (const tick of ticks) priceTicks.set(`${tick.asset}:${tick.priceFeed}:${tick.timestamp}`, tick);
              const cutoff = Date.now() - 24 * 60 * 60_000;
              for (const [key, tick] of priceTicks) if (tick.timestamp < cutoff) priceTicks.delete(key);
            }, (status) => { streamHealth.status = status; }, controller.signal);
          }
          definitions = next;
          lastDiscoveryAt = now;
        } catch (error) {
          console.log(`[${new Date().toLocaleTimeString()}] Market discovery held: ${scrubError(error, privateKey)}`);
          await sleep(1_000);
          continue;
        }
      }
      cycle += 1;
      const tokenIds = definitions.flatMap((market) => [market.upTokenId, market.downTokenId]);
      if (!definitions.length || !tokenIds.length) {
        if (cycle % 10 === 0) console.log(`[${new Date().toLocaleTimeString()}] No active supported crypto market.`);
        await sleep(SCAN_MS);
        continue;
      }
      try {
        const [books] = await Promise.all([fetchOrderBooks(tokenIds, controller.signal)]);
        if (cycle % 30 === 0) histories = await fetchCandleHistories([...new Set(definitions.map((market) => market.asset))], controller.signal);
        const ticks = [...priceTicks.values()];
        const currentMarkets = new Map<string, LiveMarket>();
        for (const definition of definitions) {
          const market = applyPolymarketPriceTicks(buildLiveMarket(definition, books, new Map(), null, now, histories.get(definition.asset) ?? null), ticks, now);
          currentMarkets.set(market.id, market);
        }
        if (enableModelExits && now - lastPortfolioRefreshAt >= 2_000) {
          const [refreshedBalance, refreshedPositions] = await Promise.all([readBalance(client), readPositions(walletAddress)]);
          if (refreshedBalance === null) throw new Error("The wallet balance could not be refreshed for live position management.");
          lastKnownBalance = refreshedBalance;
          lastKnownPositions = refreshedPositions;
          updateRiskBaselines(state, liveEquity(refreshedBalance, refreshedPositions), now);
          lastPortfolioRefreshAt = now;
          await writeState(state);
          lastStateWriteAt = now;
        }
        const blockedReasons = new Map<string, number>();
        const recordBlock = (reason: string) => blockedReasons.set(reason, (blockedReasons.get(reason) ?? 0) + 1);
        if (enableModelExits) {
          const confirmedExits: Array<{ market: LiveMarket; position: PositionRow; side: "UP" | "DOWN"; evaluation: NonNullable<ReturnType<typeof evaluateLiveHoldExit>>["evaluation"] }> = [];
          let exitStateChanged = false;
          const presentTokens = new Set(lastKnownPositions.flatMap((position) => position.tokenID ? [position.tokenID] : []));
          for (const tokenID of state.managedPositionTokens) {
            if (presentTokens.has(tokenID)) {
              if (state.managedPositionSince[tokenID]) { delete state.managedPositionSince[tokenID]; exitStateChanged = true; }
              continue;
            }
            if (!presentTokens.has(tokenID)) {
              const absentSince = state.managedPositionSince[tokenID] ?? now;
              if (!state.managedPositionSince[tokenID]) state.managedPositionSince[tokenID] = now;
              if (now - absentSince < 30_000) continue;
              delete state.exitConfirmations[tokenID];
              delete state.managedPositionSince[tokenID];
              state.managedPositionTokens = state.managedPositionTokens.filter((entry) => entry !== tokenID);
              exitStateChanged = true;
            }
          }
          for (const position of lastKnownPositions) {
            const tokenID = position.tokenID;
            if (!tokenID || !state.managedPositionTokens.includes(tokenID)) continue;
            const retryKey = `exit:${tokenID}`;
            if ((state.retryAfter[retryKey] ?? 0) > now) continue;
            const market = [...currentMarkets.values()].find((candidate) => candidate.upTokenId === tokenID || candidate.downTokenId === tokenID);
            if (!market || market.remaining < DEFAULT_LIVE_EARLY_EXIT.earlyExitMinRemainingSeconds
              || streamHealth.status !== "CONNECTED" || marketDataFreshnessIssue(market, now)) {
              if (state.exitConfirmations[tokenID]) { delete state.exitConfirmations[tokenID]; exitStateChanged = true; }
              continue;
            }
            const side = tokenID === market.upTokenId ? "UP" : "DOWN";
            const exit = evaluateLiveHoldExit(market, position, side, now, liveEquity(lastKnownBalance, lastKnownPositions));
            if (!exit?.evaluation.shouldExit) {
              if (state.exitConfirmations[tokenID]) { delete state.exitConfirmations[tokenID]; exitStateChanged = true; }
              continue;
            }
            const previous = state.exitConfirmations[tokenID];
            const count = previous && now - previous.lastSeen <= 10_000 ? previous.count + 1 : 1;
            state.exitConfirmations[tokenID] = { count, lastSeen: now };
            exitStateChanged = true;
            if (count >= DEFAULT_LIVE_EARLY_EXIT.earlyExitConfirmations) confirmedExits.push({ market, position, side, evaluation: exit.evaluation });
          }
          if (exitStateChanged) { await writeState(state); lastStateWriteAt = now; }
          confirmedExits.sort((left, right) => right.evaluation.exitAdvantageUsd - left.evaluation.exitAdvantageUsd);
          const confirmedExit = confirmedExits[0];
          if (confirmedExit) {
            const tokenID = confirmedExit.position.tokenID!;
            const [freshBalance, freshOrders, freshPositions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
            if (freshBalance === null) throw new Error("The fresh collateral balance is unavailable; live exit held.");
            if (freshOrders.length) throw new Error("An open order appeared during the exit scan. Stop and reconcile it in Polymarket.");
            const freshPosition = freshPositions.find((position) => position.tokenID === tokenID);
            if (!freshPosition || freshPosition.size < LIVE_MINIMUM_SHARES) {
              delete state.exitConfirmations[tokenID];
              lastKnownBalance = freshBalance;
              lastKnownPositions = freshPositions;
              await writeState(state);
              await sleep(SCAN_MS);
              continue;
            }
            const marketBook = await client.getOrderBook(tokenID);
            const tickSize = marketBook.tick_size;
            if (!(new Set(["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"])).has(tickSize)) throw new Error("Unsupported CLOB tick size; no exit order submitted.");
            const receivedAt = Date.now();
            const executionMarket = withFreshExecutionBook(confirmedExit.market, tokenID, marketBook, receivedAt);
            const freshIssue = marketDataFreshnessIssue(executionMarket, receivedAt);
            const liveEquityUsd = liveEquity(freshBalance, freshPositions);
            const finalExit = freshIssue ? null : evaluateLiveHoldExit(executionMarket, freshPosition, confirmedExit.side, receivedAt, liveEquityUsd);
            const sellShares = finalExit?.requestedShares ?? 0;
            const sellQuote = finalExit && finalExit.evaluation.shouldExit
              ? liveSellQuote(executionMarket, confirmedExit.side, sellShares, Number(tickSize), receivedAt) : null;
            if (!finalExit?.evaluation.shouldExit || !sellQuote) {
              delete state.exitConfirmations[tokenID];
              lastKnownBalance = freshBalance;
              lastKnownPositions = freshPositions;
              await writeState(state);
              console.log(`[${new Date().toLocaleTimeString()}] ${confirmedExit.market.asset} live exit held after fresh model/book recheck${freshIssue ? `: ${freshIssue}` : "."}`);
              await sleep(SCAN_MS);
              continue;
            }
            const marketKey = marketCycleKey(confirmedExit.market);
            state.pending = { requestId: randomUUID(), marketId: marketKey, at: Date.now(), action: "SELL", tokenID, shares: sellShares };
            await writeState(state);
            console.log(`[${new Date().toLocaleTimeString()}] SELL ${confirmedExit.market.asset} ${confirmedExit.market.duration} ${confirmedExit.side} · ${sellShares.toFixed(2)} shares · model exit: ${finalExit.evaluation.reason} · limit ${percent(sellQuote.limitPrice)} · FOK`);
            let response;
            try {
              response = await client.createAndPostMarketOrder({ tokenID, amount: sellShares, side: Side.SELL, price: sellQuote.limitPrice, orderType: OrderType.FOK },
                { tickSize: tickSize as TickSize, negRisk: Boolean(marketBook.neg_risk) }, OrderType.FOK);
            } catch (error) {
              console.error(`Exit outcome UNCERTAIN: ${scrubError(error, privateKey)}`);
              console.error(`The trader halted with a pending marker. Check wallet positions, open orders, and activity before restart: ${STATE_PATH}`);
              return;
            }
            try {
              let [afterBalance, afterOrders, afterPositions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
              const startingSize = freshPosition.size;
              let soldShares = Math.max(0, startingSize - (afterPositions.find((position) => position.tokenID === tokenID)?.size ?? 0));
              for (let attempt = 0; attempt < 4 && soldShares + 0.005 < sellShares; attempt += 1) {
                await sleep(500);
                [afterBalance, afterOrders, afterPositions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
                soldShares = Math.max(0, startingSize - (afterPositions.find((position) => position.tokenID === tokenID)?.size ?? 0));
              }
              if (afterBalance === null) throw new Error("Exit balance recheck returned no value.");
              if (afterOrders.length) throw new Error("A supposedly immediate FOK exit remains open; the result is unresolved.");
              if (soldShares + 0.005 < sellShares) {
                if (response.success || soldShares > 0) throw new Error("The SELL response and wallet position do not reconcile to a full FOK fill.");
                state.pending = null;
                state.retryAfter[`exit:${tokenID}`] = Date.now() + RETRY_NO_FILL_MS;
                delete state.exitConfirmations[tokenID];
                await writeState(state);
                console.log(`[${new Date().toLocaleTimeString()}] Exit FOK did not fill; the model may retry after ${Math.ceil(RETRY_NO_FILL_MS / 1_000)} seconds.`);
              } else {
                state.pending = null;
                delete state.exitConfirmations[tokenID];
                const residual = afterPositions.find((position) => position.tokenID === tokenID);
                if (!residual || residual.size < LIVE_MINIMUM_SHARES) {
                  state.managedPositionTokens = state.managedPositionTokens.filter((entry) => entry !== tokenID);
                  delete state.managedPositionSince[tokenID];
                }
                await writeState(state);
                console.log(`[${new Date().toLocaleTimeString()}] Exit reconciled · sold ${soldShares.toFixed(2)} shares · residual ${residual?.size.toFixed(4) ?? "0"} · USDC ${money(afterBalance)}.`);
              }
              lastKnownBalance = afterBalance;
              lastKnownPositions = afterPositions;
              lastPortfolioRefreshAt = Date.now();
              updateRiskBaselines(state, liveEquity(afterBalance, afterPositions), Date.now());
              await writeState(state);
              lastStateWriteAt = Date.now();
              await sleep(SCAN_MS);
              continue;
            } catch (error) {
              console.error(`Exit result could not be reconciled: ${scrubError(error, privateKey)}`);
              console.error(`The trader halted and left a pending marker. Reconcile Polymarket before restarting: ${STATE_PATH}`);
              return;
            }
          }
        }
        const candidates: Array<{ market: LiveMarket; opportunity: PaperOpportunity }> = [];
        for (const market of currentMarkets.values()) {
          const marketKey = marketCycleKey(market);
          if (market.remaining < 30 || !RISK.allowedDurations.includes(market.duration) || streamHealth.status !== "CONNECTED") {
            recordBlock(streamHealth.status !== "CONNECTED" ? `oracle ${streamHealth.status.toLowerCase()}` : "outside the active entry window");
            continue;
          }
          if (state.attemptedMarkets.includes(marketKey)) { recordBlock("already filled this market cycle"); continue; }
          if ((state.retryAfter[marketKey] ?? 0) > now) { recordBlock("recent FOK no-fill cooldown"); continue; }
          const issue = marketDataFreshnessIssue(market, now);
          if (issue) { recordBlock(issue); continue; }
          const opportunity = evaluateLiveOpportunity({ market, markets: currentMarkets, balance: lastKnownBalance,
            positions: lastKnownPositions, state, now });
          if (!opportunity.approved) { recordBlock(opportunity.reason); continue; }
          if (opportunity.signal.action === "PASS" || opportunity.signal.tier !== "LOCK"
            || opportunity.signal.edge === null || opportunity.signal.edge < RISK.minEdge) {
            recordBlock(opportunity.signal.reason); continue;
          }
          candidates.push({ market, opportunity });
        }
        candidates.sort((left, right) => (right.opportunity.score?.score ?? 0) - (left.opportunity.score?.score ?? 0)
          || (right.opportunity.signal.edge ?? -1) - (left.opportunity.signal.edge ?? -1));
        const best = candidates[0];
        if (!best) {
          if (cycle % 15 === 0) {
            const leadingBlock = [...blockedReasons.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "no supported active market";
            console.log(`[${new Date().toLocaleTimeString()}] No actionable LOCK opportunity · ${definitions.length} markets scanned · ${leadingBlock}.`);
          }
          await sleep(SCAN_MS);
          continue;
        }

        const [freshBalance, freshOrders, freshPositions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
        if (freshBalance === null || freshBalance < 1) throw new Error("The fresh collateral balance is unavailable or below $1; entries held.");
        if (freshOrders.length) throw new Error("An open order appeared during the scan. Stop and reconcile it in Polymarket.");
        lastKnownBalance = freshBalance;
        lastKnownPositions = freshPositions;
        const freshEquity = liveEquity(freshBalance, freshPositions);
        updateRiskBaselines(state, freshEquity, Date.now());
        if (Date.now() - lastStateWriteAt >= 30_000) { await writeState(state); lastStateWriteAt = Date.now(); }
        const currentMarketKey = marketCycleKey(best.market);
        const activeMarketPosition = freshPositions.find((position) => position.tokenID === best.market.upTokenId || position.tokenID === best.market.downTokenId || (best.market.conditionId && position.conditionId?.toLowerCase() === best.market.conditionId.toLowerCase()) || position.slug?.toLowerCase() === best.market.slug.toLowerCase());
        if (activeMarketPosition) {
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} ${best.market.duration} held: a position already exists in this market.`);
          await sleep(SCAN_MS);
          continue;
        }
        const side = best.opportunity.signal.action;
        if (side === "PASS") throw new Error("The selected bankroll opportunity no longer has a trade side.");
        const tokenID = side === "UP" ? best.market.upTokenId : best.market.downTokenId;
        const marketBook = await client.getOrderBook(tokenID);
        const tickSize = marketBook.tick_size;
        if (!(new Set(["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"])).has(tickSize)) throw new Error("Unsupported CLOB tick size; no order submitted.");
        const clobTickSize = tickSize as TickSize;
        const bookReceivedAt = Date.now();
        const executionMarket = withFreshExecutionBook(best.market, tokenID, marketBook, bookReceivedAt);
        const executionMarkets = new Map(currentMarkets);
        executionMarkets.set(executionMarket.id, executionMarket);
        const finalFreshnessIssue = marketDataFreshnessIssue(executionMarket, bookReceivedAt);
        if (finalFreshnessIssue) {
          recordBlock(finalFreshnessIssue);
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} held after recheck: ${finalFreshnessIssue}`);
          await sleep(SCAN_MS);
          continue;
        }
        const finalOpportunity = evaluateLiveOpportunity({ market: executionMarket, markets: executionMarkets,
          balance: freshBalance, positions: freshPositions, state, now: bookReceivedAt });
        if (!finalOpportunity.approved || finalOpportunity.signal.action !== side || finalOpportunity.signal.tier !== "LOCK"
          || finalOpportunity.signal.edge === null || finalOpportunity.signal.edge < RISK.minEdge || !finalOpportunity.sizing) {
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} held after model recheck: ${finalOpportunity.reason}`);
          await sleep(SCAN_MS);
          continue;
        }
        const fairUp = finalOpportunity.signal.fairUp;
        const fairProbability = fairUp === null ? null : side === "UP" ? fairUp : 1 - fairUp;
        if (fairProbability === null) throw new Error("The final model probability is unavailable.");
        const orderQuote = minimumShareOrder(executionMarket, side, Number(tickSize), fairProbability);
        if (!orderQuote) {
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} ${side} held: the fresh book cannot fill ${LIVE_MINIMUM_SHARES} shares inside the model and 25 bps price limits.`);
          await sleep(SCAN_MS);
          continue;
        }
        const freshProfile = liveProfileFor(freshEquity);
        const perEntryCap = Math.min(RISK.maxTradeUsd, freshBalance * freshProfile.maxStakePct, freshEquity * freshProfile.maxStakePct);
        const totalExposure = freshPositions.reduce((sum, position) => sum + position.exposureUsd, 0);
        const totalExposureCap = freshEquity * freshProfile.maxExposurePct;
        if (orderQuote.worstTotalCostUsd > perEntryCap + 1e-8 || orderQuote.worstTotalCostUsd > finalOpportunity.sizing.stakeUsd + 0.01) {
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} ${side} held: a ${orderQuote.minimumShares}-share FOK would cost up to ${money(orderQuote.worstTotalCostUsd)}, above the approved live size ${money(Math.min(perEntryCap, finalOpportunity.sizing.stakeUsd))}.`);
          await sleep(SCAN_MS);
          continue;
        }
        if (freshBalance < orderQuote.worstTotalCostUsd || totalExposure + orderQuote.worstTotalCostUsd > totalExposureCap + 1e-8) {
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} ${side} held: the five-share order exceeds available collateral or the 15% portfolio exposure ceiling.`);
          await sleep(SCAN_MS);
          continue;
        }
        const requestId = randomUUID();
        state.pending = { requestId, marketId: currentMarketKey, at: Date.now(), action: "BUY", tokenID, shares: orderQuote.requestedShares };
        delete state.retryAfter[currentMarketKey];
        await writeState(state);
        console.log(`[${new Date().toLocaleTimeString()}] SUBMIT ${best.market.asset} ${best.market.duration} ${side} · ${orderQuote.requestedShares.toFixed(4)} shares requested (minimum ${orderQuote.minimumShares}) · ${money(orderQuote.amountUsd)} order amount · up to ${money(orderQuote.worstTotalCostUsd)} incl. fees · net edge ${percent(finalOpportunity.signal.edge)} · limit ${percent(orderQuote.limitPrice)} · FOK`);
        let response;
        try {
          response = await client.createAndPostMarketOrder({ tokenID, amount: orderQuote.amountUsd, side: Side.BUY, price: orderQuote.limitPrice, orderType: OrderType.FOK, userUSDCBalance: freshBalance }, { tickSize: clobTickSize, negRisk: Boolean(marketBook.neg_risk) }, OrderType.FOK);
        } catch (error) {
          console.error(`Order outcome UNCERTAIN: ${scrubError(error, privateKey)}`);
          console.error(`The trader has halted. Check positions, open orders, and activity before removing the pending marker in ${STATE_PATH}.`);
          return;
        }
        try {
          let [afterBalance, afterOrders, afterPositions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
          const previousSize = freshPositions.find((position) => position.tokenID === tokenID)?.size ?? 0;
          let positionDelta = Math.max(0, (afterPositions.find((position) => position.tokenID === tokenID)?.size ?? 0) - previousSize);
          if (positionDelta + 1e-6 < orderQuote.requestedShares && (number(response.takingAmount) ?? 0) + 1e-6 < orderQuote.requestedShares) {
            for (let attempt = 0; attempt < 4 && positionDelta + 1e-6 < orderQuote.requestedShares; attempt += 1) {
              await sleep(500);
              [afterBalance, afterOrders, afterPositions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
              positionDelta = Math.max(0, (afterPositions.find((position) => position.tokenID === tokenID)?.size ?? 0) - previousSize);
            }
          }
          if (afterBalance === null) throw new Error("Balance recheck returned no value.");
          if (afterOrders.length) throw new Error("A supposedly immediate FOK order remains open; the result is unresolved.");
          const newPosition = afterPositions.find((position) => position.tokenID === tokenID);
          const responseShares = number(response.takingAmount) ?? 0;
          const filledShares = Math.max(positionDelta, responseShares);
          console.log(`Order response: ${response.success ? "accepted" : "rejected"} · status ${response.status ?? "—"} · filled ${filledShares.toFixed(4)} shares · amount ${response.makingAmount ?? "—"}`);
          console.log(`Reconciled USDC ${money(afterBalance)} · positions ${afterPositions.length} · open orders ${afterOrders.length}${newPosition ? ` · ${side} position ${newPosition.size.toFixed(4)} shares` : ""}`);
          if (filledShares + 1e-6 >= orderQuote.requestedShares) {
            state.pending = null;
            state.attemptedMarkets.push(currentMarketKey);
            state.attemptedMarkets = state.attemptedMarkets.slice(-300);
            if (!state.managedPositionTokens.includes(tokenID)) state.managedPositionTokens.push(tokenID);
            state.managedPositionSince[tokenID] = Date.now();
            state.managedPositionTokens = state.managedPositionTokens.slice(-100);
            delete state.retryAfter[currentMarketKey];
          } else {
            if (response.success || positionDelta > 0) throw new Error("The CLOB response and wallet position do not prove a complete five-share FOK fill.");
            state.pending = null;
            state.retryAfter[currentMarketKey] = Date.now() + RETRY_NO_FILL_MS;
            console.log(`[${new Date().toLocaleTimeString()}] FOK did not fill; this market can retry after ${Math.ceil(RETRY_NO_FILL_MS / 1_000)} seconds if the model still qualifies.`);
          }
          lastKnownBalance = afterBalance;
          lastKnownPositions = afterPositions;
          updateRiskBaselines(state, liveEquity(afterBalance, afterPositions), Date.now());
          await writeState(state);
          lastStateWriteAt = Date.now();
        } catch (error) {
          console.error(`Order result could not be reconciled: ${scrubError(error, privateKey)}`);
          console.error(`The trader has halted and left a pending marker. Reconcile Polymarket before restarting: ${STATE_PATH}`);
          return;
        }
      } catch (error) {
        console.log(`[${new Date().toLocaleTimeString()}] Scan held safely: ${scrubError(error, privateKey)}`);
      }
      await sleep(SCAN_MS);
    }
    stopStream();
    console.log("\nTrader stopped. No new orders will be sent.");
  } finally {
    stopStream();
    if (inputInterface && exitListener) inputInterface.removeListener("line", exitListener);
    inputInterface?.close();
    if (stopSignalListener) process.removeListener("SIGINT", stopSignalListener);
    await unlock();
    void privateKey;
  }
}

main().catch((error) => {
  console.error(`Live trader stopped: ${scrubError(error, "")}`);
  process.exitCode = 1;
});
