import assert from "node:assert/strict";
import { test } from "node:test";
import { decideSettlement, isValidJournalOrder, MAX_SETTLEMENT_WAIT_MS, reservedExposureUsd, type JournalOrder } from "../../app/lib/live-order-journal";
import { collateralUsdFromRaw } from "../../app/lib/collateral";
import { updateRiskBaselines } from "../../app/lib/live-risk-baselines";

const NOW = 1_790_000_000_000;
const buy: JournalOrder = {
  requestId: "r1", marketId: "m1:1", tokenID: "tok", action: "BUY", requestedShares: 5, limitPrice: 0.52, reservedUsd: 2.7,
  baselineShares: 0, phase: "SETTLING", submittedAt: NOW - 5_000, orderID: "o1",
};

test("a CLOB match is not a fill until its trades are terminal", () => {
  const decision = decideSettlement({ order: buy, matchedShares: 5, orderStillOpen: false, walletShares: 0, now: NOW,
    trades: [{ id: "t1", status: "MATCHED", size: 5 }] });
  assert.equal(decision.kind, "WAIT");
  const mined = decideSettlement({ order: buy, matchedShares: 5, orderStillOpen: false, walletShares: 5, now: NOW,
    trades: [{ id: "t1", status: "MINED", size: 5 }] });
  assert.equal(mined.kind, "WAIT");
});

test("confirmed trades still wait for the wallet view to catch up, then settle", () => {
  const lagging = decideSettlement({ order: buy, matchedShares: 5, orderStillOpen: false, walletShares: 0, now: NOW,
    trades: [{ id: "t1", status: "CONFIRMED", size: 5 }] });
  assert.equal(lagging.kind, "WAIT");
  assert.match((lagging as { reason: string }).reason, /wallet view/);
  const settled = decideSettlement({ order: buy, matchedShares: 5, orderStillOpen: false, walletShares: 5, now: NOW,
    trades: [{ id: "t1", status: "CONFIRMED", size: 5 }] });
  assert.deepEqual(settled, { kind: "SETTLED", filledShares: 5, failedShares: 0 });
});

test("a confirmed order reconciles after a long restart, while unresolved evidence times out", () => {
  const oldOrder = { ...buy, submittedAt: NOW - MAX_SETTLEMENT_WAIT_MS - 1 };
  assert.deepEqual(decideSettlement({ order: oldOrder, matchedShares: 5, orderStillOpen: false, walletShares: 5, now: NOW,
    trades: [{ id: "t1", status: "CONFIRMED", size: 5 }] }), { kind: "SETTLED", filledShares: 5, failedShares: 0 });
  assert.equal(decideSettlement({ order: oldOrder, matchedShares: 5, orderStillOpen: false, walletShares: 0, now: NOW,
    trades: [{ id: "t1", status: "CONFIRMED", size: 5 }] }).kind, "HALT");
});

test("a trade that fails on-chain is not counted as a fill", () => {
  const decision = decideSettlement({ order: buy, matchedShares: 5, orderStillOpen: false, walletShares: 2, now: NOW,
    trades: [{ id: "t1", status: "CONFIRMED", size: 2 }, { id: "t2", status: "FAILED", size: 3 }] });
  assert.deepEqual(decision, { kind: "SETTLED", filledShares: 2, failedShares: 3 });
});

test("partial fills, unmatched FAKs, and open remainders are handled explicitly", () => {
  assert.deepEqual(decideSettlement({ order: buy, matchedShares: 0, orderStillOpen: false, walletShares: 0, now: NOW, trades: [] }),
    { kind: "SETTLED", filledShares: 0, failedShares: 0 });
  assert.equal(decideSettlement({ order: buy, matchedShares: 2, orderStillOpen: true, walletShares: 0, now: NOW, trades: [] }).kind, "WAIT");
  assert.equal(decideSettlement({ order: buy, matchedShares: null, orderStillOpen: false, walletShares: 0, now: NOW, trades: [] }).kind, "WAIT");
});

test("unexpected wallet movement or a stuck order halts for a human", () => {
  assert.equal(decideSettlement({ order: buy, matchedShares: 0, orderStillOpen: false, walletShares: 3, now: NOW, trades: [] }).kind, "HALT");
  assert.equal(decideSettlement({ order: buy, matchedShares: 5, orderStillOpen: false, walletShares: 9, now: NOW,
    trades: [{ id: "t1", status: "CONFIRMED", size: 5 }] }).kind, "HALT");
  assert.equal(decideSettlement({ order: { ...buy, submittedAt: NOW - MAX_SETTLEMENT_WAIT_MS - 1 }, matchedShares: 5, orderStillOpen: false,
    walletShares: 0, now: NOW, trades: [{ id: "t1", status: "MATCHED", size: 5 }] }).kind, "HALT");
});

test("sells reconcile shares shed from the pre-order baseline", () => {
  const sell: JournalOrder = { ...buy, action: "SELL", reservedUsd: 0, baselineShares: 8 };
  assert.deepEqual(decideSettlement({ order: sell, matchedShares: 8, orderStillOpen: false, walletShares: 0, now: NOW,
    trades: [{ id: "t1", status: "CONFIRMED", size: 8 }] }), { kind: "SETTLED", filledShares: 8, failedShares: 0 });
  assert.equal(reservedExposureUsd(sell), 0);
  assert.equal(reservedExposureUsd(buy), 2.7);
});

test("only a SETTLING order with an order ID survives a restart", () => {
  assert.equal(isValidJournalOrder(buy), true);
  assert.equal(isValidJournalOrder({ ...buy, orderID: undefined }), false);
  assert.equal(isValidJournalOrder({ ...buy, phase: "SUBMITTING", orderID: undefined }), true);
  assert.equal(isValidJournalOrder({ requestId: "old", marketId: "m", at: 1, action: "BUY", tokenID: "t", shares: 5 }), false);
});

test("collateral balances are always raw six-decimal units", () => {
  assert.equal(collateralUsdFromRaw("0"), 0);
  assert.equal(collateralUsdFromRaw("1"), 0.000001);
  assert.equal(collateralUsdFromRaw("500000"), 0.5);
  assert.equal(collateralUsdFromRaw("999999"), 0.999999);
  assert.equal(collateralUsdFromRaw("1000000"), 1);
  assert.equal(collateralUsdFromRaw("25000000"), 25);
  assert.equal(collateralUsdFromRaw("-1"), null);
  assert.equal(collateralUsdFromRaw(""), null);
});

test("the drawdown peak survives UTC midnight while the daily baseline rolls", () => {
  const baselines = { riskDayKey: null as string | null, riskDayStartEquityUsd: null as number | null, peakLiquidationEquityUsd: null as number | null };
  const day1 = Date.UTC(2026, 8, 25, 23, 59);
  updateRiskBaselines(baselines, 100, day1);
  updateRiskBaselines(baselines, 120, day1 + 10_000);
  updateRiskBaselines(baselines, 90, Date.UTC(2026, 8, 26, 0, 1));
  assert.equal(baselines.peakLiquidationEquityUsd, 120);
  assert.equal(baselines.riskDayStartEquityUsd, 90);
  assert.equal(baselines.riskDayKey, "2026-09-26");
});
