import { createServer } from "node:http";
import {
  buildLiveMarket,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  fetchSpotPrices,
  type LiveMarket,
  type MarketDefinition,
} from "../app/lib/polymarket-data";
import { analyzeMarketSignal, marketDataFreshnessIssue } from "../app/lib/engines";

type RankedSignal = {
  marketId: string;
  question: string;
  asset: string;
  duration: "5m";
  action: "UP" | "DOWN";
  tier: "LOCK";
  fairUp: number;
  edge: number;
  entryPrice: number;
  confidence: number | null;
  spread: number;
  liquidity: number;
  remainingSeconds: number;
  suggestedStakeUsd: number;
  reason: string;
  observedAt: number;
};

const pollMs = intEnv("SIGNAL_POLL_MS", 5_000, 2_000, 60_000);
const port = intEnv("SIGNAL_PORT", 8790, 1024, 65_535);
const bankroll = numEnv("SIGNAL_BANKROLL_USD", 10, 1, 1_000_000);
const maxTradeUsd = numEnv("SIGNAL_MAX_TRADE_USD", 3, 1, 100_000);
const maxPositionPct = numEnv("SIGNAL_MAX_POSITION_PCT", 0.30, 0.01, 0.50);
const minNetEdge = numEnv("SIGNAL_MIN_NET_EDGE", 0.06, 0.04, 0.30);
const slippageBps = numEnv("SIGNAL_SLIPPAGE_BPS", 20, 0, 100);
const maxSpread = numEnv("SIGNAL_MAX_SPREAD", 0.06, 0.005, 0.20);
const minRemaining = intEnv("SIGNAL_MIN_REMAINING_SECONDS", 45, 30, 240);
const maxRemaining = intEnv("SIGNAL_MAX_REMAINING_SECONDS", 270, 60, 295);
const allowedAssets = new Set(
  (process.env.SIGNAL_ALLOWED_ASSETS ?? "BTC,ETH,SOL,XRP")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean),
);

let lastCycleAt: number | null = null;
let lastHealthyAt: number | null = null;
let lastError: string | null = null;
let ranked: RankedSignal[] = [];
let stopping = false;

function numEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = numEnv(name, fallback, min, max);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function suggestedStake(balance: number, fair: number, entry: number): number {
  if (entry <= 0 || entry >= 1 || fair <= entry) return 0;
  const fullKelly = Math.max(0, (fair - entry) / (1 - entry));
  const kellyFraction = balance < 20 ? 0.75 : balance < 50 ? 0.5 : 0.25;
  const tierPct = balance < 20 ? 0.30 : balance < 50 ? 0.15 : balance < 100 ? 0.10 : 0.05;
  const cap = Math.min(maxTradeUsd, balance * Math.min(maxPositionPct, tierPct));
  return Number(Math.min(cap, Math.max(1, balance * fullKelly * kellyFraction)).toFixed(2));
}

async function hydrate(definitions: MarketDefinition[]): Promise<LiveMarket[]> {
  if (!definitions.length) return [];
  const tokenIds = definitions.flatMap((market) => [market.upTokenId, market.downTokenId]);
  const assets = [...new Set(definitions.map((market) => market.asset))];
  const [books, spots, histories] = await Promise.all([
    fetchOrderBooks(tokenIds),
    fetchSpotPrices(assets),
    fetchCandleHistories(assets),
  ]);
  const now = Date.now();
  return definitions.map((definition) =>
    buildLiveMarket(definition, books, spots, null, now, histories.get(definition.asset) ?? null),
  );
}

function score(markets: LiveMarket[]): RankedSignal[] {
  const previewBudget = Math.min(maxTradeUsd, bankroll * maxPositionPct);
  return markets
    .filter((market) =>
      market.duration === "5m" &&
      allowedAssets.has(market.asset.toUpperCase()) &&
      market.referenceSource === "POLYMARKET" &&
      market.remaining >= minRemaining &&
      market.remaining <= maxRemaining &&
      market.spread !== null &&
      market.spread <= maxSpread &&
      !marketDataFreshnessIssue(market),
    )
    .map((market) => {
      const signal = analyzeMarketSignal(
        market,
        { feeRate: 0, slippageBps },
        previewBudget,
        minNetEdge,
      );
      if (
        signal.action === "PASS" ||
        signal.tier !== "LOCK" ||
        signal.fairUp === null ||
        signal.edge === null ||
        signal.entryPrice === null ||
        market.spread === null
      ) return null;
      const fair = signal.action === "UP" ? signal.fairUp : 1 - signal.fairUp;
      return {
        marketId: market.id,
        question: market.question,
        asset: market.asset,
        duration: "5m" as const,
        action: signal.action,
        tier: "LOCK" as const,
        fairUp: signal.fairUp,
        edge: signal.edge,
        entryPrice: signal.entryPrice,
        confidence: signal.confidence,
        spread: market.spread,
        liquidity: market.liquidity,
        remainingSeconds: Math.round(market.remaining),
        suggestedStakeUsd: suggestedStake(bankroll, fair, signal.entryPrice),
        reason: signal.reason,
        observedAt: Date.now(),
      };
    })
    .filter((item): item is RankedSignal => item !== null)
    .filter((item) => item.suggestedStakeUsd >= 1)
    .sort((a, b) =>
      b.edge - a.edge ||
      a.spread - b.spread ||
      b.liquidity - a.liquidity,
    )
    .slice(0, 10);
}

async function runCycle(): Promise<void> {
  lastCycleAt = Date.now();
  try {
    const definitions = (await discoverCryptoMarkets()).filter(
      (market) =>
        market.duration === "5m" &&
        allowedAssets.has(market.asset.toUpperCase()),
    );
    ranked = score(await hydrate(definitions));
    lastHealthyAt = Date.now();
    lastError = null;
    const top = ranked[0];
    process.stdout.write(
      JSON.stringify({
        at: new Date().toISOString(),
        level: "INFO",
        message: top ? "Best live 5m signal" : "No LOCK-quality 5m signal",
        top: top ?? null,
        candidates: ranked.length,
      }) + "\n",
    );
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Signal cycle failed.";
    process.stderr.write(
      JSON.stringify({
        at: new Date().toISOString(),
        level: "ERROR",
        message: lastError,
      }) + "\n",
    );
  }
}

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.url === "/healthz") {
    response.statusCode = lastError ? 503 : 200;
    response.end(JSON.stringify({ ok: !lastError, lastCycleAt, lastHealthyAt }));
    return;
  }
  if (request.url === "/signals" || request.url === "/status") {
    response.statusCode = 200;
    response.end(JSON.stringify({
      mode: "live-data-signal-only",
      bankroll,
      allowedAssets: [...allowedAssets],
      lastCycleAt,
      lastHealthyAt,
      lastError,
      best: ranked[0] ?? null,
      signals: ranked,
    }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ ok: false, error: "Not found" }));
});

server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

while (!stopping) {
  const started = Date.now();
  await runCycle();
  const elapsed = Date.now() - started;
  if (!stopping && elapsed < pollMs) await sleep(pollMs - elapsed);
}

await new Promise<void>((resolve) => server.close(() => resolve()));
