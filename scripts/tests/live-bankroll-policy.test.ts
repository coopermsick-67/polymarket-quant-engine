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

test("small live accounts retain a 15% entry and portfolio cap", () => {
  for (const equity of [10, 20, 25, 50, 100]) {
    const profile = liveBankrollProfile(equity);
    assert.equal(profile.maxStakePct, 0.15);
    assert.equal(profile.maxExposurePct, 0.15);
    assert.equal(profile.eligible, true);
  }
  assert.equal(liveBankrollProfile(101).maxStakePct, bankrollProfile(101).maxStakePct);
});
