import { AssetType, Chain, ClobClient, OrderType, Side, SignatureTypeV2, type ApiKeyCreds } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { getChatGPTUser } from "../../../chatgpt-auth";
import {
  applyPolymarketPriceTicks,
  anchoredFairUp,
  buildLiveMarket,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  fetchSpotPrices,
  synchronizedPolymarketTime,
} from "../../../lib/polymarket-data";
import { analyzeMarketSignal, estimateSidePrice, marketDataFreshnessIssue } from "../../../lib/engines";
import { evaluateModelAwareExit } from "../../../lib/early-exit";
import { assessLiveExposure, computeKellySizing, enforceLiveExecutionRisk, type LiveRiskConfig } from "../../../lib/live-risk";
import {
  clearLiveSessionCookie,
  liveSessionCookie,
  LIVE_SESSION_TTL_SECONDS,
  isLoopbackRequest,
  LOCAL_LIVE_USER_ID,
  localLiveEnabled,
  readLiveSession,
  sealLiveSession,
  type LiveSession,
} from "../../../lib/polymarket-session";
import { env } from "cloudflare:workers";
import { readPolymarketPriceTicks } from "../../../lib/polymarket-price-stream";
import { fetchAllWalletPositions, openPositions, positionsUrl, settledPositions } from "../../../lib/wallet-positions";

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const SESSION_OWNER = () => typeof env.POLYMARKET_LIVE_ALLOWED_USER_ID === "string" ? env.POLYMARKET_LIVE_ALLOWED_USER_ID.trim() : "";
const liveExecutionEnabled = () => (env.POLYMARKET_LIVE_EXECUTION_ENABLED ?? "").trim().toLowerCase() === "true";
const MIN_LIVE_REMAINING_SECONDS = 30;
const EXECUTION_COOLDOWN_MS = 45_000;
const recentExecutionKeys = new Map<string, number>();
const recentLiveEntryMarketKeys = new Map<string, number>();
const recentLiveExitTokenKeys = new Map<string, number>();
const activeLiveEntryKeys = new Map<string, symbol>();
const VALID_TICK_SIZES = new Set(["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"]);

type LiveAction = "connect" | "balance" | "positions" | "execute" | "manual-entry" | "exit" | "manual-exit" | "cancel-all" | "disconnect";
type LiveRequest = {
  action?: unknown;
  walletAddress?: unknown;
  privateKey?: unknown;
  signatureType?: unknown;
  marketId?: unknown;
  tokenID?: unknown;
  amount?: unknown;
  side?: unknown;
  stakeUsd?: unknown;
  minimumPrice?: unknown;
  confirmLive?: unknown;
  requestId?: unknown;
  config?: Partial<LiveRiskConfig>;
};

type JsonRecord = Record<string, unknown>;

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { ...responseHeaders, ...extraHeaders },
});

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const dollars = (value: number) => `$${value.toFixed(2)}`;
const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const validAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);
const validPrivateKey = (value: string) => /^(?:0x)?[a-fA-F0-9]{64}$/.test(value);
const validSignatureType = (value: number) => Number.isInteger(value) && value >= 0 && value <= 3;
const normalizedPrivateKey = (value: string) => (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;

const floorPriceToTick = (price: number, tickSize: string) => {
  const tick = Number(tickSize);
  if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return null;
  const decimals = tickSize.includes(".") ? tickSize.split(".")[1].length : 0;
  const rounded = Math.floor((price + tick * 1e-9) / tick) * tick;
  return Number(rounded.toFixed(decimals));
};

const ceilPriceToTick = (price: number, tickSize: string) => {
  const tick = Number(tickSize);
  if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return null;
  const decimals = tickSize.includes(".") ? tickSize.split(".")[1].length : 0;
  const rounded = Math.ceil((price - tick * 1e-9) / tick) * tick;
  return Number(rounded.toFixed(decimals));
};

const reserveLiveEntry = (userId: string, requestId: string, marketId: string) => {
  const now = Date.now();
  for (const [key, timestamp] of recentExecutionKeys) if (now - timestamp > EXECUTION_COOLDOWN_MS * 4) recentExecutionKeys.delete(key);
  for (const [key, timestamp] of recentLiveEntryMarketKeys) if (now - timestamp > EXECUTION_COOLDOWN_MS * 4) recentLiveEntryMarketKeys.delete(key);

  const requestKey = `${userId}:${requestId}`;
  const marketKey = `${userId}:entry-market:${marketId}`;
  const accountKey = `${userId}:live-order-global`;
  const previousRequest = recentExecutionKeys.get(requestKey);
  if (previousRequest && now - previousRequest < EXECUTION_COOLDOWN_MS) {
    return { response: { ...pass("This execution request is on cooldown to prevent duplicate orders."), status: "COOLDOWN" } };
  }
  const previousMarket = recentLiveEntryMarketKeys.get(marketKey);
  if (previousMarket && now - previousMarket < EXECUTION_COOLDOWN_MS) {
    return { response: { ...pass("A live entry for this market is on cooldown to prevent duplicate positions."), status: "COOLDOWN" } };
  }
  if (activeLiveEntryKeys.has(requestKey) || activeLiveEntryKeys.has(marketKey) || activeLiveEntryKeys.has(accountKey)) {
    return { response: { ...pass("A live order request for this account is already being checked."), status: "IN_PROGRESS" } };
  }

  const reservation = Symbol("live-entry");
  activeLiveEntryKeys.set(requestKey, reservation);
  activeLiveEntryKeys.set(marketKey, reservation);
  activeLiveEntryKeys.set(accountKey, reservation);
  return {
    response: null,
    markSubmitted: () => {
      const submittedAt = Date.now();
      recentExecutionKeys.set(requestKey, submittedAt);
      recentLiveEntryMarketKeys.set(marketKey, submittedAt);
    },
    release: () => {
      if (activeLiveEntryKeys.get(requestKey) === reservation) activeLiveEntryKeys.delete(requestKey);
      if (activeLiveEntryKeys.get(marketKey) === reservation) activeLiveEntryKeys.delete(marketKey);
      if (activeLiveEntryKeys.get(accountKey) === reservation) activeLiveEntryKeys.delete(accountKey);
    },
  };
};

const reserveLiveExit = (userId: string, requestId: string, tokenID: string) => {
  const now = Date.now();
  const requestKey = `${userId}:${requestId}`;
  const tokenKey = `${userId}:exit-token:${tokenID}`;
  const accountKey = `${userId}:live-order-global`;
  for (const [key, timestamp] of recentExecutionKeys) if (now - timestamp > EXECUTION_COOLDOWN_MS * 4) recentExecutionKeys.delete(key);
  for (const [key, timestamp] of recentLiveExitTokenKeys) if (now - timestamp > EXECUTION_COOLDOWN_MS * 4) recentLiveExitTokenKeys.delete(key);

  if (recentExecutionKeys.has(requestKey) && now - recentExecutionKeys.get(requestKey)! < EXECUTION_COOLDOWN_MS) {
    return { response: { ...pass("This early-exit request is on cooldown to prevent duplicate sells."), status: "COOLDOWN" } };
  }
  if (recentLiveExitTokenKeys.has(tokenKey) && now - recentLiveExitTokenKeys.get(tokenKey)! < EXECUTION_COOLDOWN_MS) {
    return { response: { ...pass("A sell for this outcome token is on cooldown to prevent duplicate exits."), status: "COOLDOWN" } };
  }
  if (activeLiveEntryKeys.has(requestKey) || activeLiveEntryKeys.has(tokenKey) || activeLiveEntryKeys.has(accountKey)) {
    return { response: { ...pass("A live order request for this account is already being checked."), status: "IN_PROGRESS" } };
  }

  const reservation = Symbol("live-exit");
  activeLiveEntryKeys.set(requestKey, reservation);
  activeLiveEntryKeys.set(tokenKey, reservation);
  activeLiveEntryKeys.set(accountKey, reservation);
  return {
    response: null,
    markSubmitted: () => {
      const submittedAt = Date.now();
      recentExecutionKeys.set(requestKey, submittedAt);
      recentLiveExitTokenKeys.set(tokenKey, submittedAt);
    },
    release: () => {
      if (activeLiveEntryKeys.get(requestKey) === reservation) activeLiveEntryKeys.delete(requestKey);
      if (activeLiveEntryKeys.get(tokenKey) === reservation) activeLiveEntryKeys.delete(tokenKey);
      if (activeLiveEntryKeys.get(accountKey) === reservation) activeLiveEntryKeys.delete(accountKey);
    },
  };
};

const errorMessage = (error: unknown) => {
  if (!(error instanceof Error)) return "Polymarket request failed.";
  const code = typeof (error as unknown as { code?: unknown }).code === "string" ? (error as unknown as { code: string }).code : "";
  const messageText = `${code} ${error.message}`.toLowerCase();
  if (messageText.includes("econnreset") || messageText.includes("socket hang up")) return "The Polymarket connection was reset while linking the account. No order was placed. Try again in a few seconds; the app will retry transient upstream failures automatically.";
  if (messageText.includes("etimedout") || messageText.includes("timeout") || messageText.includes("fetch failed")) return "The Polymarket connection timed out while linking the account. No order was placed. Check your network and try again.";
  const message = error.message.replace(/0x[a-fA-F0-9]{40,}/g, "[redacted]").slice(0, 220);
  return message || "Polymarket request failed.";
};

const transientNetworkError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  const cause = error as Error & { code?: unknown; cause?: unknown };
  const nested = cause.cause instanceof Error ? cause.cause.message : typeof cause.cause === "string" ? cause.cause : "";
  const code = typeof cause.code === "string" ? cause.code : "";
  const message = `${code} ${cause.message} ${nested}`.toLowerCase();
  return ["econnreset", "etimedout", "econnrefused", "eai_again", "socket hang up", "fetch failed"].some((marker) => message.includes(marker));
};

const wait = (milliseconds: number) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
const retryTransient = async <T,>(operation: () => Promise<T>, attempts = 3): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!transientNetworkError(error) || attempt === attempts - 1) throw error;
      await wait(250 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Polymarket request failed.");
};

const balanceNumber = (value: unknown): number | null => {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  // Older CLOB responses may expose fixed 6-decimal collateral units; newer
  // responses expose human-readable USDC. Accept both without displaying raw units.
  return numeric >= 1_000_000 ? numeric / 1_000_000 : numeric;
};

const cleanBalance = async (client: ClobClient) => {
  const payload = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return balanceNumber(payload.balance);
};

/** Every wallet position across all pages, with resolved (redeemable) rows flagged. */
const readWalletPositions = (walletAddress: string) => fetchAllWalletPositions((cursor) => retryTransient(async () => {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(positionsUrl(DATA_API, walletAddress, cursor), { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Position data returned ${response.status}.`);
    return await response.json() as unknown;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}));

/**
 * Open positions only. Resolved positions are waiting for redemption: they are
 * not open risk and cannot be sold on the CLOB, so they never block entries or
 * count toward exposure.
 */
const readLivePositions = async (walletAddress: string) => openPositions(await readWalletPositions(walletAddress));

const ensureLiveUser = async (request: Request) => {
  if (isLoopbackRequest(request) && localLiveEnabled()) {
    return { response: null, user: { userId: LOCAL_LIVE_USER_ID, displayName: "Local owner", email: "localhost", fullName: null } };
  }
  const user = await getChatGPTUser();
  if (!user) {
    const error = isLoopbackRequest(request)
      ? "Local live execution is disabled. Set POLYMARKET_LIVE_ALLOW_LOCALHOST=true in .env.local and restart the server."
      : "Sign in with ChatGPT before arming live execution.";
    return { response: json({ ok: false, error }, 401), user: null };
  }
  const ownerId = SESSION_OWNER();
  if (!ownerId) return { response: json({ ok: false, error: "Live execution is not armed for this deployment." }, 503), user: null };
  if (user.userId !== ownerId) return { response: json({ ok: false, error: "This live executor is restricted to its owner account." }, 403), user: null };
  return { response: null, user };
};

const clientFromSession = (session: LiveSession) => {
  const account = privateKeyToAccount(normalizedPrivateKey(session.privateKey));
  const signer = createWalletClient({ account, chain: polygon, transport: http() });
  const creds: ApiKeyCreds = { key: session.apiKey, secret: session.secret, passphrase: session.passphrase };
  return new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer,
    creds,
    signatureType: session.signatureType as SignatureTypeV2,
    funderAddress: session.walletAddress,
    useServerTime: true,
    retryOnError: false,
    throwOnError: true,
  });
};

const sessionFromConnection = async (input: LiveRequest, userId: string) => {
  const walletAddress = text(input.walletAddress);
  const privateKey = text(input.privateKey);
  const signatureType = Number(input.signatureType ?? 3);
  if (!validAddress(walletAddress)) throw new Error("Enter a valid Polymarket wallet address.");
  if (!validPrivateKey(privateKey)) throw new Error("Enter a 64-character hex signer private key.");
  if (!validSignatureType(signatureType)) throw new Error("Signature type must be 0, 1, 2, or 3.");

  const account = privateKeyToAccount(normalizedPrivateKey(privateKey));
  if (signatureType === 0 && account.address.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("Signature type 0 requires the wallet address to match the private-key signer address.");
  }
  const signer = createWalletClient({ account, chain: polygon, transport: http() });
  const bootstrap = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer,
    signatureType: signatureType as SignatureTypeV2,
    funderAddress: walletAddress,
    useServerTime: true,
    retryOnError: false,
    // createOrDeriveApiKey needs API error responses to fall back to deriving an existing key.
    throwOnError: false,
  });
  const rawCreds = await retryTransient(() => bootstrap.createOrDeriveApiKey());
  const apiKey = text((rawCreds as unknown as JsonRecord).key ?? (rawCreds as unknown as JsonRecord).apiKey);
  const secret = text((rawCreds as unknown as JsonRecord).secret);
  const passphrase = text((rawCreds as unknown as JsonRecord).passphrase);
  if (!apiKey || !secret || !passphrase) throw new Error("Polymarket returned an incomplete CLOB credential set.");
  const issuedAt = Date.now();
  const session: LiveSession = { userId, walletAddress, signerAddress: account.address, privateKey, signatureType, apiKey, secret, passphrase, issuedAt, expiresAt: issuedAt + LIVE_SESSION_TTL_SECONDS * 1000 };
  const client = clientFromSession(session);
  const [balance, openOrders] = await Promise.all([retryTransient(() => cleanBalance(client)), retryTransient(() => client.getOpenOrders(undefined, true))]);
  if (balance === null) throw new Error("Polymarket returned no readable collateral balance.");
  return { session, balance, openOrders: openOrders.length };
};

const publicLiveSession = (session: LiveSession, balance: number | null, openOrders: number) => ({
  walletAddress: session.walletAddress,
  signerAddress: session.signerAddress,
  signatureType: session.signatureType,
  balance,
  openOrders,
  expiresAt: session.expiresAt,
});

const pass = (reason: string, extra: JsonRecord = {}) => ({ ok: true, status: "PASS", reason, ...extra });

export async function POST(request: Request) {
  let gate: Awaited<ReturnType<typeof ensureLiveUser>>;
  try {
    gate = await ensureLiveUser(request);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
  if (gate.response || !gate.user) return gate.response ?? json({ ok: false, error: "Live authorization failed." }, 401);
  const secureCookie = !isLoopbackRequest(request);
  let input: LiveRequest;
  try { input = await request.json() as LiveRequest; } catch { return json({ ok: false, error: "Invalid JSON request." }, 400); }

  const action = text(input.action) as LiveAction;
  if (!["connect", "balance", "positions", "execute", "manual-entry", "exit", "manual-exit", "cancel-all", "disconnect"].includes(action)) return json({ ok: false, error: "Unsupported live action." }, 400);
  if (action === "disconnect") return json({ ok: true, status: "DISCONNECTED" }, 200, { "Set-Cookie": clearLiveSessionCookie(secureCookie) });
  if ((action === "execute" || action === "manual-entry" || action === "exit" || action === "manual-exit") && !liveExecutionEnabled()) return json({ ok: false, status: "DISABLED", error: "Live order submissions are disabled. Set POLYMARKET_LIVE_EXECUTION_ENABLED=true only after the live prerequisites are explicitly enabled." }, 503);

  if (action === "connect") {
    // A raw signer key may only be handed to a server on this machine. A hosted
    // deployment would receive the key over the network and hold it (encrypted)
    // in a cookie; use the terminal trader instead.
    if (!(isLoopbackRequest(request) && localLiveEnabled())) {
      return json({ ok: false, error: "Private keys are only accepted by a local server bound to loopback with POLYMARKET_LIVE_ALLOW_LOCALHOST=true. Use the terminal trader (pnpm run live) for live orders." }, 403);
    }
    try {
      const connected = await sessionFromConnection(input, gate.user.userId);
      const token = await sealLiveSession(connected.session);
      if (!token) return json({ ok: false, error: "Secure live session storage is not configured." }, 503);
      return json({ ok: true, status: "CONNECTED", live: publicLiveSession(connected.session, connected.balance, connected.openOrders) }, 200, { "Set-Cookie": liveSessionCookie(token, LIVE_SESSION_TTL_SECONDS, secureCookie) });
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 502);
    }
  }

  const session = await readLiveSession(request, gate.user.userId);
  if (!session) return json({ ok: false, error: "Live session expired. Re-link the account before trading." }, 401, { "Set-Cookie": clearLiveSessionCookie(secureCookie) });
  let client: ClobClient;
  try { client = clientFromSession(session); } catch { return json({ ok: false, error: "The encrypted live session could not be opened. Re-link the account." }, 401, { "Set-Cookie": clearLiveSessionCookie(secureCookie) }); }

  if (action === "balance") {
    try {
      const [balance, openOrders] = await Promise.all([retryTransient(() => cleanBalance(client)), retryTransient(() => client.getOpenOrders(undefined, true))]);
      return json({ ok: true, status: "READY", live: publicLiveSession(session, balance, openOrders.length) });
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 502);
    }
  }

  if (action === "positions") {
    try {
      const walletPositions = await readWalletPositions(session.walletAddress);
      return json({ ok: true, status: "READY", positions: openPositions(walletPositions), redeemablePositions: settledPositions(walletPositions) });
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 502);
    }
  }

  const confirmHeader = request.headers.get("x-polymarket-live-confirm") === "1";
  if (input.confirmLive !== true || !confirmHeader) return json({ ok: false, error: "Live order requests require an explicit confirmation." }, 400);

  if (action === "cancel-all") {
    try {
      const result = await client.cancelAll();
      return json({ ok: true, status: "CANCELLED", result: record(result) });
    } catch (error) {
      return json({ ok: false, error: `Cancel-all failed: ${errorMessage(error)}` }, 502);
    }
  }

  if (action === "exit" || action === "manual-exit") {
    const manualExit = action === "manual-exit";
    const marketId = text(input.marketId);
    const tokenID = text(input.tokenID);
    const requestedShares = finiteNumber(input.amount);
    const risk = enforceLiveExecutionRisk(input.config);
    if (!marketId || !tokenID || requestedShares === null || requestedShares <= 0) return json({ ok: false, error: "A market id, token id, and positive share amount are required for an early exit." }, 400);
    if (!manualExit && !risk.earlyExitEnabled) return json(pass("Model-aware early exits are disabled."));
    const requestId = text(input.requestId) || `exit:${tokenID}:${Math.floor(Date.now() / 5_000)}`;
    const reservation = reserveLiveExit(gate.user.userId, requestId, tokenID);
    if (reservation.response) return json(reservation.response);
    let submissionAttempted = false;
    try {
      const [positions, definitions] = await Promise.all([readLivePositions(session.walletAddress), discoverCryptoMarkets()]);
      const position = positions.find((candidate) => candidate.tokenID === tokenID && candidate.size !== null && candidate.size > 0);
      if (!position || position.size === null) return json(pass("The requested position is no longer open."));
      if (position.averagePrice === null || position.averagePrice <= 0) return json(pass("The position entry price is unavailable, so the safe cashout check cannot run."));
      const definition = definitions.find((candidate) => candidate.id === marketId && (candidate.upTokenId === tokenID || candidate.downTokenId === tokenID));
      if (!definition) return json(pass("Market is no longer in the active validated 5m/15m crypto set."));
      if (!risk.allowedDurations.includes(definition.duration)) return json(pass(`${definition.duration} is disabled in the live duration filter.`));
      const side = definition.upTokenId === tokenID ? "UP" : "DOWN";
      const [books, spots, histories] = await Promise.all([
        fetchOrderBooks([definition.upTokenId, definition.downTokenId]),
        fetchSpotPrices([definition.asset]),
        fetchCandleHistories([definition.asset]),
      ]);
      const now = Date.now();
      let market = buildLiveMarket(definition, books, spots, null, now, histories.get(definition.asset) ?? null);
      let modelDataAvailable = false;
      if (!manualExit) {
        const ticks = definition.priceFeed === "UNSUPPORTED" || definition.startTime === null ? [] : await readPolymarketPriceTicks([{ asset: definition.asset, priceFeed: definition.priceFeed, startTime: definition.startTime }]);
        market = applyPolymarketPriceTicks(market, ticks, Date.now());
        modelDataAvailable = marketDataFreshnessIssue(market) === null;
      }
      const currentPrice = side === "UP" ? market.upBid : market.downBid;
      const fairUp = manualExit ? null : anchoredFairUp(market);
      const fairProbability = fairUp === null ? null : side === "UP" ? fairUp : 1 - fairUp;
      const positionBook = side === "UP" ? market.upBook : market.downBook;
      const marketNow = synchronizedPolymarketTime(now);
      const positionBookIsFresh = Boolean(positionBook && positionBook.timestamp !== null
        && positionBook.timestamp <= marketNow + 30_000 && marketNow - positionBook.timestamp <= 60_000
        && positionBook.bids.some((level) => level.price > 0 && level.price < 1 && level.size > 0));
      if (!manualExit && (!market.startTimeVerified || market.startTime === null || market.startTime > marketNow + 1_000
        || market.remaining < risk.earlyExitStopLossMinRemainingSeconds || !positionBookIsFresh)) {
        return json(pass("Automatic early exit requires a verified active market and a fresh executable bid."));
      }
      if (currentPrice === null || (!manualExit && fairProbability === null && !positionBookIsFresh)) return json(pass("Current executable bid or safe exit quote is unavailable."));
      const shares = Math.min(requestedShares, position.size);
      const evaluation = manualExit ? null : evaluateModelAwareExit({ policy: risk, entryPrice: position.averagePrice, currentPrice,
        fairProbability: fairProbability ?? 0.5, modelDataAvailable, shares, feeRate: risk.feeRate, remainingSeconds: market.remaining });
      if (evaluation && !evaluation.shouldExit) return json(pass(evaluation.reason, { evaluation, market: { id: market.id, asset: market.asset, duration: market.duration, remaining: market.remaining } }));
      const openOrders = await client.getOpenOrders({ asset_id: tokenID }, true);
      if (openOrders.length) return json(pass("An open order already exists for this position; the early exit was not submitted.", { openOrders: openOrders.length }));
      const orderBook = await retryTransient(() => client.getOrderBook(tokenID));
      const tickSize = text(orderBook.tick_size);
      if (!VALID_TICK_SIZES.has(tickSize)) return json(pass("The CLOB returned an unsupported tick size; the early exit was not submitted."));
      const clobTickSize = tickSize as "0.1" | "0.01" | "0.005" | "0.0025" | "0.001" | "0.0001";
      const bestBid = (Array.isArray(orderBook.bids) ? orderBook.bids : [])
        .map((level) => finiteNumber(record(level).price))
        .filter((price): price is number => price !== null && price > 0 && price < 1)
        .sort((left, right) => right - left)[0] ?? null;
      if (bestBid === null) return json(pass("The CLOB has no readable executable bid; the early exit was not submitted."));
      const slippageFloor = ceilPriceToTick(bestBid * (1 - risk.slippageBps / 10_000), clobTickSize);
      const userMinimumPrice = finiteNumber(input.minimumPrice);
      const requestedFloor = manualExit && userMinimumPrice !== null ? Math.max(slippageFloor ?? 0, ceilPriceToTick(userMinimumPrice, clobTickSize) ?? 0) : slippageFloor;
      const minimumExecutionPrice = requestedFloor;
      if (minimumExecutionPrice === null || minimumExecutionPrice > bestBid || minimumExecutionPrice <= 0) {
        return json(pass("The current bid cannot satisfy the configured exit slippage bound; the early exit was not submitted.", { bestBid, minimumExecutionPrice }));
      }
      const startedAt = Date.now();
      // Never retry an order submission after a transport reset: the exchange
      // may have accepted it even when the response was lost.
      reservation.markSubmitted();
      submissionAttempted = true;
      const response = await client.createAndPostMarketOrder({ tokenID, amount: shares, side: Side.SELL, price: minimumExecutionPrice, orderType: OrderType.FAK }, { tickSize: clobTickSize, negRisk: Boolean(orderBook.neg_risk) }, OrderType.FAK);
      const afterBalance = await retryTransient(() => cleanBalance(client)).catch(() => null);
      return json({
        ok: true,
        status: response.success ? "EXECUTED" : "REJECTED",
        latencyMs: Date.now() - startedAt,
        balanceAfter: afterBalance,
        market: { id: market.id, asset: market.asset, duration: market.duration, question: market.question, remaining: market.remaining, tokenID, side },
        evaluation,
        executionGuard: { bestBid, minimumExecutionPrice, slippageBps: risk.slippageBps },
        sizing: evaluation ? { shares, netProfit: evaluation.netProfit, modelGap: evaluation.modelGap } : { shares },
        order: { success: response.success, orderID: response.orderID, status: response.status, errorMsg: response.errorMsg, makingAmount: response.makingAmount, takingAmount: response.takingAmount, transactionsHashes: response.transactionsHashes ?? [], tradeIDs: response.tradeIDs ?? [] },
        manual: manualExit,
      });
    } catch (error) {
      if (submissionAttempted) return json({ ok: false, uncertain: true, error: `Early-exit state is uncertain; reconcile the account before retrying. ${errorMessage(error)}` }, 502);
      return json({ ok: false, uncertain: false, error: `Early-exit preflight failed; no sell was submitted. ${errorMessage(error)}` }, 502);
    } finally {
      reservation.release();
    }
  }

  const manualEntry = action === "manual-entry";
  const marketId = text(input.marketId);
  if (!marketId) return json({ ok: false, error: "A market id is required for execution." }, 400);
  const requestedManualSide = text(input.side).toUpperCase();
  const manualSide = manualEntry && (requestedManualSide === "UP" || requestedManualSide === "DOWN") ? requestedManualSide as "UP" | "DOWN" : null;
  if (manualEntry && !manualSide) return json({ ok: false, error: "Choose UP or DOWN for the manual entry." }, 400);
  const requestedManualStake = manualEntry ? finiteNumber(input.stakeUsd) : null;
  if (manualEntry && (requestedManualStake === null || requestedManualStake < 1)) return json({ ok: false, error: "Manual live entries must be at least $1." }, 400);
  const risk = enforceLiveExecutionRisk(input.config);
  const requestId = text(input.requestId) || `${marketId}:${Math.floor(Date.now() / 5_000)}`;
  const reservation = reserveLiveEntry(gate.user.userId, requestId, marketId);
  if (reservation.response) return json(reservation.response);
  let submissionAttempted = false;

  try {
    const [balance, definitions, positions] = await Promise.all([
      cleanBalance(client),
      discoverCryptoMarkets(),
      readLivePositions(session.walletAddress),
    ]);
    if (balance === null || balance < 1) return json(pass("Available collateral is below the $1 live-order minimum.", { balance }));
    const definition = definitions.find((candidate) => candidate.id === marketId);
    if (!definition) return json(pass("Market is no longer in the active validated 5m/15m crypto set."));
    if (!risk.allowedDurations.includes(definition.duration)) return json(pass(`${definition.duration} is disabled in the live duration filter.`));

    const marketTokenIds = new Set([definition.upTokenId, definition.downTokenId]);
    const normalizedConditionId = definition.conditionId?.toLowerCase() ?? null;
    const normalizedSlug = definition.slug.toLowerCase();
    const existingMarketPosition = positions.find((position) =>
      (position.tokenID !== null && marketTokenIds.has(position.tokenID))
      || (normalizedConditionId !== null && position.conditionId?.toLowerCase() === normalizedConditionId)
      || (position.slug !== null && position.slug.toLowerCase() === normalizedSlug),
    );
    if (existingMarketPosition) return json(pass("An open position already exists in this market; live entries are limited to one position per market.", { position: existingMarketPosition }));

    const [books, spots, histories] = await Promise.all([
      fetchOrderBooks([definition.upTokenId, definition.downTokenId]),
      fetchSpotPrices([definition.asset]),
      fetchCandleHistories([definition.asset]),
    ]);
    const now = Date.now();
    const baseMarket = buildLiveMarket(definition, books, spots, null, now, histories.get(definition.asset) ?? null);
    const oracleTicks = definition.priceFeed === "UNSUPPORTED" || definition.startTime === null ? [] : await readPolymarketPriceTicks([{ asset: definition.asset, priceFeed: definition.priceFeed, startTime: definition.startTime }]);
    const market = applyPolymarketPriceTicks(baseMarket, oracleTicks, Date.now());
    if (market.remaining < MIN_LIVE_REMAINING_SECONDS) return json(pass("Too little time remains for a fresh live entry.", { remaining: market.remaining }));
    const manualBudget = requestedManualStake ?? Math.min(risk.maxTradeUsd, balance);
    const signal = analyzeMarketSignal(market, { feeRate: risk.feeRate, slippageBps: risk.slippageBps }, manualEntry ? manualBudget : Math.min(risk.maxTradeUsd, balance), risk.minEdge, Date.now());
    const selectedSide = manualEntry ? manualSide : signal.action === "PASS" ? null : signal.action;
    const manualQuote = manualEntry && selectedSide ? estimateSidePrice(market, selectedSide, { feeRate: risk.feeRate, slippageBps: risk.slippageBps }, manualBudget, signal.fairUp) : null;
    const selectedProbability = selectedSide === null || signal.fairUp === null ? null : selectedSide === "UP" ? signal.fairUp : 1 - signal.fairUp;
    const selectedCostPerShare = manualEntry ? manualQuote?.costPerShare ?? null : signal.executableCostProbability;
    const selectedEdge = manualEntry ? manualQuote?.netEdge ?? null : signal.edge;
    const selectedEntryPrice = manualEntry ? manualQuote?.averagePrice ?? null : signal.entryPrice;
    if (manualEntry) {
      const freshnessIssue = marketDataFreshnessIssue(market, Date.now());
      if (freshnessIssue) return json(pass(`Manual order blocked: ${freshnessIssue}`, { signal, balance }));
      if (selectedProbability === null || selectedCostPerShare === null || selectedEdge === null || selectedEntryPrice === null || !manualQuote?.fill) {
        return json(pass("The selected side does not have a complete executable quote at that size.", { signal, balance, side: selectedSide, quote: manualQuote }));
      }
      if (selectedEdge < risk.minEdge) return json(pass(`The selected ${selectedSide} net edge is ${Math.round(selectedEdge * 1000) / 10}%, below the server minimum of ${Math.round(risk.minEdge * 1000) / 10}%.`, { signal, balance, side: selectedSide, quote: manualQuote }));
    } else {
      if (signal.action === "PASS" || selectedProbability === null || selectedEntryPrice === null || signal.edge === null || selectedCostPerShare === null) return json(pass(signal.reason, { signal, balance, market: { id: market.id, asset: market.asset, duration: market.duration, remaining: market.remaining } }));
      if (risk.requireLock && signal.tier !== "LOCK") return json(pass("Live execution requires a LOCK signal under the current risk policy.", { signal, balance }));
    }

    const sizing = computeKellySizing(selectedProbability!, selectedCostPerShare!, balance, risk);
    if (manualEntry && requestedManualStake! > sizing.stakeUsd + 1e-8) {
      return json(pass(`The selected stake exceeds the current model or bankroll cap of ${dollars(sizing.stakeUsd)}. Lower the manual size to continue.`, { signal, sizing, balance, side: selectedSide, quote: manualQuote }));
    }
    if (!sizing.approved) return json(pass(sizing.reason, { signal, sizing, balance }));
    const tokenID = selectedSide === "UP" ? definition.upTokenId : definition.downTokenId;
    const existingExposureUsd = positions.reduce((total, position) => total + position.exposureUsd, 0);
    const exposure = assessLiveExposure(balance, existingExposureUsd, sizing.stakeUsd, risk);
    if (!exposure.approved) return json(pass(exposure.reason, { signal, sizing, exposure, balance }));

    const openOrders = await client.getOpenOrders(undefined, true);
    if (openOrders.length) return json(pass("An open order already exists in this account; cancel or reconcile it before a new live entry.", { signal, sizing, exposure, balance, openOrders: openOrders.length }));
    const orderBook = await client.getOrderBook(tokenID);
    const tickSize = text(orderBook.tick_size);
    if (!VALID_TICK_SIZES.has(tickSize)) return json(pass("The CLOB returned an unsupported tick size; the live order was not submitted.", { signal, sizing, exposure }));
    const clobTickSize = tickSize as "0.1" | "0.01" | "0.005" | "0.0025" | "0.001" | "0.0001";
    const bestAsk = (Array.isArray(orderBook.asks) ? orderBook.asks : [])
      .map((level) => finiteNumber(record(level).price))
      .filter((price): price is number => price !== null && price > 0 && price < 1)
      .sort((left, right) => left - right)[0] ?? null;
    if (bestAsk === null) return json(pass("The CLOB has no readable executable ask; the live order was not submitted.", { signal, sizing, exposure }));
    const slippageCeiling = bestAsk * (1 + risk.slippageBps / 10_000);
    const maximumExecutionPrice = floorPriceToTick(Math.min(selectedEntryPrice!, slippageCeiling), clobTickSize);
    if (maximumExecutionPrice === null || maximumExecutionPrice < bestAsk || maximumExecutionPrice >= 1) {
      return json(pass("The current ask exceeds the model price or configured slippage bound; the live order was not submitted.", { signal, sizing, exposure, bestAsk, maximumExecutionPrice }));
    }

    const startedAt = Date.now();
    reservation.markSubmitted();
    submissionAttempted = true;
    const response = await client.createAndPostMarketOrder({ tokenID, amount: sizing.stakeUsd, side: Side.BUY, price: maximumExecutionPrice, orderType: OrderType.FAK, userUSDCBalance: balance }, { tickSize: clobTickSize, negRisk: Boolean(orderBook.neg_risk) }, OrderType.FAK);
    const afterBalance = await cleanBalance(client).catch(() => null);
    return json({
      ok: true,
      status: response.success ? "EXECUTED" : "REJECTED",
      latencyMs: Date.now() - startedAt,
      balanceBefore: balance,
      balanceAfter: afterBalance,
      market: { id: market.id, asset: market.asset, duration: market.duration, question: market.question, remaining: market.remaining, tokenID, side: selectedSide },
      signal,
      sizing,
      exposure,
      manual: manualEntry,
      quote: manualQuote,
      executionGuard: { bestAsk, maximumExecutionPrice, slippageBps: risk.slippageBps },
      order: { success: response.success, orderID: response.orderID, status: response.status, errorMsg: response.errorMsg, makingAmount: response.makingAmount, takingAmount: response.takingAmount, transactionsHashes: response.transactionsHashes ?? [], tradeIDs: response.tradeIDs ?? [] },
    });
  } catch (error) {
    if (submissionAttempted) {
      // Keep the cooldown after an unknown submission outcome; retrying a timed-out
      // order can create a duplicate position. Reconcile the account before retrying.
      return json({ ok: false, uncertain: true, error: `Execution state is uncertain; reconcile the account before retrying. ${errorMessage(error)}` }, 502);
    }
    return json({ ok: false, uncertain: false, error: `Live entry preflight failed; no order was submitted. ${errorMessage(error)}` }, 502);
  } finally {
    reservation.release();
  }
}
