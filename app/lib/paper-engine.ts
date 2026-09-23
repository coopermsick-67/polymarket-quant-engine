// One step of the paper/shadow trading loop, shared by the browser and the
// headless runner. Decisions are made on the current snapshot, but fills are
// simulated `latencyMs` later against the book that exists then, at the
// decision's limit price: the same mechanics as a live FAK limit order.

import type { DerivedFeed } from "./feeds";
import {
  accountEquity,
  buyPaper,
  closePaperPositions,
  exposureCheck,
  haltState,
  markAccount,
  settleResolvedPaperPositions,
  type PaperAccount,
} from "./engines";
import { DEFAULT_PAPER_EARLY_EXIT, normalizeEarlyExitPolicy, type EarlyExitPolicy } from "./early-exit";
import { clamp, finiteNumber } from "./num";
import { snapshotFromLiveMarket, type LiveMarket, type Resolution } from "./polymarket-data";
import { DEFAULT_SIGNAL_PARAMS, evaluateExit, evaluateSignal, normalizeSignalParams, type Horizon, type Side, type Signal, type SignalParams } from "./signal";

export type PaperConfig = EarlyExitPolicy & {
  signal: SignalParams;
  stakeUsd: number;
  latencyMs: number;
  dailyLossPct: number;
  maxDrawdownPct: number;
  maxOpenExposurePct: number;
  maxSameWindowSameSide: number;
  allowedDurations: Horizon[];
  allowedAssets: string[] | null;
};

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  ...DEFAULT_PAPER_EARLY_EXIT,
  signal: DEFAULT_SIGNAL_PARAMS,
  stakeUsd: 25,
  latencyMs: 750,
  dailyLossPct: 0.05,
  maxDrawdownPct: 0.15,
  maxOpenExposurePct: 0.25,
  maxSameWindowSameSide: 2,
  allowedDurations: ["5m", "15m"],
  allowedAssets: null,
};

export const normalizePaperConfig = (input: Partial<PaperConfig> | null | undefined): PaperConfig => {
  const d = DEFAULT_PAPER_CONFIG;
  const num = (value: unknown, fallback: number, min: number, max: number) => clamp(finiteNumber(value) ?? fallback, min, max);
  const durations = Array.isArray(input?.allowedDurations)
    ? input.allowedDurations.filter((value): value is Horizon => value === "5m" || value === "15m")
    : d.allowedDurations;
  return {
    ...normalizeEarlyExitPolicy(input, d),
    signal: normalizeSignalParams({ ...d.signal, ...(input?.signal ?? {}) }),
    stakeUsd: num(input?.stakeUsd, d.stakeUsd, 1, 10_000),
    latencyMs: num(input?.latencyMs, d.latencyMs, 0, 10_000),
    dailyLossPct: num(input?.dailyLossPct, d.dailyLossPct, 0.005, 1),
    maxDrawdownPct: num(input?.maxDrawdownPct, d.maxDrawdownPct, 0.01, 1),
    maxOpenExposurePct: num(input?.maxOpenExposurePct, d.maxOpenExposurePct, 0.01, 1),
    maxSameWindowSameSide: Math.round(num(input?.maxSameWindowSameSide, d.maxSameWindowSameSide, 1, 8)),
    allowedDurations: durations.length ? durations : d.allowedDurations,
    allowedAssets: Array.isArray(input?.allowedAssets) && input.allowedAssets.length ? input.allowedAssets : null,
  };
};

export type PendingOrder = {
  marketId: string;
  side: Side;
  limitPrice: number;
  budget: number;
  probability: number;
  decidedAt: number;
  executeAt: number;
  reason: string;
};

export type PaperEngineState = {
  account: PaperAccount;
  pending: PendingOrder[];
  exitObservations: Record<string, { count: number; lastSeen: number }>;
  halt: { reason: string; at: number } | null;
};

export type PaperEvent = {
  kind: "fill" | "miss" | "settle" | "exit" | "halt" | "order";
  tone: "positive" | "warning" | "negative" | "neutral";
  title: string;
  detail: string;
};

export type PaperStepInput = {
  markets: Map<string, LiveMarket>;
  feed: (asset: string) => DerivedFeed | null;
  resolutions: Map<string, Resolution>;
  config: PaperConfig;
  now: number;
  autoTrade: boolean;
};

export const createEngineState = (account: PaperAccount): PaperEngineState => ({ account, pending: [], exitObservations: {}, halt: null });

const money = (value: number) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;

export const stepPaperEngine = (
  state: PaperEngineState,
  input: PaperStepInput,
): { state: PaperEngineState; events: PaperEvent[]; decisions: Map<string, Signal> } => {
  const { markets, config, now } = input;
  const events: PaperEvent[] = [];
  const decisions = new Map<string, Signal>();
  let account = state.account;
  let pending = state.pending;
  const exitObservations = { ...state.exitObservations };
  let halt = state.halt;

  // 1. Settle positions whose markets have an official resolution.
  const settled = settleResolvedPaperPositions(account, input.resolutions, "official resolution", now);
  if (settled.closed) {
    account = settled.account;
    events.push({
      kind: "settle",
      tone: settled.realized >= 0 ? "positive" : "negative",
      title: `${settled.closed} position(s) settled`,
      detail: `${money(settled.realized)} realized on official Polymarket outcomes.`,
    });
  }

  // 2. Fill orders whose simulated latency has elapsed, at their limit price.
  const due = pending.filter((order) => order.executeAt <= now);
  pending = pending.filter((order) => order.executeAt > now);
  for (const order of due) {
    const market = markets.get(order.marketId);
    if (!market || market.endTime <= now) {
      events.push({ kind: "miss", tone: "warning", title: "Order expired", detail: `${order.marketId} closed before the simulated fill.` });
      continue;
    }
    const result = buyPaper(
      account,
      market,
      order.side,
      order.budget,
      { slippageBps: config.signal.slippageBps, limitPrice: order.limitPrice, probability: order.probability, reason: order.reason },
      now,
    );
    if (!result.fill) {
      events.push({
        kind: "miss",
        tone: "warning",
        title: `${market.asset} ${market.duration} ${order.side} not filled`,
        detail: `Book moved above the ${order.limitPrice.toFixed(3)} limit during ${now - order.decidedAt}ms of latency.`,
      });
      continue;
    }
    account = result.account;
    events.push({
      kind: "fill",
      tone: "positive",
      title: `${market.asset} ${market.duration} ${order.side} filled`,
      detail: `${result.fill.shares.toFixed(2)} sh @ ${(result.fill.avgPrice * 100).toFixed(1)}¢ (all-in ${(result.fill.costPerShare * 100).toFixed(1)}¢, limit ${order.limitPrice.toFixed(3)}).`,
    });
  }

  account = markAccount(account, markets, now);
  const equity = accountEquity(account, markets);

  // 3. Loss limits. Once halted, the engine stays halted until explicitly reset.
  const risk = haltState(account, equity, { dailyLossPct: config.dailyLossPct, maxDrawdownPct: config.maxDrawdownPct });
  if (risk.halted && !halt) {
    halt = { reason: risk.reason ?? "Risk limit hit.", at: now };
    pending = [];
    events.push({ kind: "halt", tone: "negative", title: "Paper risk halt", detail: halt.reason });
  }

  // 4. Model-aware early exits, confirmed over consecutive observations.
  if (config.earlyExitEnabled) {
    const exitIds = new Set<string>();
    for (const position of account.positions) {
      const market = markets.get(position.marketId);
      const feed = market ? input.feed(market.asset) : null;
      if (!market) continue;
      const exit = evaluateExit({
        snapshot: snapshotFromLiveMarket(market, feed, now),
        side: position.side,
        shares: position.shares,
        entryCostPerShare: position.avgEntry,
        params: config.signal,
        minGap: config.earlyExitModelGap,
        minProfitUsd: config.earlyExitMinProfitUsd,
        minProfitPct: config.earlyExitMinProfitPct,
        minRemainingSeconds: config.earlyExitMinRemainingSeconds,
      });
      if (!exit.shouldExit) {
        delete exitObservations[position.id];
        continue;
      }
      const previous = exitObservations[position.id];
      const count = previous && now - previous.lastSeen <= 15_000 ? previous.count + 1 : 1;
      exitObservations[position.id] = { count, lastSeen: now };
      if (count >= config.earlyExitConfirmations) exitIds.add(position.id);
    }
    if (exitIds.size) {
      const closed = closePaperPositions(account, markets, { slippageBps: config.signal.slippageBps, reason: "model-aware early exit" }, now, exitIds);
      if (closed.closed) {
        account = closed.account;
        for (const id of exitIds) delete exitObservations[id];
        events.push({
          kind: "exit",
          tone: closed.realized >= 0 ? "positive" : "warning",
          title: "Model-aware cashout",
          detail: `${closed.closed} position(s) sold into the bid; ${money(closed.realized)} realized.`,
        });
      }
    }
  }

  // 5. Evaluate every market (for the ledger) and queue at most one new entry.
  let best: { market: LiveMarket; signal: Signal } | null = null;
  for (const market of markets.values()) {
    if (market.endTime <= now || market.startTime > now) continue;
    const signal = evaluateSignal(snapshotFromLiveMarket(market, input.feed(market.asset), now), {
      ...config.signal,
      budgetUsd: Math.min(config.stakeUsd, Math.max(1, account.cash)),
    });
    decisions.set(market.id, signal);
    if (signal.action === "PASS" || !signal.chosen) continue;
    if (!config.allowedDurations.includes(market.duration) || (config.allowedAssets && !config.allowedAssets.includes(market.asset))) continue;
    if (pending.some((order) => order.marketId === market.id)) continue;
    if (!best || (signal.chosen.edge ?? 0) > (best.signal.chosen?.edge ?? 0)) best = { market, signal };
  }
  if (input.autoTrade && !halt && best?.signal.chosen?.fill && best.signal.chosen.limitPrice !== null && best.signal.action !== "PASS") {
    const chosen = best.signal.chosen;
    const budget = Math.min(config.stakeUsd, account.cash);
    const blocked = exposureCheck(account, equity, best.market, best.signal.action as Side, budget, {
      maxOpenExposurePct: config.maxOpenExposurePct,
      maxSameWindowSameSide: config.maxSameWindowSameSide,
    });
    if (!blocked && budget >= 1) {
      pending = [
        ...pending,
        {
          marketId: best.market.id,
          side: best.signal.action as Side,
          limitPrice: chosen.limitPrice!,
          budget,
          probability: chosen.conservativeProbability,
          decidedAt: now,
          executeAt: now + config.latencyMs,
          reason: `${best.signal.tier} · edge ${((chosen.edge ?? 0) * 100).toFixed(1)}pt`,
        },
      ];
      events.push({
        kind: "order",
        tone: "neutral",
        title: `${best.market.asset} ${best.market.duration} ${best.signal.action} order`,
        detail: `Limit ${chosen.limitPrice!.toFixed(3)}, fair ${(chosen.conservativeProbability * 100).toFixed(1)}%, edge ${((chosen.edge ?? 0) * 100).toFixed(1)}pt; fills after ${config.latencyMs}ms.`,
      });
    }
  }

  return { state: { account, pending, exitObservations, halt }, events, decisions };
};
