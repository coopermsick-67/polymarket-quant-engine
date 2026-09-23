import { env } from "cloudflare:workers";
import { fromBase64Url, toBase64Url } from "./num";

export const LIVE_SESSION_COOKIE = "pm_live_session_v2";
export const LIVE_DAY_COOKIE = "pm_live_day_v1";
export const LIVE_SESSION_TTL_SECONDS = 15 * 60;
export const LIVE_DAY_TTL_SECONDS = 36 * 60 * 60;
export const LOCAL_LIVE_USER_ID = "local-owner";

const truthy = (value: string | undefined) => ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
const envText = (key: string) => {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
};

/** Local live mode is an explicit opt-in for a trusted development machine. */
export const localLiveEnabled = () => truthy(envText("POLYMARKET_LIVE_ALLOW_LOCALHOST"));

export const isLoopbackRequest = (request: Request) => {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
};

/**
 * Server-held signer. When POLYMARKET_PRIVATE_KEY and POLYMARKET_WALLET_ADDRESS
 * are set, the key never touches the browser or a cookie.
 */
export const serverSigner = (): { privateKey: string; walletAddress: string; signatureType: number } | null => {
  const privateKey = envText("POLYMARKET_PRIVATE_KEY");
  const walletAddress = envText("POLYMARKET_WALLET_ADDRESS");
  const signatureType = Number(envText("POLYMARKET_SIGNATURE_TYPE") || "3");
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(privateKey) || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress) || !Number.isInteger(signatureType)) return null;
  return { privateKey, walletAddress, signatureType };
};

export type LiveSession = {
  userId: string;
  keySource: "server" | "browser";
  walletAddress: string;
  signerAddress: string;
  /** Present only for browser-linked sessions; server sessions read the env key. */
  privateKey: string | null;
  signatureType: number;
  apiKey: string;
  secret: string;
  passphrase: string;
  issuedAt: number;
  expiresAt: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const importKey = async () => {
  const secret = envText("POLYMARKET_LIVE_SESSION_SECRET");
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) bytes[index] = Number.parseInt(secret.slice(index * 2, index * 2 + 2), 16);
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
};

/** AES-GCM seal with the cookie name as associated data, so tokens cannot be swapped between cookies. */
export const sealJson = async (value: unknown, purpose: string): Promise<string | null> => {
  const key = await importKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(purpose) }, key, encoder.encode(JSON.stringify(value))),
  );
  return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
};

export const openJson = async <T>(token: string | undefined, purpose: string): Promise<T | null> => {
  if (!token) return null;
  const key = await importKey();
  const [ivPart, ciphertextPart] = token.split(".");
  if (!key || !ivPart || !ciphertextPart) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivPart), additionalData: encoder.encode(purpose) },
      key,
      fromBase64Url(ciphertextPart),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return null;
  }
};

export const readCookie = (request: Request, name: string) =>
  (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export const sealLiveSession = (session: LiveSession) => sealJson(session, LIVE_SESSION_COOKIE);

export const readLiveSession = async (request: Request, userId: string): Promise<LiveSession | null> => {
  const session = await openJson<LiveSession>(readCookie(request, LIVE_SESSION_COOKIE), LIVE_SESSION_COOKIE);
  if (!session || session.userId !== userId || session.expiresAt <= Date.now() || !session.apiKey || !session.secret || !session.passphrase) return null;
  if (session.keySource === "browser" && !session.privateKey) return null;
  if (session.keySource === "server" && !serverSigner()) return null;
  return session;
};

export const cookie = (name: string, token: string, maxAge: number, secure: boolean) =>
  `${name}=${token}; Path=/api/polymarket; Max-Age=${maxAge}; HttpOnly${secure ? "; Secure" : ""}; SameSite=Strict`;

export const liveSessionCookie = (token: string, maxAge = LIVE_SESSION_TTL_SECONDS, secure = true) => cookie(LIVE_SESSION_COOKIE, token, maxAge, secure);
export const clearLiveSessionCookie = (secure = true) => cookie(LIVE_SESSION_COOKIE, "", 0, secure);
