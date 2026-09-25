import assert from "node:assert/strict";
import test from "node:test";
import { parseBacktestCsv, parseHorizon, runBacktest, type BacktestRow } from "../app/lib/engines";
import { accountLinkPlan } from "../app/lib/account-link";

const params = { startingCash: 10, minEdge: 0, maxTrade: 10, feeRate: 0, slippageBps: 0 };
const decision = (overrides: Partial<BacktestRow>): BacktestRow => ({
  timestamp: 1_000_000, asset: "BTC", duration: "5m", reference: 100, spot: 100.1, upAsk: 0.5, downAsk: 0.5,
  outcome: "UP", remainingSeconds: 120, modelFairUp: 0.7, modelAction: "UP", ...overrides,
});

test("an entry settles at its market's expiry, so unresolved cash cannot be reused (audit B7 reproduction)", () => {
  const result = runBacktest([
    decision({ marketId: "a", timestamp: 1_000_000 }),
    decision({ marketId: "b", timestamp: 1_001_000 }),
  ], params);
  // Before: 2 settled trades, $20 P&L, equity [10, 20, 30].
  assert.equal(result.signals, 1, "the second market has no cash while the first is unresolved");
  assert.equal(result.settled, 1);
  assert.equal(result.netPnl, 10);
  assert.ok(Math.max(...result.equityCurve) <= 20);
});

test("a later market can reuse cash only after the earlier one expires", () => {
  const result = runBacktest([
    decision({ marketId: "a", timestamp: 1_000_000 }),
    decision({ marketId: "b", timestamp: 1_000_000 + 121_000 }),
  ], params);
  assert.equal(result.signals, 2);
  assert.equal(result.settled, 2);
});

test("blank CSV cells stay missing: no probability means no trade, and recorded edges are ignored (audit B8)", () => {
  const csv = [
    "timestamp,asset,duration,market_id,reference,spot,up_ask,down_ask,outcome,remaining_seconds,validation_probability_up,validation_decision,validation_edge",
    "1000,BTC,5m,a,100,100.1,0.5,0.5,UP,120,,UP,0.10",
    "1001,BTC,5m,b,100,100.1,0.5,0.5,UP,120,0.45,UP,0.50",
    "1002,BTC,5m,c,100,100.1,0.5,0.5,UP,120,0.70,,0.20",
  ].join("\n");
  const parsed = parseBacktestCsv(csv);
  assert.equal(parsed.rows[0].modelFairUp, null, "a blank probability is null, not 0");
  const result = runBacktest(parsed.rows, params);
  assert.equal(result.signals, 0, "blank probability, negative recomputed edge, and missing action all stay out");
  assert.equal(result.skippedWithoutModel, 2);
});

test("unsupported horizons are rejected rather than read as 5m", () => {
  assert.equal(parseHorizon("5m"), "5m");
  assert.equal(parseHorizon("15 min"), "15m");
  assert.equal(parseHorizon("60m"), null);
  assert.equal(parseHorizon("1h"), null);
  const parsed = parseBacktestCsv("timestamp,asset,duration,reference,spot,up_ask,down_ask\n1000,BTC,1h,100,100,0.5,0.5");
  assert.equal(parsed.rejected, 1);
});

test("fees follow each row's recorded rate and the result shows fee sensitivity", () => {
  const rows = [decision({ marketId: "a", feeRate: 0.07 })];
  const result = runBacktest(rows, { ...params, feeRate: 0 });
  const costPerShare = 0.5 + 0.07 * 0.25;
  assert.ok(Math.abs(result.netPnl! - (10 / costPerShare - 10)) < 1e-4);
  assert.equal(result.drawdownBasis, "SETTLEMENT");
  assert.deepEqual(result.feeSensitivity.map((entry) => entry.feeMultiplier), [0.5, 1.5]);
  assert.ok(result.feeSensitivity[0].netPnl! > result.netPnl! && result.feeSensitivity[1].netPnl! < result.netPnl!);
});

test("a hosted page never builds a request containing the signer key (audit B12)", () => {
  const connection = { walletAddress: "0x0000000000000000000000000000000000000001", privateKey: "ab".repeat(32), signatureType: "1" };
  const hosted = accountLinkPlan(connection, "quant.example.com");
  assert.equal(hosted.kind, "wallet-only");
  assert.ok(!JSON.stringify(hosted).includes(connection.privateKey));
  assert.ok(!("privateKey" in hosted.body));
  const local = accountLinkPlan(connection, "127.0.0.1");
  assert.equal(local.kind, "live-session");
});
