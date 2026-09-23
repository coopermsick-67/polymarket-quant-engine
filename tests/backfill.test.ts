import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listRecordingFiles, openRecordingFile, RecordingStore } from "../scripts/recording-store";
import { backfillRecordings } from "../scripts/backfill";
import { makeSnapshot } from "./helpers";

describe("official data backfill", () => {
  it("backfills missing Gamma resolutions and official prices, including compressed daily files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pqe-backfill-test-"));
    const dayOne = Date.UTC(2026, 2, 1, 23, 59, 59);
    const dayTwo = Date.UTC(2026, 2, 2, 0, 0, 1);
    const store = await RecordingStore.open(root, dayOne);
    const snapshot = makeSnapshot({ now: dayOne, startTime: dayOne - 300_000, endTime: dayOne + 1_000 });
    store.recordSnapshot(snapshot);
    store.recordRaw({ receivedAt: dayTwo, source: "rtds", payload: "next day" });
    await store.waitForCompression();
    store.close();

    const result = await backfillRecordings(root, {
      resolutions: async (marketIds) => {
        assert.deepEqual(marketIds, [snapshot.marketId]);
        return new Map([[snapshot.marketId, { marketId: snapshot.marketId, outcome: "UP", resolvedAt: dayTwo + 60_000 }]]);
      },
      officialPrice: async (asset, startTime, duration) => {
        assert.equal(asset, "BTC");
        assert.equal(startTime, snapshot.startTime);
        assert.equal(duration, "5m");
        return { openPrice: 100_000, closePrice: 100_025, completed: true, fetchedAt: dayTwo + 60_000 };
      },
    });

    assert.deepEqual(result, { files: 2, markets: 1, resolutionsAdded: 1, pricesUpdated: 1 });
    const archivedPath = listRecordingFiles(root).find((file) => file.endsWith("recording-2026-03-01.sqlite.gz"));
    assert.ok(archivedPath);
    const recording = await openRecordingFile(archivedPath);
    try {
      assert.equal((recording.db.prepare("SELECT outcome FROM resolutions WHERE market_id = ?").get(snapshot.marketId) as { outcome: string }).outcome, "UP");
      assert.equal(
        (recording.db.prepare("SELECT close_price FROM official_prices WHERE market_id = ?").get(snapshot.marketId) as { close_price: number }).close_price,
        100_025,
      );
    } finally {
      await recording.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
