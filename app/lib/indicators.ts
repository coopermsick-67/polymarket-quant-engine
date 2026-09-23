// Chart indicators for display only. They are deliberately NOT inputs to fair
// value: nothing here has been shown to add out-of-sample lift on 5m/15m
// Up/Down markets. Add them back as model features only after calibration.

import { clamp, mean, standardDeviation } from "./num";
import type { Candle } from "./pricing";

export type TrendLabel = "UP" | "DOWN" | "MIXED" | "UNAVAILABLE";
export type TrendStats = { score: number; rsi: number; volatility: number };

const tanh = (value: number) => Math.tanh(clamp(value, -10, 10));

const ema = (values: number[], period: number) => {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  return values.slice(1).reduce((previous, value) => alpha * value + (1 - alpha) * previous, values[0]);
};

export const rsi = (closes: number[], period = 14) => {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-period - 1);
  const changes = recent.slice(1).map((close, index) => close - recent[index]);
  const averageGain = mean(changes.map((change) => Math.max(0, change)));
  const averageLoss = mean(changes.map((change) => Math.max(0, -change)));
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
};

export const trendStats = (history: Candle[], barSeconds: number, now: number): TrendStats | null => {
  const candles = history.filter((candle) => candle.timestamp + barSeconds * 1000 <= now && candle.close > 0 && candle.high >= candle.low).slice(-80);
  if (candles.length < 8) return null;
  const closes = candles.map((candle) => candle.close);
  const changes = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  const volatility = standardDeviation(changes.slice(-24));
  const rsiValue = rsi(closes, Math.min(14, closes.length - 1));
  if (volatility === null || volatility <= 0 || rsiValue === null) return null;
  const shortEma = ema(closes.slice(-8), 5);
  const longEma = ema(closes.slice(-24), 18);
  const atrCandles = candles.slice(-14);
  const atr = mean(
    atrCandles.map((candle, index) => {
      const previousClose = atrCandles[index - 1]?.close ?? candle.close;
      return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
    }),
  );
  const emaScore = shortEma !== null && longEma !== null && atr > 0 ? tanh(((shortEma - longEma) / atr) * 1.4) : 0;
  const recentReturn = Math.log(closes[closes.length - 1] / closes[Math.max(0, closes.length - 4)]);
  const momentumScore = tanh(recentReturn / (volatility * Math.sqrt(3) * 1.35));
  const rsiScore = clamp((rsiValue - 50) / 23, -1, 1);
  const score = clamp(emaScore * 0.45 + momentumScore * 0.35 + rsiScore * 0.2, -1, 1);
  return { score, rsi: rsiValue, volatility };
};

export const trendLabel = (stats: TrendStats | null): TrendLabel =>
  stats === null ? "UNAVAILABLE" : stats.score >= 0.16 ? "UP" : stats.score <= -0.16 ? "DOWN" : "MIXED";
