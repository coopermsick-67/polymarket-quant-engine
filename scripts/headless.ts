// Headless paper/shadow runner: the same controller, signal, and paper engine
// the browser uses, without a browser tab. Persists state and daily SQLite
// recordings, and can alert to Telegram.
//
//   pnpm run headless -- --auto --cash 1000 --minutes 60
//
// Flags: --auto (place paper orders), --cash N, --minutes N (0 = forever),
//        --no-record (disable SQLite feed and decision recording),
//        --record-interval S (default 5), --data-dir DIR (default ./data),
//        --latency MS (simulated order latency, default 750).
// Env:   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID for real-time alerts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountEquity, createPaperAccount, haltState, migratePaperAccount } from "../app/lib/engines";
import { MarketFeedController } from "../app/lib/market-feed";
import { createEngineState, normalizePaperConfig, stepPaperEngine, type PaperEngineState } from "../app/lib/paper-engine";
import { fetchOfficialPrice, officialKey, snapshotFromLiveMarket, type OfficialPrice } from "../app/lib/polymarket-data";
import { RecordingStore } from "./recording-store";
import { writeRunnerHeartbeat, type RunnerHeartbeat } from "./runner-health";
import { VenueFeedRecorder } from "./venue-feeds";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const dataDir = option("data-dir", "data");
const minutes = Number(option("minutes", "0"));
const recordInterval = Math.max(1, Number(option("record-interval", "5"))) * 1000;
const autoTrade = flag("auto");
const recording = !flag("no-record");
mkdirSync(dataDir, { recursive: true });
const statePath = join(dataDir, "paper-state.json");
const heartbeatPath = join(dataDir, "runner-heartbeat.json");
const recorder = recording ? await RecordingStore.open(dataDir) : null;

const config = normalizePaperConfig({ latencyMs: Number(option("latency", "750")) });
const loadState = (): PaperEngineState => {
  if (existsSync(statePath)) {
    try {
      const saved = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PaperEngineState>;
      const account = migratePaperAccount(saved.account ?? null);
      if (account) return { ...createEngineState(account), halt: saved.halt ?? null };
    } catch {
      console.warn("Could not read saved state; starting fresh.");
    }
  }
  return createEngineState(createPaperAccount(Number(option("cash", "1000"))));
};
let state = loadState();
const persist = () => {
  const temp = `${statePath}.tmp`;
  writeFileSync(temp, JSON.stringify({ account: state.account, halt: state.halt, savedAt: Date.now() }));
  renameSync(temp, statePath); // atomic replace: a crash never leaves a half-written file
};

const telegram = async (text: string) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3900) }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    /* alerts are best-effort */
  }
};

const log = (kind: string, detail: Record<string, unknown>) => {
  const at = Date.now();
  const line = { at: new Date(at).toISOString(), kind, ...detail };
  recorder?.recordEvent(at, kind, line);
  console.log(`${line.at} ${kind.padEnd(8)} ${JSON.stringify(detail)}`);
};

const venueFeeds =
  recording && recorder
    ? new VenueFeedRecorder({
        onRaw: (message) => recorder.recordRaw(message),
        onTick: (tick) => recorder.recordVenueTick(tick),
        onStatus: (source, status, detail) => log("venue-feed", { source, status, detail: detail ?? null }),
      })
    : null;

const controller = new MarketFeedController({
  referenceFetcher: async (requests) => {
    const out = new Map<string, OfficialPrice>();
    await Promise.all(
      requests.map(async (request) => {
        const price = await fetchOfficialPrice(request.asset, request.startTime, request.duration).catch(() => null);
        if (price) out.set(request.key, price);
      }),
    );
    return out;
  },
  onLog: (level, message) => log(level, { message }),
  onRaw: (source, data, receivedAt) =>
    recorder?.recordRaw({
      receivedAt,
      source,
      venue: source === "clob" || source === "rtds" ? "polymarket" : source,
      channel: source,
      payload: data,
    }),
});

const recordedMarkets = new Set<string>();
const knownFills = new Set<string>();
const knownResolutions = new Map<string, string>();
const knownOfficialPrices = new Map<string, string>();
let lastRecord = 0;
let lastPersist = 0;
let lastStatus = 0;
let lastStatusResyncs = 0;
let lastHealthAlertAt = 0;
let lastHealthAlertKey = "";
const startedAt = Date.now();
let lastTickAt: number | null = null;
let lastTickDurationMs: number | null = null;
let lastHeartbeatWriteAt = 0;

const writeHeartbeat = (heartbeatState: RunnerHeartbeat["state"], at = Date.now()) => {
  const heartbeat: RunnerHeartbeat = {
    version: 1,
    pid: process.pid,
    startedAt,
    heartbeatAt: at,
    lastTickAt,
    lastTickDurationMs,
    state: heartbeatState,
    markets: controller.markets.size,
    feeds: {
      polymarket: {
        clob: controller.status.clob,
        rtds: controller.status.rtds,
        coinbase: controller.status.coinbase,
        lastMessageAt: controller.status.lastMessageAt,
        lastRestAt: controller.status.lastRestAt,
        lastError: controller.status.lastError,
      },
      venues: venueFeeds?.health(at) ?? {},
    },
  };
  try {
    writeRunnerHeartbeat(heartbeatPath, heartbeat);
    lastHeartbeatWriteAt = at;
  } catch (error) {
    console.error("Could not update runner heartbeat:", error instanceof Error ? error.message : String(error));
  }
};

const tick = () => {
  const now = Date.now();
  controller.watchResolution([...state.account.positions.map((position) => position.marketId), ...recordedMarkets]);
  const step = stepPaperEngine(state, {
    markets: controller.markets,
    feed: (asset) => controller.derived(asset, now),
    resolutions: controller.resolutions,
    config,
    now,
    autoTrade,
  });
  state = step.state;
  if (recorder) {
    for (const [marketId, signal] of step.decisions) recorder.recordDecision(marketId, now, signal);
    for (const [marketId, signal] of step.decisions) {
      const market = controller.markets.get(marketId);
      const remainingSeconds = market ? (market.endTime - now) / 1000 : Infinity;
      if (remainingSeconds <= 75 && remainingSeconds > 45 && signal.pUpPosterior !== null && signal.pUpMarket !== null) {
        recorder.recordCalibrationCheckpoint({
          marketId,
          at: now,
          remainingSeconds,
          posteriorProbability: signal.pUpPosterior,
          bookProbability: signal.pUpMarket,
        });
      }
    }
    for (const fill of state.account.fills) {
      if (knownFills.has(fill.id)) continue;
      recorder.recordPaperFill(fill);
      knownFills.add(fill.id);
    }
    for (const definition of controller.definitions.values()) {
      const price = controller.official.get(officialKey(definition));
      if (!price) continue;
      const key = JSON.stringify(price);
      if (knownOfficialPrices.get(definition.id) === key) continue;
      recorder.recordOfficialPrice({
        marketId: definition.id,
        asset: definition.asset,
        duration: definition.duration,
        startTime: definition.startTime,
        endTime: definition.endTime,
        price,
      });
      knownOfficialPrices.set(definition.id, key);
    }
    for (const [marketId, resolution] of controller.resolutions) {
      const key = JSON.stringify(resolution);
      if (knownResolutions.get(marketId) === key) continue;
      recorder.recordResolution(resolution);
      knownResolutions.set(marketId, key);
    }
  }
  for (const event of step.events) {
    log(event.kind, { title: event.title, detail: event.detail });
    if (event.kind === "halt" || event.kind === "fill" || event.kind === "settle") void telegram(`${event.title}\n${event.detail}`);
  }
  if (recording && recorder && now - lastRecord >= recordInterval) {
    lastRecord = now;
    for (const market of controller.markets.values()) {
      if (market.startTime > now || market.endTime <= now) continue;
      const snapshot = snapshotFromLiveMarket(market, controller.derived(market.asset, now), now);
      snapshot.up = { ...snapshot.up, bids: snapshot.up.bids.slice(0, 10), asks: snapshot.up.asks.slice(0, 10) };
      snapshot.down = { ...snapshot.down, bids: snapshot.down.bids.slice(0, 10), asks: snapshot.down.asks.slice(0, 10) };
      recorder.recordSnapshot(snapshot);
      recordedMarkets.add(market.id);
    }
  }
  if (now - lastPersist >= 10_000) {
    lastPersist = now;
    persist();
  }
  if (now - lastStatus >= 60_000) {
    lastStatus = now;
    const passCounts: Record<string, number> = {};
    let entries = 0;
    for (const signal of step.decisions.values()) {
      if (signal.action === "PASS") passCounts[signal.gate] = (passCounts[signal.gate] ?? 0) + 1;
      else entries += 1;
    }
    const feeds = Object.fromEntries(
      [...controller.feeds.keys()].map((asset) => {
        const feed = controller.derived(asset, now);
        const ageMs = feed.spotTimestamp === null ? null : Math.max(0, now - feed.spotTimestamp);
        return [
          asset,
          {
            status: ageMs === null ? "MISSING" : ageMs > 10_000 ? "STALE" : "LIVE",
            ageMs,
            source: feed.spotSource,
            basisBps: feed.basisBps,
            volBpPerMinute: feed.sigmaPerSqrtSecond ? feed.sigmaPerSqrtSecond * Math.sqrt(60) * 10_000 : null,
          },
        ];
      }),
    );
    const staleFeeds = Object.entries(feeds)
      .filter(([, feed]) => feed.status !== "LIVE")
      .map(([asset]) => asset);
    const activeMarkets = [...controller.markets.values()].filter((market) => market.startTime <= now && market.endTime > now);
    const staleBooks = activeMarkets.filter((market) => {
      const timestamps = [market.upBook?.timestamp, market.downBook?.timestamp].filter(
        (timestamp): timestamp is number => timestamp !== null && timestamp !== undefined,
      );
      return timestamps.length < 2 || timestamps.some((timestamp) => now - timestamp > 15_000);
    }).length;
    const resyncsLastMinute = Math.max(0, controller.status.bookResyncs - lastStatusResyncs);
    lastStatusResyncs = controller.status.bookResyncs;
    const equity = accountEquity(state.account, controller.markets);
    const dailyPnlUsd = equity - state.account.dayStartEquity;
    const risk = haltState(state.account, equity, { dailyLossPct: config.dailyLossPct, maxDrawdownPct: config.maxDrawdownPct });
    const calibrationWindow = recorder?.rollingCalibration(500) ?? {
      markets: 0,
      posteriorBrier: null,
      bookBrier: null,
      brierDifferencePosteriorMinusBook: null,
    };
    const healthAlerts = [
      staleFeeds.length ? `stale feeds: ${staleFeeds.join(", ")}` : "",
      staleBooks > 0 ? `stale books: ${staleBooks}/${activeMarkets.length}` : "",
      resyncsLastMinute >= 10 ? `book resyncs: ${resyncsLastMinute}/min` : "",
      dailyPnlUsd <= -state.account.dayStartEquity * 0.03 ? `daily paper P&L: $${dailyPnlUsd.toFixed(2)}` : "",
      risk.halted || state.halt ? `halt: ${state.halt?.reason ?? risk.reason}` : "",
      calibrationWindow.markets >= 500 && (calibrationWindow.brierDifferencePosteriorMinusBook ?? 0) > 0.01
        ? `rolling-500 posterior Brier trails book by ${(calibrationWindow.brierDifferencePosteriorMinusBook! * 100).toFixed(2)}pt`
        : "",
    ].filter(Boolean);
    const healthAlertKey = healthAlerts.join("; ");
    if (healthAlertKey && (healthAlertKey !== lastHealthAlertKey || now - lastHealthAlertAt >= 15 * 60_000)) {
      lastHealthAlertKey = healthAlertKey;
      lastHealthAlertAt = now;
      void telegram(`Health alert\n${healthAlertKey}`);
    } else if (!healthAlertKey) {
      lastHealthAlertKey = "";
    }
    log("status", {
      markets: controller.markets.size,
      sockets: `${controller.status.clob}/${controller.status.rtds}/${controller.status.coinbase}`,
      resyncs: controller.status.bookResyncs,
      resyncsLastMinute,
      staleBooks: `${staleBooks}/${activeMarkets.length}`,
      equity: equity.toFixed(2),
      dailyPnlUsd: dailyPnlUsd.toFixed(2),
      dailyPnlPct: (risk.dailyPnlPct * 100).toFixed(2),
      positions: state.account.positions.length,
      pending: state.pending.length,
      halted: state.halt?.reason ?? null,
      entries,
      passGates: passCounts,
      feeds,
      rollingCalibration500: calibrationWindow,
    });
  }
  const completedAt = Date.now();
  lastTickAt = completedAt;
  lastTickDurationMs = completedAt - now;
  if (completedAt - lastHeartbeatWriteAt >= 5_000) writeHeartbeat("running", completedAt);
  if (minutes > 0 && now - startedAt >= minutes * 60_000) void shutdown();
};

let loop: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
const shutdown = async (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (loop) clearInterval(loop);
  writeHeartbeat("stopping");
  try {
    controller.stop();
    venueFeeds?.stop();
    persist();
    recorder?.close();
    await recorder?.waitForCompression();
    writeHeartbeat("stopped");
    console.log("Stopped; state saved to", statePath);
  } catch (error) {
    console.error("Error while stopping the paper runner:", error instanceof Error ? error.message : String(error));
    exitCode = 1;
  }
  process.exit(exitCode);
};
process.on("SIGINT", () => void shutdown());
// Persist state before dying on an unexpected error; the supervisor restarts the process.
process.on("uncaughtException", (error) => {
  try {
    log("error", { message: `uncaught: ${error instanceof Error ? error.message : String(error)}` });
  } catch {
    console.error(error);
  }
  void shutdown(1);
});
process.on("SIGTERM", () => void shutdown());
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection in the paper runner:", error instanceof Error ? (error.stack ?? error.message) : String(error));
  void shutdown(1);
});

log("start", {
  autoTrade,
  recording,
  dataDir,
  cash: state.account.cash,
  config: { latencyMs: config.latencyMs, minEdge: config.signal.minEdge, modelWeight: config.signal.modelWeight },
});
controller.start();
venueFeeds?.start();
writeHeartbeat("starting");
loop = setInterval(() => {
  if (shuttingDown) return;
  try {
    tick();
  } catch (error) {
    console.error("Paper loop failed:", error instanceof Error ? (error.stack ?? error.message) : String(error));
    void shutdown(1);
  }
}, 1_000);
