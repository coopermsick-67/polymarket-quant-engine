import { getChatGPTUser } from "../../chatgpt-auth";
import {
  clearTelegramSessionCookie,
  readTelegramSession,
  sealTelegramSession,
  telegramSessionCookie,
  TELEGRAM_SESSION_TTL_SECONDS,
  type TelegramSession,
} from "../../lib/telegram-session";
import { env } from "cloudflare:workers";

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...responseHeaders, ...extraHeaders } });
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validBotToken = (value: string) => /^\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(value);

const telegramJson = async (botToken: string, method: string, params?: Record<string, string>) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const query = params ? "?" + new URLSearchParams(params).toString() : "";
    const response = await fetch("https://api.telegram.org/bot" + botToken + "/" + method + query, { cache: "no-store", signal: controller.signal });
    const body = await response.text();
    let payload: unknown = null;
    try { payload = body ? JSON.parse(body) : null; } catch { payload = null; }
    if (!response.ok || record(payload).ok !== true) throw new Error(text(record(payload).description) || "Telegram rejected the request.");
    return record(payload).result;
  } finally {
    clearTimeout(timeoutId);
  }
};

const ownerGate = async () => {
  const user = await getChatGPTUser();
  if (!user) return { response: json({ ok: false, error: "Sign in with ChatGPT before linking Telegram." }, 401), user: null };
  const ownerId = typeof env.POLYMARKET_LIVE_ALLOWED_USER_ID === "string" ? env.POLYMARKET_LIVE_ALLOWED_USER_ID.trim() : "";
  if (!ownerId) return { response: json({ ok: false, error: "Telegram reporting is not armed for this deployment." }, 503), user: null };
  if (user.userId !== ownerId) return { response: json({ ok: false, error: "Telegram reporting is restricted to the owner account." }, 403), user: null };
  return { response: null, user };
};

const publicSession = (session: TelegramSession) => ({
  connected: true,
  botUsername: session.botUsername,
  botName: session.botName,
  chatId: session.chatId,
  chatTitle: session.chatTitle,
  linkedAt: session.linkedAt,
  expiresAt: session.expiresAt,
});

const errorMessage = (error: unknown) => error instanceof Error ? error.message.replace(/\d{6,12}:[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 220) : "Telegram request failed.";

export async function POST(request: Request) {
  const gate = await ownerGate();
  if (gate.response || !gate.user) return gate.response ?? json({ ok: false, error: "Telegram authorization failed." }, 401);
  let input: { action?: unknown; botToken?: unknown; chatId?: unknown; text?: unknown };
  try { input = await request.json() as typeof input; } catch { return json({ ok: false, error: "Invalid JSON request." }, 400); }
  const action = text(input.action);
  if (!["connect", "status", "send-test", "send-report", "disconnect"].includes(action)) return json({ ok: false, error: "Unsupported Telegram action." }, 400);
  if (action === "disconnect") return json({ ok: true, status: "DISCONNECTED" }, 200, { "Set-Cookie": clearTelegramSessionCookie() });

  if (action === "connect") {
    const botToken = text(input.botToken);
    const chatId = text(input.chatId);
    if (!validBotToken(botToken)) return json({ ok: false, error: "Enter a valid Telegram bot token from BotFather." }, 400);
    if (!chatId || chatId.length > 80) return json({ ok: false, error: "Enter the Telegram chat ID or @channel username." }, 400);
    try {
      const bot = record(await telegramJson(botToken, "getMe"));
      const chat = record(await telegramJson(botToken, "getChat", { chat_id: chatId }));
      const linkedAt = Date.now();
      const session: TelegramSession = {
        userId: gate.user.userId,
        botToken,
        botUsername: text(bot.username),
        botName: text(bot.first_name) || "Telegram bot",
        chatId,
        chatTitle: text(chat.title) || text(chat.username) || text(chat.first_name) || chatId,
        linkedAt,
        expiresAt: linkedAt + TELEGRAM_SESSION_TTL_SECONDS * 1000,
      };
      const sealed = await sealTelegramSession(session);
      if (!sealed) return json({ ok: false, error: "Telegram session storage is not configured." }, 503);
      return json({ ok: true, status: "CONNECTED", telegram: publicSession(session) }, 200, { "Set-Cookie": telegramSessionCookie(sealed) });
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 502);
    }
  }

  const session = await readTelegramSession(request, gate.user.userId);
  if (!session) return json({ ok: false, error: "Telegram link expired. Link the bot again." }, 401, { "Set-Cookie": clearTelegramSessionCookie() });
  if (action === "status") return json({ ok: true, status: "READY", telegram: publicSession(session) });

  const reportText = text(input.text);
  if (!reportText) return json({ ok: false, error: "A report message is required." }, 400);
  if (reportText.length > 3900) return json({ ok: false, error: "The report is too long for one Telegram message." }, 400);
  try {
    await telegramJson(session.botToken, "sendMessage", { chat_id: session.chatId, text: reportText, disable_web_page_preview: "true" });
    return json({ ok: true, status: "SENT", telegram: publicSession(session) });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
}
