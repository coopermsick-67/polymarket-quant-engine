import { AssetType, Chain, ClobClient, OrderType, Side as ClobSide, SignatureTypeV2, type ApiKeyCreds, type TickSize } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { z } from "zod";
import { getChatGPTUser } from "../../../chatgpt-auth";
import type { DerivedFeed } from "../../../lib/feeds";
import {
  checkPortfolioRisk,
  computeKellySizing,
  equityOf,
  normalizeLiveRiskConfig,
  parseCollateralBalance,
  parseLivePosition,
  type DayState,
  type LivePosition,
} from "../../../lib/live-risk";
import { round } from "../../../lib/num";
import {
  buildLiveMarket,
  fetchExchangeSpots,
  fetchMarketById,
  fetchOfficialPrice,
  fetchOrderBooks,
  officialKey,
  snapshotFromLiveMarket,
  tokenFor,
  type MarketDefinition,
} from "../../../lib/polymarket-data";
import {
  clearLiveSessionCookie,
  cookie,
  isLoopbackRequest,
  LIVE_DAY_COOKIE,
  LIVE_DAY_TTL_SECONDS,
  LIVE_SESSION_TTL_SECONDS,
  liveSessionCookie,
  LOCAL_LIVE_USER_ID,
  localLiveEnabled,
  openJson,
  readCookie,
  readLiveSession,
  sealJson,
  sealLiveSession,
  serverSigner,
  type LiveSession,
} from "../../../lib/polymarket-session";
import { tradingDayKey } from "../../../lib/engines";
import { evaluateExit, evaluateSignal } from "../../../lib/signal";
import { env } from "cloudflare:workers";

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
/** Max disagreement between the browser's feed and the server's own exchange check. */
const MAX_CLIENT_FEED_DIVERGENCE_BPS = 60;
const recentRequestKeys = new Map<string, number>();

const headers = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const json = (body: unknown, status = 200, setCookies: string[] = []) => {
  const response = new Response(JSON.stringify(body), { status, headers });
  for (const value of setCookies) response.headers.append("Set-Cookie", value);
  return response;
};
const pass = (reason: string, extra: Record<string, unknown> = {}) => ({ ok: true, status: "PASS", reason, ...extra });

const feedSchema = z.object({
  clientNow: z.number(),
  spot: z.number().positive(),
  spotTimestamp: z.number(),
  spotSource: z.enum(["ANCHORED", "EXCHANGE", "STREAM"]),
  basisBps: z.number().nullable(),
  sigmaPerSqrtSecond: z.number().positive().max(0.01),
  volSamples: z.number().int().min(0).max(100_000),
  ticks: z.array(z.object({ timestamp: z.number(), price: z.number().positive() })).max(600),
});

const requestSchema = z.object({
  action: z.enum(["status", "connect", "balance", "positions", "execute", "exit", "cancel-all", "disconnect"]),
  useServerKey: z.boolean().optional(),
  walletAddress: z.string().optional(),
  privateKey: z.string().optional(),
  signatureType: z.number().int().min(0).max(3).optional(),
  marketId: z.string().optional(),
  side: z.enum(["UP", "DOWN"]).optional(),
  tokenID: z.string().optional(),
  amount: z.number().positive().optional(),
  requestId: z.string().max(200).optional(),
  confirmLive: z.boolean().optional(),
  feed: feedSchema.optional(),
  config: z.record(z.unknown()).optional(),
});
type LiveRequest = z.infer<typeof requestSchema>;

const errorMessage = (error: unknown) => {
  if (!(error instanceof Error)) return "Polymarket request failed.";
  const lowered = error.message.toLowerCase();
  if (lowered.includes("econnreset") || lowered.includes("socket hang up"))
    return "The Polymarket connection was reset. Reconcile the account before retrying.";
  if (lowered.includes("timeout") || lowered.includes("fetch failed")) return "The Polymarket request timed out. Reconcile the account before retrying.";
  return error.message.replace(/0x[a-fA-F0-9]{40,}/g, "[redacted]").slice(0, 220) || "Polymarket request failed.";
};

const transient = (error: unknown) =>
  error instanceof Error &&
  ["econnreset", "etimedout", "econnrefused", "eai_again", "socket hang up", "fetch failed"].some((marker) => error.message.toLowerCase().includes(marker));
const retryRead = async <T>(operation: () => Promise<T>, attempts = 3): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!transient(error) || attempt >= attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
};

const ensureOwner = async (request: Request) => {
  if (isLoopbackRequest(request) && localLiveEnabled()) return { userId: LOCAL_LIVE_USER_ID, response: null };
  const user = await getChatGPTUser();
  if (!user)
    return {
      userId: null,
      response: json(
        {
          ok: false,
          error: isLoopbackRequest(request)
            ? "Local live execution is disabled. Set POLYMARKET_LIVE_ALLOW_LOCALHOST=true and restart."
            : "Sign in before arming live execution.",
        },
        401,
      ),
    };
  const owner = typeof env.POLYMARKET_LIVE_ALLOWED_USER_ID === "string" ? env.POLYMARKET_LIVE_ALLOWED_USER_ID.trim() : "";
  if (!owner) return { userId: null, response: json({ ok: false, error: "Live execution is not armed for this deployment." }, 503) };
  if (user.userId !== owner) return { userId: null, response: json({ ok: false, error: "This live executor is restricted to its owner account." }, 403) };
  return { userId: user.userId, response: null };
};

const normalizedKey = (value: string) => (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;

const signerFor = (session: Pick<LiveSession, "keySource" | "privateKey">) => {
  const key = session.keySource === "server" ? serverSigner()?.privateKey : session.privateKey;
  if (!key) throw new Error("Signer key unavailable.");
  const account = privateKeyToAccount(normalizedKey(key));
  return { account, wallet: createWalletClient({ account, chain: polygon, transport: http() }) };
};

const clientFor = (session: LiveSession) => {
  const { wallet } = signerFor(session);
  const creds: ApiKeyCreds = { key: session.apiKey, secret: session.secret, passphrase: session.passphrase };
  return new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer: wallet,
    creds,
    signatureType: session.signatureType as SignatureTypeV2,
    funderAddress: session.walletAddress,
    useServerTime: true,
    retryOnError: false,
    throwOnError: true,
  });
};

const readBalance = async (client: ClobClient) => parseCollateralBalance((await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })).balance);

const readPositions = async (walletAddress: string): Promise<LivePosition[]> =>
  retryRead(async () => {
    const response = await fetch(`${DATA_API}/positions?user=${encodeURIComponent(walletAddress)}&sizeThreshold=0.01&limit=200`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Position data returned ${response.status}.`);
    const payload = (await response.json()) as unknown;
    const rows = Array.isArray(payload) ? payload : [];
    return rows.flatMap((row) => {
      const position = row && typeof row === "object" ? parseLivePosition(row as Record<string, unknown>) : null;
      return position ? [position] : [];
    });
  });

const connectSession = async (input: LiveRequest, userId: string) => {
  const server = input.useServerKey ? serverSigner() : null;
  if (input.useServerKey && !server) throw new Error("No server-held signer is configured (POLYMARKET_PRIVATE_KEY / POLYMARKET_WALLET_ADDRESS).");
  const walletAddress = server?.walletAddress ?? (input.walletAddress ?? "").trim();
  const privateKey = server?.privateKey ?? (input.privateKey ?? "").trim();
  const signatureType = server?.signatureType ?? input.signatureType ?? 3;
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) throw new Error("Enter a valid Polymarket wallet address.");
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(privateKey)) throw new Error("Enter a 64-character hex signer private key.");
  const account = privateKeyToAccount(normalizedKey(privateKey));
  if (signatureType === 0 && account.address.toLowerCase() !== walletAddress.toLowerCase())
    throw new Error("Signature type 0 requires the wallet to be the signer address.");
  const bootstrap = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer: createWalletClient({ account, chain: polygon, transport: http() }),
    signatureType: signatureType as SignatureTypeV2,
    funderAddress: walletAddress,
    useServerTime: true,
    retryOnError: false,
    throwOnError: true,
  });
  const raw = (await retryRead(() => bootstrap.createOrDeriveApiKey())) as unknown as Record<string, unknown>;
  const apiKey = String(raw.key ?? raw.apiKey ?? "");
  const secret = String(raw.secret ?? "");
  const passphrase = String(raw.passphrase ?? "");
  if (!apiKey || !secret || !passphrase) throw new Error("Polymarket returned an incomplete CLOB credential set.");
  const issuedAt = Date.now();
  const session: LiveSession = {
    userId,
    keySource: server ? "server" : "browser",
    walletAddress,
    signerAddress: account.address,
    privateKey: server ? null : privateKey,
    signatureType,
    apiKey,
    secret,
    passphrase,
    issuedAt,
    expiresAt: issuedAt + LIVE_SESSION_TTL_SECONDS * 1000,
  };
  const client = clientFor(session);
  const [balance, openOrders] = await Promise.all([retryRead(() => readBalance(client)), retryRead(() => client.getOpenOrders(undefined, true))]);
  if (balance === null) throw new Error("Polymarket returned no readable collateral balance.");
  return { session, balance, openOrders: openOrders.length };
};

const publicSession = (session: LiveSession, balance: number | null, openOrders: number) => ({
  walletAddress: session.walletAddress,
  signerAddress: session.signerAddress,
  signatureType: session.signatureType,
  keySource: session.keySource,
  balance,
  openOrders,
  expiresAt: session.expiresAt,
});

/** Rebase the browser's feed onto server time and sanity-check it against the server's own exchange read. */
const verifiedFeed = async (
  definition: MarketDefinition,
  feed: z.infer<typeof feedSchema>,
  now: number,
): Promise<{ feed: DerivedFeed | null; error: string | null }> => {
  const skew = now - feed.clientNow;
  if (Math.abs(skew) > 30_000) return { feed: null, error: "Browser clock differs from the server by more than 30s." };
  const exchange = (await fetchExchangeSpots([definition.asset])).get(definition.asset) ?? null;
  if (exchange) {
    const divergence = (Math.abs(feed.spot - exchange.price) / exchange.price) * 10_000;
    if (divergence > MAX_CLIENT_FEED_DIVERGENCE_BPS)
      return { feed: null, error: `Browser feed disagrees with the server's exchange check by ${divergence.toFixed(0)}bp.` };
  }
  return {
    error: null,
    feed: {
      asset: definition.asset,
      spot: feed.spot,
      spotTimestamp: feed.spotTimestamp + skew,
      spotSource: exchange ? feed.spotSource : feed.spotSource === "ANCHORED" ? "EXCHANGE" : feed.spotSource,
      ticks: feed.ticks.map((tick) => ({ timestamp: tick.timestamp + skew, price: tick.price })),
      settlementValue: null,
      settlementTimestamp: null,
      basisBps: feed.basisBps,
      exchangeSpot: exchange?.price ?? null,
      exchangeSpotTimestamp: exchange?.timestamp ?? null,
      sigmaPerSqrtSecond: feed.sigmaPerSqrtSecond,
      sigmaSource: "CLIENT",
      volSamples: feed.volSamples,
    },
  };
};

/** Server-side market state: definition, books, and the official price to beat. Nothing here comes from the browser. */
const loadMarket = async (marketId: string, now: number) => {
  const definition = await fetchMarketById(marketId);
  if (!definition) return null;
  const [books, official] = await Promise.all([
    fetchOrderBooks([definition.upTokenId, definition.downTokenId]),
    definition.startTime <= now ? fetchOfficialPrice(definition.asset, definition.startTime, definition.duration).catch(() => null) : Promise.resolve(null),
  ]);
  const officialMap = new Map(official ? [[officialKey(definition), official]] : []);
  return { definition, market: buildLiveMarket(definition, { books, official: officialMap, candles: new Map() }, now) };
};

const readDay = async (request: Request, userId: string, equity: number, now: number): Promise<DayState & { userId: string }> => {
  const stored = await openJson<DayState & { userId: string }>(readCookie(request, LIVE_DAY_COOKIE), LIVE_DAY_COOKIE);
  const dayKey = tradingDayKey(now);
  if (!stored || stored.userId !== userId || stored.dayKey !== dayKey) return { userId, dayKey, startEquity: equity, orders: [] };
  return stored;
};

const dayCookie = async (day: DayState & { userId: string }, secure: boolean) => {
  const token = await sealJson({ ...day, orders: day.orders.slice(-50) }, LIVE_DAY_COOKIE);
  return token ? cookie(LIVE_DAY_COOKIE, token, LIVE_DAY_TTL_SECONDS, secure) : null;
};

const orderSummary = (response: Record<string, unknown>) => ({
  success: response.success === true,
  orderID: response.orderID ?? null,
  status: response.status ?? null,
  errorMsg: response.errorMsg ?? null,
  makingAmount: response.makingAmount ?? null,
  takingAmount: response.takingAmount ?? null,
});

export async function POST(request: Request) {
  const owner = await ensureOwner(request).catch((error) => ({ userId: null, response: json({ ok: false, error: errorMessage(error) }, 502) }));
  if (owner.response || !owner.userId) return owner.response ?? json({ ok: false, error: "Live authorization failed." }, 401);
  const userId = owner.userId;
  const secure = !isLoopbackRequest(request);
  let input: LiveRequest;
  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success)
      return json({ ok: false, error: `Invalid request: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` }, 400);
    input = parsed.data;
  } catch {
    return json({ ok: false, error: "Invalid JSON request." }, 400);
  }

  if (input.action === "status") return json({ ok: true, serverKeyConfigured: serverSigner() !== null });
  if (input.action === "disconnect") return json({ ok: true, status: "DISCONNECTED" }, 200, [clearLiveSessionCookie(secure)]);
  if (input.action === "connect") {
    try {
      const connected = await connectSession(input, userId);
      const token = await sealLiveSession(connected.session);
      if (!token) return json({ ok: false, error: "Secure session storage is not configured (POLYMARKET_LIVE_SESSION_SECRET)." }, 503);
      return json({ ok: true, status: "CONNECTED", live: publicSession(connected.session, connected.balance, connected.openOrders) }, 200, [
        liveSessionCookie(token, LIVE_SESSION_TTL_SECONDS, secure),
      ]);
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 502);
    }
  }

  const session = await readLiveSession(request, userId);
  if (!session) return json({ ok: false, error: "Live session expired. Re-link the account before trading." }, 401, [clearLiveSessionCookie(secure)]);
  let client: ClobClient;
  try {
    client = clientFor(session);
  } catch {
    return json({ ok: false, error: "The live session could not be opened. Re-link the account." }, 401, [clearLiveSessionCookie(secure)]);
  }

  if (input.action === "balance") {
    try {
      const [balance, openOrders] = await Promise.all([retryRead(() => readBalance(client)), retryRead(() => client.getOpenOrders(undefined, true))]);
      return json({ ok: true, status: "READY", live: publicSession(session, balance, openOrders.length) });
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 502);
    }
  }
  if (input.action === "positions") {
    try {
      return json({ ok: true, status: "READY", positions: await readPositions(session.walletAddress) });
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 502);
    }
  }

  if (input.confirmLive !== true || request.headers.get("x-polymarket-live-confirm") !== "1")
    return json({ ok: false, error: "Live order requests require an explicit confirmation." }, 400);

  if (input.action === "cancel-all") {
    try {
      return json({ ok: true, status: "CANCELLED", result: await client.cancelAll() });
    } catch (error) {
      return json({ ok: false, error: `Cancel-all failed: ${errorMessage(error)}` }, 502);
    }
  }

  const config = normalizeLiveRiskConfig(input.config as never);
  const marketId = (input.marketId ?? "").trim();
  if (!marketId || !input.feed) return json({ ok: false, error: "A market id and a price-feed snapshot are required." }, 400);
  const requestKey = `${userId}:${input.requestId || `${input.action}:${marketId}:${Math.floor(Date.now() / 10_000)}`}`;
  const lastAttempt = recentRequestKeys.get(requestKey);
  if (lastAttempt && Date.now() - lastAttempt < 60_000) return json({ ...pass("Duplicate request id within 60s; not resubmitting."), status: "COOLDOWN" });
  for (const [key, at] of recentRequestKeys) if (Date.now() - at > 5 * 60_000) recentRequestKeys.delete(key);

  const now = Date.now();
  try {
    const [loaded, balance, positions] = await Promise.all([
      loadMarket(marketId, now),
      retryRead(() => readBalance(client)),
      readPositions(session.walletAddress),
    ]);
    if (!loaded) return json(pass("Market is not an active 5m/15m crypto Up/Down market."));
    if (balance === null) return json(pass("Collateral balance is unreadable."));
    const { definition, market } = loaded;
    if (!config.allowedDurations.includes(definition.duration)) return json(pass(`${definition.duration} is disabled in the live policy.`));
    if (!config.allowedAssets.includes(definition.asset)) return json(pass(`${definition.asset} is not in the live asset allow-list.`));
    const verified = await verifiedFeed(definition, input.feed, now);
    if (!verified.feed) return json(pass(verified.error ?? "Price feed rejected."));
    const snapshot = snapshotFromLiveMarket(market, verified.feed, now);
    const equity = equityOf(balance, positions);
    const day = await readDay(request, userId, equity, now);

    if (input.action === "exit") {
      const tokenID = (input.tokenID ?? "").trim();
      const side = tokenID === definition.upTokenId ? "UP" : tokenID === definition.downTokenId ? "DOWN" : null;
      const position = positions.find((candidate) => candidate.tokenId === tokenID);
      if (!side || !position) return json(pass("No open position in that outcome token."));
      if (!config.earlyExitEnabled) return json(pass("Model-aware early exits are disabled."));
      const shares = Math.min(input.amount ?? position.size, position.size);
      const exit = evaluateExit({
        snapshot,
        side,
        shares,
        entryCostPerShare: position.averagePrice ?? 1,
        params: config.signal,
        minGap: config.earlyExitModelGap,
        minProfitUsd: config.earlyExitMinProfitUsd,
        minProfitPct: config.earlyExitMinProfitPct,
        minRemainingSeconds: config.earlyExitMinRemainingSeconds,
      });
      if (!exit.shouldExit || exit.limitPrice === null) return json(pass(exit.reason, { exit }));
      recentRequestKeys.set(requestKey, now);
      const startedAt = Date.now();
      // Never retried: a lost response may still have filled on the exchange.
      const response = (await client.createAndPostMarketOrder(
        { tokenID, amount: round(shares, 2), side: ClobSide.SELL, price: exit.limitPrice, orderType: OrderType.FAK },
        { tickSize: String(definition.tickSize) as TickSize, negRisk: definition.negRisk },
        OrderType.FAK,
      )) as unknown as Record<string, unknown>;
      const updated = await dayCookie({ ...day, orders: [...day.orders, { key: requestKey, at: now }] }, secure);
      return json(
        { ok: true, status: response.success === true ? "EXECUTED" : "REJECTED", latencyMs: Date.now() - startedAt, exit, order: orderSummary(response) },
        200,
        updated ? [updated] : [],
      );
    }

    const side = input.side;
    const signal = evaluateSignal(snapshot, { ...config.signal, budgetUsd: Math.min(config.maxTradeUsd, balance) });
    if (signal.action === "PASS" || !signal.chosen?.fill || signal.chosen.limitPrice === null) return json(pass(signal.reason, { gate: signal.gate }));
    if (side && signal.action !== side) return json(pass(`Server re-evaluation now favors ${signal.action}, not ${side}.`));
    if (config.requireLock && signal.tier !== "LOCK") return json(pass("The live policy requires a LOCK-tier signal.", { tier: signal.tier }));
    const chosen = signal.chosen;
    const book = signal.action === "UP" ? snapshot.up : snapshot.down;
    const depthUnderLimit = book.asks.filter((level) => level.price <= chosen.limitPrice! + 1e-9).reduce((sum, level) => sum + level.price * level.size, 0);
    const sizing = computeKellySizing(chosen.conservativeProbability, chosen.fill!.costPerShare, balance, depthUnderLimit, config);
    if (!sizing.approved) return json(pass(sizing.reason, { sizing }));
    const tokenID = tokenFor(definition, signal.action);
    const risk = checkPortfolioRisk({
      config,
      positions,
      balance,
      day,
      now,
      candidate: {
        conditionId: definition.conditionId,
        tokenIds: [definition.upTokenId, definition.downTokenId],
        endTime: definition.endTime,
        side: signal.action,
        stakeUsd: sizing.stakeUsd,
        requestKey,
      },
    });
    if (!risk.approved) return json(pass(risk.reason, { sizing }));

    recentRequestKeys.set(requestKey, now);
    const updated = await dayCookie({ ...day, orders: [...day.orders, { key: requestKey, at: now }] }, secure);
    const startedAt = Date.now();
    // FAK with a limit: fills only at prices that keep the required edge after fees. Never retried.
    const response = (await client.createAndPostMarketOrder(
      { tokenID, amount: sizing.stakeUsd, side: ClobSide.BUY, price: chosen.limitPrice!, orderType: OrderType.FAK, userUSDCBalance: balance },
      { tickSize: String(definition.tickSize) as TickSize, negRisk: definition.negRisk },
      OrderType.FAK,
    )) as unknown as Record<string, unknown>;
    return json(
      {
        ok: true,
        status: response.success === true ? "EXECUTED" : "REJECTED",
        latencyMs: Date.now() - startedAt,
        market: { id: definition.id, asset: definition.asset, duration: definition.duration, side: signal.action, tokenID, remaining: snapshot.endTime - now },
        signal: {
          tier: signal.tier,
          edge: chosen.edge,
          limitPrice: chosen.limitPrice,
          probability: chosen.conservativeProbability,
          costPerShare: chosen.fill!.costPerShare,
          reason: signal.reason,
        },
        sizing,
        balanceBefore: balance,
        order: orderSummary(response),
      },
      200,
      updated ? [updated] : [],
    );
  } catch (error) {
    // Keep the request key: an unknown submission outcome must be reconciled, never blindly retried.
    return json({ ok: false, uncertain: true, error: `Execution state is uncertain; reconcile before retrying. ${errorMessage(error)}` }, 502);
  }
}
