import { getChatGPTUser } from "../../../chatgpt-auth";
import { parseCollateralBalance } from "../../../lib/live-risk";
import { isLoopbackRequest, LOCAL_LIVE_USER_ID, localLiveEnabled, readLiveSession, type LiveSession } from "../../../lib/polymarket-session";

const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const REQUEST_TIMEOUT_MS = 12_000;

// Public wallet reads need only an address. Authenticated CLOB reads use the
// owner's sealed live session; private keys and raw API secrets are never
// accepted in this request body.
type AccountRequest = { walletAddress?: unknown };

type JsonRecord = Record<string, unknown>;
type ClobCredentials = { signerAddress: string; apiKey: string; secret: string; passphrase: string };

class UpstreamError extends Error {
  constructor(
    public readonly source: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: responseHeaders });

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const number = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const epochMs = (value: unknown): number | null => {
  const numeric = number(value);
  if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const record = (value: unknown): JsonRecord => (value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {});

const arrayFrom = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.filter((item): item is JsonRecord => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const source = record(value);
  const data = source.data ?? source.items ?? source.results ?? source.points;
  if (!Array.isArray(data) && data && typeof data === "object") {
    const nested = record(data);
    const nestedArray = nested.items ?? nested.results ?? nested.points;
    return Array.isArray(nestedArray)
      ? nestedArray.filter((item): item is JsonRecord => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      : [];
  }
  return Array.isArray(data) ? data.filter((item): item is JsonRecord => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
};

const dataFrom = (value: unknown): unknown => {
  const source = record(value);
  return source.data === undefined ? value : source.data;
};

const fetchJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  const timeoutController = new AbortController();
  const timeoutId = globalThis.setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const upstreamSignal = init?.signal;
  const abortRequest = () => timeoutController.abort();
  if (upstreamSignal?.aborted) timeoutController.abort();
  else upstreamSignal?.addEventListener("abort", abortRequest, { once: true });

  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: timeoutController.signal });
    const body = await response.text();
    let payload: unknown = null;
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const upstreamMessage = text(record(payload).error || record(payload).message);
      throw new UpstreamError(new URL(url).hostname, response.status, upstreamMessage || `${response.status} ${response.statusText}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (timeoutController.signal.aborted && !upstreamSignal?.aborted)
      throw new UpstreamError(new URL(url).hostname, 504, `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortRequest);
  }
};

const base64Bytes = (value: string): Uint8Array => {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(normalized);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const urlSafeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
};

const hmacSignature = async (secret: string, timestamp: string, method: string, path: string, body = "") => {
  const secretBytes = base64Bytes(secret);
  const keyBytes = new ArrayBuffer(secretBytes.byteLength);
  new Uint8Array(keyBytes).set(secretBytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}${method}${path}${body}`));
  return urlSafeBase64(new Uint8Array(signature));
};

const authenticatedGet = async (path: string, credentials: { signerAddress: string; apiKey: string; secret: string; passphrase: string }, query = "") => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacSignature(credentials.secret, timestamp, "GET", path);
  return fetchJson(`${CLOB_API}${path}${query}`, {
    headers: {
      POLY_ADDRESS: credentials.signerAddress,
      POLY_API_KEY: credentials.apiKey,
      POLY_PASSPHRASE: credentials.passphrase,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: timestamp,
    },
  });
};

const validAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);
const safeText = (source: JsonRecord, ...keys: string[]) => {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
};

const readCollateralBalance = async (credentials: ClobCredentials, preferredType: string): Promise<number | null> => {
  const signatureTypes = [...new Set([preferredType, "3", "0", "1", "2"])];
  let lastError: unknown = null;
  for (const signatureType of signatureTypes) {
    try {
      const payload = await authenticatedGet("/balance-allowance", credentials, `?asset_type=COLLATERAL&signature_type=${signatureType}`);
      const source = record(dataFrom(payload));
      const balance = parseCollateralBalance(source.balance);
      if (balance !== null) return balance;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
};

const publicPosition = (source: JsonRecord) => ({
  id:
    safeText(source, "asset", "asset_id", "token_id", "conditionId", "condition_id") ??
    [safeText(source, "title", "question"), safeText(source, "outcome", "name")].filter(Boolean).join(":"),
  title: safeText(source, "title", "question") ?? "Untitled market",
  slug: safeText(source, "slug", "eventSlug", "event_slug"),
  outcome: safeText(source, "outcome", "name") ?? "—",
  size: number(source.current_size ?? source.size ?? source.total_size),
  averagePrice: number(source.avgPrice ?? source.avg_price ?? source.average_price),
  currentPrice: number(source.curPrice ?? source.currentPrice ?? source.current_price),
  currentValue: number(source.currentValue ?? source.current_value),
  unrealizedPnl: number(source.cashPnl ?? source.cash_pnl ?? source.unrealizedPnl ?? source.unrealized_pnl),
  realizedPnl: number(source.realizedPnl ?? source.realized_pnl),
  percentPnl: number(source.percentPnl ?? source.percent_pnl),
  status: safeText(source, "status") ?? "OPEN",
  lastEventAt: epochMs(source.last_event_at ?? source.lastEventAt ?? source.endDate),
});

const publicTrade = (source: JsonRecord) => ({
  id:
    safeText(source, "id", "transaction_hash", "transactionHash") ??
    [source.timestamp, source.match_time, safeText(source, "title", "question"), safeText(source, "side"), source.price, source.shares ?? source.size]
      .map(String)
      .join(":"),
  timestamp: epochMs(source.timestamp ?? source.match_time ?? source.matched_at ?? source.last_update),
  title: safeText(source, "title", "question") ?? "Untitled market",
  slug: safeText(source, "slug", "event_slug"),
  side: safeText(source, "side") ?? "—",
  outcome: safeText(source, "outcome") ?? "—",
  price: number(source.price),
  shares: number(source.shares ?? source.size),
  amount: number(source.amount ?? source.usdcSize ?? source.usdc_size),
  status: safeText(source, "status", "type") ?? "TRADE",
  transactionHash: safeText(source, "transaction_hash", "transactionHash"),
});

const dedupe = <T extends { id: string }>(items: T[]) => [...new Map(items.map((item) => [item.id, item])).values()];

export async function POST(request: Request) {
  let input: AccountRequest;
  try {
    input = (await request.json()) as AccountRequest;
  } catch {
    return json({ ok: false, error: "Invalid JSON request." }, 400);
  }

  const walletAddress = text(input.walletAddress);
  if (!validAddress(walletAddress)) return json({ ok: false, error: "Enter the Polymarket account wallet address (0x followed by 40 hex characters)." }, 400);
  const sessionUserId = isLoopbackRequest(request) && localLiveEnabled() ? LOCAL_LIVE_USER_ID : ((await getChatGPTUser())?.userId ?? null);
  const liveSession: LiveSession | null = sessionUserId ? await readLiveSession(request, sessionUserId) : null;
  if (liveSession && liveSession.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    return json({ ok: false, error: "The requested wallet does not match the active live session. Disconnect and link the intended wallet." }, 409);
  }
  const signatureType = liveSession ? String(liveSession.signatureType) : "3";

  const publicWarnings: string[] = [];
  const [valueResult, positionsResult, activityResult, pnlResult, statsResult] = await Promise.allSettled([
    fetchJson(`${DATA_API}/v2/value?user=${encodeURIComponent(walletAddress)}`),
    fetchJson(`${DATA_API}/v2/positions?user=${encodeURIComponent(walletAddress)}&limit=100`),
    fetchJson(`${DATA_API}/v2/activity?user=${encodeURIComponent(walletAddress)}&limit=100`),
    fetchJson(`${DATA_API}/v2/user-pnl?user=${encodeURIComponent(walletAddress)}&interval=1d&fidelity=1h`),
    fetchJson(`${DATA_API}/v2/user-stats?user=${encodeURIComponent(walletAddress)}`),
  ]);

  const valuePayload = valueResult.status === "fulfilled" ? record(dataFrom(valueResult.value)) : null;
  if (!valuePayload) publicWarnings.push("Portfolio value could not be loaded.");
  const positions = positionsResult.status === "fulfilled" ? arrayFrom(positionsResult.value).map(publicPosition) : [];
  if (positionsResult.status === "rejected") publicWarnings.push("Open positions could not be loaded.");
  const activity = activityResult.status === "fulfilled" ? arrayFrom(activityResult.value) : [];
  if (activityResult.status === "rejected") publicWarnings.push("Public activity could not be loaded.");
  const activityTrades = activity.filter((item) => text(item.type).toUpperCase() === "TRADE").map(publicTrade);
  const pnlPoints = pnlResult.status === "fulfilled" ? arrayFrom(dataFrom(pnlResult.value)) : [];
  if (pnlResult.status === "rejected") publicWarnings.push("P&L history could not be loaded.");
  const statsPayload = statsResult.status === "fulfilled" ? record(dataFrom(statsResult.value)) : null;
  if (statsResult.status === "rejected") publicWarnings.push("Account statistics could not be loaded.");

  const privateWarnings: string[] = [];
  const credentials: ClobCredentials | null = liveSession
    ? { signerAddress: liveSession.signerAddress, apiKey: liveSession.apiKey, secret: liveSession.secret, passphrase: liveSession.passphrase }
    : null;
  const authenticated = credentials !== null;
  let cashBalance: number | null = null;
  let openOrders: JsonRecord[] = [];
  let privateTrades: ReturnType<typeof publicTrade>[] = [];

  if (credentials) {
    const [balanceResult, ordersResult, tradesResult] = await Promise.allSettled([
      readCollateralBalance(credentials, signatureType),
      authenticatedGet("/data/orders", credentials),
      authenticatedGet("/data/trades", credentials),
    ]);
    if (balanceResult.status === "fulfilled") {
      cashBalance = balanceResult.value;
      if (cashBalance === null) privateWarnings.push("CLOB returned no readable collateral balance.");
    } else privateWarnings.push("Authenticated cash balance could not be loaded. Check that the signer key controls this Polymarket account.");
    if (ordersResult.status === "fulfilled") openOrders = arrayFrom(ordersResult.value);
    else privateWarnings.push("Authenticated open orders could not be loaded.");
    if (tradesResult.status === "fulfilled") privateTrades = arrayFrom(tradesResult.value).map(publicTrade);
    else privateWarnings.push("Authenticated CLOB trades could not be loaded; showing public wallet activity when available.");
  }

  const latestPnl =
    pnlPoints
      .map((point) => number(point.pnl ?? point.value ?? point.amount))
      .filter((value): value is number => value !== null)
      .at(-1) ?? null;
  const portfolioValue = number(valuePayload?.value ?? valuePayload?.portfolio_value ?? valuePayload?.portfolioValue);
  const trades = dedupe([...privateTrades, ...activityTrades])
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))
    .slice(0, 100);
  const warnings = [...publicWarnings, ...privateWarnings];

  return json({
    ok: true,
    account: {
      walletAddress,
      authenticated,
      portfolioValue,
      cashBalance,
      openPositions: positions,
      openOrders: openOrders.map((order) => ({
        id:
          safeText(order, "id", "order_id") ??
          [safeText(order, "side"), order.price, order.original_size ?? order.size, order.created_at ?? order.createdAt].map(String).join(":"),
        side: safeText(order, "side") ?? "—",
        price: number(order.price),
        size: number(order.original_size ?? order.size),
        matched: number(order.size_matched ?? order.sizeMatched),
        status: safeText(order, "status") ?? "LIVE",
        createdAt: epochMs(order.created_at ?? order.createdAt),
      })),
      recentTrades: trades,
      pnl: latestPnl,
      tradedMarketCount: number(
        statsPayload?.tradedMarketCount ??
          statsPayload?.traded_market_count ??
          statsPayload?.marketsTraded ??
          statsPayload?.markets_traded ??
          statsPayload?.traded ??
          statsPayload?.trades,
      ),
      fetchedAt: Date.now(),
      warnings,
    },
  });
}
