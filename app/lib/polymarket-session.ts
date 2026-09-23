import { env } from "cloudflare:workers";

export const LIVE_SESSION_COOKIE = "pm_live_session_v1";
export const LIVE_SESSION_TTL_SECONDS = 15 * 60;
export const LOCAL_LIVE_USER_ID = "local-owner";

const truthy = (value: string | undefined) => ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());

/** Local live mode is an explicit opt-in for a trusted development machine. */
export const localLiveEnabled = () => truthy(env.POLYMARKET_LIVE_ALLOW_LOCALHOST);

export const isLoopbackRequest = (request: Request) => {
  try {
    const requestUrl = new URL(request.url);
    const hostname = requestUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLocalHostname = (value: string) => {
      const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
      return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
    };
    if (!isLocalHostname(hostname)) return false;

    // The Fetch Request API does not expose the socket peer. Avoid the local
    // owner bypass when any proxy/forwarding header is present, and require a
    // matching Host/Origin so a forwarded external request cannot opt in by
    // supplying only a localhost Host header.
    if (["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "cf-connecting-ip"]
      .some((header) => Boolean(request.headers.get(header)?.trim()))) return false;
    const hostHeader = request.headers.get("host");
    if (!hostHeader) return false;
    const hostUrl = new URL(`http://${hostHeader}`);
    if (!isLocalHostname(hostUrl.hostname) || hostUrl.hostname.toLowerCase() !== requestUrl.hostname.toLowerCase()) return false;
    const originHeader = request.headers.get("origin");
    if (originHeader) {
      const origin = new URL(originHeader);
      if (origin.host.toLowerCase() !== requestUrl.host.toLowerCase() || !isLocalHostname(origin.hostname)) return false;
    }
    return true;
  } catch {
    return false;
  }
};

export type LiveSession = {
  userId: string;
  walletAddress: string;
  signerAddress: string;
  privateKey: string;
  signatureType: number;
  apiKey: string;
  secret: string;
  passphrase: string;
  issuedAt: number;
  expiresAt: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(normalized);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const sessionSecretBytes = () => {
  const secret = typeof env.POLYMARKET_LIVE_SESSION_SECRET === "string" ? env.POLYMARKET_LIVE_SESSION_SECRET.trim() : "";
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(secret.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

const importSessionKey = async () => {
  const secret = sessionSecretBytes();
  if (!secret) return null;
  return crypto.subtle.importKey("raw", secret, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
};

export const sealLiveSession = async (session: LiveSession): Promise<string | null> => {
  const key = await importSessionKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(session));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
};

export const readLiveSession = async (request: Request, userId: string): Promise<LiveSession | null> => {
  const key = await importSessionKey();
  if (!key) return null;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const token = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${LIVE_SESSION_COOKIE}=`))?.slice(LIVE_SESSION_COOKIE.length + 1);
  if (!token) return null;
  const [ivPart, ciphertextPart] = token.split(".");
  if (!ivPart || !ciphertextPart) return null;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivPart) }, key, fromBase64Url(ciphertextPart));
    const session = JSON.parse(decoder.decode(plaintext)) as LiveSession;
    if (!session || session.userId !== userId || session.expiresAt <= Date.now() || !session.privateKey || !session.apiKey || !session.secret || !session.passphrase) return null;
    return session;
  } catch {
    return null;
  }
};

export const liveSessionCookie = (token: string, maxAge = LIVE_SESSION_TTL_SECONDS, secure = true) => `${LIVE_SESSION_COOKIE}=${token}; Path=/api/polymarket; Max-Age=${maxAge}; HttpOnly${secure ? "; Secure" : ""}; SameSite=Lax`;
export const clearLiveSessionCookie = (secure = true) => liveSessionCookie("", 0, secure);
