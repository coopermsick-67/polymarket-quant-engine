import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkMarketBuyShares } from "../../app/lib/live-order-sizing";

test("BUY share preflight matches the CLOB SDK amount precision", () => {
  // $1.67 / $0.333 is rounded down to five decimals by clob-client-v2.
  assert.equal(sdkMarketBuyShares(1.67, 0.333, "0.001"), 5.01501);
});

test("the $1 BUY notional floor is included in requested shares", () => {
  assert.equal(sdkMarketBuyShares(1, 0.1, "0.001"), 10);
});

test("unsupported ticks and invalid order inputs fail closed", () => {
  assert.equal(sdkMarketBuyShares(1, 0.5, "0.03"), 0);
  assert.equal(sdkMarketBuyShares(1, 0, "0.01"), 0);
  assert.equal(sdkMarketBuyShares(Number.NaN, 0.5, "0.01"), 0);
});
