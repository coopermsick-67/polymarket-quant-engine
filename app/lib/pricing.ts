// Fair-value, fee, and volatility primitives for Polymarket crypto Up/Down
// markets. Everything here is pure and deterministic so the live engine, the
// headless runner, and the replay backtester share one implementation.

import { clamp, normalCdf } from "./num";

export type PriceTick = { timestamp: number; price: number };

/**
 * Per-market fee schedule as published by Gamma (`feeSchedule`).
 * Fee per share = rate * (p * (1 - p)) ^ exponent, the same formula the
 * official @polymarket/clob-client-v2 uses in `adjustBuyAmountForFees`.
 */
export type FeeSchedule = { rate: number; exponent: number; takerOnly: boolean; rebateRate: number };

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 };

export const takerFeePerShare = (price: number, schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE): number => {
  if (!(price > 0 && price < 1)) return 0;
  return Math.max(0, schedule.rate) * (price * (1 - price)) ** Math.max(0, schedule.exponent);
};

export const makerFeePerShare = (price: number, schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE): number =>
  schedule.takerOnly ? 0 : takerFeePerShare(price, schedule);

export type SettlementSpec = {
  /** Chainlink TWAP lookback. 0 means point-price settlement. */
  lookbackSeconds: number;
};

export type SettlementDistribution = {
  /** Expected settlement value (TWAP or point) in price units. */
  mean: number;
  /** Standard deviation of the settlement value in price units. */
  sd: number;
  remainingSeconds: number;
  /** Seconds of the final averaging window already observed. */
  observedSeconds: number;
  /** Share of the observed window actually covered by ticks (1 = complete). */
  observedCoverage: number;
};

/**
 * Distribution of the settlement value under zero-drift Brownian motion in
 * relative terms. For a TWAP over the last L seconds, with tau seconds left:
 *
 *   TWAP = (o/L) * observedAverage + (f/L) * S * (1 + X)
 *   o = max(0, L - tau)   seconds of the window already printed
 *   f = min(tau, L)       seconds of the window still in the future
 *   g = max(0, tau - L)   gap before the window opens
 *   Var(X) = sigma^2 * (g + f / 3)
 *
 * which gives Var = sigma^2 (tau - 2L/3) S^2 before the window opens and
 * sigma^2 tau^3 / (3 L^2) S^2 inside it.
 */
export const settlementDistribution = (input: {
  spot: number;
  now: number;
  endTime: number;
  sigmaPerSqrtSecond: number;
  spec: SettlementSpec;
  ticks?: PriceTick[];
}): SettlementDistribution => {
  const remainingSeconds = Math.max(0, (input.endTime - input.now) / 1000);
  const sigma = Math.max(0, input.sigmaPerSqrtSecond);
  const lookback = Math.max(0, input.spec.lookbackSeconds);
  if (lookback <= 0) {
    return { mean: input.spot, sd: input.spot * sigma * Math.sqrt(remainingSeconds), remainingSeconds, observedSeconds: 0, observedCoverage: 1 };
  }
  const observedSeconds = Math.max(0, lookback - remainingSeconds);
  const futureSeconds = Math.min(remainingSeconds, lookback);
  const gapSeconds = Math.max(0, remainingSeconds - lookback);

  let observedAverage = input.spot;
  let observedCoverage = observedSeconds > 0 ? 0 : 1;
  if (observedSeconds > 0) {
    const windowStart = input.endTime - lookback * 1000;
    const inWindow = (input.ticks ?? []).filter((tick) => tick.timestamp > windowStart && tick.timestamp <= input.now && tick.price > 0);
    if (inWindow.length) {
      // Chainlink streams print about once per second; weight each tick equally,
      // which matches a per-second TWAP when the feed has no gaps.
      observedAverage = inWindow.reduce((sum, tick) => sum + tick.price, 0) / inWindow.length;
      observedCoverage = clamp(inWindow.length / Math.max(1, Math.floor(observedSeconds)), 0, 1);
    }
  }
  const mean = (observedSeconds / lookback) * observedAverage + (futureSeconds / lookback) * input.spot;
  const sd = (futureSeconds / lookback) * input.spot * sigma * Math.sqrt(gapSeconds + futureSeconds / 3);
  return { mean, sd, remainingSeconds, observedSeconds, observedCoverage };
};

/** P(settlement >= reference). Polymarket resolves ties to Up. */
export const probabilityUp = (distribution: SettlementDistribution, reference: number): number => {
  if (!(reference > 0)) return 0.5;
  if (distribution.sd <= 0 || !Number.isFinite(distribution.sd)) return distribution.mean >= reference ? 1 : 0;
  return normalCdf((distribution.mean - reference) / distribution.sd);
};

export type FairValue = {
  /** Central P(UP). */
  pUp: number;
  /** P(UP) under low and high volatility scenarios; the robust band. */
  pUpLowVol: number;
  pUpHighVol: number;
  distribution: SettlementDistribution;
};

export const fairValue = (input: {
  reference: number;
  spot: number;
  now: number;
  endTime: number;
  sigmaPerSqrtSecond: number;
  spec: SettlementSpec;
  ticks?: PriceTick[];
  /** Relative volatility uncertainty for the robust band, e.g. 0.3 = +/-30%. */
  volUncertainty?: number;
}): FairValue => {
  const uncertainty = clamp(input.volUncertainty ?? 0.3, 0, 0.9);
  const at = (sigma: number) => settlementDistribution({ ...input, sigmaPerSqrtSecond: sigma });
  const distribution = at(input.sigmaPerSqrtSecond);
  return {
    pUp: probabilityUp(distribution, input.reference),
    pUpLowVol: probabilityUp(at(input.sigmaPerSqrtSecond * (1 - uncertainty)), input.reference),
    pUpHighVol: probabilityUp(at(input.sigmaPerSqrtSecond * (1 + uncertainty)), input.reference),
    distribution,
  };
};

/** Worst-case probability for a side across the volatility band. */
export const conservativeSideProbability = (fair: FairValue, side: "UP" | "DOWN") => {
  const ups = [fair.pUp, fair.pUpLowVol, fair.pUpHighVol];
  return side === "UP" ? Math.min(...ups) : 1 - Math.max(...ups);
};

export type VolEstimate = {
  sigmaPerSqrtSecond: number;
  source: "TICKS" | "CANDLES" | "BLEND";
  tickReturns: number;
};

/**
 * EWMA realized volatility from roughly 1 Hz ticks, normalized per sqrt(second).
 * Returns null when there are too few usable returns.
 */
export const ewmaTickVolatility = (ticks: PriceTick[], halfLifeSeconds = 300, minReturns = 60): { sigma: number; returns: number } | null => {
  const clean = ticks.filter((tick) => tick.price > 0 && Number.isFinite(tick.timestamp)).sort((left, right) => left.timestamp - right.timestamp);
  if (clean.length < minReturns + 1) return null;
  const lambda = Math.pow(0.5, 1 / Math.max(1, halfLifeSeconds));
  let variance = 0;
  let weight = 0;
  let returns = 0;
  for (let index = 1; index < clean.length; index += 1) {
    const dt = (clean[index].timestamp - clean[index - 1].timestamp) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const r = Math.log(clean[index].price / clean[index - 1].price);
    const decay = Math.pow(lambda, dt);
    variance = variance * decay + (r * r) / dt;
    weight = weight * decay + 1;
    returns += 1;
  }
  if (returns < minReturns || weight <= 0) return null;
  const sigma = Math.sqrt(variance / weight);
  return Number.isFinite(sigma) && sigma > 0 ? { sigma, returns } : null;
};

export type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

/** Garman-Klass volatility per sqrt(second) from completed OHLC bars. */
export const garmanKlassVolatility = (candles: Candle[], barSeconds: number, now: number, bars = 24): number | null => {
  const completed = candles
    .filter((candle) => candle.timestamp + barSeconds * 1000 <= now && candle.open > 0 && candle.close > 0 && candle.high >= candle.low && candle.low > 0)
    .slice(-bars);
  if (completed.length < Math.min(12, bars)) return null;
  const perBar =
    completed.reduce((sum, candle) => {
      const hl = Math.log(candle.high / candle.low);
      const co = Math.log(candle.close / candle.open);
      return sum + 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
    }, 0) / completed.length;
  if (!(perBar > 0)) return null;
  return Math.sqrt(perBar / barSeconds);
};

/**
 * Blend tick-based and candle-based volatility. Tick data dominates once there
 * are a few hundred returns; candles anchor the estimate on a cold start.
 */
export const blendVolatility = (tickVol: { sigma: number; returns: number } | null, candleSigma: number | null, floor = 2e-6): VolEstimate | null => {
  if (!tickVol && candleSigma === null) return null;
  if (tickVol && candleSigma === null) return { sigmaPerSqrtSecond: Math.max(floor, tickVol.sigma), source: "TICKS", tickReturns: tickVol.returns };
  if (!tickVol && candleSigma !== null) return { sigmaPerSqrtSecond: Math.max(floor, candleSigma), source: "CANDLES", tickReturns: 0 };
  const weight = tickVol!.returns / (tickVol!.returns + 300);
  const variance = weight * tickVol!.sigma ** 2 + (1 - weight) * candleSigma! ** 2;
  return { sigmaPerSqrtSecond: Math.max(floor, Math.sqrt(variance)), source: "BLEND", tickReturns: tickVol!.returns };
};

/** Blend a model probability with the market-implied probability in log-odds space. */
export const shrinkToMarket = (modelP: number, marketP: number | null, modelWeight: number) => {
  if (marketP === null || !(marketP > 0 && marketP < 1)) return modelP;
  const w = clamp(modelWeight, 0, 1);
  const lo = (p: number) => Math.log(clamp(p, 1e-6, 1 - 1e-6) / (1 - clamp(p, 1e-6, 1 - 1e-6)));
  const blended = w * lo(modelP) + (1 - w) * lo(marketP);
  return 1 / (1 + Math.exp(-blended));
};
