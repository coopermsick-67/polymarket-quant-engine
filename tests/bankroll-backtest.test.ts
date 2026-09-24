import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_MODEL_VERSION, decisionLedgerCsv, type MarketDecisionRow } from "../app/lib/decision-ledger";
import { BANKROLL_REPLAY_BALANCES, parseBankrollBacktestCsv, runMultiBankrollBacktest, type BankrollBacktestRow } from "../app/lib/bankroll-backtest";

const start = Date.UTC(2026, 0, 1);
const row = (index: number, outcome: "UP" | "DOWN" | null = "UP", patch: Partial<BankrollBacktestRow> = {}): BankrollBacktestRow => ({
  timestamp: start + index * 200_000,
  marketId: `market-${index}`,
  asset: "BTC",
  duration: "5m",
  reference: 100,
  spot: 101,
  upAsk: 0.5,
  downAsk: 0.5,
  upBid: 0.495,
  downBid: 0.495,
  upDepthUsd: 1_000,
  downDepthUsd: 1_000,
  upBidDepthUsd: 1_000,
  downBidDepthUsd: 1_000,
  minOrderUsd: 1,
  minOrderShares: 1,
  modelVersion: ACTIVE_MODEL_VERSION,
  remainingSeconds: 120,
  modelAction: "UP",
  modelFairUp: 0.7,
  outcome,
  ...patch,
});

test("same recorded decisions replay through all eleven bankroll profiles", () => {
  const result = runMultiBankrollBacktest([row(0, "UP"), row(1, "DOWN"), row(2, "UP")]);
  assert.deepEqual(result.accounts.map((account) => account.startingBalanceUsd), [...BANKROLL_REPLAY_BALANCES]);
  assert.equal(result.accounts[0].tier, "MICRO");
  assert.equal(result.accounts[2].tier, "SMALL");
  assert.equal(result.accounts[4].tier, "GROWTH");
  assert.equal(result.accounts[5].tier, "STANDARD");
  assert.equal(result.accounts[7].tier, "LARGE");
  assert.ok(result.accounts[0].tradeDetails.every((trade) => trade.stakeUsd <= 1.00001));
  assert.ok(result.accounts[10].tradeDetails.every((trade) => trade.stakeUsd <= 50.00001));
  assert.equal(result.accounts[10].unsettled, 0);
  assert.equal(result.accounts[10].settled, result.accounts[10].trades);
  assert.ok(result.accounts[10].feesUsd > 0);
  assert.ok(result.accounts[10].slippageUsd > 0);
  assert.ok(result.accounts[10].maxDrawdown !== null);
  assert.equal(result.accounts[10].severeDrawdownProbability, null);
});

test("minimum order above small-account hard cap produces a PASS", () => {
  const result = runMultiBankrollBacktest([row(0, "UP", { minOrderUsd: 5, microScore: 0.7, biasConfidence: 0.7 })]);
  assert.equal(result.accounts[0].trades, 0);
  assert.equal(result.accounts[0].minimumOrderRejects, 1);
  assert.equal(result.accounts[4].trades, 0);
  assert.equal(result.accounts[4].minimumOrderRejects, 1);
  assert.equal(result.accounts[10].trades, 1);
});

test("missing executable order-book evidence does not fabricate fills", () => {
  const result = runMultiBankrollBacktest([row(0, "UP", { upDepthUsd: null, upBid: null, microScore: 0.7 })]);
  assert.ok(result.accounts.every((account) => account.trades === 0));
  assert.equal(result.accounts[0].passesByReason.MISSING_BID_OR_SPREAD, 1);
  assert.equal(result.accounts[0].winRate, null);
  assert.equal(result.accounts[0].brierScore, null);
});

test("unknown venue minimum blocks a replayed paper entry", () => {
  const result = runMultiBankrollBacktest([row(0, "UP", { minOrderUsd: null, minOrderShares: null, microScore: 0.7 })], { balances: [20] });
  assert.equal(result.accounts[0].trades, 0);
  assert.equal(result.accounts[0].passesByReason.MISSING_MINIMUM_ORDER, 1);
});

test("paper minimum and share minimum override sub-dollar replay assumptions", () => {
  const lowMinimum = row(0, "UP", { minOrderUsd: 0.5, minOrderShares: 0.5, microScore: 0.7 });
  const result = runMultiBankrollBacktest([lowMinimum], { balances: [20], minimumOrderUsd: 0.5 });
  assert.equal(result.accounts[0].trades, 0);
  assert.equal(result.accounts[0].minimumOrderRejects, 1);
  assert.match(result.assumptions.join(" "), /minimum is \$1\.00/);
});

test("replay consumes recorded ask levels and prices each bankroll at its executable VWAP", () => {
  const flatResult = runMultiBankrollBacktest([row(0, null, { modelFairUp: 0.9 })], { balances: [100] });
  const ladderResult = runMultiBankrollBacktest([row(0, null, {
    modelFairUp: 0.9,
    upAskLevels: [{ price: 0.5, size: 1 }, { price: 0.7, size: 100 }],
  })], { balances: [100] });
  const flat = flatResult.accounts[0];
  const ladder = ladderResult.accounts[0];
  assert.equal(flat.trades, 1);
  assert.equal(ladder.trades, 1);
  assert.ok(ladder.tradeDetails[0].entryCostPerShare > flat.tradeDetails[0].entryCostPerShare);
  assert.ok(ladder.tradeDetails[0].slippageUsd > 0);
  assert.ok(ladder.tradeDetails[0].shares < flat.tradeDetails[0].shares);
  assert.equal(ladderResult.entryRowsWithAskLadders, 1);
  assert.equal(flatResult.entryRowsUsingFixedPriceFallback, 1);
});

test("recorded ask ladders are consulted before a legacy modeled fill price", () => {
  const result = runMultiBankrollBacktest([row(0, null, {
    modelFairUp: 0.95,
    modelEntryPrice: 0.9,
    biasConfidence: 0.7,
    upAskLevels: [{ price: 0.5, size: 1 }, { price: 0.7, size: 100 }],
  })], { balances: [50, 100] });
  assert.ok(result.accounts.every((account) => account.trades === 1));
  assert.ok(result.accounts[0].tradeDetails[0].entryCostPerShare < 0.9);
});

test("bankroll-specific replay stakes walk different portions of the same ask ladder", () => {
  const result = runMultiBankrollBacktest([row(0, null, {
    modelFairUp: 0.95,
    biasConfidence: 0.7,
    upAskLevels: [{ price: 0.5, size: 2 }, { price: 0.65, size: 100 }],
  })], { balances: [50, 100] });
  const [small, growth] = result.accounts;
  assert.equal(small.trades, 1);
  assert.equal(growth.trades, 1);
  assert.ok(growth.tradeDetails[0].stakeUsd > small.tradeDetails[0].stakeUsd);
  assert.ok(growth.tradeDetails[0].entryCostPerShare > small.tradeDetails[0].entryCostPerShare);
  assert.ok(growth.tradeDetails[0].shares > small.tradeDetails[0].shares);
});

test("replay reduces the next stake after two same-day settled losses", () => {
  const losses = runMultiBankrollBacktest([
    row(0, "DOWN", { modelFairUp: 0.7, biasConfidence: 0.7 }),
    row(1, "DOWN", { modelFairUp: 0.7, biasConfidence: 0.7 }),
    row(2, "UP", { modelFairUp: 0.7, biasConfidence: 0.7 }),
  ], { balances: [5_000] }).accounts[0];
  const wins = runMultiBankrollBacktest([
    row(0, "UP", { modelFairUp: 0.7, biasConfidence: 0.7 }),
    row(1, "UP", { modelFairUp: 0.7, biasConfidence: 0.7 }),
    row(2, "UP", { modelFairUp: 0.7, biasConfidence: 0.7 }),
  ], { balances: [5_000] }).accounts[0];
  assert.equal(losses.trades, 3);
  assert.equal(wins.trades, 3);
  assert.ok(losses.tradeDetails[2].stakeUsd < wins.tradeDetails[2].stakeUsd);
});

test("replay rejects an ask ladder that cannot fill the approved minimum stake", () => {
  const result = runMultiBankrollBacktest([row(0, null, {
    modelFairUp: 0.9,
    upAskLevels: [{ price: 0.5, size: 1 }],
  })], { balances: [100] });
  assert.equal(result.accounts[0].trades, 0);
  assert.equal(result.accounts[0].passesByReason.RECORDED_ASK_LADDER_TOO_SHALLOW, 1);
});

test("missing settlement leaves ending equity and outcome metrics unavailable", () => {
  const result = runMultiBankrollBacktest([row(0, null, { microScore: 0.7, biasConfidence: 0.7 })], { balances: [50] });
  assert.equal(result.accounts[0].trades, 1);
  assert.equal(result.accounts[0].unsettled, 1);
  assert.equal(result.accounts[0].endingEquityUsd, null);
  assert.equal(result.accounts[0].totalReturn, null);
  assert.equal(result.accounts[0].winRate, null);
  assert.equal(result.datasetHasSettledOutcomes, false);
});

test("extended CSV parses recorded depth, spread, strategy evidence, exchange minimum and quoted market id", () => {
  const csv = `timestamp,asset,duration,market_id,reference,spot,up_ask,down_ask,up_bid,down_bid,up_depth_usd,down_depth_usd,remaining_seconds,validation_probability_up,validation_decision,outcome,min_order_shares,validation_micro_score,bias_confidence,model_version,up_bid_depth_usd,down_bid_depth_usd\n${start},BTC,5m,"market, one",100,101,0.5,0.5,0.495,0.49,1000,1000,120,0.7,UP,UP,5,0.72,0.64,${ACTIVE_MODEL_VERSION},1000,1000\n`;
  const parsed = parseBankrollBacktestCsv(csv);
  assert.equal(parsed.rejected, 0);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].marketId, "market, one");
  assert.equal(parsed.rows[0].upDepthUsd, 1000);
  assert.equal(parsed.rows[0].minOrderShares, 5);
  assert.equal(parsed.rows[0].microScore, 0.72);
  assert.equal(parsed.rows[0].biasConfidence, 0.64);
  assert.equal(parsed.rows[0].modelVersion, ACTIVE_MODEL_VERSION);
  assert.equal(parsed.rows[0].upBidDepthUsd, 1000);
});

test("replay applies MICRO and SMALL signal filters from recorded evidence", () => {
  const missingMicro = runMultiBankrollBacktest([row(0)], { balances: [40] });
  const alignedMicro = runMultiBankrollBacktest([row(0, "UP", { microScore: 0.7 })], { balances: [40] });
  const missingSmall = runMultiBankrollBacktest([row(0)], { balances: [50] });
  const supportedSmall = runMultiBankrollBacktest([row(0, "UP", { biasConfidence: 0.7 })], { balances: [50] });
  assert.equal(missingMicro.accounts[0].passesByReason.MICRO_TREND_FILTER, 1);
  assert.equal(alignedMicro.accounts[0].trades, 1);
  assert.equal(missingSmall.accounts[0].passesByReason.SMALL_CONFLUENCE_FILTER, 1);
  assert.equal(supportedSmall.accounts[0].trades, 1);
});

test("ledger CSV timestamp fallback keeps PASS rows with missing quote fields", () => {
  const csv = `validation_at_utc,observed_at_utc,asset,duration,market_id,reference,spot,up_ask,down_ask,validation_decision,initial_decision,outcome,remaining_seconds,model_version\n,2026-01-01T00:00:00.000Z,BTC,5m,m1,,,,,PASS,PASS,UP,120,${ACTIVE_MODEL_VERSION}\n`;
  const parsed = parseBankrollBacktestCsv(csv);
  assert.equal(parsed.rejected, 0);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].modelAction, "PASS");
  const result = runMultiBankrollBacktest(parsed.rows, { balances: [20] });
  assert.equal(result.accounts[0].passesByReason.NO_RECORDED_ENTRY, 1);
});

test("mixed model versions do not enter trades from another model", () => {
  const result = runMultiBankrollBacktest([
    row(0, "UP", { modelVersion: "legacy" }),
    row(1, "UP", { modelVersion: ACTIVE_MODEL_VERSION }),
    row(2, "UP", { modelVersion: null }),
  ], { balances: [100] });
  assert.equal(result.accounts[0].decisionRows, 1);
  assert.equal(result.accounts[0].trades, 1);
  assert.equal(result.recordedPredictions, 1);
  assert.equal(result.excludedModelVersionRows, 2);
});

test("replay strategy tier follows current liquidation equity after a settled loss", () => {
  const first = row(0, "DOWN", { modelAction: "UP", modelFairUp: 0.92 });
  const second = row(1, "UP", { biasConfidence: null, microScore: null });
  const result = runMultiBankrollBacktest([first, second], { balances: [100] });
  assert.equal(result.accounts[0].trades, 1);
  assert.equal(result.accounts[0].passesByReason.SMALL_CONFLUENCE_FILTER, 1);
  assert.equal(result.accounts[0].tier, "GROWTH");
  assert.equal(result.accounts[0].endingTier, "SMALL");
});

test("decision ledger exports validation-time book evidence that the replay parser can consume", () => {
  const ledgerRow: MarketDecisionRow = {
    id: "market-ledger", marketId: "market-ledger", observedAt: start, firstSeenAt: start, lastUpdatedAt: start,
    asset: "BTC", duration: "5m", slug: "btc-5m", question: "BTC up or down?", sourceUrl: "https://polymarket.com",
    decision: "UP", initialDecision: "UP", tier: "ENTRY", fairUp: 0.7, upEdge: 0.1, downEdge: null, edge: 0.1,
    entryPrice: 0.5, upAsk: 0.5, downAsk: 0.51, upBid: 0.49, downBid: 0.49,
    upDepthUsd: 100, downDepthUsd: 90, upBidDepthUsd: 40, downBidDepthUsd: 35,
    minOrderShares: 5, minOrderUsd: 2.5, reference: 100, spot: 101, remainingSeconds: 120,
    outcome: "UP", result: "WIN", outcomeAt: start + 300_000, simulatedStake: 2.5, simulatedUnits: 5,
    signalConfidence: 0.8, biasConfidence: 0.7, microScore: 0.72, trend5m: "UP", trend15m: "UP", reason: "test", changeCount: 0,
    modelVersion: ACTIVE_MODEL_VERSION, validationDecision: "UP", validationFairUp: 0.7, validationEdge: 0.1,
    validationEntryPrice: 0.5, validationStakeUsd: 2.5, validationAt: start,
    validationReference: 100, validationReferenceAt: start, validationSpot: 101, validationSpotAt: start + 750,
    validationUpAsk: 0.5, validationDownAsk: 0.51, validationUpBid: 0.49, validationDownBid: 0.49,
    validationUpDepthUsd: 100, validationDownDepthUsd: 90, validationUpBidDepthUsd: 40, validationDownBidDepthUsd: 35,
    validationMinOrderShares: 5, validationMinOrderUsd: 2.5, validationMicroScore: 0.72, validationBiasConfidence: 0.7,
    validationUpAskLevels: [{ price: 0.5, size: 5 }, { price: 0.51, size: 20 }],
    validationDownAskLevels: [{ price: 0.51, size: 5 }],
  };
  const csv = decisionLedgerCsv([ledgerRow]);
  const headers = csv.split("\n", 1)[0];
  assert.match(headers, /validation_up_bid/);
  assert.match(headers, /validation_up_depth_usd/);
  assert.match(headers, /validation_min_order_shares/);
  assert.match(headers, /validation_up_ask_levels_json/);
  const parsed = parseBankrollBacktestCsv(csv);
  assert.equal(parsed.rejected, 0);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].upAsk, 0.5);
  assert.equal(parsed.rows[0].reference, 100);
  assert.equal(parsed.rows[0].spot, 101);
  assert.equal(parsed.rows[0].upBid, 0.49);
  assert.equal(parsed.rows[0].upDepthUsd, 100);
  assert.equal(parsed.rows[0].upBidDepthUsd, 40);
  assert.equal(parsed.rows[0].minOrderShares, 5);
  assert.equal(parsed.rows[0].minOrderUsd, 2.5);
  assert.equal(parsed.rows[0].microScore, 0.72);
  assert.equal(parsed.rows[0].biasConfidence, 0.7);
  assert.deepEqual(parsed.rows[0].upAskLevels, [{ price: 0.5, size: 5 }, { price: 0.51, size: 20 }]);
  assert.deepEqual(parsed.rows[0].downAskLevels, [{ price: 0.51, size: 5 }]);
});

test("legacy decision-ledger rows do not substitute a later generic spot for missing validation data", () => {
  const csv = decisionLedgerCsv([{
    id: "legacy", marketId: "legacy", observedAt: start + 10_000, firstSeenAt: start, lastUpdatedAt: start + 10_000,
    asset: "BTC", duration: "5m", slug: "btc-5m", question: "BTC up?", sourceUrl: "https://polymarket.com",
    decision: "UP", initialDecision: "UP", tier: "ENTRY", fairUp: 0.7, upEdge: 0.1, downEdge: null, edge: 0.1,
    entryPrice: 0.5, upAsk: 0.5, downAsk: 0.5, upBid: 0.49, downBid: 0.49,
    upDepthUsd: 100, downDepthUsd: 100, upBidDepthUsd: 100, downBidDepthUsd: 100,
    minOrderShares: 1, minOrderUsd: 1, reference: 100, spot: 105, remainingSeconds: 120,
    outcome: null, result: "PENDING", outcomeAt: null, simulatedStake: 1, simulatedUnits: 2,
    signalConfidence: 0.8, biasConfidence: 0.7, trend5m: "UP", trend15m: "UP", reason: "legacy", changeCount: 0,
    modelVersion: ACTIVE_MODEL_VERSION, validationDecision: "UP", validationFairUp: 0.7, validationAt: start,
    validationReference: null, validationSpot: null,
  }]);
  const parsed = parseBankrollBacktestCsv(csv);
  assert.equal(parsed.rows[0].reference, null);
  assert.equal(parsed.rows[0].spot, null);
});

test("conflicting recorded outcomes cannot settle a market", () => {
  const result = runMultiBankrollBacktest([
    row(0, "UP"),
    row(0, "DOWN", { timestamp: start + 1_000 }),
  ], { balances: [20] });
  assert.equal(result.accounts[0].trades, 0);
  assert.equal(result.accounts[0].passesByReason.CONFLICTING_OUTCOME, 2);
  assert.equal(result.resolvedMarkets, 0);
});
