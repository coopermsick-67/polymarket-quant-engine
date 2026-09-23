import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { makeSnapshot } from "./helpers";
import { evaluateSignal } from "../app/lib/signal";
import { listRecordingFiles, openRecordingFile, RecordingStore } from "../scripts/recording-store";

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

describe("SQLite recording store", () => {
  it("keeps resolved rolling calibration observations across day rotations and process restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pqe-calibration-test-"));
    const dayOne = Date.UTC(2026, 0, 1, 23, 59, 59);
    const dayTwo = Date.UTC(2026, 0, 2, 0, 0, 1);
    const store = await RecordingStore.open(root, dayOne);
    store.recordCalibrationCheckpoint({ marketId: "cal-1", at: dayOne, remainingSeconds: 60, posteriorProbability: 0.8, bookProbability: 0.5 });
    store.recordResolution({ marketId: "cal-1", outcome: "UP", resolvedAt: dayTwo });
    store.recordCalibrationCheckpoint({ marketId: "cal-2", at: dayTwo, remainingSeconds: 60, posteriorProbability: 0.2, bookProbability: 0.5 });
    store.recordResolution({ marketId: "cal-2", outcome: "DOWN", resolvedAt: dayTwo + 300_000 });
    await store.waitForCompression();
    store.close();

    const reopened = await RecordingStore.open(root, dayTwo);
    try {
      const rolling = reopened.rollingCalibration(1);
      assert.equal(rolling.markets, 1);
      assert.ok(Math.abs(rolling.posteriorBrier! - 0.04) < 1e-9);
      assert.ok(Math.abs(rolling.bookBrier! - 0.25) < 1e-9);
      assert.ok(Math.abs(rolling.brierDifferencePosteriorMinusBook! + 0.21) < 1e-9);
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists raw feeds, venue ticks, snapshots, decisions, fills, events, resolutions and official prices", async () => {
    const root = await mkdtemp(join(tmpdir(), "pqe-store-test-"));
    const at = Date.UTC(2026, 0, 1, 12);
    const store = await RecordingStore.open(root, at);
    try {
      const snapshot = makeSnapshot({ now: at, startTime: at - 300_000, endTime: at + 120_000 });
      const signal = evaluateSignal(snapshot);
      const fill = {
        id: "fill-1",
        timestamp: at,
        action: "BUY" as const,
        marketId: snapshot.marketId,
        marketLabel: "BTC 5m Up/Down",
        asset: "BTC",
        duration: "5m" as const,
        side: "UP" as const,
        shares: 10,
        price: 0.5,
        notional: 5,
        fee: 0.02,
        reason: "test fill",
      };

      store.recordRaw({ receivedAt: at, source: "coinbase", venue: "coinbase", channel: "ticker", asset: "BTC", payload: '{"price":"100000"}' });
      store.recordVenueTick({ receivedAt: at, exchangeAt: at - 100, venue: "binance", marketType: "spot", asset: "BTC", price: 100_000 });
      store.recordSnapshot(snapshot);
      store.recordDecision(snapshot.marketId, at, signal);
      store.recordPaperFill(fill);
      store.recordPaperFill(fill);
      store.recordEvent(at, "fill", fill);
      store.recordResolution({ marketId: snapshot.marketId, outcome: "UP", resolvedAt: at + 120_000 });
      store.recordOfficialPrice({
        marketId: snapshot.marketId,
        asset: "BTC",
        duration: "5m",
        startTime: at - 300_000,
        endTime: at,
        price: { openPrice: 100_000, closePrice: 100_100, completed: true, fetchedAt: at + 120_000 },
      });
      store.close();

      const file = listRecordingFiles(root)[0];
      assert.ok(file.endsWith("recording-2026-01-01.sqlite"));
      const opened = await openRecordingFile(file);
      try {
        assert.equal(count(opened.db, "raw_messages"), 1);
        assert.equal(count(opened.db, "venue_ticks"), 1);
        assert.equal(count(opened.db, "snapshots"), 1);
        assert.equal(count(opened.db, "decisions"), 1);
        assert.equal(count(opened.db, "simulated_fills"), 1, "fill IDs are idempotent");
        assert.equal(count(opened.db, "events"), 1);
        assert.equal(count(opened.db, "resolutions"), 1);
        assert.equal(count(opened.db, "official_prices"), 1);
      } finally {
        await opened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The store is already closed after the assertions above.
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rotates on UTC day boundaries, compresses closed databases, and restores an archive for recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "pqe-rotation-test-"));
    const dayOne = Date.UTC(2026, 1, 1, 23, 59, 59);
    const dayTwo = Date.UTC(2026, 1, 2, 0, 0, 1);
    const store = await RecordingStore.open(root, dayOne);
    store.recordRaw({ receivedAt: dayOne, source: "rtds", payload: "first day" });
    store.recordRaw({ receivedAt: dayTwo, source: "rtds", payload: "second day" });
    await store.waitForCompression();

    const files = listRecordingFiles(root);
    assert.deepEqual(
      files.map((file) => file.split("/").at(-1)),
      ["recording-2026-02-01.sqlite.gz", "recording-2026-02-02.sqlite"],
    );
    const archived = await openRecordingFile(files[0]);
    try {
      assert.equal(count(archived.db, "raw_messages"), 1);
    } finally {
      await archived.close();
    }

    store.close();
    const restored = await RecordingStore.open(root, dayOne);
    try {
      assert.ok(listRecordingFiles(root).some((file) => file.endsWith("recording-2026-02-01.sqlite")));
    } finally {
      restored.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
