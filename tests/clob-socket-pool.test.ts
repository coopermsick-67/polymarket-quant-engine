import assert from "node:assert/strict";
import test from "node:test";
import { ClobSocketPool } from "../app/lib/clob-socket-pool";

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.({ code: 1000, reason: "" }); }
  open() { this.readyState = 1; this.onopen?.(); }
}

test("the pool opens one connection per market shard and keeps unchanged shards connected", () => {
  const original = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  FakeSocket.instances = [];
  const received: string[][] = [];
  const pool = new ClobSocketPool({ onEvents: (events, tokens) => received.push([events[0].kind, ...tokens]) });
  try {
    pool.setShards([["a-up", "a-down"], ["b-up", "b-down"]]);
    assert.equal(FakeSocket.instances.length, 2);
    for (const socket of FakeSocket.instances) socket.open();
    assert.deepEqual(JSON.parse(FakeSocket.instances[0].sent[0]).assets_ids, ["a-down", "a-up"]);
    assert.deepEqual(pool.status(), { shards: 2, connected: 2 });

    FakeSocket.instances[1].onmessage?.({ data: JSON.stringify({ event_type: "book", asset_id: "b-up", bids: [], asks: [] }) });
    assert.deepEqual(received, [["book", "b-down", "b-up"]]);

    // Market A rolls off, market C arrives: B's connection is untouched.
    pool.setShards([["b-up", "b-down"], ["c-up", "c-down"]]);
    assert.equal(FakeSocket.instances[0].closed, true);
    assert.equal(FakeSocket.instances[1].closed, false);
    assert.equal(FakeSocket.instances.length, 3);
    assert.deepEqual([...pool.connectedTokens()].sort(), ["b-down", "b-up"]);
  } finally {
    pool.close();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
  }
});
