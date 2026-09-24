import assert from "node:assert/strict";
import test from "node:test";
import { createPaperAccount, updatePaperRiskBaselines } from "../app/lib/engines";

test("paper daily baseline rolls at UTC midnight while the liquidation peak persists", () => {
  const firstDay = Date.UTC(2026, 0, 1, 12, 0, 0);
  const account = createPaperAccount(100, firstDay);
  const sameDay = updatePaperRiskBaselines(account, 91, firstDay + 60 * 60_000);
  assert.equal(sameDay.riskDayStartEquityUsd, 100);
  assert.equal(sameDay.peakLiquidationEquityUsd, 100);

  const nextDay = updatePaperRiskBaselines(sameDay, 90, firstDay + 12 * 60 * 60_000);
  assert.equal(nextDay.riskDayKey, "2026-01-02");
  assert.equal(nextDay.riskDayStartEquityUsd, 90);
  assert.equal(nextDay.peakLiquidationEquityUsd, 100);
});
