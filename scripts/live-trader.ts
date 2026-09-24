import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AssetType, Chain, ClobClient, OrderType, Side, SignatureTypeV2, type ApiKeyCreds, type TickSize } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  applyPolymarketPriceTicks,
  buildLiveMarket,
  discoverCryptoMarkets,
  fetchCandleHistories,
  fetchOrderBooks,
  type Asset,
  type CandleHistory,
  type LiveMarket,
  type PolymarketPriceTick,
} from "../app/lib/polymarket-data";
import { subscribePolymarketPrices, type PolymarketPriceStreamStatus } from "../app/lib/polymarket-price-stream";
import { analyzeMarketSignal, marketDataFreshnessIssue } from "../app/lib/engines";
import { enforceLiveExecutionRisk } from "../app/lib/live-risk";

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const STORE_DIR = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "PolymarketQuantEngine");
const STATE_PATH = join(STORE_DIR, "live-trader-state.json");
const LOCK_PATH = join(STORE_DIR, "live-trader.lock");
const SCAN_MS = 1_000;
const DISCOVERY_MS = 15_000;
const RISK = enforceLiveExecutionRisk({ feeRate: 0.05, slippageBps: 25, minEdge: 0.04, requireLock: true });

type PositionRow = { tokenID: string | null; conditionId: string | null; slug: string | null; size: number; averagePrice: number | null; exposureUsd: number };
type TraderState = { version: 1; attemptedMarkets: string[]; pending: { requestId: string; marketId: string; at: number } | null };

const number = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const money = (value: number) => `$${value.toFixed(2)}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const marketCycleKey = (market: { id: string; endTime: number }) => `${market.id}:${market.endTime}`;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const scrubError = (error: unknown, privateKey: string) => {
  const raw = error instanceof Error ? error.message : "Polymarket request failed.";
  const withoutPrivateKey = privateKey ? raw.replaceAll(privateKey, "[redacted]") : raw;
  return withoutPrivateKey.replace(/0x[a-fA-F0-9]{40,}/g, "[redacted]").slice(0, 240);
};

const ask = async (prompt: string) => {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Run this setup in a real terminal so the private key can stay hidden.");
  const readline = createInterface({ input: stdin, output: stdout });
  try { return (await readline.question(prompt)).trim(); }
  finally { readline.close(); }
};

const askSecret = async (prompt: string) => {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") throw new Error("A terminal with hidden input is required for the private key prompt.");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const restore = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          restore();
          reject(new Error("Setup cancelled."));
          return;
        }
        if (byte === 10 || byte === 13) {
          restore();
          resolve(value.trim());
          return;
        }
        if (byte === 8 || byte === 127) {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (byte >= 32 && byte <= 126) {
          value += String.fromCharCode(byte);
          stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
};

const readState = async (): Promise<TraderState> => {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<TraderState>;
    if (state.version !== 1 || !Array.isArray(state.attemptedMarkets) || (state.pending !== null && state.pending !== undefined)) {
      if (state.pending) throw new Error("A prior order request has an uncertain outcome. Check wallet positions, open orders, and activity before restarting. The pending marker is in the local trader state file.");
      throw new Error("The saved trader state is invalid; it will not be overwritten.");
    }
    return { version: 1, attemptedMarkets: state.attemptedMarkets.filter((entry): entry is string => typeof entry === "string").slice(-300), pending: null };
  } catch (error) {
    if (error instanceof Error && !("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    return { version: 1, attemptedMarkets: [], pending: null };
  }
};

const writeState = async (state: TraderState) => {
  const temp = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  await rename(temp, STATE_PATH);
};

const acquireLock = async () => {
  await mkdir(STORE_DIR, { recursive: true });
  try {
    const handle = await open(LOCK_PATH, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return async () => { await handle.close().catch(() => undefined); await rm(LOCK_PATH, { force: true }).catch(() => undefined); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Another trader process may be running. If it is stopped, remove ${LOCK_PATH} after checking its process first.`);
    throw error;
  }
};

const readPositions = async (wallet: string): Promise<PositionRow[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${DATA_API}/v2/positions?user=${encodeURIComponent(wallet)}&limit=100`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Polymarket position lookup returned ${response.status}.`);
    const payload = await response.json() as unknown;
    const rows = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data) ? (payload as { data: unknown[] }).data : null;
    if (!rows || rows.length >= 100) throw new Error("The complete position list could not be established; live orders are blocked.");
    return rows.map((row): PositionRow => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("A position row was unreadable; live orders are blocked.");
      const source = row as Record<string, unknown>;
      const tokenID = typeof (source.asset ?? source.asset_id ?? source.token_id) === "string" ? String(source.asset ?? source.asset_id ?? source.token_id) : null;
      const conditionId = typeof (source.conditionId ?? source.condition_id ?? source.market) === "string" ? String(source.conditionId ?? source.condition_id ?? source.market) : null;
      const slug = typeof (source.slug ?? source.eventSlug ?? source.event_slug) === "string" ? String(source.slug ?? source.eventSlug ?? source.event_slug) : null;
      const size = number(source.current_size ?? source.size ?? source.total_size);
      const averagePrice = number(source.avgPrice ?? source.avg_price ?? source.average_price);
      const initialValue = number(source.initialValue ?? source.initial_value ?? source.costBasis ?? source.cost_basis);
      if (size === null || size < 0) throw new Error("Position size was unreadable; live orders are blocked.");
      if (size > 0 && !tokenID && !conditionId && !slug) throw new Error("A position could not be mapped to its market; live orders are blocked.");
      const basis = averagePrice !== null && averagePrice > 0 && averagePrice <= 1 ? size * averagePrice : initialValue;
      if (size > 0 && (basis === null || basis <= 0)) throw new Error("Position cost basis was unreadable; live orders are blocked.");
      return { tokenID, conditionId, slug, size, averagePrice, exposureUsd: size > 0 ? Math.max(size * (averagePrice ?? 0), initialValue ?? 0) : 0 };
    }).filter((position) => position.size > 0);
  } finally { clearTimeout(timer); }
};

const readBalance = async (client: ClobClient) => {
  const payload = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const raw = number(payload.balance);
  if (raw === null || raw < 0) return null;
  return raw >= 1_000_000 ? raw / 1_000_000 : raw;
};

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("The live trader requires an interactive terminal.");
  console.log("\nPOLYMARKET LIVE TRADER · TERMINAL SETUP\n");
  console.log("This connects to the real CLOB. The private key is requested with hidden input, kept in memory only, and never saved by this program. Orders are FAK market orders and may partially fill or not fill. The model is uncalibrated and does not guarantee profit.\n");
  const walletAddress = await ask("Polymarket wallet address: ");
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) throw new Error("Enter a valid 0x wallet address.");
  console.log("\nSignature type: 0 EOA · 1 Polymarket Proxy · 2 Gnosis Safe · 3 contract wallet / deposit wallet.");
  const signatureInput = await ask("Signature type (0-3): ");
  const signatureType = Number(signatureInput);
  if (!Number.isInteger(signatureType) || signatureType < 0 || signatureType > 3) throw new Error("Choose one of the listed signature types.");
  const privateKey = await askSecret("Signer private key (input hidden): ");
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(privateKey)) throw new Error("The key must be exactly 32 bytes in hexadecimal format.");

  const unlock = await acquireLock();
  let stopStream: () => void = () => undefined;
  let exitListener: ((line: string) => void) | undefined;
  let inputInterface: ReturnType<typeof createInterface> | null = null;
  let stopSignalListener: (() => void) | undefined;
  try {
    const state = await readState();
    if (state.pending) throw new Error("A previous live order outcome remains unresolved. Reconcile the wallet before restarting.");
    const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`);
    if (signatureType === SignatureTypeV2.EOA && account.address.toLowerCase() !== walletAddress.toLowerCase()) throw new Error("Signature type 0 requires the wallet address to match the private-key signer.");
    const signer = createWalletClient({ account, chain: polygon, transport: http() });
    const bootstrap = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer, signatureType: signatureType as SignatureTypeV2, funderAddress: walletAddress, useServerTime: true, retryOnError: false, throwOnError: true });
    console.log("\nConnecting to Polymarket and reading your balance…");
    const rawCredentials = await bootstrap.createOrDeriveApiKey();
    const credentials = rawCredentials as ApiKeyCreds;
    if (!credentials.key || !credentials.secret || !credentials.passphrase) throw new Error("Polymarket returned incomplete account credentials.");
    const client = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer, creds: credentials, signatureType: signatureType as SignatureTypeV2, funderAddress: walletAddress, useServerTime: true, retryOnError: false, throwOnError: true });
    const [balance, orders, positions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
    if (balance === null) throw new Error("Polymarket did not return a readable collateral balance.");
    console.log(`\nWallet: ${walletAddress}`);
    console.log(`Signer: ${account.address} · signature type ${signatureType}`);
    console.log(`Available USDC: ${money(balance)}`);
    console.log(`Open positions: ${positions.length} · open orders: ${orders.length}`);
    if (positions.length) console.log(`Existing exposure: ${money(positions.reduce((sum, position) => sum + position.exposureUsd, 0))}`);
    if (orders.length) throw new Error("Open orders exist. Reconcile or cancel them in Polymarket, then restart the terminal trader.");
    if (balance < 1) throw new Error("Available USDC is below the $1 minimum executable stake.");

    console.log("\nLive guardrails: LOCK signals only · minimum 4% net edge · fee estimate at least 5% · 25 bps slippage · one position per market · one order at a time.");
    console.log("For balances up to $100 the unit is capped at $1 per entry; higher balances use a 1% unit, capped at $5. Total exposure is capped at 10% of the current balance.");
    const answer = await ask("Type YES to arm live trading: ");
    if (answer.toUpperCase() !== "YES") {
      console.log("Not armed. No order was placed.");
      return;
    }

    const priceTicks = new Map<string, PolymarketPriceTick>();
    const streamHealth: { status: PolymarketPriceStreamStatus } = { status: "CONNECTING" };
    let lastDiscoveryAt = 0;
    let definitions: Awaited<ReturnType<typeof discoverCryptoMarkets>> = [];
    let histories = new Map<Asset, CandleHistory>();
    let cycle = 0;
    const controller = new AbortController();
    const input = createInterface({ input: stdin, output: stdout, terminal: true });
    inputInterface = input;
    exitListener = (line: string) => {
      if (line.trim().toLowerCase() === "q" || line.trim().toLowerCase() === "quit") controller.abort(new Error("Stop requested."));
    };
    input.on("line", exitListener);
    stopSignalListener = () => controller.abort(new Error("Stop requested."));
    process.once("SIGINT", stopSignalListener);
    console.log("\nLIVE TRADER ARMED · scanning once per second · type Q and press Enter to stop.\n");
    let subscribedAssets = "";

    while (!controller.signal.aborted) {
      const now = Date.now();
      if (now - lastDiscoveryAt >= DISCOVERY_MS || !definitions.length) {
        try {
          const next = await discoverCryptoMarkets(controller.signal);
          const assets = [...new Set(next.map((market) => market.asset))].sort().join(",");
          if (assets !== subscribedAssets) {
            stopStream();
            subscribedAssets = assets;
            stopStream = subscribePolymarketPrices(next.map((market) => market.asset), (ticks) => {
              for (const tick of ticks) priceTicks.set(`${tick.asset}:${tick.priceFeed}:${tick.timestamp}`, tick);
              const cutoff = Date.now() - 24 * 60 * 60_000;
              for (const [key, tick] of priceTicks) if (tick.timestamp < cutoff) priceTicks.delete(key);
            }, (status) => { streamHealth.status = status; }, controller.signal);
          }
          definitions = next;
          lastDiscoveryAt = now;
        } catch (error) {
          console.log(`[${new Date().toLocaleTimeString()}] Market discovery held: ${scrubError(error, privateKey)}`);
          await sleep(1_000);
          continue;
        }
      }
      cycle += 1;
      const tokenIds = definitions.flatMap((market) => [market.upTokenId, market.downTokenId]);
      if (!definitions.length || !tokenIds.length) {
        if (cycle % 10 === 0) console.log(`[${new Date().toLocaleTimeString()}] No active supported crypto market.`);
        await sleep(SCAN_MS);
        continue;
      }
      try {
        const [books] = await Promise.all([fetchOrderBooks(tokenIds, controller.signal)]);
        if (cycle % 30 === 0) histories = await fetchCandleHistories([...new Set(definitions.map((market) => market.asset))], controller.signal);
        const ticks = [...priceTicks.values()];
        const candidates: Array<{ market: LiveMarket; signal: ReturnType<typeof analyzeMarketSignal> }> = [];
        for (const definition of definitions) {
          const market = applyPolymarketPriceTicks(buildLiveMarket(definition, books, new Map(), null, now, histories.get(definition.asset) ?? null), ticks, now);
          if (market.remaining < 30 || !RISK.allowedDurations.includes(market.duration) || streamHealth.status !== "CONNECTED") continue;
          const issue = marketDataFreshnessIssue(market, now);
          const signal = analyzeMarketSignal(market, { feeRate: RISK.feeRate, slippageBps: RISK.slippageBps }, Math.min(RISK.maxTradeUsd, balance), RISK.minEdge, now);
          if (!issue && signal.action !== "PASS" && signal.tier === "LOCK" && signal.edge !== null && signal.edge >= RISK.minEdge && !state.attemptedMarkets.includes(marketCycleKey(market))) candidates.push({ market, signal });
        }
        candidates.sort((left, right) => (right.signal.edge ?? -1) - (left.signal.edge ?? -1));
        const best = candidates[0];
        if (!best) {
          if (cycle % 15 === 0) console.log(`[${new Date().toLocaleTimeString()}] No fresh LOCK edge · oracle ${streamHealth.status.toLowerCase()} · ${definitions.length} markets scanned.`);
          await sleep(SCAN_MS);
          continue;
        }

        const [freshBalance, freshOrders, freshPositions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
        if (freshBalance === null || freshBalance < 1) throw new Error("The fresh collateral balance is unavailable or below $1; entries held.");
        if (freshOrders.length) throw new Error("An open order appeared during the scan. Stop and reconcile it in Polymarket.");
        const activeMarketPosition = freshPositions.find((position) => position.tokenID === best.market.upTokenId || position.tokenID === best.market.downTokenId || (best.market.conditionId && position.conditionId?.toLowerCase() === best.market.conditionId.toLowerCase()) || position.slug?.toLowerCase() === best.market.slug.toLowerCase());
        if (activeMarketPosition) {
          state.attemptedMarkets.push(marketCycleKey(best.market));
          await writeState(state);
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} ${best.market.duration} held: a position already exists in this market.`);
          await sleep(SCAN_MS);
          continue;
        }
        const side = best.signal.action;
        const tokenID = side === "UP" ? best.market.upTokenId : best.market.downTokenId;
        const probability = best.signal.fairUp === null ? null : side === "UP" ? best.signal.fairUp : 1 - best.signal.fairUp;
        const allInPrice = best.signal.executableCostProbability;
        if (probability === null || allInPrice === null || allInPrice >= 1) continue;
        const totalExposure = freshPositions.reduce((sum, position) => sum + position.exposureUsd, 0);
        const marketUnit = freshBalance <= 100 ? 1 : Math.min(5, freshBalance * 0.01);
        const kellyFraction = Math.max(0, (probability - allInPrice) / (1 - allInPrice)) * freshBalance * 0.25;
        const availableExposure = Math.max(0, freshBalance * 0.1 - totalExposure);
        const stake = Math.min(marketUnit, kellyFraction, availableExposure, freshBalance, RISK.maxTradeUsd);
        if (stake < 1) {
          state.attemptedMarkets.push(marketCycleKey(best.market));
          await writeState(state);
          console.log(`[${new Date().toLocaleTimeString()}] ${best.market.asset} ${best.market.duration} ${side} held: capped Kelly size ${money(stake)} is below the $1 venue minimum.`);
          await sleep(SCAN_MS);
          continue;
        }
        const marketBook = await client.getOrderBook(tokenID);
        const tickSize = marketBook.tick_size;
        if (!(new Set(["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"])).has(tickSize)) throw new Error("Unsupported CLOB tick size; no order submitted.");
        const clobTickSize = tickSize as TickSize;
        const bestAsk = (marketBook.asks ?? []).map((level) => Number(level.price)).filter((price) => Number.isFinite(price) && price > 0 && price < 1).sort((a, b) => a - b)[0];
        const estimate = best.signal.estimatedFill;
        if (bestAsk === undefined || !estimate) throw new Error("The fresh CLOB ask or estimated fill is unavailable.");
        const maxPrice = Math.floor(Math.min(estimate.price, bestAsk * (1 + RISK.slippageBps / 10_000)) / Number(tickSize) + 1e-9) * Number(tickSize);
        const decimals = tickSize.includes(".") ? tickSize.split(".")[1].length : 0;
        const limitPrice = Number(maxPrice.toFixed(decimals));
        if (limitPrice < bestAsk || limitPrice >= 1) throw new Error("The current ask exceeds the model price or slippage ceiling; no order submitted.");
        const marketKey = marketCycleKey(best.market);
        const requestId = randomUUID();
        state.pending = { requestId, marketId: marketKey, at: Date.now() };
        state.attemptedMarkets.push(marketKey);
        state.attemptedMarkets = state.attemptedMarkets.slice(-300);
        await writeState(state);
        console.log(`[${new Date().toLocaleTimeString()}] SUBMIT ${best.market.asset} ${best.market.duration} ${side} · ${money(stake)} max · net edge ${percent(best.signal.edge!)} · limit ${percent(limitPrice)} · FAK`);
        let response;
        try {
          response = await client.createAndPostMarketOrder({ tokenID, amount: stake, side: Side.BUY, price: limitPrice, orderType: OrderType.FAK, userUSDCBalance: freshBalance }, { tickSize: clobTickSize, negRisk: Boolean(marketBook.neg_risk) }, OrderType.FAK);
        } catch (error) {
          console.error(`Order outcome UNCERTAIN: ${scrubError(error, privateKey)}`);
          console.error(`The trader has halted. Check positions, open orders, and activity before removing the pending marker in ${STATE_PATH}.`);
          return;
        }
        try {
          const [afterBalance, afterOrders, afterPositions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
          if (afterBalance === null) throw new Error("Balance recheck returned no value.");
          const newPosition = afterPositions.find((position) => position.tokenID === tokenID);
          console.log(`Order response: ${response.success ? "accepted" : "rejected"} · status ${response.status ?? "—"} · shares ${response.takingAmount ?? "—"} · amount ${response.makingAmount ?? "—"}`);
          console.log(`Reconciled USDC ${money(afterBalance)} · positions ${afterPositions.length} · open orders ${afterOrders.length}${newPosition ? ` · ${side} position ${newPosition.size.toFixed(4)} shares` : ""}`);
          state.pending = null;
          await writeState(state);
        } catch (error) {
          console.error(`Order result could not be reconciled: ${scrubError(error, privateKey)}`);
          console.error(`The trader has halted and left a pending marker. Reconcile Polymarket before restarting: ${STATE_PATH}`);
          return;
        }
      } catch (error) {
        console.log(`[${new Date().toLocaleTimeString()}] Scan held safely: ${scrubError(error, privateKey)}`);
      }
      await sleep(SCAN_MS);
    }
    stopStream();
    console.log("\nTrader stopped. No new orders will be sent.");
  } finally {
    stopStream();
    if (inputInterface && exitListener) inputInterface.removeListener("line", exitListener);
    inputInterface?.close();
    if (stopSignalListener) process.removeListener("SIGINT", stopSignalListener);
    await unlock();
    void privateKey;
  }
}

main().catch((error) => {
  console.error(`Live trader stopped: ${scrubError(error, "")}`);
  process.exitCode = 1;
});
