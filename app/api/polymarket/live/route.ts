import { AssetType, Chain, ClobClient, SignatureTypeV2, type ApiKeyCreds } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { getChatGPTUser } from "../../../chatgpt-auth";
import type { LiveRiskConfig } from "../../../lib/live-risk";
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
import { collateralUsdFromRaw } from "../../../lib/collateral";
import { readJsonBody, sameOriginFailure } from "../../../lib/request-guards";
import { assertNoComboPositions, comboPositionsUrl, fetchAllWalletPositions, openPositions, positionsUrl, settledPositions } from "../../../lib/wallet-positions";

const CLOB_HOST = "https://clob.polymarket.com";
const TERMINAL_ONLY_MESSAGE = "Live orders are placed only by the terminal trader (pnpm run live), which journals every order durably and reconciles it against the CLOB and on-chain trade status. The web app can link a local session, read balance and positions, and cancel open orders.";
const DATA_API = "https://data-api.polymarket.com";
const SESSION_OWNER = () => typeof env.POLYMARKET_LIVE_ALLOWED_USER_ID === "string" ? env.POLYMARKET_LIVE_ALLOWED_USER_ID.trim() : "";

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
const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
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


const cleanBalance = async (client: ClobClient) => {
  const payload = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return collateralUsdFromRaw(payload.balance);
};

const readJson = (url: string) => retryTransient(async () => {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Position data returned ${response.status}.`);
    return await response.json() as unknown;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
});

/** Every wallet position across all pages, with resolved (redeemable) rows flagged; combo wallets are refused. */
const readWalletPositions = async (walletAddress: string) => {
  assertNoComboPositions(await readJson(comboPositionsUrl(DATA_API, walletAddress)));
  return fetchAllWalletPositions((cursor) => readJson(positionsUrl(DATA_API, walletAddress, cursor)));
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


export async function POST(request: Request) {
  let gate: Awaited<ReturnType<typeof ensureLiveUser>>;
  try {
    gate = await ensureLiveUser(request);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
  if (gate.response || !gate.user) return gate.response ?? json({ ok: false, error: "Live authorization failed." }, 401);
  const secureCookie = !isLoopbackRequest(request);
  const crossOrigin = sameOriginFailure(request);
  if (crossOrigin) return json({ ok: false, error: crossOrigin.error }, crossOrigin.status);
  const body = await readJsonBody<LiveRequest>(request, 8_192);
  if ("failure" in body) return json({ ok: false, error: body.failure.error }, body.failure.status);
  const input: LiveRequest = body.value && typeof body.value === "object" ? body.value : {};

  const action = text(input.action) as LiveAction;
  if (!["connect", "balance", "positions", "execute", "manual-entry", "exit", "manual-exit", "cancel-all", "disconnect"].includes(action)) return json({ ok: false, error: "Unsupported live action." }, 400);
  if (action === "disconnect") return json({ ok: true, status: "DISCONNECTED" }, 200, { "Set-Cookie": clearLiveSessionCookie(secureCookie) });
  if (action === "execute" || action === "manual-entry" || action === "exit" || action === "manual-exit") {
    return json({ ok: false, status: "TERMINAL_ONLY", error: TERMINAL_ONLY_MESSAGE }, 410);
  }

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

  // execute, manual-entry, exit, manual-exit: order submission is terminal-only.
  // A serverless route cannot hold a durable per-wallet order journal or a
  // cross-instance lock, and an accepted FAK is not proof of a fill, so the
  // terminal trader (pnpm run live) is the single live executor.
  return json({ ok: false, status: "TERMINAL_ONLY", error: TERMINAL_ONLY_MESSAGE }, 410);
}
