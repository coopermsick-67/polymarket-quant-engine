import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPriceCeiling, quoteMinimumShareBuy, quoteSell, takerFeePerShare } from "../../app/lib/live-order-pricing";
import { reconcileFakWithOrderStatus } from "../../app/lib/fak-fill-reconciliation";

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

test("the CLOB order record decides a FAK fill even while the wallet view lags", () => {
  const lagging = reconcileFakWithOrderStatus({ side: "BUY", requestedShares: 5, clobMatchedShares: 5, walletShares: 0, responseShares: 5, accepted: true });
  assert.deepEqual([lagging.status, lagging.filledShares, lagging.source], ["FULL", 5, "CLOB"]);
  const partial = reconcileFakWithOrderStatus({ side: "SELL", requestedShares: 5, clobMatchedShares: 2, walletShares: 2, responseShares: 0, accepted: true });
  assert.equal(partial.status, "PARTIAL");
  const noFill = reconcileFakWithOrderStatus({ side: "BUY", requestedShares: 5, clobMatchedShares: 0, walletShares: 0, responseShares: 0, accepted: true });
  assert.equal(noFill.status, "NO_FILL");
  const extra = reconcileFakWithOrderStatus({ side: "BUY", requestedShares: 5, clobMatchedShares: 5, walletShares: 9, responseShares: 5, accepted: true });
  assert.equal(extra.status, "UNCERTAIN", "more wallet shares than the order matched means something else traded");
  const fallback = reconcileFakWithOrderStatus({ side: "BUY", requestedShares: 5, clobMatchedShares: null, walletShares: 0, responseShares: 0, accepted: true });
  assert.deepEqual([fallback.status, fallback.source], ["UNCERTAIN", "WALLET"]);
});
