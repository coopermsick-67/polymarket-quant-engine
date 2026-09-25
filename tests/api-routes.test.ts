import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Route handlers import `cloudflare:workers` and `next/headers`; stub them so
// the real handlers run end to end on Request/Response objects.
register("./support/worker-hooks.mjs", import.meta.url);
const workerEnv: Record<string, string> = ((globalThis as { __WORKER_ENV__?: Record<string, string> }).__WORKER_ENV__ ??= {});
const setUserHeaders = (headers: Record<string, string>) => { (globalThis as { __REQUEST_HEADERS__?: Record<string, string> }).__REQUEST_HEADERS__ = headers; };

const live = await import("../app/api/polymarket/live/route");
const account = await import("../app/api/polymarket/account/route");
const telegram = await import("../app/api/telegram/route");
const telegramSession = await import("../app/lib/telegram-session");

const LOCAL = "http://127.0.0.1:8787";
const HOSTED = "https://quant.example.com";
const WALLET = "0x" + "a".repeat(40);
const KEY = "b".repeat(64);

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(base + path, { method: "POST", body: payload,
    headers: { host: new URL(base).host, origin: base, "content-type": "application/json", ...headers } });
};
const errorOf = async (response: Response) => (await response.json() as { error?: string; status?: string });

const localOwner = () => {
  for (const key of Object.keys(workerEnv)) delete workerEnv[key];
  Object.assign(workerEnv, { POLYMARKET_LIVE_ALLOW_LOCALHOST: "true", POLYMARKET_LIVE_SESSION_SECRET: "1".repeat(64),
    POLYMARKET_TELEGRAM_SESSION_SECRET: "2".repeat(64), POLYMARKET_LIVE_ALLOWED_USER_ID: "owner" });
  setUserHeaders({});
};

test("the web live route never places orders: every order action returns 410 TERMINAL_ONLY", async () => {
  localOwner();
  for (const action of ["execute", "manual-entry", "exit", "manual-exit"]) {
    const response = await live.POST(post(LOCAL, "/api/polymarket/live", { action, confirmLive: true }, { "x-polymarket-live-confirm": "1" }));
    assert.equal(response.status, 410, action);
    assert.equal((await errorOf(response)).status, "TERMINAL_ONLY");
  }
});

test("a hosted deployment refuses a raw private key even from the signed-in owner", async () => {
  localOwner();
  setUserHeaders({ "oai-authenticated-user-id": "owner", "oai-authenticated-user-email": "owner@example.com" });
  const connect = await live.POST(post(HOSTED, "/api/polymarket/live", { action: "connect", walletAddress: WALLET, privateKey: KEY }));
  assert.equal(connect.status, 403);
  assert.match((await errorOf(connect)).error ?? "", /only accepted by a local server/);
});

test("POLYMARKET_HOSTED disables the loopback owner bypass", async () => {
  localOwner();
  workerEnv.POLYMARKET_HOSTED = "true";
  const response = await live.POST(post(LOCAL, "/api/polymarket/live", { action: "balance" }));
  assert.equal(response.status, 401);
});

test("forwarding headers make a localhost request non-local, so the owner bypass does not apply", async () => {
  localOwner();
  const response = await live.POST(post(LOCAL, "/api/polymarket/live", { action: "balance" }, { "x-forwarded-for": "203.0.113.9" }));
  assert.equal(response.status, 401);
});

test("the live route requires the owner account and a same-origin JSON body", async () => {
  localOwner();
  setUserHeaders({ "oai-authenticated-user-id": "someone-else", "oai-authenticated-user-email": "x@example.com" });
  assert.equal((await live.POST(post(HOSTED, "/api/polymarket/live", { action: "balance" }))).status, 403);
  setUserHeaders({});
  assert.equal((await live.POST(post(LOCAL, "/api/polymarket/live", { action: "balance" }, { "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal((await live.POST(post(LOCAL, "/api/polymarket/live", "action=balance", { "content-type": "text/plain" }))).status, 415);
  assert.equal((await live.POST(post(LOCAL, "/api/polymarket/live", { action: "balance", pad: "x".repeat(9_000) }))).status, 413);
});

test("without a sealed session cookie the live route reports an expired session and clears the cookie", async () => {
  localOwner();
  const response = await live.POST(post(LOCAL, "/api/polymarket/live", { action: "balance" }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("the account route refuses a private key on a hosted deployment and rate-limits each client", async () => {
  localOwner();
  const refused = await account.POST(post(HOSTED, "/api/polymarket/account", { walletAddress: WALLET, privateKey: KEY }));
  assert.equal(refused.status, 403);
  // Twelve requests a minute per client (this test's first request counts); invalid bodies still count.
  const statuses: number[] = [];
  for (let index = 0; index < 12; index += 1) {
    statuses.push((await account.POST(post(HOSTED, "/api/polymarket/account", "{}", { "content-type": "text/plain" }))).status);
  }
  assert.deepEqual(statuses.slice(0, 11), Array(11).fill(415));
  assert.equal(statuses[11], 429);
});

test("the telegram route requires an owner, a sealed link, and rate-limits sends", async (t) => {
  localOwner();
  assert.equal((await telegram.POST(post(LOCAL, "/api/telegram", { action: "send-test", text: "hi" }, { "sec-fetch-site": "cross-site" }))).status, 403);
  setUserHeaders({ "oai-authenticated-user-id": "someone-else", "oai-authenticated-user-email": "x@example.com" });
  assert.equal((await telegram.POST(post(HOSTED, "/api/telegram", { action: "status" }))).status, 403);
  setUserHeaders({});
  assert.equal((await telegram.POST(post(LOCAL, "/api/telegram", { action: "send-test", text: "hi" }))).status, 401);

  const now = Date.now();
  const sealed = await telegramSession.sealTelegramSession({ userId: "local-owner", botToken: "123456:" + "A".repeat(30), botUsername: "bot",
    botName: "Bot", chatId: "42", chatTitle: "Chat", linkedAt: now, expiresAt: now + 60_000 });
  assert.ok(sealed);
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    sent.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  const cookie = { cookie: `${telegramSession.TELEGRAM_SESSION_COOKIE}=${sealed}` };
  const statuses: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    statuses.push((await telegram.POST(post(LOCAL, "/api/telegram", { action: "send-report", text: "report" }, cookie))).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
  assert.equal(sent.length, 6);
});
