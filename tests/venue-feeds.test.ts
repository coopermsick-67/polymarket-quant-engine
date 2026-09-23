import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseVenueTicks, RECORDED_ASSETS, VenueFeedRecorder } from "../scripts/venue-feeds";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({});
  }

  fail() {
    this.onerror?.({});
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(data: string) {
    this.onmessage?.({ data });
  }
}

describe("secondary exchange recorder", () => {
  it("normalizes Binance, Bybit and OKX spot and perpetual trade messages", () => {
    const binance = parseVenueTicks("binance:spot", '{"stream":"btcusdt@trade","data":{"s":"BTCUSDT","p":"64000.5","T":123}}', 200);
    const bybit = parseVenueTicks("bybit:perp", '{"topic":"publicTrade.HYPEUSDT","data":[{"s":"HYPEUSDT","p":"32.5","T":124}]}', 201);
    const okx = parseVenueTicks("okx:public", '{"arg":{"channel":"trades","instId":"ZEC-USDT-SWAP"},"data":[{"px":"42.25","ts":"125"}]}', 202);

    assert.deepEqual(binance, [{ receivedAt: 200, exchangeAt: 123, venue: "binance", marketType: "spot", asset: "BTC", price: 64_000.5 }]);
    assert.deepEqual(bybit, [{ receivedAt: 201, exchangeAt: 124, venue: "bybit", marketType: "perp", asset: "HYPE", price: 32.5 }]);
    assert.deepEqual(okx, [{ receivedAt: 202, exchangeAt: 125, venue: "okx", marketType: "perp", asset: "ZEC", price: 42.25 }]);
    assert.deepEqual(parseVenueTicks("binance:spot", "not json", 203), []);
  });

  it("subscribes to the configured assets, records exact payloads and stops all sockets", () => {
    FakeSocket.instances = [];
    const raw: { source: string; payload: string }[] = [];
    const ticks: { venue: string; marketType: string; asset: string; price: number }[] = [];
    const feed = new VenueFeedRecorder({
      WebSocketImpl: FakeSocket,
      onRaw: (message) => raw.push({ source: message.source, payload: message.payload }),
      onTick: (tick) => ticks.push(tick),
    });

    feed.start();
    assert.equal(FakeSocket.instances.length, 5);
    assert.ok(FakeSocket.instances[0].url.includes("btcusdt@trade"));
    assert.ok(FakeSocket.instances[1].url.startsWith("wss://fstream.binance.com/"));
    for (const socket of FakeSocket.instances) socket.open();
    assert.equal(JSON.parse(FakeSocket.instances[2].sent[0]).args.length, RECORDED_ASSETS.length);
    const okxArgs = JSON.parse(FakeSocket.instances[4].sent[0]).args as { instId: string }[];
    assert.equal(okxArgs.length, RECORDED_ASSETS.length * 2);

    const payload = '{"topic":"publicTrade.BTCUSDT","data":[{"s":"BTCUSDT","p":"64000","T":123}]}';
    FakeSocket.instances[2].message(payload);
    assert.deepEqual(raw, [{ source: "bybit:spot", payload }]);
    assert.deepEqual(
      ticks.map((tick) => [tick.venue, tick.marketType, tick.asset, tick.price]),
      [["bybit", "spot", "BTC", 64_000]],
    );
    assert.equal(feed.health(Date.now())["bybit:spot"].messages, 1);
    assert.equal(feed.health(Date.now())["bybit:spot"].parsedTicks, 1);
    assert.equal(feed.health(Date.now() + 61_000)["binance:spot"].status, "STALE");
    feed.stop();
    assert.ok(FakeSocket.instances.every((socket) => socket.readyState === 3));
  });

  it("closes a failed socket and schedules reconnection instead of leaving it stuck", () => {
    FakeSocket.instances = [];
    const feed = new VenueFeedRecorder({
      WebSocketImpl: FakeSocket,
      onRaw: () => undefined,
      onTick: () => undefined,
    });
    feed.start();
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.fail();
    assert.equal(socket.readyState, 3);
    assert.equal(feed.health()["binance:spot"].status, "DOWN");
    assert.equal(feed.health()["binance:spot"].lastError, "websocket error");
    feed.stop();
  });
});
