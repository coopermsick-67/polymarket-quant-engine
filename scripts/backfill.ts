import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fetchOfficialPrice, fetchResolutions, type OfficialPrice, type Resolution } from "../app/lib/polymarket-data";
import type { MarketSnapshot } from "../app/lib/signal";
import { listRecordingFiles, openRecordingFile } from "./recording-store";

export type BackfillSources = {
  resolutions: (marketIds: string[]) => Promise<Map<string, Resolution>>;
  officialPrice: (asset: string, startTime: number, duration: "5m" | "15m") => Promise<OfficialPrice | null>;
};

const defaultSources: BackfillSources = {
  resolutions: fetchResolutions,
  officialPrice: (asset, startTime, duration) => fetchOfficialPrice(asset, startTime, duration).catch(() => null),
};

const getMarkets = (db: DatabaseSync) => {
  const rows = db.prepare("SELECT market_id, snapshot_json FROM snapshots GROUP BY market_id").all() as { market_id: string; snapshot_json: string }[];
  const markets = new Map<string, MarketSnapshot>();
  for (const row of rows) {
    try {
      const snapshot = JSON.parse(row.snapshot_json) as MarketSnapshot;
      if (snapshot.marketId === row.market_id && snapshot.asset && snapshot.startTime && snapshot.endTime) markets.set(row.market_id, snapshot);
    } catch {
      // A corrupt snapshot should not prevent backfilling the remaining markets.
    }
  }
  return markets;
};

export const backfillRecordingDatabase = async (db: DatabaseSync, sources: BackfillSources = defaultSources) => {
  const markets = getMarkets(db);
  const existingResolutions = new Set((db.prepare("SELECT market_id FROM resolutions").all() as { market_id: string }[]).map((row) => row.market_id));
  const missingResolutionIds = [...markets.keys()].filter((marketId) => !existingResolutions.has(marketId));
  let resolutionsAdded = 0;
  for (let i = 0; i < missingResolutionIds.length; i += 120) {
    const resolved = await sources.resolutions(missingResolutionIds.slice(i, i + 120));
    const write = db.prepare(
      "INSERT INTO resolutions (market_id, resolved_at, outcome, payload_json) VALUES (?, ?, ?, ?) ON CONFLICT(market_id) DO UPDATE SET resolved_at=excluded.resolved_at, outcome=excluded.outcome, payload_json=excluded.payload_json",
    );
    for (const [marketId, resolution] of resolved) {
      if (!markets.has(marketId)) continue;
      write.run(marketId, resolution.resolvedAt, resolution.outcome, JSON.stringify(resolution));
      resolutionsAdded += 1;
    }
  }

  const existingPrices = new Map(
    (
      db.prepare("SELECT market_id, open_price, close_price, completed FROM official_prices").all() as {
        market_id: string;
        open_price: number | null;
        close_price: number | null;
        completed: number;
      }[]
    ).map((row) => [row.market_id, row]),
  );
  const pricesToFetch = [...markets.entries()].filter(([marketId]) => {
    const existing = existingPrices.get(marketId);
    return !existing || !existing.completed || existing.open_price === null || existing.close_price === null;
  });
  let pricesUpdated = 0;
  const writePrice = db.prepare(
    "INSERT INTO official_prices (market_id, asset, duration, start_time, end_time, open_price, close_price, completed, fetched_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(market_id) DO UPDATE SET open_price=excluded.open_price, close_price=excluded.close_price, completed=excluded.completed, fetched_at=excluded.fetched_at, payload_json=excluded.payload_json",
  );
  for (let i = 0; i < pricesToFetch.length; i += 8) {
    const batch = pricesToFetch.slice(i, i + 8);
    const results = await Promise.all(
      batch.map(async ([marketId, snapshot]) => ({
        marketId,
        snapshot,
        price: await sources.officialPrice(snapshot.asset, snapshot.startTime, snapshot.duration),
      })),
    );
    for (const { marketId, snapshot, price } of results) {
      if (!price) continue;
      writePrice.run(
        marketId,
        snapshot.asset,
        snapshot.duration,
        snapshot.startTime,
        snapshot.endTime,
        price.openPrice,
        price.closePrice,
        Number(price.completed),
        price.fetchedAt,
        JSON.stringify(price),
      );
      pricesUpdated += 1;
    }
  }
  return { markets: markets.size, resolutionsAdded, pricesUpdated };
};

export const backfillRecordings = async (dataDir: string, sources: BackfillSources = defaultSources) => {
  const files = listRecordingFiles(dataDir);
  const plainPaths = new Set(files.filter((file) => file.endsWith(".sqlite")));
  const uniqueFiles = files.filter((file) => !file.endsWith(".gz") || !plainPaths.has(file.slice(0, -3)));
  const totals = { files: 0, markets: 0, resolutionsAdded: 0, pricesUpdated: 0 };
  for (const file of uniqueFiles) {
    const recording = await openRecordingFile(file, true);
    try {
      const result = await backfillRecordingDatabase(recording.db, sources);
      totals.files += 1;
      totals.markets += result.markets;
      totals.resolutionsAdded += result.resolutionsAdded;
      totals.pricesUpdated += result.pricesUpdated;
    } finally {
      await recording.close();
    }
  }
  return totals;
};

const option = (name: string, fallback: string) => {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const scriptUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === scriptUrl) {
  const result = await backfillRecordings(option("data-dir", "data"));
  console.log(JSON.stringify(result));
}
