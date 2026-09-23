// Headless paper/shadow runner: the same controller, signal, and paper engine
// the browser uses, without a browser tab. Persists state, records replayable
// JSONL, and can alert to Telegram.
//
//   pnpm run headless -- --auto --cash 1000 --minutes 60 --record
//
// Flags: --auto (place paper orders), --cash N, --minutes N (0 = forever),
//        --record (write snapshots for the replay backtester),
//        --record-interval S (default 5), --data-dir DIR (default ./data),
//        --latency MS (simulated order latency, default 750).
// Env:   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID for real-time alerts.

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountEquity, createPaperAccount, migratePaperAccount } from "../app/lib/engines";
import { MarketFeedController } from "../app/lib/market-feed";
import { createEngineState, normalizePaperConfig, stepPaperEngine, type PaperEngineState } from "../app/lib/paper-engine";
import { fetchOfficialPrice, snapshotFromLiveMarket, type OfficialPrice } from "../app/lib/polymarket-data";
import { serializeResolutionLine, serializeSnapshotLine } from "../app/lib/replay";

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
const recording = flag("record");
mkdirSync(dataDir, { recursive: true });
const statePath = join(dataDir, "paper-state.json");
const day = new Date().toISOString().slice(0, 10);
const events = createWriteStream(join(dataDir, `events-${day}.jsonl`), { flags: "a" });
const recorder = recording ? createWriteStream(join(dataDir, `replay-${day}.jsonl`), { flags: "a" }) : null;

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
  const line = { at: new Date().toISOString(), kind, ...detail };
  events.write(JSON.stringify(line) + "\n");
  console.log(`${line.at} ${kind.padEnd(8)} ${JSON.stringify(detail)}`);
};

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
});

const recordedMarkets = new Set<string>();
const writtenResolutions = new Set<string>();
let lastRecord = 0;
let lastPersist = 0;
let lastStatus = 0;
const startedAt = Date.now();

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
  for (const event of step.events) {
    log(event.kind, { title: event.title, detail: event.detail });
    if (event.kind === "halt" || event.kind === "fill" || event.kind === "settle") void telegram(`${event.title}\n${event.detail}`);
  }
  if (recorder && now - lastRecord >= recordInterval) {
    lastRecord = now;
    for (const market of controller.markets.values()) {
      if (market.startTime > now || market.endTime <= now) continue;
      const snapshot = snapshotFromLiveMarket(market, controller.derived(market.asset, now), now);
      snapshot.up = { ...snapshot.up, bids: snapshot.up.bids.slice(0, 10), asks: snapshot.up.asks.slice(0, 10) };
      snapshot.down = { ...snapshot.down, bids: snapshot.down.bids.slice(0, 10), asks: snapshot.down.asks.slice(0, 10) };
      recorder.write(serializeSnapshotLine(snapshot));
      recordedMarkets.add(market.id);
    }
    for (const [id, resolution] of controller.resolutions) {
      if (!recordedMarkets.has(id) || writtenResolutions.has(id)) continue;
      recorder.write(serializeResolutionLine(id, resolution.outcome));
      writtenResolutions.add(id);
      recordedMarkets.delete(id);
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
        return [
          asset,
          `${feed.spotSource}${feed.basisBps === null ? "" : ` basis ${feed.basisBps.toFixed(1)}bp`}${feed.sigmaPerSqrtSecond ? ` vol ${(feed.sigmaPerSqrtSecond * Math.sqrt(60) * 10_000).toFixed(1)}bp/min` : ""}`,
        ];
      }),
    );
    log("status", {
      markets: controller.markets.size,
      sockets: `${controller.status.clob}/${controller.status.rtds}/${controller.status.coinbase}`,
      resyncs: controller.status.bookResyncs,
      equity: accountEquity(state.account, controller.markets).toFixed(2),
      positions: state.account.positions.length,
      pending: state.pending.length,
      halted: state.halt?.reason ?? null,
      entries,
      passGates: passCounts,
      feeds,
    });
  }
  if (minutes > 0 && now - startedAt >= minutes * 60_000) shutdown();
};

let loop: ReturnType<typeof setInterval> | null = null;
const shutdown = () => {
  if (loop) clearInterval(loop);
  controller.stop();
  persist();
  events.end();
  recorder?.end();
  console.log("Stopped; state saved to", statePath);
  setTimeout(() => process.exit(0), 200);
};
process.on("SIGINT", shutdown);
// Persist state before dying on an unexpected error; the supervisor restarts the process.
process.on("uncaughtException", (error) => {
  log("error", { message: `uncaught: ${error instanceof Error ? error.message : String(error)}` });
  shutdown();
});
process.on("SIGTERM", shutdown);

log("start", {
  autoTrade,
  recording,
  dataDir,
  cash: state.account.cash,
  config: { latencyMs: config.latencyMs, minEdge: config.signal.minEdge, modelWeight: config.signal.modelWeight },
});
controller.start();
loop = setInterval(tick, 1_000);
