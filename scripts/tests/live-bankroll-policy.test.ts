import assert from "node:assert/strict";
import { test } from "node:test";
import { liveBankrollProfile } from "../../app/lib/live-bankroll-policy";
import { bankrollProfile } from "../../app/lib/bankroll-policy";

test("live policy allows $10 accounts while paper policy retains its $20 floor", () => {
  assert.equal(liveBankrollProfile(9.99).eligible, false);
  assert.equal(liveBankrollProfile(10).eligible, true);
  assert.equal(liveBankrollProfile(20).eligible, true);
  assert.equal(bankrollProfile(10).eligible, false);
  assert.equal(bankrollProfile(20).eligible, true);
});

test("small live accounts retain their 15% entry and portfolio caps", () => {
  for (const equity of [10, 20, 25, 50, 100]) {
    const profile = liveBankrollProfile(equity);
    assert.equal(profile.maxStakePct, 0.15);
    assert.equal(profile.maxExposurePct, 0.15);
    assert.equal(profile.eligible, true);
  }
  assert.equal(liveBankrollProfile(101).maxStakePct, bankrollProfile(101).maxStakePct);
});

test("live entry filters are moderately looser by horizon while preserving the 4% net-edge floor", () => {
  for (const equity of [10, 20, 50, 100, 101, 250, 1_000]) {
    const original = bankrollProfile(equity);
    const fiveMinute = liveBankrollProfile(equity, 10, 0.15, "5m");
    const fifteenMinute = liveBankrollProfile(equity, 10, 0.15, "15m");
    assert.ok(fiveMinute.minNetEdge <= original.minNetEdge);
    assert.ok(fiveMinute.minNetEdge >= 0.04);
    assert.ok(fiveMinute.maxSpreadPct >= original.maxSpreadPct);
    assert.equal(fiveMinute.minRemainingSeconds, 30);
    assert.equal(fifteenMinute.minRemainingSeconds, 60);
    assert.equal(fiveMinute.microScoreMinimum, 0.35);
    assert.equal(fiveMinute.smallBiasConfidenceMinimum, 0.54);
  }
});
