import assert from "node:assert/strict";
import test from "node:test";
import { applyClobStreamEvents, confirmStreamedBooks, parseClobStreamMessage } from "../app/lib/clob-book-stream";
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

test("a snapshot repairs a book and a healthy stream re-confirms quiet books", () => {
  const drifted = applyClobStreamEvents(markets(), parseClobStreamMessage(JSON.stringify({ event_type: "price_change", price_changes: [
    { asset_id: "up", side: "BUY", price: "0.47", size: "40", best_bid: "0.50" },
  ] })), NOW).markets;
  const confirmedWhileBroken = confirmStreamedBooks(drifted, new Set(["up", "down"]), NOW);
  assert.equal(confirmedWhileBroken.get("m1")!.upBook!.timestamp, null, "an invalidated book is never re-confirmed");
  assert.equal(confirmedWhileBroken.get("m1")!.downBook!.timestamp, NOW);
  const repaired = applyClobStreamEvents(drifted, parseClobStreamMessage(JSON.stringify({ event_type: "book", asset_id: "up", timestamp: String(NOW),
    bids: [{ price: "0.50", size: "40" }], asks: [{ price: "0.51", size: "40" }] })), NOW).markets;
  assert.equal(repaired.get("m1")!.upBook!.timestamp, NOW);
  assert.equal(repaired.get("m1")!.upBid, 0.5);
});

test("PONG frames and malformed messages are ignored", () => {
  assert.deepEqual(parseClobStreamMessage("PONG"), []);
  assert.deepEqual(parseClobStreamMessage("{not json"), []);
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
