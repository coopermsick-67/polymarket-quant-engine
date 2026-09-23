import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  checkPortfolioRisk,
  computeKellySizing,
  DEFAULT_LIVE_RISK,
  isLiveOrderSubmissionEnabled,
  LIVE_EXECUTION_DISABLED_REASON,
  LIVE_EXECUTION_ENABLED,
  normalizeLiveRiskConfig,
  parseCollateralBalance,
  parseLivePosition,
  type LivePosition,
} from "../app/lib/live-risk";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/data-api-position.json", import.meta.url), "utf8"));

describe("live execution gate", () => {
  it("fails closed for buy and sell submissions while preserving read and cancel actions", () => {
    assert.equal(LIVE_EXECUTION_ENABLED, false);
    assert.match(LIVE_EXECUTION_DISABLED_REASON, /edge/);
    assert.equal(isLiveOrderSubmissionEnabled("execute"), false);
    assert.equal(isLiveOrderSubmissionEnabled("exit"), false);
    assert.equal(isLiveOrderSubmissionEnabled("cancel-all"), true);
    assert.equal(isLiveOrderSubmissionEnabled("positions"), true);
  });
});

describe("collateral balance parsing", () => {
  it("reads integer micro-USDC strings and decimal dollar strings without magnitude guessing", () => {
    assert.equal(parseCollateralBalance("12500000"), 12.5);
    assert.equal(parseCollateralBalance("500000"), 0.5); // the old heuristic read this as $500,000
    assert.equal(parseCollateralBalance("12.5"), 12.5);
    assert.equal(parseCollateralBalance("abc"), null);
    assert.equal(parseCollateralBalance(-1), null);
  });
});

describe("Kelly sizing", () => {
  const config = normalizeLiveRiskConfig({ maxTradeUsd: 100, unitBalancePct: 0.05, unitsPerTrade: 5, kellyFraction: 0.25 });
  it("uses the all-in cost per share", () => {
    const sizing = computeKellySizing(0.8, 0.7, 1000, 10_000, config);
    assert.ok(Math.abs(sizing.fullKelly - (0.8 - 0.7) / 0.3) < 1e-6);
    assert.equal(sizing.stakeUsd, Math.round(1000 * sizing.fullKelly * 0.25 * 100) / 100);
    assert.ok(sizing.approved);
  });
  it("caps by depth under the limit and refuses negative edge", () => {
    assert.equal(computeKellySizing(0.9, 0.5, 10_000, 20, config).stakeUsd, 10);
    assert.equal(computeKellySizing(0.5, 0.55, 1000, 1000, config).approved, false);
  });
});

describe("live positions", () => {
  it("parses the Data API shape and derives the window end from the slug", () => {
    const position = parseLivePosition(fixture)!;
    assert.equal(position.side, "UP");
    assert.equal(position.endTime, 1_790_129_400_000 + 300_000);
    assert.equal(position.currentValue, 2341.15);
  });
});

describe("portfolio risk", () => {
  const now = 1_790_129_500_000;
  const base = (positions: LivePosition[], overrides: Partial<Parameters<typeof checkPortfolioRisk>[0]> = {}) =>
    checkPortfolioRisk({
      config: DEFAULT_LIVE_RISK,
      positions,
      balance: 1000,
      day: { dayKey: "2026-09-22", startEquity: 1000, orders: [] },
      now,
      candidate: { conditionId: "0xnew", tokenIds: ["a", "b"], endTime: now + 200_000, side: "UP", stakeUsd: 20, requestKey: "k1" },
      ...overrides,
    });
  const held = (overrides: Partial<LivePosition>): LivePosition => ({
    tokenId: "x",
    conditionId: "0xother",
    slug: null,
    title: "",
    outcome: "Up",
    size: 10,
    averagePrice: 0.5,
    initialValue: 5,
    currentValue: 5,
    endTime: now + 200_000,
    side: "UP",
    ...overrides,
  });

  it("approves a clean book", () => assert.equal(base([]).approved, true));
  it("blocks a second position in the same market", () => assert.equal(base([held({ conditionId: "0xnew" })]).approved, false));
  it("blocks correlated same-window same-side stacking", () => assert.equal(base([held({ tokenId: "p1" }), held({ tokenId: "p2" })]).approved, false));
  it("blocks when aggregate exposure would breach the cap", () =>
    assert.equal(base([held({ initialValue: 230, currentValue: 230, endTime: now + 900_000 })]).approved, false));
  it("halts after the daily loss limit", () => assert.equal(base([], { balance: 900 }).approved, false));
  it("rejects duplicate request ids and enforces the order rate", () => {
    assert.equal(base([], { day: { dayKey: "d", startEquity: 1000, orders: [{ key: "k1", at: now - 1000 }] } }).approved, false);
    const burst = Array.from({ length: 6 }, (_, index) => ({ key: `o${index}`, at: now - 1000 }));
    assert.equal(base([], { day: { dayKey: "d", startEquity: 1000, orders: burst } }).approved, false);
  });
});
