import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MarketFeedController } from "../app/lib/market-feed";
import { DEFAULT_FEE_SCHEDULE } from "../app/lib/pricing";
import type { LiveMarket } from "../app/lib/polymarket-data";

type Internals = {
  applyClobEvent: (event: Record<string, unknown>, now: number) => void;
  recordOpen: (asset: string, timestamp: number, value: number) => void;
  resyncQueue: Set<string>;
};

const start = 1_790_000_100_000; // a 5-minute boundary
const market: LiveMarket = {
  id: "m1",
  conditionId: null,
  slug: "btc-updown-5m-1790000100",
  question: "",
  asset: "BTC",
  duration: "5m",
  startTime: start,
  endTime: start + 300_000,
  upTokenId: "up",
  downTokenId: "down",
  sourceUrl: "",
  declaredTwapSeconds: 60,
  feeSchedule: DEFAULT_FEE_SCHEDULE,
  tickSize: 0.01,
  minOrderSize: 5,
  negRisk: false,
  remaining: 300,
  reference: null,
  referenceSource: "MISSING",
  officialClose: null,
  upBook: { tokenId: "up", bids: [{ price: 0.5, size: 10 }], asks: [{ price: 0.52, size: 10 }], timestamp: 1, minOrderSize: 5, tickSize: 0.01, hash: null },
  downBook: null,
  upBid: 0.5,
  upAsk: 0.52,
  downBid: null,
  downAsk: null,
  spread: 0.02,
  liquidity: 0,
  imbalance: null,
  sourceTimestamp: 1,
  chart5m: [],
  chart15m: [],
  chartUpdatedAt: null,
};

const controllerWith = () => {
  const controller = new MarketFeedController({ referenceFetcher: async () => new Map() });
  controller.markets.set(market.id, market);
  return { controller, internals: controller as unknown as Internals };
};

describe("market feed controller", () => {
  it("applies price_change deltas and queues a REST resync when the reported top of book disagrees", () => {
    const { controller, internals } = controllerWith();
    internals.applyClobEvent(
      {
        event_type: "price_change",
        timestamp: "5",
        price_changes: [{ asset_id: "up", price: "0.51", size: "4", side: "BUY", best_bid: "0.51", best_ask: "0.52" }],
      },
      5,
    );
    assert.equal(controller.markets.get("m1")!.upBid, 0.51);
    assert.equal(internals.resyncQueue.size, 0);
    internals.applyClobEvent(
      {
        event_type: "price_change",
        timestamp: "6",
        price_changes: [{ asset_id: "up", price: "0.49", size: "4", side: "BUY", best_bid: "0.55", best_ask: "0.56" }],
      },
      6,
    );
    assert.ok(internals.resyncQueue.has("up"));
  });
  it("replaces books on snapshot events and updates tick size", () => {
    const { controller, internals } = controllerWith();
    internals.applyClobEvent(
      { event_type: "book", asset_id: "up", timestamp: "7", bids: [{ price: "0.3", size: "1" }], asks: [{ price: "0.35", size: "2" }] },
      7,
    );
    assert.equal(controller.markets.get("m1")!.upAsk, 0.35);
    internals.applyClobEvent({ event_type: "tick_size_change", asset_id: "up", new_tick_size: "0.001" }, 8);
    assert.equal(controller.markets.get("m1")!.tickSize, 0.001);
  });
  it("captures the price to beat from the stream tick printed at the window start", () => {
    const { controller, internals } = controllerWith();
    internals.recordOpen("BTC", start, 86_272.1);
    const updated = controller.markets.get("m1")!;
    assert.equal(updated.reference, 86_272.1);
    assert.equal(updated.referenceSource, "CHAINLINK");
  });
});
