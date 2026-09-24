import assert from "node:assert/strict";
import test from "node:test";
import { StaleRecoveryTracker } from "../app/lib/stale-recovery";

const healthy = (signature: string) => ({
  haltLatched: true,
  freshMarketCount: 1,
  minimumFreshMarkets: 1,
  portfolioMarkable: true,
  hasError: false,
  signature,
});

test("stale recovery counts distinct source snapshots instead of repeated cached checks", () => {
  const tracker = new StaleRecoveryTracker();
  assert.equal(tracker.observe(healthy("tick-1")), 1);
  assert.equal(tracker.observe(healthy("tick-1")), 1);
  assert.equal(tracker.observe(healthy("tick-2")), 2);
  assert.equal(tracker.observe(healthy("tick-3")), 3);
});

test("stale recovery resets after errors, unmarkable portfolios, or a cleared halt", () => {
  const tracker = new StaleRecoveryTracker();
  assert.equal(tracker.observe(healthy("tick-1")), 1);
  assert.equal(tracker.observe({ ...healthy("tick-2"), hasError: true }), 0);
  assert.equal(tracker.observe(healthy("tick-2")), 1);
  assert.equal(tracker.observe({ ...healthy("tick-3"), portfolioMarkable: false }), 0);
  assert.equal(tracker.observe(healthy("tick-3")), 1);
  assert.equal(tracker.observe({ ...healthy("tick-4"), haltLatched: false }), 0);
  assert.equal(tracker.healthyObservations, 0);
});
