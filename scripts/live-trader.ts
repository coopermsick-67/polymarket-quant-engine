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
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  anchoredFairUp,
  synchronizedPolymarketTime,
  syncPolymarketClock,
  type Asset,
  type CandleHistory,
  type LiveMarket,
  type OrderBook,
  type MarketFeeSchedule,
  type PolymarketPriceTick,
} from "../app/lib/polymarket-data";
import { subscribePolymarketPrices, type PolymarketPriceStreamStatus } from "../app/lib/polymarket-price-stream";
import { analyzeMarketSignal, estimatePaperExitFill, marketDataFreshnessIssue, MAX_ORDER_BOOK_AGE_MS, type ClosedPaperTrade, type PaperAccount, type PaperPosition } from "../app/lib/engines";
import { enforceLiveExecutionRisk } from "../app/lib/live-risk";
import { DEFAULT_LIVE_EARLY_EXIT, evaluatePaperHoldExit } from "../app/lib/early-exit";
import { bankrollProfile } from "../app/lib/bankroll-policy";
import { liveBankrollProfile, type LiveBankrollProfile } from "../app/lib/live-bankroll-policy";
import { decideSettlement, isValidJournalOrder, settlementTimedOut, type JournalOrder, type SettlementDecision, type TradeObservation } from "../app/lib/live-order-journal";
import { evaluatePaperMarket, type PaperOpportunity } from "../app/lib/paper-bankroll";
import { bidLiquidationValue, quoteMinimumShareBuy, quoteSell, takerFeePerShare } from "../app/lib/live-order-pricing";
import { assertNoComboPositions, comboPositionsUrl, fetchAllWalletPositions, openPositions, positionsUrl, settledPositions, type WalletPosition } from "../app/lib/wallet-positions";
import { loadCalibrationFile } from "./calibration-file";
import { collateralUsdFromRaw } from "../app/lib/collateral";
import { updateRiskBaselines } from "../app/lib/live-risk-baselines";

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const STORE_DIR = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "PolymarketQuantEngine");
const STATE_PATH = join(STORE_DIR, "live-trader-state.json");
const LOCK_PATH = join(STORE_DIR, "live-trader.lock");
const SCAN_MS = 1_000;
const DISCOVERY_MS = 15_000;
const LIVE_ENTRY_RISK_PCT = 0.15;
const LIVE_MINIMUM_EQUITY_USD = 10;
const LIVE_MINIMUM_SHARES = 5;
const LIVE_MINIMUM_ORDER_USD = 1;
const RETRY_NO_FILL_MS = 20_000;
const CLOSED_HISTORY_REFRESH_MS = 60_000;
const CLOSED_HISTORY_MAX_AGE_MS = 90_000;
/** Ticks a FAK limit may sit beyond the observed price, so a one-tick move before arrival does not cancel it. */
const LIVE_LIMIT_TOLERANCE_TICKS = 2;
const CLOCK_RESYNC_MS = 5 * 60_000;
/** Fast-path settlement polling right after an order; afterwards the main loop keeps checking every 2 s. */
const RECONCILE_WAIT_MS = 10_000;
const PORTFOLIO_REFRESH_MS = 3_000;
// feeRate here is only the stand-in when a market's CLOB fee schedule is unreadable.
const RISK = enforceLiveExecutionRisk({ feeRate: 0.05, slippageBps: 25, minEdge: 0.04, requireLock: process.env.POLYMARKET_LIVE_REQUIRE_LOCK?.trim().toLowerCase() === "true" });
const LIVE_MINIMUM_ALL_IN_USD = Math.ceil((LIVE_MINIMUM_ORDER_USD * (1 + RISK.feeRate) - 1e-9) * 100) / 100;

type PositionRow = WalletPosition;
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
  /** The one in-flight order; see app/lib/live-order-journal.ts for its phases. */
  pending: JournalOrder | null;
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
    const pending = state.pending ?? null;
    if (pending !== null && !(isValidJournalOrder(pending) && pending.phase === "SETTLING")) {
      // SUBMITTING (or an older marker) means the process stopped between
      // posting and recording the CLOB response: the outcome is unknown.
      throw new Error("A prior order request has an uncertain outcome. Check wallet positions, open orders, and activity before restarting. The pending marker is in the local trader state file.");
    }
    if (![1, 2, 3].includes(state.version ?? -1) || !Array.isArray(state.attemptedMarkets)) {
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
      // A SETTLING order has a known CLOB order ID; reconciliation resumes.
      pending,
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

const fetchWithRetry = async (url: string): Promise<unknown> => {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      response = await fetch(url, { cache: "no-store", signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
    // This endpoint is read-only, so retry temporary upstream failures before
    // holding a whole scan. Never substitute cached positions for a failed read.
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(2_000, retryAfter * 1_000)
      : 250 * (2 ** attempt);
    await response.body?.cancel().catch(() => undefined);
    await sleep(delay);
  }
  if (!response?.ok) throw new Error(`Polymarket position lookup returned ${response?.status ?? "no response"} after up to 3 attempts.`);
  return await response.json() as unknown;
};

/** Every wallet position, across all pages; resolved (redeemable) rows are flagged, not dropped. */
const readPositions = async (wallet: string): Promise<PositionRow[]> => {
  // Combo positions live on a separate endpoint the engine cannot value; refuse rather than under-count.
  assertNoComboPositions(await fetchWithRetry(comboPositionsUrl(DATA_API, wallet)));
  return fetchAllWalletPositions((cursor) => fetchWithRetry(positionsUrl(DATA_API, wallet, cursor)));
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
  return collateralUsdFromRaw(payload.balance);
};

/** Latest executable book per held token, refreshed on a fixed schedule; the source of position marks. */
const positionBooks = new Map<string, { book: OrderBook; feeSchedule?: MarketFeeSchedule }>();

/**
 * Liquidation equity: cash, plus what each open position would raise by
 * selling into its current bids after fees, plus the fixed value of resolved
 * positions awaiting redemption. A position without a fresh book is valued at
 * zero, never at the Data API's mark, so a thin book cannot inflate equity.
 */
const liveEquity = (balance: number, positions: PositionRow[]) => balance + positions.reduce((sum, position) => {
  if (position.settled) return sum + position.currentValueUsd;
  const entry = position.tokenID ? positionBooks.get(position.tokenID) : undefined;
  if (!entry || entry.book.timestamp === null || synchronizedPolymarketTime() - entry.book.timestamp > MAX_ORDER_BOOK_AGE_MS * 3) return sum;
  return sum + bidLiquidationValue(entry.book.bids, position.size, entry.feeSchedule, RISK.feeRate);
}, 0);

const rememberPositionBooks = (positions: PositionRow[], markets: Iterable<LiveMarket>) => {
  const held = new Set(openPositions(positions).flatMap((position) => position.tokenID ? [position.tokenID] : []));
  for (const market of markets) {
    if (held.has(market.upTokenId) && market.upBook) positionBooks.set(market.upTokenId, { book: market.upBook, feeSchedule: market.feeSchedule });
    if (held.has(market.downTokenId) && market.downBook) positionBooks.set(market.downTokenId, { book: market.downBook, feeSchedule: market.feeSchedule });
  }
  for (const token of [...positionBooks.keys()]) if (!held.has(token)) positionBooks.delete(token);
};

/** Fetch books for held tokens that the active-market scan does not cover (unrelated or older markets). */
const refreshPositionBooks = async (positions: PositionRow[], covered: ReadonlySet<string>) => {
  const missing = openPositions(positions).flatMap((position) => position.tokenID && !covered.has(position.tokenID) ? [position.tokenID] : []);
  if (!missing.length) return;
  const books = await fetchOrderBooks(missing);
  for (const token of missing) {
    const book = books.get(token);
    if (book) positionBooks.set(token, { book });
    else positionBooks.delete(token);
  }
};
/** Capital at risk in open markets; resolved positions are fixed in value and carry no exposure. */
const openExposureUsd = (positions: PositionRow[]) => openPositions(positions).reduce((sum, position) => sum + position.exposureUsd, 0);

const redemptionNotice = (positions: PositionRow[]): string | null => {
  const settled = settledPositions(positions);
  if (!settled.length) return null;
  const value = settled.reduce((sum, position) => sum + position.currentValueUsd, 0);
  return `${settled.length} resolved position(s) worth ${money(value)} await redemption. They no longer count as open exposure, but their cash is unavailable until you redeem them on polymarket.com; this trader does not send on-chain redemption transactions.`;
};


const liveProfileFor = (equityUsd: number, duration: "5m" | "15m"): LiveBankrollProfile => {
  return liveBankrollProfile(equityUsd, LIVE_MINIMUM_EQUITY_USD, LIVE_ENTRY_RISK_PCT, duration);
};

const liveExitBookIssue = (market: LiveMarket, tokenID: string, now: number): string | null => {
  const marketNow = synchronizedPolymarketTime(now);
  if (market.priceFeed === "UNSUPPORTED" || !market.startTimeVerified || market.startTime === null
    || market.startTime > marketNow + 1_000 || market.remaining < DEFAULT_LIVE_EARLY_EXIT.earlyExitStopLossMinRemainingSeconds) {
    return "The market interval is not verified and active for an automatic exit.";
  }
  const sideBook = tokenID === market.upTokenId ? market.upBook : tokenID === market.downTokenId ? market.downBook : null;
  if (!sideBook || sideBook.timestamp === null || sideBook.timestamp > marketNow + 2_000
    || marketNow - sideBook.timestamp > MAX_ORDER_BOOK_AGE_MS || !sideBook.bids.some((level) => level.price > 0 && level.price < 1 && level.size > 0)) {
    return "The position has no fresh executable bid for an automatic exit.";
  }
  return null;
};

let fixedExitThresholdsEnabled = false;

const liveExitPolicyFor = (equityUsd: number) => {
  const profile = bankrollProfile(equityUsd);
  return {
    ...DEFAULT_LIVE_EARLY_EXIT,
    earlyExitEnabled: true,
    // Optional 20% take-profit / stop-loss; even then they only fire when the
    // model does not value holding above the fee-adjusted sale.
    earlyExitTakeProfitPct: fixedExitThresholdsEnabled ? 0.2 : 0,
    earlyExitStopLossPct: fixedExitThresholdsEnabled ? 0.2 : 0,
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
  if (!sideBook?.bids.length) return null;
  // Price the exit exactly as it would be posted: the book's own tick and the
  // capped tolerance, judged on the worst proceeds the limit allows.
  const tickSize = String(sideBook.tickSize ?? 0.01);
  const quote = quoteSell({ bids: sideBook.bids, shares: requestedShares, tickSize, toleranceTicks: LIVE_LIMIT_TOLERANCE_TICKS, minimumShares,
    feeSchedule: market.feeSchedule, fallbackFeeRate: RISK.feeRate });
  if (!quote) return null;
  const executableBids = sideBook.bids.filter((level) => level.price + 1e-8 >= quote.limitPrice);
  const executableShares = quote.shares;
  const executionBook = { ...sideBook, bids: executableBids };
  const executionMarket = side === "UP" ? { ...market, upBook: executionBook } : { ...market, downBook: executionBook };
  const fill = estimatePaperExitFill(executionMarket, side, executableShares, { feeRate: RISK.feeRate, slippageBps: RISK.slippageBps }, now);
  if (!fill || fill.shares + 1e-8 < executableShares) return null;
  const fairUp = anchoredFairUp(market);
  const fairProbability = fairUp === null ? 0.5 : side === "UP" ? fairUp : 1 - fairUp;
  const modelDataAvailable = fairUp !== null && marketDataFreshnessIssue(market, now) === null;
  const modelRead = !modelDataAvailable ? null : analyzeMarketSignal(market,
    { feeRate: RISK.feeRate, slippageBps: RISK.slippageBps }, Math.max(1, position.exposureUsd), 0.04, now);
  const opposite = side === "UP" ? "DOWN" : "UP";
  const directionalReversal = modelRead?.bias === opposite && (modelRead.biasConfidence ?? 0) >= 0.6 && fairProbability < 0.45;
  const evaluation = evaluatePaperHoldExit({
    policy: liveExitPolicyFor(equityUsd),
    entryCostUsd: position.exposureUsd * (requestedShares / position.size),
    originalShares: requestedShares,
    filledShares: executableShares,
    netExitProceedsUsd: Math.min(fill.totalCost, quote.worstProceedsUsd),
    sideFairProbability: fairProbability,
    remainingSeconds: market.remaining,
    directionalReversal,
    reversalMarginPct: bankrollProfile(equityUsd).tier === "MICRO" ? 0.005 : 0.01,
    modelDataAvailable,
  });
  return { evaluation, requestedShares, executableShares, fairProbability, modelRead };
};

const liveSellQuote = (market: LiveMarket, side: "UP" | "DOWN", shares: number, tickSize: string, now: number) => {
  const sourceBook = side === "UP" ? market.upBook : market.downBook;
  if (!sourceBook?.bids.length || shares <= 0) return null;
  const minimumShares = Math.max(LIVE_MINIMUM_SHARES, sourceBook.minOrderSize ?? 0);
  const quote = quoteSell({ bids: sourceBook.bids, shares, tickSize, toleranceTicks: LIVE_LIMIT_TOLERANCE_TICKS, minimumShares,
    feeSchedule: market.feeSchedule, fallbackFeeRate: RISK.feeRate });
  if (!quote) return null;
  const limitedBook = { ...sourceBook, bids: sourceBook.bids.filter((level) => level.price + 1e-8 >= quote.limitPrice) };
  const executionMarket = side === "UP" ? { ...market, upBook: limitedBook } : { ...market, downBook: limitedBook };
  const estimatedFill = estimatePaperExitFill(executionMarket, side, quote.shares, { feeRate: RISK.feeRate, slippageBps: RISK.slippageBps }, now);
  return estimatedFill && estimatedFill.shares + 1e-8 >= quote.shares
    ? { shares: quote.shares, limitPrice: quote.limitPrice, worstProceedsUsd: quote.worstProceedsUsd, executionMarket, estimatedFill } : null;
};

const buildPaperAccount = (balance: number, rows: PositionRow[], markets: Map<string, LiveMarket>, timestamp: number, dayStart: number,
  closedTrades: ClosedPaperTrade[] = []): PaperAccount => {
  const positions: PaperPosition[] = openPositions(rows).map((row, index) => {
    const market = [...markets.values()].find((candidate) => candidate.upTokenId === row.tokenID || candidate.downTokenId === row.tokenID
      || Boolean(candidate.conditionId && row.conditionId && candidate.conditionId.toLowerCase() === row.conditionId.toLowerCase())
      || candidate.slug.toLowerCase() === row.slug?.toLowerCase());
    const tokenSide = market && row.tokenID === market.downTokenId ? "DOWN" : market && row.tokenID === market.upTokenId ? "UP" : null;
    const side = tokenSide ?? row.side;
    // Wallets can hold unrelated markets, including YES/NO outcomes, while this
    // engine only trades crypto UP/DOWN. Keep those costs in aggregate exposure
    // and open-position limits, but give each an isolated identity so it can
    // never be mistaken for a position in a discovered market or auto-exited.
    const isUnmapped = side === null;
    const riskMarket = isUnmapped ? null : market;
    const riskSide = side ?? "UP";
    const marketId = riskMarket?.id ?? (isUnmapped
      ? `unmapped:${row.tokenID ?? row.conditionId ?? row.slug ?? index}`
      : row.conditionId ?? row.slug ?? row.tokenID ?? `position:${index}`);
    const avgEntry = row.averagePrice && row.averagePrice > 0 && row.averagePrice <= 1 ? row.averagePrice : Math.max(0.0001, row.exposureUsd / row.size);
    return {
      id: row.tokenID ?? marketId,
      marketId,
      marketLabel: riskMarket ? `${riskMarket.asset} ${riskMarket.duration}` : row.slug ?? "Existing Polymarket position",
      asset: riskMarket?.asset ?? "CRYPTO",
      duration: riskMarket?.duration ?? "5m",
      side: riskSide,
      shares: row.size,
      avgEntry,
      totalCost: Math.max(0.0001, row.exposureUsd),
      mark: null,
      endTime: riskMarket?.endTime ?? timestamp,
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
    // Book timestamps are server time everywhere in the engine.
    timestamp: number(source.timestamp) ?? synchronizedPolymarketTime(receivedAt),
    tickSize: number(source.tick_size),
    minOrderSize: number(source.min_order_size ?? source.minOrderSize)
      ?? (tokenID === market.upTokenId ? market.upBook?.minOrderSize : market.downBook?.minOrderSize) ?? null,
    hash: typeof source.hash === "string" ? source.hash : null,
  };
  if (tokenID === market.upTokenId) return { ...market, upBook: orderBook, upBid: bids[0]?.price ?? null, upAsk: asks[0]?.price ?? null };
  if (tokenID === market.downTokenId) return { ...market, downBook: orderBook, downBid: bids[0]?.price ?? null, downAsk: asks[0]?.price ?? null };
  throw new Error("The refreshed order book did not match the selected market token.");
};

const minimumShareOrder = (market: LiveMarket, side: "UP" | "DOWN", tickSize: string, fairProbability: number) => {
  const book = side === "UP" ? market.upBook : market.downBook;
  if (!book) return null;
  return quoteMinimumShareBuy({ asks: book.asks, venueMinimumShares: book.minOrderSize, floorShares: LIVE_MINIMUM_SHARES, tickSize,
    fairProbability, minEdge: RISK.minEdge, slippageBps: RISK.slippageBps, toleranceTicks: LIVE_LIMIT_TOLERANCE_TICKS,
    feeSchedule: market.feeSchedule, fallbackFeeRate: RISK.feeRate });
};

/**
 * Can this equity place any entry at all? The smallest order is the venue
 * minimum at the tier's lowest allowed entry price; if that exceeds the
 * per-entry cap, the trader would scan forever without trading.
 */
const liveEntryFeasibility = (equityUsd: number) => {
  const profile = liveProfileFor(equityUsd, "5m");
  const perEntryCap = Math.min(RISK.maxTradeUsd, equityUsd * profile.maxStakePct);
  const cheapest = LIVE_MINIMUM_SHARES * (profile.minEntryPrice + takerFeePerShare(profile.minEntryPrice, undefined, RISK.feeRate));
  const requiredEquity = Math.ceil(cheapest / profile.maxStakePct * 100) / 100;
  return { feasible: profile.eligible && cheapest <= perEntryCap + 1e-9, perEntryCap, cheapest, requiredEquity, profile };
};

const assertEntryEligible = (balance: number, positions: PositionRow[]) => {
  const equity = liveEquity(balance, positions);
  if (equity < LIVE_MINIMUM_EQUITY_USD) throw new Error("Liquidation equity is below the $10 live-entry floor.");
  if (balance < 1) throw new Error("Available USDC is below the $1 minimum executable stake.");
  const feasibility = liveEntryFeasibility(equity);
  if (!feasibility.feasible) {
    throw new Error(`No entry can pass at this balance: the ${feasibility.profile.tier} tier caps an entry at ${money(feasibility.perEntryCap)}, but the smallest allowed order (${LIVE_MINIMUM_SHARES} shares at the tier's ${Math.round(feasibility.profile.minEntryPrice * 100)}c floor, with fees) costs ${money(feasibility.cheapest)}. At least ${money(feasibility.requiredEquity)} of equity is needed.`);
  }
};

const normalizeTradeStatus = (status: unknown) => String(status ?? "").toUpperCase().replace(/^TRADE_STATUS_/, "");

/**
 * One reconciliation pass for a SETTLING order: the CLOB order record, the
 * status of each of its trades, open orders, and the wallet. A FAK remainder
 * still reported open is cancelled.
 */
const reconcileJournalOrder = async (client: ClobClient, walletAddress: string, order: JournalOrder) => {
  const [balance, openOrders, positions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
  let matchedShares: number | null = null;
  let tradeIds: string[] = order.tradeIds ?? [];
  try {
    const record = await client.getOrder(order.orderID!);
    matchedShares = number(record?.size_matched);
    if (Array.isArray(record?.associate_trades)) tradeIds = record.associate_trades.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch { /* unreadable this pass; the decision waits */ }
  let orderStillOpen = openOrders.some((open) => open.id === order.orderID);
  const unrelatedOpen = openOrders.filter((open) => open.id !== order.orderID);
  if (unrelatedOpen.length) return { decision: { kind: "HALT", reason: "An unrelated open order appeared while an order was settling." } as SettlementDecision, balance, positions, tradeIds };
  if (orderStillOpen && Date.now() - order.submittedAt > 1_500) {
    await client.cancelOrder({ orderID: order.orderID! }).catch(() => undefined);
    orderStillOpen = (await client.getOpenOrders(undefined, true)).some((open) => open.id === order.orderID);
  }
  const trades: TradeObservation[] = [];
  for (const id of tradeIds) {
    try {
      const rows = await client.getTrades({ id }, true);
      const trade = rows.find((row) => row.id === id);
      if (trade) trades.push({ id, status: normalizeTradeStatus(trade.status), size: number(trade.size) ?? 0 });
    } catch { /* a missing trade keeps the decision waiting */ }
  }
  const walletShares = positions.find((position) => position.tokenID === order.tokenID)?.size ?? 0;
  const decision = decideSettlement({ order, matchedShares, orderStillOpen, trades, walletShares, now: Date.now() });
  return { decision, balance, positions, tradeIds };
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
  const profile = liveProfileFor(equity, input.market.duration);
  const maxTradeUsd = Math.min(RISK.maxTradeUsd, input.balance * profile.maxStakePct, equity * profile.maxStakePct);
  const account = buildPaperAccount(input.balance, input.positions, input.markets, input.now, dayStart, input.state.closedTrades);
  const opportunity = evaluatePaperMarket({ market: input.market, markets: input.markets, account,
    costs: { feeRate: RISK.feeRate, slippageBps: RISK.slippageBps }, liquidationEquityUsd: equity,
    dayStartLiquidationEquityUsd: dayStart, peakLiquidationEquityUsd: input.state.peakLiquidationEquityUsd ?? equity,
    minOrderUsd: LIVE_MINIMUM_ALL_IN_USD, maxTradeUsd, maxExposurePct: profile.maxExposurePct, minimumSharesOverride: LIVE_MINIMUM_SHARES,
    profileOverride: profile, minNetEdge: RISK.minEdge,
    strategyThresholds: { microScoreMinimum: profile.microScoreMinimum, smallBiasConfidenceMinimum: profile.smallBiasConfidenceMinimum },
    now: input.now });
  if (input.state.closedTradesAt === null || input.now - input.state.closedTradesAt > CLOSED_HISTORY_MAX_AGE_MS) {
    return { ...opportunity, approved: false, reason: "PASS: recent realized P&L history is unavailable or stale, so live loss-streak controls cannot be applied." };
  }
  return opportunity;
};

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("The live trader requires an interactive terminal.");
  console.log("\nPOLYMARKET LIVE TRADER · TERMINAL SETUP\n");
  console.log("This connects to the real CLOB. Credentials can be read from the local .env file or entered here; the program does not write credentials to disk. FAK orders can partially fill and cancel the remainder. The model is uncalibrated and does not guarantee profit.\n");
  const walletAddress = process.env.POLYMARKET_WALLET_ADDRESS?.trim() || await ask("Polymarket wallet address: ");
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) throw new Error("Enter a valid 0x wallet address.");
  console.log("\nSignature type: 0 EOA · 1 Polymarket Proxy · 2 Gnosis Safe · 3 contract wallet / deposit wallet.");
  const signatureInput = process.env.POLYMARKET_SIGNATURE_TYPE?.trim() || await ask("Signature type (0-3): ");
  const signatureType = Number(signatureInput);
  if (!Number.isInteger(signatureType) || signatureType < 0 || signatureType > 3) throw new Error("Choose one of the listed signature types.");
  if (process.env.POLYMARKET_PRIVATE_KEY) {
    console.log("POLYMARKET_PRIVATE_KEY is set in the environment and is ignored. Remove it from .env; the key is only accepted through the hidden prompt.");
  }
  const privateKey = await askSecret("Signer private key (input hidden): ");
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(privateKey)) throw new Error("The key must be exactly 32 bytes in hexadecimal format.");

  const unlock = await acquireLock();
  let stopStream: () => void = () => undefined;
  let exitListener: ((line: string) => void) | undefined;
  let inputInterface: ReturnType<typeof createInterface> | null = null;
  let stopSignalListener: (() => void) | undefined;
  try {
    const state = await readState();
    if (state.pending) console.log(`Resuming reconciliation of ${state.pending.action} order ${state.pending.orderID}; no new orders until it settles.`);
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
    if (orders.some((order) => order.id !== state.pending?.orderID)) throw new Error("Open orders exist. Reconcile or cancel them in Polymarket, then restart the terminal trader.");
    if (!state.pending) await refreshPositionBooks(positions, new Set());
    const notice = redemptionNotice(positions);
    if (notice) console.log(notice);
    if (!state.pending) assertEntryEligible(balance, positions);
    const calibrationPath = process.env.POLYMARKET_CALIBRATION_FILE?.trim() || join(process.cwd(), "var", "model-calibration.json");
    const calibration = await loadCalibrationFile(calibrationPath);
    console.log(calibration.active
      ? `Model weight: fitted stacking calibration from ${calibration.active.markets} settled markets (model coefficient ${calibration.active.modelCoefficient.toFixed(2)}, lower bound ${calibration.active.modelCoefficientLower.toFixed(2)}).`
      : `Model weight: conservative prior (${calibration.reason}). Entries need a large model/market disagreement, so expect few or none until \`pnpm run calibrate\` fits weights from at least 300 settled markets.`);

    if (!state.pending) {
      updateRiskBaselines(state, liveEquity(balance, positions), Date.now());
      state.closedTrades = await readClosedTrades(walletAddress, Date.now());
      state.closedTradesAt = Date.now();
    }
    await writeState(state);

    console.log(`\nLive guardrails: full market-specific model and bankroll filters · ${RISK.requireLock ? "LOCK signals only" : "ENTRY or LOCK signals"} · tier-adjusted edge floor (never below 4% net) · five-share order minimum · FAK execution reconciled against the CLOB order record · each market's CLOB fee schedule · limit up to ${LIVE_LIMIT_TOLERANCE_TICKS} ticks past the observed price, never above the model ceiling.`);
    console.log("Live entries require at least $10 liquidation equity. A partial FAK fill below five shares will be tracked but held to settlement because it may be below the venue's exit minimum.");
    console.log("For balances up to $100, an entry may use up to 15% of equity to meet the five-share minimum, with a $5 per-order cap and 15% position, daily-loss, and drawdown limits. Larger balances keep their tier limits.");
    const enableModelExits = (await ask("Enable model-aware cashouts for positions opened by this trader? Type YES to enable, or press Enter to hold to settlement: ")).toUpperCase() === "YES";
    if (enableModelExits) {
      fixedExitThresholdsEnabled = (await ask("Also enable a 20% net take-profit and stop-loss? They still only sell when the model does not value holding above the sale. Type YES, or press Enter to skip: ")).toUpperCase() === "YES";
    }
    console.log(enableModelExits
      ? `Model-aware cashouts are enabled${fixedExitThresholdsEnabled ? " with a model-checked 20% take-profit and stop-loss" : ""} for positions opened by this trader; all other wallet positions remain unmanaged.`
      : "Automatic cashouts are off; the trader will hold its entries to market settlement unless you manage them manually.");
    const answer = await ask("Type YES to arm live trading: ");
    if (answer.toUpperCase() !== "YES") {
      console.log("Not armed. No order was placed.");
      return;
    }

    const priceTicks = new Map<string, PolymarketPriceTick>();
    const streamHealth: { status: PolymarketPriceStreamStatus } = { status: "CONNECTING" };
    let lastDiscoveryAt = 0;
    let definitions: Awaited<ReturnType<typeof discoverCryptoMarkets>> = [];
    const histories = new Map<Asset, CandleHistory>();
    let lastHistoryRefreshAt = 0;
    let historyRefreshInFlight = false;
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
    let lastClockSyncAt = Date.now();
    let lastRedemptionNoticeAt = Date.now();
    let lastSettlementLogAt = 0;

    /** Apply a settled order to the trader's own bookkeeping. */
    const finalizeOrder = async (order: JournalOrder, filledShares: number, positions: PositionRow[], balanceNow: number | null) => {
      const now = Date.now();
      if (order.action === "BUY") {
        if (filledShares > 0) {
          state.attemptedMarkets = [...state.attemptedMarkets, order.marketId].slice(-300);
          if (!state.managedPositionTokens.includes(order.tokenID)) state.managedPositionTokens = [...state.managedPositionTokens, order.tokenID].slice(-100);
          state.managedPositionSince[order.tokenID] = now;
          delete state.retryAfter[order.marketId];
        } else {
          state.retryAfter[order.marketId] = now + RETRY_NO_FILL_MS;
        }
      } else {
        delete state.exitConfirmations[order.tokenID];
        if (filledShares <= 0) state.retryAfter[`exit:${order.tokenID}`] = now + RETRY_NO_FILL_MS;
        const residual = positions.find((position) => position.tokenID === order.tokenID);
        if (!residual || residual.size < LIVE_MINIMUM_SHARES) {
          state.managedPositionTokens = state.managedPositionTokens.filter((entry) => entry !== order.tokenID);
          delete state.managedPositionSince[order.tokenID];
        }
      }
      state.pending = null;
      if (balanceNow !== null) {
        lastKnownBalance = balanceNow;
        lastKnownPositions = positions;
        lastPortfolioRefreshAt = now;
        updateRiskBaselines(state, liveEquity(balanceNow, positions), now);
      }
      await writeState(state);
      lastStateWriteAt = now;
      const partial = filledShares > 0 && filledShares + 0.005 < order.requestedShares;
      console.log(`[${new Date().toLocaleTimeString()}] ${order.action} settled · ${filledShares > 0 ? `${filledShares.toFixed(4)} shares confirmed on-chain${partial ? ` of ${order.requestedShares.toFixed(4)} requested` : ""}` : "no fill"}${balanceNow !== null ? ` · USDC ${money(balanceNow)}` : ""}.`);
      if (order.action === "BUY" && filledShares > 0 && filledShares + 1e-6 < LIVE_MINIMUM_SHARES) {
        console.log("The confirmed fill is below five shares; it is tracked and held to settlement because the venue minimum prevents a sell.");
      }
    };

    /** One settlement pass for the pending order. */
    const settlePendingOrder = async (): Promise<"SETTLED" | "WAIT" | "HALT"> => {
      const order = state.pending!;
      try {
        const result = await reconcileJournalOrder(client, walletAddress, order);
        if (result.tradeIds.length && JSON.stringify(result.tradeIds) !== JSON.stringify(order.tradeIds ?? [])) {
          state.pending = { ...order, tradeIds: result.tradeIds };
          await writeState(state);
        }
        if (result.decision.kind === "SETTLED") {
          await finalizeOrder(order, result.decision.filledShares, result.positions, result.balance);
          if (result.decision.failedShares > 0) console.log(`${result.decision.failedShares.toFixed(4)} matched shares FAILED on-chain and were not filled.`);
          return "SETTLED";
        }
        if (result.decision.kind === "HALT") {
          console.error(`Order ${order.orderID} could not be reconciled: ${result.decision.reason}`);
          console.error(`The trader halted with the order still recorded in ${STATE_PATH}. Reconcile Polymarket before restarting.`);
          return "HALT";
        }
        if (Date.now() - lastSettlementLogAt >= 15_000) {
          lastSettlementLogAt = Date.now();
          console.log(`[${new Date().toLocaleTimeString()}] ${order.action} order ${order.orderID} settling: ${result.decision.reason} New orders are held.`);
        }
        return "WAIT";
      } catch (error) {
        console.log(`[${new Date().toLocaleTimeString()}] Settlement check held: ${scrubError(error, privateKey)}`);
        if (settlementTimedOut(order, Date.now())) {
          console.error(`Order ${order.orderID} has not reconciled within 10 minutes. The pending marker remains in ${STATE_PATH}; check Polymarket before restarting.`);
          return "HALT";
        }
        return "WAIT";
      }
    };

    /**
     * Record the CLOB response for a submitted order. With an order ID it
     * becomes SETTLING and is reconciled until final; an explicit rejection
     * without an ID is a no-fill once the wallet confirms nothing moved.
     */
    const afterSubmission = async (response: { success?: boolean; orderID?: string; errorMsg?: string } | undefined): Promise<"SETTLED" | "WAIT" | "HALT"> => {
      const order = state.pending!;
      if (!response?.orderID) {
        if (response && response.success === false) {
          const [afterOrders, afterPositions] = await Promise.all([client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
          const walletShares = afterPositions.find((position) => position.tokenID === order.tokenID)?.size ?? 0;
          if (!afterOrders.length && Math.abs(walletShares - order.baselineShares) <= 0.01) {
            console.log(`[${new Date().toLocaleTimeString()}] Order rejected by the CLOB${response.errorMsg ? `: ${response.errorMsg}` : ""}.`);
            await finalizeOrder(order, 0, afterPositions, await readBalance(client));
            return "SETTLED";
          }
        }
        console.error("Order outcome UNCERTAIN: the CLOB returned no order ID.");
        console.error(`The trader halted with a pending marker. Check wallet positions, open orders, and activity before restart: ${STATE_PATH}`);
        return "HALT";
      }
      state.pending = { ...order, phase: "SETTLING", orderID: response.orderID };
      await writeState(state);
      const fastPathUntil = Date.now() + RECONCILE_WAIT_MS;
      while (Date.now() < fastPathUntil) {
        const outcome = await settlePendingOrder();
        if (outcome !== "WAIT") return outcome;
        await sleep(750);
      }
      return "WAIT";
    };

    while (!controller.signal.aborted) {
      if (Date.now() - lastClockSyncAt >= CLOCK_RESYNC_MS) {
        lastClockSyncAt = Date.now();
        await syncPolymarketClock(controller.signal).catch(() => undefined);
      }
      if (Date.now() - lastRedemptionNoticeAt >= 15 * 60_000) {
        lastRedemptionNoticeAt = Date.now();
        const notice = redemptionNotice(lastKnownPositions);
        if (notice) console.log(`[${new Date().toLocaleTimeString()}] ${notice}`);
      }
      if (state.pending) {
        if (state.pending.phase !== "SETTLING") {
          console.error(`Trader halted with unresolved ${state.pending.action} order ${state.pending.requestId}; reconcile the wallet before continuing.`);
          return;
        }
        // No new entries or exits while an order is settling: its outcome is
        // part of the exposure every other decision depends on.
        const outcome = await settlePendingOrder();
        if (outcome === "HALT") return;
        if (outcome === "SETTLED") {
          try {
            assertEntryEligible(lastKnownBalance, lastKnownPositions);
          } catch (error) {
            console.log(`Order reconciled; live entry remains disarmed: ${scrubError(error, privateKey)}`);
            return;
          }
        }
        await sleep(outcome === "SETTLED" ? SCAN_MS : 2_000);
        continue;
      }
      let now = Date.now();
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
            lastHistoryRefreshAt = 0;
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
      // Only markets that are trading now (or about to) need books every
      // second; Gamma's two-hour discovery window would otherwise multiply the
      // request load for no decision value.
      const serverNow = synchronizedPolymarketTime(now);
      const heldTokens = new Set(openPositions(lastKnownPositions).flatMap((position) => position.tokenID ? [position.tokenID] : []));
      const tokenIds = definitions.filter((market) => (market.startTime === null || market.startTime <= serverNow + 5_000) && market.endTime > serverNow
        || heldTokens.has(market.upTokenId) || heldTokens.has(market.downTokenId))
        .flatMap((market) => [market.upTokenId, market.downTokenId]);
      if (!definitions.length || !tokenIds.length) {
        if (cycle % 10 === 0) console.log(`[${new Date().toLocaleTimeString()}] No active supported crypto market.`);
        await sleep(SCAN_MS);
        continue;
      }
      try {
        const [books] = await Promise.all([fetchOrderBooks(tokenIds, controller.signal)]);
        if (!historyRefreshInFlight && Date.now() - lastHistoryRefreshAt >= 30_000) {
          historyRefreshInFlight = true;
          const candleAssets = [...new Set(definitions.map((market) => market.asset))];
          void fetchCandleHistories(candleAssets, controller.signal)
            .then((freshHistories) => {
              for (const [asset, history] of freshHistories) histories.set(asset, history);
              lastHistoryRefreshAt = Date.now();
            })
            .catch((error) => {
              if (!controller.signal.aborted) console.log(`[${new Date().toLocaleTimeString()}] Candle refresh held: ${scrubError(error, privateKey)}`);
            })
            .finally(() => { historyRefreshInFlight = false; });
        }
        // Discovery, books, and candle requests can take several seconds. Use
        // the post-I/O clock for oracle filtering so valid RTDS ticks received
        // during those requests are not discarded as future-dated.
        now = Date.now();
        const ticks = [...priceTicks.values()];
        const currentMarkets = new Map<string, LiveMarket>();
        for (const definition of definitions) {
          const market = applyPolymarketPriceTicks(buildLiveMarket(definition, books, new Map(), null, now, histories.get(definition.asset) ?? null), ticks, now);
          currentMarkets.set(market.id, market);
        }
        rememberPositionBooks(lastKnownPositions, currentMarkets.values());
        // Wallet, marks and risk baselines refresh on a fixed schedule whether
        // or not exits are enabled, so peaks and losses are never missed.
        if (now - lastPortfolioRefreshAt >= PORTFOLIO_REFRESH_MS) {
          const [refreshedBalance, refreshedPositions] = await Promise.all([readBalance(client), readPositions(walletAddress)]);
          if (refreshedBalance === null) throw new Error("The wallet balance could not be refreshed.");
          lastKnownBalance = refreshedBalance;
          lastKnownPositions = refreshedPositions;
          rememberPositionBooks(refreshedPositions, currentMarkets.values());
          await refreshPositionBooks(refreshedPositions, new Set([...currentMarkets.values()].flatMap((market) => [market.upTokenId, market.downTokenId])));
          updateRiskBaselines(state, liveEquity(refreshedBalance, refreshedPositions), now);
          lastPortfolioRefreshAt = now;
          await writeState(state);
          lastStateWriteAt = now;
        }
        const blockedReasons = new Map<string, number>();
        const recordBlock = (reason: string) => blockedReasons.set(reason, (blockedReasons.get(reason) ?? 0) + 1);
        if (enableModelExits) {
          const confirmedExits: Array<{ market: LiveMarket; position: PositionRow; side: "UP" | "DOWN"; evaluation: NonNullable<ReturnType<typeof evaluateLiveHoldExit>>["evaluation"]; executableShares: number }> = [];
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
            const exitPolicy = liveExitPolicyFor(liveEquity(lastKnownBalance, lastKnownPositions));
            const stopLossWindowStart = Math.min(exitPolicy.earlyExitMinRemainingSeconds, exitPolicy.earlyExitStopLossMinRemainingSeconds);
            if (!market || market.remaining < stopLossWindowStart || liveExitBookIssue(market, tokenID, now)) {
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
            if (count >= DEFAULT_LIVE_EARLY_EXIT.earlyExitConfirmations) confirmedExits.push({ market, position, side,
              evaluation: exit.evaluation, executableShares: exit.executableShares });
          }
          if (exitStateChanged) { await writeState(state); lastStateWriteAt = now; }
          confirmedExits.sort((left, right) => {
            const leftStopLoss = left.evaluation.reason.startsWith("Stop-loss:");
            const rightStopLoss = right.evaluation.reason.startsWith("Stop-loss:");
            if (leftStopLoss !== rightStopLoss) return leftStopLoss ? -1 : 1;
            return right.evaluation.exitAdvantageUsd - left.evaluation.exitAdvantageUsd;
          });
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
            // Judge the freshly read position and market, not the earlier snapshot:
            // a market that has just resolved can no longer be sold.
            if (freshPosition.settled || executionMarket.endTime <= synchronizedPolymarketTime(receivedAt) + 5_000) {
              delete state.exitConfirmations[tokenID];
              await sleep(SCAN_MS);
              continue;
            }
            const freshIssue = liveExitBookIssue(executionMarket, tokenID, receivedAt);
            const liveEquityUsd = liveEquity(freshBalance, freshPositions);
            const finalExit = freshIssue ? null : evaluateLiveHoldExit(executionMarket, freshPosition, confirmedExit.side, receivedAt, liveEquityUsd);
            const sellQuote = finalExit && finalExit.evaluation.shouldExit
              ? liveSellQuote(executionMarket, confirmedExit.side, finalExit.executableShares, tickSize, receivedAt) : null;
            const sellShares = sellQuote?.shares ?? 0;
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
            state.pending = { requestId: randomUUID(), marketId: marketKey, tokenID, action: "SELL", requestedShares: sellShares,
              limitPrice: sellQuote.limitPrice, reservedUsd: 0, baselineShares: freshPosition.size, phase: "SUBMITTING", submittedAt: Date.now() };
            await writeState(state);
            console.log(`[${new Date().toLocaleTimeString()}] SELL ${confirmedExit.market.asset} ${confirmedExit.market.duration} ${confirmedExit.side} · ${sellShares.toFixed(2)} shares · model exit: ${finalExit.evaluation.reason} · limit ${percent(sellQuote.limitPrice)} (worst proceeds ${money(sellQuote.worstProceedsUsd)}) · FAK`);
            let response;
            try {
              response = await client.createAndPostMarketOrder({ tokenID, amount: sellShares, side: Side.SELL, price: sellQuote.limitPrice, orderType: OrderType.FAK },
                { tickSize: tickSize as TickSize, negRisk: Boolean(marketBook.neg_risk) }, OrderType.FAK);
            } catch (error) {
              console.error(`Exit outcome UNCERTAIN: ${scrubError(error, privateKey)}`);
              console.error(`The trader halted with a pending marker. Check wallet positions, open orders, and activity before restart: ${STATE_PATH}`);
              return;
            }
            const exitOutcome = await afterSubmission(response);
            if (exitOutcome === "HALT") return;
            await sleep(SCAN_MS);
            continue;
          }
        }
        const candidates: Array<{ market: LiveMarket; opportunity: PaperOpportunity }> = [];
        for (const market of currentMarkets.values()) {
          const marketKey = marketCycleKey(market);
          if (market.remaining < 30 || !RISK.allowedDurations.includes(market.duration) || streamHealth.status !== "CONNECTED") {
            recordBlock(streamHealth.status !== "CONNECTED" ? `oracle ${streamHealth.status.toLowerCase()}` : "outside the active entry window");
            continue;
          }
          // Future markets are part of Gamma's two-hour discovery window. Skip
          // them before tallying blocked reasons so they cannot mask the state
          // of markets that are already trading.
          if (market.startTimeVerified && market.startTime !== null
            && market.startTime > synchronizedPolymarketTime(now) + 1_000) continue;
          if (state.attemptedMarkets.includes(marketKey)) { recordBlock("already filled this market cycle"); continue; }
          if ((state.retryAfter[marketKey] ?? 0) > now) { recordBlock("recent FAK no-fill cooldown"); continue; }
          const issue = marketDataFreshnessIssue(market, now);
          if (issue) { recordBlock(issue); continue; }
          const opportunity = evaluateLiveOpportunity({ market, markets: currentMarkets, balance: lastKnownBalance,
            positions: lastKnownPositions, state, now });
          if (!opportunity.approved) { recordBlock(opportunity.reason); continue; }
          if (opportunity.signal.action === "PASS" || opportunity.signal.tier === "PASS"
            || (RISK.requireLock && opportunity.signal.tier !== "LOCK")
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
            const marketNow = synchronizedPolymarketTime(now);
            const activeMarkets = [...currentMarkets.values()].filter((market) => market.startTimeVerified && market.startTime !== null
              && market.startTime <= marketNow + 1_000 && market.endTime > marketNow);
            const freshOracleCount = activeMarkets.filter((market) => market.spotSource === "POLYMARKET"
              && market.spotUpdatedAt !== null && marketNow - market.spotUpdatedAt <= 10_000
              && market.spotUpdatedAt <= marketNow + 1_000).length;
            console.log(`[${new Date().toLocaleTimeString()}] No actionable model opportunity · ${definitions.length} markets discovered · ${activeMarkets.length} active · ${freshOracleCount}/${activeMarkets.length} active markets have a fresh oracle tick · ${leadingBlock}.`);
          }
          await sleep(SCAN_MS);
          continue;
        }

        const [freshBalance, freshOrders, freshPositions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
        if (freshBalance === null || freshBalance < 1 || liveEquity(freshBalance, freshPositions) < LIVE_MINIMUM_EQUITY_USD) throw new Error("Fresh collateral or liquidation equity is below the $10 live-entry floor; entries held.");
        if (freshOrders.length) throw new Error("An open order appeared during the scan. Stop and reconcile it in Polymarket.");
        lastKnownBalance = freshBalance;
        lastKnownPositions = freshPositions;
        const freshEquity = liveEquity(freshBalance, freshPositions);
        updateRiskBaselines(state, freshEquity, Date.now());
        if (Date.now() - lastStateWriteAt >= 30_000) { await writeState(state); lastStateWriteAt = Date.now(); }
        const currentMarketKey = marketCycleKey(best.market);
        const activeMarketPosition = openPositions(freshPositions).find((position) => position.tokenID === best.market.upTokenId || position.tokenID === best.market.downTokenId || (best.market.conditionId && position.conditionId?.toLowerCase() === best.market.conditionId.toLowerCase()) || position.slug?.toLowerCase() === best.market.slug.toLowerCase());
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
        if (!finalOpportunity.approved || finalOpportunity.signal.action !== side || finalOpportunity.signal.tier === "PASS"
          || (RISK.requireLock && finalOpportunity.signal.tier !== "LOCK")
          || finalOpportunity.signal.edge === null || finalOpportunity.signal.edge < RISK.minEdge || !finalOpportunity.sizing) {
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} held after model recheck: ${finalOpportunity.reason}`);
          await sleep(SCAN_MS);
          continue;
        }
        const fairUp = finalOpportunity.signal.fairUp;
        const fairProbability = fairUp === null ? null : side === "UP" ? fairUp : 1 - fairUp;
        if (fairProbability === null) throw new Error("The final model probability is unavailable.");
        const orderQuote = minimumShareOrder(executionMarket, side, tickSize, fairProbability);
        if (!orderQuote) {
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} ${side} held: the fresh book cannot fill ${LIVE_MINIMUM_SHARES} shares at or below the model's price ceiling.`);
          await sleep(SCAN_MS);
          continue;
        }
        const freshProfile = liveProfileFor(freshEquity, best.market.duration);
        const perEntryCap = Math.min(RISK.maxTradeUsd, freshBalance * freshProfile.maxStakePct, freshEquity * freshProfile.maxStakePct);
        const totalExposure = openExposureUsd(freshPositions);
        const totalExposureCap = freshEquity * freshProfile.maxExposurePct;
        if (orderQuote.worstTotalCostUsd > perEntryCap + 1e-8 || orderQuote.worstTotalCostUsd > finalOpportunity.sizing.stakeUsd + 0.01) {
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} ${side} held: a ${orderQuote.minimumShares}-share FAK would cost up to ${money(orderQuote.worstTotalCostUsd)}, above the approved live size ${money(Math.min(perEntryCap, finalOpportunity.sizing.stakeUsd))}.`);
          await sleep(SCAN_MS);
          continue;
        }
        if (freshBalance < orderQuote.worstTotalCostUsd || totalExposure + orderQuote.worstTotalCostUsd > totalExposureCap + 1e-8) {
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} ${side} held: the five-share order exceeds available collateral or the 15% portfolio exposure ceiling.`);
          await sleep(SCAN_MS);
          continue;
        }
        state.pending = { requestId: randomUUID(), marketId: currentMarketKey, tokenID, action: "BUY", requestedShares: orderQuote.requestedShares,
          limitPrice: orderQuote.limitPrice, reservedUsd: orderQuote.worstTotalCostUsd,
          baselineShares: freshPositions.find((position) => position.tokenID === tokenID)?.size ?? 0, phase: "SUBMITTING", submittedAt: Date.now() };
        delete state.retryAfter[currentMarketKey];
        await writeState(state);
        console.log(`[${new Date().toLocaleTimeString()}] SUBMIT ${best.market.asset} ${best.market.duration} ${side} · ${orderQuote.requestedShares.toFixed(4)} shares requested (minimum ${orderQuote.minimumShares}) · ${money(orderQuote.amountUsd)} order amount · up to ${money(orderQuote.worstTotalCostUsd)} incl. fees · net edge ${percent(finalOpportunity.signal.edge)} · limit ${percent(orderQuote.limitPrice)} · FAK`);
        let response;
        try {
          response = await client.createAndPostMarketOrder({ tokenID, amount: orderQuote.amountUsd, side: Side.BUY, price: orderQuote.limitPrice, orderType: OrderType.FAK, userUSDCBalance: freshBalance }, { tickSize: clobTickSize, negRisk: Boolean(marketBook.neg_risk) }, OrderType.FAK);
        } catch (error) {
          console.error(`Order outcome UNCERTAIN: ${scrubError(error, privateKey)}`);
          console.error(`The trader has halted. Check positions, open orders, and activity before removing the pending marker in ${STATE_PATH}.`);
          return;
        }
        const entryOutcome = await afterSubmission(response);
        if (entryOutcome === "HALT") return;
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
