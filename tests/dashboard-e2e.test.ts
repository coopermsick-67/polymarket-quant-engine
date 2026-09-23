import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium, type Page, type Route } from "playwright";

const runBrowserTest = process.env.RUN_DASHBOARD_E2E === "1";
const port = 5_187;
const origin = `http://127.0.0.1:${port}`;
const fixtureUrl = new URL("./fixtures/gamma-open-markets.json", import.meta.url);

const makeOpenMarkets = async () => {
  const input = JSON.parse(await readFile(fixtureUrl, "utf8")) as { markets: Record<string, unknown>[] };
  const start = Math.floor(Date.now() / 300_000) * 300_000;
  return input.markets.slice(0, 3).map((market, index) => {
    const slug = String(market.slug).replace(/-\d{10}$/, `-${Math.floor(start / 1000)}`);
    const duration = slug.includes("-15m-") ? 900_000 : 300_000;
    return {
      ...market,
      id: `e2e-${index + 1}`,
      slug,
      eventStartTime: new Date(start).toISOString(),
      endDate: new Date(start + duration).toISOString(),
      active: true,
      closed: false,
      archived: false,
    };
  });
};

/** External market-data requests are handled in Node so Chromium never reaches the public APIs. */
const relayRequest = async (route: Route, markets: Record<string, unknown>[]) => {
  const request = route.request();
  const url = new URL(request.url());

  if (url.pathname === "/api/polymarket/live") {
    await route.fulfill({ json: { ok: true, serverKeyConfigured: false } });
    return;
  }
  if (url.pathname === "/api/telegram") {
    await route.fulfill({ json: { ok: false, telegram: null } });
    return;
  }
  if (url.pathname === "/api/polymarket/reference") {
    const prices = Object.fromEntries(
      (url.searchParams.get("keys") ?? "")
        .split(",")
        .filter(Boolean)
        .map((key) => [key, { openPrice: 100_000, closePrice: null, completed: false, fetchedAt: Date.now() }]),
    );
    await route.fulfill({ json: { ok: true, prices } });
    return;
  }
  if (url.hostname === "clob.polymarket.com" && url.pathname === "/time") {
    await route.fulfill({ json: Date.now() });
    return;
  }
  if (url.hostname === "gamma-api.polymarket.com" && url.pathname.endsWith("/markets/keyset")) {
    await route.fulfill({ json: markets });
    return;
  }
  if (url.hostname === "clob.polymarket.com" && url.pathname === "/books") {
    const tokens = JSON.parse(request.postData() ?? "[]") as { token_id?: string }[];
    await route.fulfill({
      json: tokens.map(({ token_id }) => ({
        asset_id: token_id,
        bids: [{ price: "0.48", size: "50" }],
        asks: [{ price: "0.51", size: "50" }],
        timestamp: new Date().toISOString(),
        tick_size: "0.01",
        min_order_size: "5",
      })),
    });
    return;
  }
  if (url.hostname === "api.exchange.coinbase.com") {
    await route.fulfill({ json: [] });
    return;
  }
  if (url.origin !== origin) {
    await route.abort("blockedbyclient");
    return;
  }
  await route.continue();
};

const installSocketStub = (page: Page) =>
  page.addInitScript(`
    class FixtureWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = FixtureWebSocket.CONNECTING;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        window.setTimeout(() => {
          if (this.readyState !== FixtureWebSocket.CONNECTING) return;
          this.readyState = FixtureWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        }, 0);
      }
      send(data) { void data; }
      close() {
        if (this.readyState === FixtureWebSocket.CLOSED) return;
        this.readyState = FixtureWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: FixtureWebSocket });
  `);

const startDevServer = () =>
  spawn(process.execPath, ["scripts/run-framework.mjs", "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

const waitForDevServer = async (server: ChildProcess) => {
  const output: string[] = [];
  server.stdout?.on("data", (data: Buffer) => output.push(data.toString()));
  server.stderr?.on("data", (data: Buffer) => output.push(data.toString()));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Dashboard server exited early:\n${output.join("").slice(-6000)}`);
    const status = await new Promise<number>((resolve) => {
      const request = httpRequest(origin, { agent: false, timeout: 1_000 }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", () => resolve(0));
      request.on("timeout", () => {
        request.destroy();
        resolve(0);
      });
      request.end();
    });
    if (status >= 200 && status < 500) return;
    await delay(300);
  }
  throw new Error(`Dashboard server did not become ready:\n${output.join("").slice(-6000)}`);
};

test("dashboard renders markets and explicit live evidence gates without page errors", { skip: !runBrowserTest, timeout: 120_000 }, async () => {
  const markets = await makeOpenMarkets();
  const server = startDevServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    await waitForDevServer(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installSocketStub(page);
    await page.route("**/*", (route) => relayRequest(route, markets));
    await page.goto(origin, { waitUntil: "domcontentloaded" });

    await page.getByRole("heading", { name: "Active 5m / 15m markets" }).waitFor();
    await page.locator(".market-card").first().waitFor({ timeout: 20_000 });
    assert.ok((await page.locator(".market-card").count()) > 0, "fixture markets render");

    await page.getByRole("tab", { name: "Live executor" }).click();
    await page.getByRole("heading", { name: "Live order submission is disabled" }).waitFor();
    await page.getByText("out-of-sample strategy and execution safety evidence gates pass").waitFor();
    assert.match(await page.locator(".live-executor").innerText(), /Buys and sells remain blocked/i);
    assert.equal(await page.getByRole("button", { name: /START LIVE|RUNNING/ }).count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), delay(5_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
});
