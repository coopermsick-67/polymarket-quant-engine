import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { appendTick, deriveFeed, pushTick, resampleSeconds, streamValueAt } from "../app/lib/feeds";
import {
  buildLiveMarket,
  newerBook,
  normalizeMarket,
  officialPriceUrl,
  parseOfficialPrice,
  parseResolution,
  replaceLiveMarketBook,
  updateLiveMarketBookLevel,
  type OrderBook,
} from "../app/lib/polymarket-data";

const open = JSON.parse(readFileSync(new URL("./fixtures/gamma-open-markets.json", import.meta.url), "utf8")).markets as Record<string, unknown>[];
const closed = JSON.parse(readFileSync(new URL("./fixtures/gamma-closed-markets.json", import.meta.url), "utf8")) as Record<string, unknown>[];
const twapCapture = JSON.parse(readFileSync(new URL("./fixtures/twap-open-verification.json", import.meta.url), "utf8"));
const capturedAt = Date.parse("2026-09-22T23:40:00Z");

describe("Gamma normalization (real captured payloads)", () => {
  const markets = open.map((row) => normalizeMarket(row, capturedAt));
  it("accepts every 5m/15m up/down market and rejects 4h, hourly and strike markets", () => {
    const accepted = markets.filter((market) => market !== null);
    const expected = open.filter((row) => /^[a-z]+-updown-(5m|15m)-\d{10}$/.test(String(row.slug)));
    assert.equal(accepted.length, expected.length);
    assert.ok(accepted.some((market) => market!.duration === "15m"));
  });
  it("reads the TWAP config, fee schedule, tick size and min size from Gamma", () => {
    const btc = markets.find((market) => market?.asset === "BTC" && market.duration === "5m")!;
    assert.equal(btc.twapLookbackSeconds, 60);
    assert.deepEqual(btc.feeSchedule, { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 });
    assert.ok(btc.tickSize > 0 && btc.minOrderSize === 5);
    assert.equal(btc.endTime - btc.startTime, 300_000);
  });
  it("maps Up/Down tokens by outcome label, not by position", () => {
    const row = open.find((candidate) => String(candidate.slug).startsWith("eth-updown-5m"))!;
    const swapped = { ...row, outcomes: JSON.stringify(["Down", "Up"]) };
    const normal = normalizeMarket(row, capturedAt)!;
    const flipped = normalizeMarket(swapped, capturedAt)!;
    assert.equal(normal.upTokenId, flipped.downTokenId);
  });
  it("never scrapes a reference price out of the description", () => {
    for (const market of markets) if (market) assert.equal("reference" in market, false);
  });
});

describe("official prices and resolutions", () => {
  it("parses closed markets into official outcomes", () => {
    const resolutions = closed.map((row) => parseResolution(row)).filter(Boolean);
    assert.equal(resolutions.length, closed.length);
    for (const resolution of resolutions) assert.ok(resolution!.outcome === "UP" || resolution!.outcome === "DOWN");
    assert.equal(parseResolution({ ...closed[0], closed: false }), null);
    assert.equal(parseResolution({ ...closed[0], outcomePrices: '["0.5","0.5"]' }), null);
  });
  it("builds the official price URL with the right variant", () => {
    const url = new URL(officialPriceUrl("btc", 1_790_128_200_000, "15m"));
    assert.equal(url.searchParams.get("symbol"), "BTC");
    assert.equal(url.searchParams.get("variant"), "fifteen");
    assert.equal(url.searchParams.get("eventStartTime"), "2026-09-23T01:50:00Z");
    assert.equal(url.searchParams.get("endDate"), "2026-09-23T02:05:00Z");
  });
  it("parses official price payloads", () => {
    assert.deepEqual(parseOfficialPrice({ openPrice: 86272.1, closePrice: null, completed: false }, 1), {
      openPrice: 86272.1,
      closePrice: null,
      completed: false,
      fetchedAt: 1,
    });
    assert.equal(parseOfficialPrice({ openPrice: -1 }), null);
  });
  it("the Chainlink stream tick at the boundary equals the official open (captured live)", () => {
    for (const result of Object.values(twapCapture.results) as { official: number; spotAtB: number }[]) {
      assert.ok(Math.abs(result.spotAtB - result.official) / result.official < 1e-12);
    }
  });
});

describe("order books", () => {
  const market = buildLiveMarket(
    normalizeMarket(
      open.find((row) => String(row.slug).startsWith("btc-updown-5m"))!,
      capturedAt,
    )!,
    { books: new Map(), official: new Map(), candles: new Map() },
    capturedAt,
  );
  const up = market.upTokenId;
  it("keeps bids best-first and asks best-first through replacement and deltas", () => {
    let next = replaceLiveMarketBook(
      market,
      up,
      [
        { price: 0.4, size: 10 },
        { price: 0.45, size: 5 },
      ],
      [
        { price: 0.5, size: 3 },
        { price: 0.48, size: 7 },
      ],
      1,
      null,
      1,
    );
    assert.equal(next.upBid, 0.45);
    assert.equal(next.upAsk, 0.48);
    next = updateLiveMarketBookLevel(next, up, "BUY", 0.47, 2, 2, 2);
    assert.equal(next.upBook!.bids[0].price, 0.47);
    next = updateLiveMarketBookLevel(next, up, "SELL", 0.48, 0, 3, 3);
    assert.equal(next.upAsk, 0.5);
  });
  it("a REST snapshot never overwrites a newer WebSocket book", () => {
    const ws: OrderBook = { tokenId: up, bids: [{ price: 0.6, size: 1 }], asks: [], timestamp: 2_000, minOrderSize: null, tickSize: null, hash: null };
    const rest: OrderBook = { ...ws, bids: [{ price: 0.4, size: 1 }], timestamp: 1_000 };
    assert.equal(newerBook(ws, rest), ws);
    assert.equal(newerBook(rest, ws), ws);
  });
});

describe("feeds", () => {
  it("anchors exchange ticks to the TWAP stream via the basis", () => {
    const now = 1_000_000;
    const exchange = Array.from({ length: 300 }, (_, index) => ({ timestamp: now - (299 - index) * 1000, price: 100 + index * 0.01 }));
    const trailingMean = exchange.slice(-60).reduce((sum, tick) => sum + tick.price, 0) / 60;
    const stream = [{ timestamp: now, price: trailingMean + 0.05 }];
    const feed = deriveFeed({ asset: "BTC", stream, exchange, exchangeAlt: [] }, now);
    assert.equal(feed.spotSource, "ANCHORED");
    assert.ok(Math.abs(feed.spot! - (exchange[exchange.length - 1].price + 0.05)) < 1e-9);
    assert.ok(Math.abs(feed.basisBps! - (0.05 / stream[0].price) * 10_000) < 1e-9);
  });
  it("falls back to exchange-only and then stream-only, and reports missing", () => {
    const now = 1_000_000;
    assert.equal(deriveFeed({ asset: "X", stream: [], exchange: [{ timestamp: now, price: 1 }], exchangeAlt: [] }, now).spotSource, "EXCHANGE");
    assert.equal(deriveFeed({ asset: "X", stream: [{ timestamp: now, price: 1 }], exchange: [], exchangeAlt: [] }, now).spotSource, "STREAM");
    assert.equal(deriveFeed({ asset: "X", stream: [], exchange: [], exchangeAlt: [] }, now).spotSource, "MISSING");
  });
  it("tick buffers dedupe, order, and trim", () => {
    let ticks = appendTick([], { timestamp: 2000, price: 2 });
    ticks = appendTick(ticks, { timestamp: 1000, price: 1 });
    assert.deepEqual(
      ticks.map((tick) => tick.timestamp),
      [1000, 2000],
    );
    const hot = [{ timestamp: 0, price: 1 }];
    pushTick(hot, { timestamp: 100, price: 2 }, 60_000, 250);
    assert.equal(hot.length, 1);
    assert.equal(hot[0].price, 2);
    assert.equal(resampleSeconds([{ timestamp: 500, price: 1 }], 0, 3000).length, 3);
    assert.equal(streamValueAt([{ timestamp: 300_000, price: 5 }], 300_000), 5);
  });
});

describe("resolution fetch", () => {
  it("sets an explicit limit so Gamma's 20-row default cannot drop results", async () => {
    const { fetchResolutions } = await import("../app/lib/polymarket-data");
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(closed), { status: 200 });
    };
    const ids = Array.from({ length: 45 }, (_, index) => String(4_000_000 + index));
    await fetchResolutions(ids, undefined, fetcher as typeof fetch);
    assert.equal(urls.length, 2);
    assert.ok(urls[0].includes("limit=40") && urls[1].includes("limit=5"));
  });
});
