import assert from "node:assert/strict";
import test from "node:test";
import { parsePolymarketPriceMessage } from "../app/lib/polymarket-price-stream";

test("parses exact RTDS 60-second TWAP snapshots and updates", () => {
  const snapshot = parsePolymarketPriceMessage(JSON.stringify({
    topic: "crypto_prices_twap_sixty",
    type: "subscribe",
    payload: {
      symbol: "btc/usd",
      window_s: 60,
      data: [
        { timestamp: 1_800_000_000_000, value: 84_200.12345679, full_accuracy_value: "84200123456790000000000" },
        { timestamp: 1_800_000_001_000, value: 84_201 },
      ],
    },
  }));
  assert.deepEqual(snapshot, [
    { asset: "BTC", priceFeed: "TWAP_60", timestamp: 1_800_000_000_000, price: 84_200.12345679 },
    { asset: "BTC", priceFeed: "TWAP_60", timestamp: 1_800_000_001_000, price: 84_201 },
  ]);

  const update = parsePolymarketPriceMessage(JSON.stringify({
    topic: "crypto_prices_twap_sixty",
    type: "update",
    payload: { symbol: "btc/usd", window_s: 60, timestamp: 1_800_000_002_000, value: "84202.25" },
  }));
  assert.deepEqual(update, [{ asset: "BTC", priceFeed: "TWAP_60", timestamp: 1_800_000_002_000, price: 84_202.25 }]);
});

test("rejects malformed prices, unsupported TWAP windows, and unrelated topics", () => {
  const make = (topic: string, payload: unknown) => JSON.stringify({ topic, type: "update", payload });
  assert.deepEqual(parsePolymarketPriceMessage(make("crypto_prices_twap_sixty", {
    symbol: "btc/usd", window_s: 15, timestamp: 1_800_000_000_000, value: "84200",
  })), []);
  assert.deepEqual(parsePolymarketPriceMessage(make("crypto_prices_twap_sixty", {
    symbol: "btc/usd", window_s: 60, timestamp: 1_800_000_000_000, value: "NaN",
  })), []);
  assert.deepEqual(parsePolymarketPriceMessage(make("unrelated", {
    symbol: "btc/usd", window_s: 60, timestamp: 1_800_000_000_000, value: "84200",
  })), []);
});
