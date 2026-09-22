import { AssetType, Chain, ClobClient, OrderType, Side, SignatureTypeV2, type ApiKeyCreds } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { getChatGPTUser } from "../../../chatgpt-auth";
import {
  buildLiveMarket,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  fetchSpotPrices,
} from "../../../lib/polymarket-data";
import { analyzeMarketSignal } from "../../../lib/engines";
import { evaluateModelAwareExit } from "../../../lib/early-exit";
import { computeKellySizing, normalizeLiveRiskConfig, type LiveRiskConfig } from "../../../lib/live-risk";
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

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const SESSION_OWNER = () => typeof env.POLYMARKET_LIVE_ALLOWED_USER_ID === "string" ? env.POLYMARKET_LIVE_ALLOWED_USER_ID.trim() : "";
const MIN_LIVE_REMAINING_SECONDS = 30;
const EXECUTION_COOLDOWN_MS = 45_000;
const recentExecutionKeys = new Map<string, number>();
const VALID_TICK_SIZES = new Set(["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"]);

type LiveAction = "connect" | "balance" | "positions" | "execute" | "exit" | "cancel-all" | "disconnect";
type LiveRequest = {
  action?: unknown;
  walletAddress?: unknown;
  privateKey?: unknown;
  signatureType?: unknown;
  marketId?: unknown;
  tokenID?: unknown;
  amount?: unknown;
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
const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const arrayFrom = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.filter((item): item is JsonRecord => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const source = record(value);
  const data = source.data ?? source.items ?? source.results ?? source.positions;
  return Array.isArray(data) ? data.filter((item): item is JsonRecord => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
};
const safeText = (source: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
};
const validAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);
const validPrivateKey = (value: string) => /^(?:0x)?[a-fA-F0-9]{64}$/.test(value);
const validSignatureType = (value: number) => Number.isInteger(value) && value >= 0 && value <= 3;
const normalizedPrivateKey = (value: string) => (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;

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

const readLivePositions = async (walletAddress: string) => {
  const payload = await retryTransient(async () => {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${DATA_API}/v2/positions?user=${encodeURIComponent(walletAddress)}&limit=100`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Position data returned ${response.status}.`);
      return await response.json() as unknown;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  });
  return arrayFrom(payload).map((source) => {
    const tokenID = safeText(source, "asset", "asset_id", "token_id");
    const conditionId = safeText(source, "conditionId", "condition_id", "market");
    return {
      id: tokenID ?? conditionId ?? safeText(source, "title", "question") ?? "unknown-position",
      tokenID,
      conditionId,
      title: safeText(source, "title", "question") ?? "Untitled market",
      outcome: safeText(source, "outcome", "name") ?? "—",
      size: finiteNumber(source.current_size ?? source.size ?? source.total_size),
      averagePrice: finiteNumber(source.avgPrice ?? source.avg_price ?? source.average_price),
    };
  }).filter((position) => (position.size ?? 0) > 0);
};

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
    throwOnError: true,
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
  if (!["connect", "balance", "positions", "execute", "exit", "cancel-all", "disconnect"].includes(action)) return json({ ok: false, error: "Unsupported live action." }, 400);
  if (action === "disconnect") return json({ ok: true, status: "DISCONNECTED" }, 200, { "Set-Cookie": clearLiveSessionCookie(secureCookie) });

  if (action === "connect") {
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
      return json({ ok: true, status: "READY", positions: await readLivePositions(session.walletAddress) });
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

  if (action === "exit") {
    const marketId = text(input.marketId);
    const tokenID = text(input.tokenID);
    const requestedShares = finiteNumber(input.amount);
    const risk = normalizeLiveRiskConfig(input.config);
    if (!marketId || !tokenID || requestedShares === null || requestedShares <= 0) return json({ ok: false, error: "A market id, token id, and positive share amount are required for an early exit." }, 400);
    if (!risk.earlyExitEnabled) return json(pass("Model-aware early exits are disabled."));
    const requestId = text(input.requestId) || `exit:${tokenID}:${Math.floor(Date.now() / 5_000)}`;
    const requestKey = `${gate.user.userId}:${requestId}`;
    const previousExecution = recentExecutionKeys.get(requestKey);
    if (previousExecution && Date.now() - previousExecution < EXECUTION_COOLDOWN_MS) return json({ ...pass("This early-exit request is on cooldown to prevent duplicate sells."), status: "COOLDOWN" });
    for (const [key, timestamp] of recentExecutionKeys) if (Date.now() - timestamp > EXECUTION_COOLDOWN_MS * 4) recentExecutionKeys.delete(key);

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
      const market = buildLiveMarket(definition, books, spots, null, Date.now(), histories.get(definition.asset) ?? null);
      const currentPrice = side === "UP" ? market.upBid : market.downBid;
      const fairProbability = side === "UP" ? market.fairUp : market.fairUp === null ? null : 1 - market.fairUp;
      if (currentPrice === null || fairProbability === null) return json(pass("Current executable bid or model fair probability is unavailable."));
      const shares = Math.min(requestedShares, position.size);
      const evaluation = evaluateModelAwareExit({ policy: risk, entryPrice: position.averagePrice, currentPrice, fairProbability, shares, feeRate: risk.feeRate, remainingSeconds: market.remaining });
      if (!evaluation.shouldExit) return json(pass(evaluation.reason, { evaluation, market: { id: market.id, asset: market.asset, duration: market.duration, remaining: market.remaining } }));
      const orderBook = await retryTransient(() => client.getOrderBook(tokenID));
      const tickSize = VALID_TICK_SIZES.has(orderBook.tick_size) ? orderBook.tick_size as "0.1" | "0.01" | "0.005" | "0.0025" | "0.001" | "0.0001" : "0.01";
      recentExecutionKeys.set(requestKey, Date.now());
      const startedAt = Date.now();
      // Never retry an order submission after a transport reset: the exchange
      // may have accepted it even when the response was lost.
      const response = await client.createAndPostMarketOrder({ tokenID, amount: shares, side: Side.SELL, orderType: OrderType.FAK }, { tickSize, negRisk: Boolean(orderBook.neg_risk) }, OrderType.FAK);
      const afterBalance = await retryTransient(() => cleanBalance(client)).catch(() => null);
      return json({
        ok: true,
        status: response.success ? "EXECUTED" : "REJECTED",
        latencyMs: Date.now() - startedAt,
        balanceAfter: afterBalance,
        market: { id: market.id, asset: market.asset, duration: market.duration, question: market.question, remaining: market.remaining, tokenID, side },
        evaluation,
        sizing: { shares, netProfit: evaluation.netProfit, modelGap: evaluation.modelGap },
        order: { success: response.success, orderID: response.orderID, status: response.status, errorMsg: response.errorMsg, makingAmount: response.makingAmount, takingAmount: response.takingAmount, transactionsHashes: response.transactionsHashes ?? [], tradeIDs: response.tradeIDs ?? [] },
      });
    } catch (error) {
      return json({ ok: false, uncertain: true, error: `Early-exit state is uncertain; reconcile the account before retrying. ${errorMessage(error)}` }, 502);
    }
  }

  const marketId = text(input.marketId);
  if (!marketId) return json({ ok: false, error: "A market id is required for execution." }, 400);
  const risk = normalizeLiveRiskConfig(input.config);
  const requestId = text(input.requestId) || `${marketId}:${Math.floor(Date.now() / 5_000)}`;
  const requestKey = `${gate.user.userId}:${requestId}`;
  const previousExecution = recentExecutionKeys.get(requestKey);
  if (previousExecution && Date.now() - previousExecution < EXECUTION_COOLDOWN_MS) return json({ ...pass("This execution request is on cooldown to prevent duplicate orders."), status: "COOLDOWN" });
  for (const [key, timestamp] of recentExecutionKeys) if (Date.now() - timestamp > EXECUTION_COOLDOWN_MS * 4) recentExecutionKeys.delete(key);

  try {
    const balance = await cleanBalance(client);
    if (balance === null || balance < 1) return json(pass("Available collateral is below the $1 live-order minimum.", { balance }));
    const definitions = await discoverCryptoMarkets();
    const definition = definitions.find((candidate) => candidate.id === marketId);
    if (!definition) return json(pass("Market is no longer in the active validated 5m/15m crypto set."));
    if (!risk.allowedDurations.includes(definition.duration)) return json(pass(`${definition.duration} is disabled in the live duration filter.`));

    const [books, spots, histories] = await Promise.all([
      fetchOrderBooks([definition.upTokenId, definition.downTokenId]),
      fetchSpotPrices([definition.asset]),
      fetchCandleHistories([definition.asset]),
    ]);
    const now = Date.now();
    const market = buildLiveMarket(definition, books, spots, null, now, histories.get(definition.asset) ?? null);
    if (market.remaining < MIN_LIVE_REMAINING_SECONDS) return json(pass("Too little time remains for a fresh live entry.", { remaining: market.remaining }));
    const signal = analyzeMarketSignal(market, { feeRate: risk.feeRate, slippageBps: risk.slippageBps }, Math.min(risk.maxTradeUsd, balance), risk.minEdge);
    const probability = signal.action === "UP" ? signal.fairUp : signal.action === "DOWN" && signal.fairUp !== null ? 1 - signal.fairUp : null;
    if (signal.action === "PASS" || probability === null || signal.entryPrice === null || signal.edge === null) return json(pass(signal.reason, { signal, balance, market: { id: market.id, asset: market.asset, duration: market.duration, remaining: market.remaining } }));
    if (risk.requireLock && signal.tier !== "LOCK") return json(pass("Live execution requires a LOCK signal under the current risk policy.", { signal, balance }));

    const sizing = computeKellySizing(probability, signal.entryPrice, balance, risk);
    if (!sizing.approved) return json(pass(sizing.reason, { signal, sizing, balance }));
    const tokenID = signal.action === "UP" ? definition.upTokenId : definition.downTokenId;
    const openOrders = await client.getOpenOrders({ asset_id: tokenID }, true);
    if (openOrders.length) return json(pass("An open order already exists for this outcome token.", { signal, sizing, balance, openOrders: openOrders.length }));
    const orderBook = await client.getOrderBook(tokenID);
    const tickSize = VALID_TICK_SIZES.has(orderBook.tick_size) ? orderBook.tick_size as "0.1" | "0.01" | "0.005" | "0.0025" | "0.001" | "0.0001" : "0.01";

    recentExecutionKeys.set(requestKey, Date.now());
    const startedAt = Date.now();
    const response = await client.createAndPostMarketOrder({ tokenID, amount: sizing.stakeUsd, side: Side.BUY, orderType: OrderType.FAK, userUSDCBalance: balance }, { tickSize, negRisk: Boolean(orderBook.neg_risk) }, OrderType.FAK);
    const afterBalance = await cleanBalance(client).catch(() => null);
    return json({
      ok: true,
      status: response.success ? "EXECUTED" : "REJECTED",
      latencyMs: Date.now() - startedAt,
      balanceBefore: balance,
      balanceAfter: afterBalance,
      market: { id: market.id, asset: market.asset, duration: market.duration, question: market.question, remaining: market.remaining, tokenID, side: signal.action },
      signal,
      sizing,
      order: { success: response.success, orderID: response.orderID, status: response.status, errorMsg: response.errorMsg, makingAmount: response.makingAmount, takingAmount: response.takingAmount, transactionsHashes: response.transactionsHashes ?? [], tradeIDs: response.tradeIDs ?? [] },
    });
  } catch (error) {
    // Keep the cooldown after an unknown submission outcome; retrying a timed-out
    // order can create a duplicate position. Reconcile from the Account tab first.
    return json({ ok: false, uncertain: true, error: `Execution state is uncertain; reconcile the account before retrying. ${errorMessage(error)}` }, 502);
  }
}
