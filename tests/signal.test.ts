import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { takerFeePerShare } from "../app/lib/pricing";
import { evaluateExit, evaluateSignal, marketImpliedUp, maxPriceForEdge, simulateBuy, simulateSell } from "../app/lib/signal";
import { makeSnapshot } from "./helpers";

const fee = { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 };

describe("execution simulation", () => {
  it("walks asks, charges the fee curve per level, and respects the limit", () => {
    const asks = [
      { price: 0.5, size: 10 },
      { price: 0.52, size: 10 },
      { price: 0.6, size: 1000 },
    ];
    const fill = simulateBuy(asks, 100, fee, 0, 0.55)!;
    assert.equal(fill.shares, 20);
    assert.equal(fill.worstPrice, 0.52);
    const expectedFee = 10 * takerFeePerShare(0.5, fee) + 10 * takerFeePerShare(0.52, fee);
    assert.ok(Math.abs(fill.fee - expectedFee) < 1e-12);
    assert.ok(Math.abs(fill.totalCost - (10 * 0.5 + 10 * 0.52 + expectedFee)) < 1e-12);
  });

  it("never spends more than the budget including fees", () => {
    const fill = simulateBuy([{ price: 0.5, size: 1e6 }], 25, fee, 20)!;
    assert.ok(fill.totalCost <= 25 + 1e-9);
    assert.ok(fill.totalCost > 24.99);
  });

  it("rejects fills below the minimum order size", () => {
    assert.equal(simulateBuy([{ price: 0.5, size: 3 }], 100, fee, 0, 1, 5), null);
  });

  it("sells into bids net of fees and stops at the limit", () => {
    const sale = simulateSell(
      [
        { price: 0.7, size: 5 },
        { price: 0.6, size: 100 },
      ],
      20,
      fee,
      0,
      0.65,
    )!;
    assert.equal(sale.shares, 5);
    assert.ok(Math.abs(sale.netProceeds - (5 * 0.7 - 5 * takerFeePerShare(0.7, fee))) < 1e-12);
  });

  it("maxPriceForEdge keeps the required edge after fees", () => {
    const limit = maxPriceForEdge(0.8, 0.03, fee, 10, 0.01)!;
    assert.ok(0.8 - limit * 1.001 - takerFeePerShare(limit, fee) >= 0.03);
    const next = limit + 0.01;
    assert.ok(0.8 - next * 1.001 - takerFeePerShare(next, fee) < 0.03);
  });

  it("derives the market-implied probability from both books", () => {
    const p = marketImpliedUp(makeSnapshot({ upAsk: 0.61, downAsk: 0.41 }))!;
    assert.ok(p > 0.58 && p < 0.62);
  });
});

describe("signal gates", () => {
  it("requires a verified reference", () => {
    assert.equal(evaluateSignal(makeSnapshot({ reference: null, referenceSource: "MISSING" })).gate, "REFERENCE");
    assert.equal(evaluateSignal(makeSnapshot({ referenceSource: "ESTIMATE" })).gate, "REFERENCE");
  });
  it("halts on stale feeds, divergence, and stale books", () => {
    const snapshot = makeSnapshot();
    assert.equal(evaluateSignal({ ...snapshot, spotTimestamp: snapshot.now - 10_000 }).gate, "STALE_SPOT");
    assert.equal(evaluateSignal({ ...snapshot, basisBps: 80 }).gate, "DIVERGENCE");
    assert.equal(evaluateSignal({ ...snapshot, up: { ...snapshot.up, timestamp: snapshot.now - 60_000 } }).gate, "STALE_BOOK");
    assert.equal(evaluateSignal({ ...snapshot, sigmaPerSqrtSecond: null }).gate, "VOLATILITY");
    assert.equal(evaluateSignal(makeSnapshot({ secondsLeft: 5 })).gate, "TIME");
  });
  it("passes when the book already prices the model", () => {
    // Spot at the reference, 2 minutes left: fair ~50%, book 52/50 -> no edge after a 1.75c fee.
    const signal = evaluateSignal(makeSnapshot());
    assert.equal(signal.action, "PASS");
    assert.equal(signal.gate, "EDGE");
  });
});

describe("signal decisions", () => {
  it("buys the favourite when the TWAP is nearly locked and the book lags", () => {
    // 20 bp above the price to beat with 25 s left: the final TWAP is almost certainly above.
    const signal = evaluateSignal(makeSnapshot({ secondsLeft: 25, distanceBps: 20, upAsk: 0.85, downAsk: 0.17 }));
    assert.equal(signal.action, "UP");
    assert.ok(signal.chosen!.limitPrice! >= 0.85);
    assert.ok(signal.chosen!.edge! >= signal.requiredEdge);
  });

  it("regression: never buys the cheap losing tail near expiry (audit finding #3)", () => {
    // Old engine: spot 6 bp above the reference with ~61 s left bought DOWN at 4c claiming 24pt edge.
    for (const secondsLeft of [20, 40, 61, 90]) {
      for (const sigma of [0.00005, 0.0001, 0.0003]) {
        const signal = evaluateSignal(makeSnapshot({ secondsLeft, distanceBps: 6, upAsk: 0.97, downAsk: 0.04, sigmaPerSqrtSecond: sigma }));
        assert.notEqual(signal.action, "DOWN", `bought DOWN at ${secondsLeft}s sigma ${sigma}: ${signal.reason}`);
      }
    }
  });

  it("refuses tails below the minimum entry price even with apparent edge", () => {
    const signal = evaluateSignal(makeSnapshot({ secondsLeft: 200, distanceBps: -30, upAsk: 0.03, downAsk: 0.99 }), { modelWeight: 1, minEntryPrice: 0.05 });
    assert.notEqual(signal.action, "UP");
  });

  it("the market prior shrinks model conviction", () => {
    const snapshot = makeSnapshot({ secondsLeft: 100, distanceBps: 8, upAsk: 0.6, downAsk: 0.42 });
    const trusting = evaluateSignal(snapshot, { modelWeight: 1 });
    const skeptical = evaluateSignal(snapshot, { modelWeight: 0.2 });
    assert.ok(trusting.sides.UP!.probability > skeptical.sides.UP!.probability);
  });

  it("LOCK tier requires anchored feeds and a multiple of the edge floor", () => {
    const strong = evaluateSignal(makeSnapshot({ secondsLeft: 25, distanceBps: 25, upAsk: 0.8, downAsk: 0.22 }));
    assert.equal(strong.tier, "LOCK");
    const exchangeOnly = evaluateSignal(makeSnapshot({ secondsLeft: 25, distanceBps: 25, upAsk: 0.8, downAsk: 0.22, spotSource: "EXCHANGE" }));
    assert.notEqual(exchangeOnly.tier, "LOCK");
  });
});

describe("exit rule", () => {
  it("cashes out only when the bid beats fair value by the gap", () => {
    const snapshot = makeSnapshot({ secondsLeft: 200, distanceBps: 0 });
    const rich = { ...snapshot, up: { ...snapshot.up, bids: [{ price: 0.75, size: 500 }] } };
    const exit = evaluateExit({
      snapshot: rich,
      side: "UP",
      shares: 50,
      entryCostPerShare: 0.5,
      minGap: 0.03,
      minProfitUsd: 1,
      minProfitPct: 0.05,
      minRemainingSeconds: 30,
    });
    assert.equal(exit.shouldExit, true);
    const fair = evaluateExit({
      snapshot,
      side: "UP",
      shares: 50,
      entryCostPerShare: 0.5,
      minGap: 0.03,
      minProfitUsd: 1,
      minProfitPct: 0.05,
      minRemainingSeconds: 30,
    });
    assert.equal(fair.shouldExit, false);
  });
});

describe("live-run regressions", () => {
  it("refuses entries on unanchored feeds by default (basis error ~5bp exceeded BTC's per-minute vol)", () => {
    const snapshot = makeSnapshot({ secondsLeft: 25, distanceBps: 25, upAsk: 0.8, downAsk: 0.22, spotSource: "EXCHANGE" });
    assert.equal(evaluateSignal(snapshot).gate, "UNANCHORED");
    assert.equal(evaluateSignal(snapshot, { requireAnchoredFeed: false }).action, "UP");
  });
});
