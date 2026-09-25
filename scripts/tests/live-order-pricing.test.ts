import assert from "node:assert/strict";
import { test } from "node:test";
import { bidLiquidationValue, modelPriceCeiling, quoteMinimumShareBuy, quoteSell, takerFeePerShare, toleranceTicksFor } from "../../app/lib/live-order-pricing";

const CLOB_FEES = { rate: 0.07, exponent: 1, feesEnabled: true, source: "CLOB" as const };

test("the model ceiling is the highest tick whose all-in cost still clears the edge floor", () => {
  const ceiling = modelPriceCeiling({ fairProbability: 0.7, minEdge: 0.04, tickSize: 0.01, slippageBps: 25, feeSchedule: CLOB_FEES, fallbackFeeRate: 0.05 })!;
  const allIn = (price: number) => price * 1.0025 + takerFeePerShare(price, CLOB_FEES, 0.05);
  assert.ok(allIn(ceiling) <= 0.66 + 1e-12);
  assert.ok(allIn(ceiling + 0.01) > 0.66);
});

test("a buy limit may sit a couple of ticks past the observed ask, but never above the model ceiling", () => {
  const base = { venueMinimumShares: 5, floorShares: 5, tickSize: "0.01", minEdge: 0.04, slippageBps: 25, toleranceTicks: 2, feeSchedule: CLOB_FEES, fallbackFeeRate: 0.05 };
  const asks = [{ price: 0.5, size: 100 }];
  const roomy = quoteMinimumShareBuy({ ...base, asks, fairProbability: 0.8 })!;
  assert.equal(roomy.limitPrice, 0.52, "two ticks of tolerance above the 50c ask");
  const tight = quoteMinimumShareBuy({ ...base, asks, fairProbability: 0.56 })!;
  assert.ok(tight.limitPrice >= 0.5 && tight.limitPrice <= tight.modelCeiling);
  assert.equal(quoteMinimumShareBuy({ ...base, asks, fairProbability: 0.52 }), null, "no order when the ask is already above the ceiling");
  assert.ok(roomy.worstTotalCostUsd <= roomy.amountUsd + roomy.requestedShares * 0.07 * 0.25 + 0.01);
});

test("a sell limit allows the same tick tolerance below the best bid", () => {
  const quote = quoteSell({ bids: [{ price: 0.6, size: 3 }, { price: 0.59, size: 10 }], shares: 8, tickSize: "0.01", toleranceTicks: 2, minimumShares: 5 })!;
  assert.equal(quote.limitPrice, 0.58);
  assert.equal(quote.shares, 8);
  assert.equal(quoteSell({ bids: [{ price: 0.6, size: 3 }], shares: 8, tickSize: "0.01", toleranceTicks: 2, minimumShares: 5 }), null);
});

test("a coarse tick can never widen a limit past two cents (a 0.60 bid with a 0.10 tick sells at 0.60, not 0.40)", () => {
  assert.equal(toleranceTicksFor(2, 0.1), 0);
  assert.equal(toleranceTicksFor(2, 0.01), 2);
  assert.equal(toleranceTicksFor(2, 0.005), 2);
  const coarse = quoteSell({ bids: [{ price: 0.6, size: 10 }], shares: 5, tickSize: "0.1", toleranceTicks: 2, minimumShares: 5, feeSchedule: CLOB_FEES })!;
  assert.equal(coarse.limitPrice, 0.6);
  const buy = quoteMinimumShareBuy({ asks: [{ price: 0.5, size: 100 }], venueMinimumShares: 5, floorShares: 5, tickSize: "0.1", fairProbability: 0.95,
    minEdge: 0.04, slippageBps: 25, toleranceTicks: 2, feeSchedule: CLOB_FEES, fallbackFeeRate: 0.05 })!;
  assert.equal(buy.limitPrice, 0.5);
});

test("sell quotes report the worst proceeds the posted limit allows, after fees", () => {
  const quote = quoteSell({ bids: [{ price: 0.6, size: 3 }, { price: 0.59, size: 10 }], shares: 8, tickSize: "0.01", toleranceTicks: 2, minimumShares: 5, feeSchedule: CLOB_FEES })!;
  assert.ok(Math.abs(quote.worstProceedsUsd - 8 * (0.58 - 0.07 * 0.58 * 0.42)) < 1e-9);
});

test("liquidation value walks the bids, charges fees, and values shares beyond depth at zero", () => {
  const value = bidLiquidationValue([{ price: 0.5, size: 4 }, { price: 0.4, size: 2 }], 10, CLOB_FEES, 0.05);
  const expected = 4 * (0.5 - 0.07 * 0.25) + 2 * (0.4 - 0.07 * 0.24);
  assert.ok(Math.abs(value - expected) < 1e-9);
  assert.equal(bidLiquidationValue([], 10, CLOB_FEES, 0.05), 0);
});
