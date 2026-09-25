import assert from "node:assert/strict";
import test from "node:test";
import { applyBookSnapshot, applyClobStreamEvents, parseClobStreamMessage, preserveNewerStreamBooks, staleBookTokens } from "../app/lib/clob-book-stream";
import { setPolymarketClockOffsetForTesting } from "../app/lib/polymarket-data";
import { marketWith } from "./market-fixture";

setPolymarketClockOffsetForTesting(0);
const NOW = Date.now();
const markets = () => new Map([["m1", marketWith(NOW - 5_000, 0.6, 0.49, 0.51)]]);

test("a price change that matches the venue's top of book is applied and stamped in server time", () => {
  const events = parseClobStreamMessage(JSON.stringify({ event_type: "price_change", timestamp: String(NOW), price_changes: [
    { asset_id: "up", side: "BUY", price: "0.50", size: "40", best_bid: "0.50", best_ask: "0.51" },
  ] }));
  const result = applyClobStreamEvents(markets(), events, NOW);
  const market = result.markets.get("m1")!;
  assert.equal(result.desyncedTokens.size, 0);
  assert.equal(market.upBid, 0.5);
  assert.equal(market.upBook!.timestamp, NOW);
});

test("a price change that disagrees with the venue's top of book invalidates that book", () => {
  const events = parseClobStreamMessage(JSON.stringify({ event_type: "price_change", timestamp: String(NOW), price_changes: [
    { asset_id: "up", side: "BUY", price: "0.47", size: "40", best_bid: "0.50", best_ask: "0.51" },
  ] }));
  const result = applyClobStreamEvents(markets(), events, NOW);
  assert.deepEqual([...result.desyncedTokens], ["up"]);
  assert.equal(result.markets.get("m1")!.upBook!.timestamp, null);
});

test("several changes to one token in a frame are checked once, after the last change", () => {
  const events = parseClobStreamMessage(JSON.stringify({ event_type: "price_change", timestamp: String(NOW), price_changes: [
    { asset_id: "up", side: "BUY", price: "0.50", size: "10", best_bid: "0.49", best_ask: "0.51" },
    { asset_id: "up", side: "BUY", price: "0.49", size: "0", best_bid: "0.50", best_ask: "0.51" },
  ] }));
  const result = applyClobStreamEvents(markets(), events, NOW);
  assert.equal(result.desyncedTokens.size, 0);
  assert.equal(result.markets.get("m1")!.upBid, 0.5);
});

test("a quiet book is stale without token-specific evidence, even while the socket is healthy (audit M3)", () => {
  const quiet = markets();
  const tokens = new Set(["up", "down"]);
  assert.deepEqual(staleBookTokens(quiet.values(), tokens, NOW, 4_000).sort(), ["down", "up"], "books last confirmed more than 4 s ago are stale");
  // A best_bid_ask that agrees with the book confirms that token only.
  const confirmed = applyClobStreamEvents(quiet, parseClobStreamMessage(JSON.stringify({ event_type: "best_bid_ask", asset_id: "up", timestamp: String(NOW), best_bid: "0.49", best_ask: "0.51" })), NOW).markets;
  assert.deepEqual(staleBookTokens(confirmed.values(), tokens, NOW, 4_000), ["down"]);
  // A disagreeing best_bid_ask neither confirms nor invalidates.
  const disagreeing = applyClobStreamEvents(quiet, parseClobStreamMessage(JSON.stringify({ event_type: "best_bid_ask", asset_id: "up", timestamp: String(NOW), best_bid: "0.40", best_ask: "0.51" })), NOW);
  assert.equal(disagreeing.desyncedTokens.size, 0);
  assert.deepEqual(staleBookTokens(disagreeing.markets.values(), tokens, NOW, 4_000).sort(), ["down", "up"]);
});

test("an invalidated book is only restored by a snapshot, and an older snapshot never rolls a book back", () => {
  const drifted = applyClobStreamEvents(markets(), parseClobStreamMessage(JSON.stringify({ event_type: "price_change", price_changes: [
    { asset_id: "up", side: "BUY", price: "0.47", size: "40", best_bid: "0.50" },
  ] })), NOW).markets;
  assert.equal(drifted.get("m1")!.upBook!.timestamp, null);
  const levelAfter = applyClobStreamEvents(drifted, parseClobStreamMessage(JSON.stringify({ event_type: "price_change", timestamp: String(NOW), price_changes: [
    { asset_id: "up", side: "BUY", price: "0.48", size: "10", best_bid: "0.48" },
  ] })), NOW).markets;
  assert.equal(levelAfter.get("m1")!.upBook!.timestamp, null, "a level change cannot revive an invalidated book");
  const snapshot = { tokenId: "up", bids: [{ price: 0.5, size: 40 }], asks: [{ price: 0.51, size: 40 }], timestamp: NOW, updatedAt: NOW, minOrderSize: 5, hash: null, tickSize: 0.01 };
  const repaired = applyBookSnapshot(drifted.get("m1")!, "up", snapshot, NOW);
  assert.equal(repaired.upBook!.timestamp, NOW);
  assert.equal(repaired.upBid, 0.5);
  const older = applyBookSnapshot(repaired, "up", { ...snapshot, bids: [{ price: 0.3, size: 1 }], timestamp: NOW - 2_000 }, NOW);
  assert.equal(older.upBid, 0.5, "an older REST snapshot is ignored");
});

test("PONG frames and malformed messages are ignored", () => {
  assert.deepEqual(parseClobStreamMessage("PONG"), []);
  assert.deepEqual(parseClobStreamMessage("{not json"), []);
});

test("a full REST refresh preserves newer stream changes received during its fetch", () => {
  const old = markets().get("m1")!;
  const previous = applyClobStreamEvents(new Map([["m1", old]]), parseClobStreamMessage(JSON.stringify({
    event_type: "price_change", timestamp: String(NOW + 1_000), price_changes: [
      { asset_id: "up", side: "BUY", price: "0.50", size: "40", best_bid: "0.50", best_ask: "0.51" },
    ],
  })), NOW + 1_000).markets.get("m1")!;
  const merged = preserveNewerStreamBooks(old, previous, NOW + 1_000);
  assert.equal(merged.upBid, 0.5);
  assert.equal(merged.upBook?.timestamp, NOW + 1_000);
  const fresher = { ...old, upBook: { ...old.upBook!, timestamp: NOW + 2_000 } };
  assert.equal(preserveNewerStreamBooks(fresher, previous).upBid, old.upBid);
});

test("an empty side reported as best_ask 1 / best_bid 0 (as the live venue sends it) is not a drift", () => {
  // Captured from the live market channel: a book with bids only, then a level change.
  const snapshot = parseClobStreamMessage(JSON.stringify({ event_type: "book", asset_id: "up", timestamp: String(NOW),
    bids: [{ price: "0.97", size: "2115.01" }, { price: "0.99", size: "37818.54" }], asks: [] }));
  const change = parseClobStreamMessage(JSON.stringify({ event_type: "price_change", timestamp: String(NOW), price_changes: [
    { asset_id: "up", price: "0.99", size: "37829.64", side: "BUY", best_bid: "0.99", best_ask: "1" },
  ] }));
  const result = applyClobStreamEvents(markets(), [...snapshot, ...change], NOW);
  assert.equal(result.desyncedTokens.size, 0);
  const downOnly = parseClobStreamMessage(JSON.stringify({ event_type: "book", asset_id: "down", timestamp: String(NOW),
    bids: [], asks: [{ price: "0.01", size: "37818.54" }] }));
  const downChange = parseClobStreamMessage(JSON.stringify({ event_type: "price_change", timestamp: String(NOW), price_changes: [
    { asset_id: "down", price: "0.01", size: "37829.64", side: "SELL", best_bid: "0", best_ask: "0.01" },
  ] }));
  assert.equal(applyClobStreamEvents(markets(), [...downOnly, ...downChange], NOW).desyncedTokens.size, 0);
});
