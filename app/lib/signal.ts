// The single decision function used by the browser terminal, the live order
// route, the headless runner, and the replay backtester.
//
// Pipeline: data-quality gates -> settlement-distribution fair value with a volatility band
// -> shrink toward the market-implied probability -> depth-walked, fee-curve
// execution cost -> limit price that preserves the required edge -> side choice.

import { clamp, roundToTick } from "./num";
import { conservativeSideProbability, fairValue, shrinkToMarket, takerFeePerShare, type FairValue, type FeeSchedule, type PriceTick } from "./pricing";

export type Side = "UP" | "DOWN";
export type Horizon = "5m" | "15m";
export type BookLevel = { price: number; size: number };
export type SnapshotBook = { bids: BookLevel[]; asks: BookLevel[]; timestamp: number | null };
export type ReferenceSource = "CHAINLINK" | "ESTIMATE" | "MISSING";
/**
 * ANCHORED: exchange ticks shifted onto the Chainlink settlement stream (best).
 * EXCHANGE: exchange ticks without a stream anchor.
 * STREAM:   only the averaged Chainlink stream (degraded).
 */
export type SpotSource = "ANCHORED" | "EXCHANGE" | "STREAM" | "MISSING";

export type MarketSnapshot = {
  marketId: string;
  asset: string;
  duration: Horizon;
  startTime: number;
  endTime: number;
  now: number;
  reference: number | null;
  referenceSource: ReferenceSource;
  /** Best estimate of the instantaneous underlying (see feeds.ts). */
  spot: number | null;
  spotTimestamp: number | null;
  spotSource: SpotSource;
  /** Latest stream value minus the trailing exchange mean; a feed-health breaker. */
  basisBps: number | null;
  /** Basis-adjusted 1 Hz underlying ticks (also used for any averaged-settlement window). */
  ticks: PriceTick[];
  sigmaPerSqrtSecond: number | null;
  /** 1 s returns behind sigma; undefined for imported data. */
  volSamples?: number;
  /** Averaging window of the settlement value; 0 = point (what the published prices show). */
  settlementLookbackSeconds: number;
  feeSchedule: FeeSchedule;
  tickSize: number;
  minOrderSize: number;
  up: SnapshotBook;
  down: SnapshotBook;
};

export type SignalParams = {
  budgetUsd: number;
  /** Required edge per share after fees and slippage, in probability points. */
  minEdge: number;
  /** Weight of the model vs the market in log-odds; 1 = ignore the market. */
  modelWeight: number;
  volUncertainty: number;
  slippageBps: number;
  minEntryPrice: number;
  maxEntryPrice: number;
  maxSpread: number;
  minRemainingSeconds: number;
  maxSpotAgeMs: number;
  maxBookAgeMs: number;
  maxDivergenceBps: number;
  allowEstimatedReference: boolean;
  /**
   * Require exchange ticks anchored to the Chainlink stream. Unanchored feeds carry
   * a basis error of several bp, which is larger than a minute of BTC volatility.
   */
  requireAnchoredFeed: boolean;
  /** Minimum 1 s tick returns before trading (startup trades were the worst in live runs). */
  minVolSamples: number;
  /**
   * Probability that the official outcome disagrees with the published open/close prices.
   * Measured 2/56 in live data; pulls extreme probabilities toward 50%.
   */
  resolutionNoise: number;
  strongEdgeMultiple: number;
};

export const DEFAULT_SIGNAL_PARAMS: SignalParams = {
  budgetUsd: 25,
  minEdge: 0.03,
  modelWeight: 0.5,
  volUncertainty: 0.3,
  slippageBps: 10,
  minEntryPrice: 0.05,
  maxEntryPrice: 0.97,
  maxSpread: 0.06,
  minRemainingSeconds: 15,
  maxSpotAgeMs: 4_000,
  maxBookAgeMs: 15_000,
  maxDivergenceBps: 30,
  allowEstimatedReference: false,
  requireAnchoredFeed: true,
  minVolSamples: 300,
  resolutionNoise: 0.02,
  strongEdgeMultiple: 2,
};

export const normalizeSignalParams = (input: Partial<SignalParams> | null | undefined): SignalParams => {
  const d = DEFAULT_SIGNAL_PARAMS;
  const num = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
  return {
    budgetUsd: num(input?.budgetUsd, d.budgetUsd, 1, 10_000),
    minEdge: num(input?.minEdge, d.minEdge, 0.005, 0.3),
    modelWeight: num(input?.modelWeight, d.modelWeight, 0, 1),
    volUncertainty: num(input?.volUncertainty, d.volUncertainty, 0, 0.9),
    slippageBps: num(input?.slippageBps, d.slippageBps, 0, 200),
    minEntryPrice: num(input?.minEntryPrice, d.minEntryPrice, 0.01, 0.5),
    maxEntryPrice: num(input?.maxEntryPrice, d.maxEntryPrice, 0.5, 0.995),
    maxSpread: num(input?.maxSpread, d.maxSpread, 0.005, 0.5),
    minRemainingSeconds: num(input?.minRemainingSeconds, d.minRemainingSeconds, 1, 600),
    maxSpotAgeMs: num(input?.maxSpotAgeMs, d.maxSpotAgeMs, 500, 120_000),
    maxBookAgeMs: num(input?.maxBookAgeMs, d.maxBookAgeMs, 500, 300_000),
    maxDivergenceBps: num(input?.maxDivergenceBps, d.maxDivergenceBps, 1, 1_000),
    allowEstimatedReference: typeof input?.allowEstimatedReference === "boolean" ? input.allowEstimatedReference : d.allowEstimatedReference,
    requireAnchoredFeed: typeof input?.requireAnchoredFeed === "boolean" ? input.requireAnchoredFeed : d.requireAnchoredFeed,
    minVolSamples: num(input?.minVolSamples, d.minVolSamples, 0, 3_600),
    resolutionNoise: num(input?.resolutionNoise, d.resolutionNoise, 0, 0.2),
    strongEdgeMultiple: num(input?.strongEdgeMultiple, d.strongEdgeMultiple, 1, 10),
  };
};

export type FillEstimate = {
  shares: number;
  /** Volume-weighted price including slippage, excluding fees. */
  avgPrice: number;
  notional: number;
  fee: number;
  totalCost: number;
  /** (notional + fee) / shares: what one share really costs. */
  costPerShare: number;
  worstPrice: number;
  levels: number;
};

const bestAsk = (book: SnapshotBook) => (book.asks.length ? Math.min(...book.asks.map((level) => level.price)) : null);
const bestBid = (book: SnapshotBook) => (book.bids.length ? Math.max(...book.bids.map((level) => level.price)) : null);

/**
 * Walk the asks with a USDC budget that must cover price, slippage, and the
 * per-share taker fee at each level. Levels above `limitPrice` are never taken.
 */
export const simulateBuy = (
  asks: BookLevel[],
  budget: number,
  schedule: FeeSchedule,
  slippageBps: number,
  limitPrice = 1,
  minOrderSize = 0,
): FillEstimate | null => {
  if (!(budget > 0)) return null;
  const slip = 1 + Math.max(0, slippageBps) / 10_000;
  let remaining = budget;
  let shares = 0;
  let notional = 0;
  let fee = 0;
  let worstPrice = 0;
  let levels = 0;
  for (const level of [...asks].sort((left, right) => left.price - right.price)) {
    if (level.price > limitPrice + 1e-9) break;
    const price = Math.min(0.999, level.price * slip);
    const perShare = price + takerFeePerShare(level.price, schedule);
    const take = Math.min(level.size, remaining / perShare);
    if (take <= 1e-9) break;
    shares += take;
    notional += take * price;
    fee += take * takerFeePerShare(level.price, schedule);
    remaining -= take * perShare;
    worstPrice = level.price;
    levels += 1;
    if (remaining <= 1e-9) break;
  }
  if (shares <= 0 || shares + 1e-9 < minOrderSize) return null;
  return { shares, avgPrice: notional / shares, notional, fee, totalCost: notional + fee, costPerShare: (notional + fee) / shares, worstPrice, levels };
};

/** Walk the bids to sell `shares`; proceeds are net of the taker fee. */
export const simulateSell = (
  bids: BookLevel[],
  shares: number,
  schedule: FeeSchedule,
  slippageBps: number,
  limitPrice = 0,
): { shares: number; avgPrice: number; proceeds: number; fee: number; netProceeds: number; worstPrice: number } | null => {
  if (!(shares > 0)) return null;
  const slip = 1 - Math.max(0, slippageBps) / 10_000;
  let remaining = shares;
  let sold = 0;
  let proceeds = 0;
  let fee = 0;
  let worstPrice = 1;
  for (const level of [...bids].sort((left, right) => right.price - left.price)) {
    if (level.price < limitPrice - 1e-9) break;
    const take = Math.min(level.size, remaining);
    if (take <= 1e-9) break;
    sold += take;
    proceeds += take * level.price * slip;
    fee += take * takerFeePerShare(level.price, schedule);
    remaining -= take;
    worstPrice = level.price;
    if (remaining <= 1e-9) break;
  }
  if (sold <= 0) return null;
  return { shares: sold, avgPrice: proceeds / sold, proceeds, fee, netProceeds: proceeds - fee, worstPrice };
};

/**
 * Highest price on the tick grid at which one share still carries `requiredEdge`
 * after slippage and the fee curve: p - price*(1+slip) - fee(price) >= requiredEdge.
 */
export const maxPriceForEdge = (probability: number, requiredEdge: number, schedule: FeeSchedule, slippageBps: number, tickSize: number) => {
  const slip = 1 + Math.max(0, slippageBps) / 10_000;
  const tick = tickSize > 0 ? tickSize : 0.01;
  for (let price = roundToTick(Math.min(0.999, probability), tick, "down"); price >= tick - 1e-12; price = roundToTick(price - tick, tick, "down")) {
    if (probability - price * slip - takerFeePerShare(price, schedule) >= requiredEdge - 1e-12) return price;
  }
  return null;
};

export const marketImpliedUp = (snapshot: Pick<MarketSnapshot, "up" | "down">): number | null => {
  const mids: number[] = [];
  const upBid = bestBid(snapshot.up);
  const upAsk = bestAsk(snapshot.up);
  const downBid = bestBid(snapshot.down);
  const downAsk = bestAsk(snapshot.down);
  if (upBid !== null && upAsk !== null && upAsk - upBid <= 0.2) mids.push((upBid + upAsk) / 2);
  if (downBid !== null && downAsk !== null && downAsk - downBid <= 0.2) mids.push(1 - (downBid + downAsk) / 2);
  if (!mids.length) return null;
  return clamp(mids.reduce((sum, value) => sum + value, 0) / mids.length, 0.001, 0.999);
};

export type SideEvaluation = {
  side: Side;
  modelProbability: number;
  /** Posterior after blending with the market. */
  probability: number;
  /** Worst case across the volatility band, then blended. */
  conservativeProbability: number;
  bestAsk: number | null;
  bestBid: number | null;
  spread: number | null;
  limitPrice: number | null;
  fill: FillEstimate | null;
  edge: number | null;
};

export type Signal = {
  action: Side | "PASS";
  tier: "LOCK" | "ENTRY" | "PASS";
  reason: string;
  gate: string;
  pUpModel: number | null;
  pUpPosterior: number | null;
  pUpMarket: number | null;
  pUpBand: [number, number] | null;
  sides: Record<Side, SideEvaluation | null>;
  requiredEdge: number;
  chosen: SideEvaluation | null;
  fair: FairValue | null;
  remainingSeconds: number;
};

const pass = (gate: string, reason: string, partial: Partial<Signal> & { requiredEdge: number; remainingSeconds: number }): Signal => ({
  action: "PASS",
  tier: "PASS",
  gate,
  reason,
  pUpModel: null,
  pUpPosterior: null,
  pUpMarket: null,
  pUpBand: null,
  sides: { UP: null, DOWN: null },
  chosen: null,
  fair: null,
  ...partial,
});

export const evaluateSignal = (snapshot: MarketSnapshot, inputParams: Partial<SignalParams> = {}): Signal => {
  const params = normalizeSignalParams({ ...DEFAULT_SIGNAL_PARAMS, ...inputParams });
  const remainingSeconds = Math.max(0, (snapshot.endTime - snapshot.now) / 1000);
  let requiredEdge = params.minEdge;
  const base = { requiredEdge, remainingSeconds };

  if (snapshot.reference === null || !(snapshot.reference > 0) || snapshot.referenceSource === "MISSING") {
    return pass("REFERENCE", "No verified price to beat for this window yet.", base);
  }
  if (snapshot.referenceSource === "ESTIMATE") {
    if (!params.allowEstimatedReference)
      return pass("REFERENCE", "Only an estimated price to beat is available; entries require the official Chainlink open.", base);
    requiredEdge += 0.03;
  }
  if (snapshot.spot === null || !(snapshot.spot > 0) || snapshot.spotTimestamp === null || snapshot.spotSource === "MISSING")
    return pass("SPOT", "No usable price feed.", base);
  if (snapshot.now - snapshot.spotTimestamp > params.maxSpotAgeMs)
    return pass("STALE_SPOT", `Price feed is ${Math.round((snapshot.now - snapshot.spotTimestamp) / 1000)}s old.`, base);
  if (params.requireAnchoredFeed && snapshot.spotSource !== "ANCHORED") {
    return pass(
      "UNANCHORED",
      `Price feed is ${snapshot.spotSource}, not anchored to the Chainlink settlement stream; the basis error is too large to trade.`,
      base,
    );
  }
  if (snapshot.spotSource === "EXCHANGE") requiredEdge += 0.02;
  if (snapshot.spotSource === "STREAM") requiredEdge += 0.03;
  if (snapshot.basisBps !== null && Math.abs(snapshot.basisBps) > params.maxDivergenceBps) {
    return pass("DIVERGENCE", `Chainlink stream and exchange prices diverge by ${snapshot.basisBps.toFixed(1)}bp; feed is suspect.`, base);
  }
  if (snapshot.sigmaPerSqrtSecond === null || !(snapshot.sigmaPerSqrtSecond > 0)) return pass("VOLATILITY", "Volatility estimate unavailable.", base);
  if (snapshot.volSamples !== undefined && snapshot.volSamples < params.minVolSamples) {
    return pass("WARMUP", `Warming up: ${snapshot.volSamples}/${params.minVolSamples} tick returns behind the volatility estimate.`, base);
  }
  if (remainingSeconds < params.minRemainingSeconds) return pass("TIME", "Too little time remains to execute safely.", base);
  const bookAge = (book: SnapshotBook) => (book.timestamp === null ? 0 : snapshot.now - book.timestamp);
  if (Math.max(bookAge(snapshot.up), bookAge(snapshot.down)) > params.maxBookAgeMs) return pass("STALE_BOOK", "Order book snapshot is stale.", base);

  const rawFair = fairValue({
    reference: snapshot.reference,
    spot: snapshot.spot,
    now: snapshot.now,
    endTime: snapshot.endTime,
    sigmaPerSqrtSecond: snapshot.sigmaPerSqrtSecond,
    spec: { lookbackSeconds: snapshot.settlementLookbackSeconds },
    ticks: snapshot.ticks,
    volUncertainty: params.volUncertainty,
  });
  const noisy = (p: number) => params.resolutionNoise + (1 - 2 * params.resolutionNoise) * p;
  const fair: FairValue = { ...rawFair, pUp: noisy(rawFair.pUp), pUpLowVol: noisy(rawFair.pUpLowVol), pUpHighVol: noisy(rawFair.pUpHighVol) };
  if (snapshot.settlementLookbackSeconds > 0 && fair.distribution.observedSeconds > 5 && fair.distribution.observedCoverage < 0.8) {
    requiredEdge += 0.02;
  }
  const pUpMarket = marketImpliedUp(snapshot);
  const pUpPosterior = shrinkToMarket(fair.pUp, pUpMarket, params.modelWeight);
  const band: [number, number] = [Math.min(fair.pUpLowVol, fair.pUpHighVol, fair.pUp), Math.max(fair.pUpLowVol, fair.pUpHighVol, fair.pUp)];

  const evaluateSide = (side: Side): SideEvaluation => {
    const book = side === "UP" ? snapshot.up : snapshot.down;
    const modelProbability = side === "UP" ? fair.pUp : 1 - fair.pUp;
    const marketSide = pUpMarket === null ? null : side === "UP" ? pUpMarket : 1 - pUpMarket;
    const probability = shrinkToMarket(modelProbability, marketSide, params.modelWeight);
    const conservativeProbability = shrinkToMarket(conservativeSideProbability(fair, side), marketSide, params.modelWeight);
    const ask = bestAsk(book);
    const bid = bestBid(book);
    const limitPrice = maxPriceForEdge(conservativeProbability, requiredEdge, snapshot.feeSchedule, params.slippageBps, snapshot.tickSize);
    const fill =
      limitPrice === null
        ? null
        : simulateBuy(book.asks, params.budgetUsd, snapshot.feeSchedule, params.slippageBps, Math.min(limitPrice, params.maxEntryPrice), snapshot.minOrderSize);
    return {
      side,
      modelProbability,
      probability,
      conservativeProbability,
      bestAsk: ask,
      bestBid: bid,
      spread: ask !== null && bid !== null ? ask - bid : null,
      limitPrice,
      fill,
      edge: fill
        ? conservativeProbability - fill.costPerShare
        : ask !== null
          ? conservativeProbability - ask - takerFeePerShare(ask, snapshot.feeSchedule)
          : null,
    };
  };
  const sides = { UP: evaluateSide("UP"), DOWN: evaluateSide("DOWN") };
  const common = { requiredEdge, remainingSeconds, pUpModel: fair.pUp, pUpPosterior, pUpMarket, pUpBand: band, sides, fair };

  const eligible = (Object.values(sides) as SideEvaluation[])
    .filter((evaluation) => evaluation.fill !== null && evaluation.edge !== null)
    .sort((left, right) => (right.edge ?? -1) - (left.edge ?? -1));
  const best = eligible[0];
  if (!best || !best.fill || best.edge === null) {
    const nearest = (Object.values(sides) as SideEvaluation[]).sort((left, right) => (right.edge ?? -1) - (left.edge ?? -1))[0];
    const detail =
      nearest?.edge !== null && nearest?.edge !== undefined ? ` Best available edge is ${(nearest.edge * 100).toFixed(1)}pt on ${nearest.side}.` : "";
    return {
      ...pass("EDGE", `No side clears the ${(requiredEdge * 100).toFixed(1)}pt edge floor after fees at executable prices.${detail}`, common),
      ...common,
      action: "PASS",
      tier: "PASS",
    };
  }
  if (best.fill.avgPrice < params.minEntryPrice) {
    return {
      ...pass("TAIL", `${best.side} is a ${(best.fill.avgPrice * 100).toFixed(1)}¢ tail; below the ${(params.minEntryPrice * 100).toFixed(0)}¢ floor.`, common),
      ...common,
      action: "PASS",
      tier: "PASS",
    };
  }
  if (best.spread === null || best.spread > params.maxSpread) {
    return { ...pass("SPREAD", `${best.side} spread is too wide for a reliable entry.`, common), ...common, action: "PASS", tier: "PASS" };
  }
  const strong = snapshot.referenceSource === "CHAINLINK" && snapshot.spotSource === "ANCHORED" && best.edge >= requiredEdge * params.strongEdgeMultiple;
  return {
    ...common,
    action: best.side,
    tier: strong ? "LOCK" : "ENTRY",
    gate: "PASSED",
    chosen: best,
    reason: `${best.side} fair ${(best.conservativeProbability * 100).toFixed(1)}% (worst case over the vol band, blended with the book) vs ${(best.fill.costPerShare * 100).toFixed(1)}¢ all-in cost; edge ${(best.edge * 100).toFixed(1)}pt, limit ${best.limitPrice?.toFixed(3)}.`,
  };
};

/** Exit rule: sell when the executable bid (net of fees) beats the model by a margin. */
export const evaluateExit = (input: {
  snapshot: MarketSnapshot;
  side: Side;
  shares: number;
  entryCostPerShare: number;
  params?: Partial<SignalParams>;
  minGap: number;
  minProfitUsd: number;
  minProfitPct: number;
  minRemainingSeconds: number;
}) => {
  const signal = evaluateSignal(input.snapshot, { ...input.params, budgetUsd: 1 });
  const evaluation = signal.sides[input.side];
  const book = input.side === "UP" ? input.snapshot.up : input.snapshot.down;
  const params = normalizeSignalParams(input.params);
  const sale = simulateSell(book.bids, input.shares, input.snapshot.feeSchedule, params.slippageBps);
  const remainingSeconds = Math.max(0, (input.snapshot.endTime - input.snapshot.now) / 1000);
  const probability = evaluation?.probability ?? null;
  const base = { sale, probability, remainingSeconds };
  if (!sale || probability === null)
    return {
      ...base,
      shouldExit: false,
      reason: "No executable bid or no model probability.",
      limitPrice: null as number | null,
      netProfit: null as number | null,
    };
  const netPerShare = sale.netProceeds / sale.shares;
  const gap = netPerShare - probability;
  const netProfit = sale.netProceeds - input.entryCostPerShare * sale.shares;
  const profitPct = input.entryCostPerShare > 0 ? netProfit / (input.entryCostPerShare * sale.shares) : 0;
  const limitPrice = roundToTick(Math.max(0.001, probability + input.minGap), input.snapshot.tickSize || 0.01, "up");
  const result = { ...base, gap, netProfit, profitPct, limitPrice };
  if (remainingSeconds < input.minRemainingSeconds) return { ...result, shouldExit: false, reason: "Too little time remains for an early exit." };
  if (gap < input.minGap) return { ...result, shouldExit: false, reason: "The bid is not sufficiently above model fair value." };
  if (netProfit < input.minProfitUsd || profitPct < input.minProfitPct)
    return { ...result, shouldExit: false, reason: "Cashout profit is below the configured thresholds." };
  return {
    ...result,
    shouldExit: true,
    reason: `Bid nets ${(netPerShare * 100).toFixed(1)}¢ vs ${(probability * 100).toFixed(1)}% fair; cash out ${netProfit.toFixed(2)}.`,
  };
};
