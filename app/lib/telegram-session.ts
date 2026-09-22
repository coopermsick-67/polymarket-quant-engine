import { env } from "cloudflare:workers";

export const TELEGRAM_SESSION_COOKIE = "pm_telegram_session_v1";
export const TELEGRAM_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

export type TelegramSession = {
  userId: string;
  botToken: string;
  botUsername: string;
  botName: string;
  chatId: string;
  chatTitle: string;
  linkedAt: number;
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

const secretBytes = () => {
  const secret = typeof env.POLYMARKET_TELEGRAM_SESSION_SECRET === "string" ? env.POLYMARKET_TELEGRAM_SESSION_SECRET.trim() : "";
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(secret.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

const importKey = async () => {
  const secret = secretBytes();
  return secret ? crypto.subtle.importKey("raw", secret, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]) : null;
};

export const sealTelegramSession = async (session: TelegramSession) => {
  const key = await importKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(session));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return toBase64Url(iv) + "." + toBase64Url(ciphertext);
};

export const readTelegramSession = async (request: Request, userId: string): Promise<TelegramSession | null> => {
  const key = await importKey();
  if (!key) return null;
  const token = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(TELEGRAM_SESSION_COOKIE + "="))?.slice(TELEGRAM_SESSION_COOKIE.length + 1);
  if (!token) return null;
  const [ivPart, ciphertextPart] = token.split(".");
  if (!ivPart || !ciphertextPart) return null;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivPart) }, key, fromBase64Url(ciphertextPart));
    const session = JSON.parse(decoder.decode(plaintext)) as TelegramSession;
    if (!session || session.userId !== userId || session.expiresAt <= Date.now() || !session.botToken || !session.chatId) return null;
    return session;
  } catch {
    return null;
  }
};

export const telegramSessionCookie = (token: string, maxAge = TELEGRAM_SESSION_TTL_SECONDS) => TELEGRAM_SESSION_COOKIE + "=" + token + "; Path=/api/telegram; Max-Age=" + maxAge + "; HttpOnly; Secure; SameSite=Lax";
export const clearTelegramSessionCookie = () => telegramSessionCookie("", 0);
