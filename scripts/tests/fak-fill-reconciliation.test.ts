import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileFakBuyFill, reconcileFakSellFill } from "../../app/lib/fak-fill-reconciliation";

test("FAK buy reconciles full and partial fills from wallet share deltas", () => {
  assert.deepEqual(reconcileFakBuyFill({ requestedShares: 5, walletPositionDelta: 5, responseShares: 5, accepted: true }),
    { status: "FULL", filledShares: 5 });
  assert.deepEqual(reconcileFakBuyFill({ requestedShares: 7, walletPositionDelta: 3, responseShares: 3, accepted: true }),
    { status: "PARTIAL", filledShares: 3 });
});

test("FAK buy never treats an acceptance without a wallet fill as a completed order", () => {
  assert.deepEqual(reconcileFakBuyFill({ requestedShares: 5, walletPositionDelta: 0, responseShares: 0, accepted: true }),
    { status: "UNCERTAIN", filledShares: 0 });
  assert.deepEqual(reconcileFakBuyFill({ requestedShares: 5, walletPositionDelta: 0, responseShares: 0, accepted: false }),
    { status: "NO_FILL", filledShares: 0 });
  assert.equal(reconcileFakBuyFill({ requestedShares: 5, walletPositionDelta: 2, responseShares: 4, accepted: true }).status, "UNCERTAIN");
});

test("FAK sell records partial share reductions and rejects unverified accepted orders", () => {
  assert.deepEqual(reconcileFakSellFill({ requestedShares: 8, walletSharesSold: 4, accepted: true }),
    { status: "PARTIAL", filledShares: 4 });
  assert.deepEqual(reconcileFakSellFill({ requestedShares: 8, walletSharesSold: 0, accepted: false }),
    { status: "NO_FILL", filledShares: 0 });
  assert.equal(reconcileFakSellFill({ requestedShares: 8, walletSharesSold: 0, accepted: true }).status, "UNCERTAIN");
});
