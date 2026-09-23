import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { PaperFill } from "../app/lib/engines";
import type { OfficialPrice, Resolution } from "../app/lib/polymarket-data";
import type { Horizon, MarketSnapshot, Signal } from "../app/lib/signal";

export type RawRecordedMessage = {
  receivedAt: number;
  source: string;
  venue?: string | null;
  channel?: string | null;
  marketId?: string | null;
  asset?: string | null;
  payload: string;
};

export type RecordedVenueTick = {
  receivedAt: number;
  exchangeAt: number;
  venue: "binance" | "bybit" | "okx";
  marketType: "spot" | "perp";
  asset: string;
  price: number;
};

export type RecordedOfficialPrice = {
  marketId: string;
  asset: string;
  duration: Horizon;
  startTime: number;
  endTime: number;
  price: OfficialPrice;
};

const dayKey = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
const databasePath = (dataDir: string, day: string) => join(dataDir, "recordings", `recording-${day}.sqlite`);

const schema = [
  "CREATE TABLE IF NOT EXISTS raw_messages (id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL, source TEXT NOT NULL, venue TEXT, channel TEXT, market_id TEXT, asset TEXT, payload TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS raw_messages_source_time ON raw_messages(source, received_at)",
  "CREATE TABLE IF NOT EXISTS venue_ticks (id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL, exchange_at INTEGER NOT NULL, venue TEXT NOT NULL, market_type TEXT NOT NULL, asset TEXT NOT NULL, price REAL NOT NULL)",
  "CREATE INDEX IF NOT EXISTS venue_ticks_asset_time ON venue_ticks(asset, venue, market_type, exchange_at)",
  "CREATE TABLE IF NOT EXISTS snapshots (market_id TEXT NOT NULL, at INTEGER NOT NULL, asset TEXT NOT NULL, duration TEXT NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY (market_id, at))",
  "CREATE INDEX IF NOT EXISTS snapshots_asset_time ON snapshots(asset, at)",
  "CREATE TABLE IF NOT EXISTS decisions (market_id TEXT NOT NULL, at INTEGER NOT NULL, action TEXT NOT NULL, gate TEXT NOT NULL, reason TEXT NOT NULL, signal_json TEXT NOT NULL, PRIMARY KEY (market_id, at))",
  "CREATE TABLE IF NOT EXISTS simulated_fills (fill_id TEXT PRIMARY KEY, at INTEGER NOT NULL, market_id TEXT NOT NULL, action TEXT NOT NULL, fill_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS resolutions (market_id TEXT PRIMARY KEY, resolved_at INTEGER NOT NULL, outcome TEXT NOT NULL, payload_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS official_prices (market_id TEXT PRIMARY KEY, asset TEXT NOT NULL, duration TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, open_price REAL, close_price REAL, completed INTEGER NOT NULL, fetched_at INTEGER NOT NULL, payload_json TEXT NOT NULL)",
];

const asJson = (value: unknown) => JSON.stringify(value);

/** One SQLite database per UTC day; closed days are gzipped after a clean checkpoint. */
export class RecordingStore {
  private readonly dataDir: string;
  readonly directory: string;
  private db: DatabaseSync;
  private readonly calibrationDb: DatabaseSync;
  private activeDay: string;
  private activePath: string;
  private compressionTasks = new Set<Promise<void>>();
  readonly compressionErrors: string[] = [];

  private constructor(dataDir: string, day: string) {
    this.dataDir = dataDir;
    this.directory = join(dataDir, "recordings");
    mkdirSync(this.directory, { recursive: true });
    this.activeDay = day;
    this.activePath = databasePath(dataDir, day);
    this.db = this.openDay(this.activePath);
    this.calibrationDb = new DatabaseSync(join(this.directory, "calibration.sqlite"));
    this.calibrationDb.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS calibration_observations (market_id TEXT PRIMARY KEY, decision_at INTEGER NOT NULL, remaining_seconds REAL NOT NULL, posterior_probability REAL NOT NULL, book_probability REAL, outcome TEXT, resolved_at INTEGER); CREATE INDEX IF NOT EXISTS calibration_resolved_at ON calibration_observations(resolved_at DESC)",
    );
  }

  static async open(dataDir: string, now = Date.now()): Promise<RecordingStore> {
    const day = dayKey(now);
    const path = databasePath(dataDir, day);
    const archive = `${path}.gz`;
    if (!existsSync(path) && existsSync(archive)) {
      const restorePath = `${path}.restore.tmp`;
      try {
        await pipeline(createReadStream(archive), createGunzip(), createWriteStream(restorePath, { flags: "wx" }));
        renameSync(restorePath, path);
      } catch (error) {
        try {
          unlinkSync(restorePath);
        } catch {
          // A failed restore must leave the compressed source intact.
        }
        throw error;
      }
    }
    return new RecordingStore(dataDir, day);
  }

  private openDay(path: string) {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    db.exec(schema.join(";\n"));
    return db;
  }

  private rotate(at: number) {
    const nextDay = dayKey(at);
    if (nextDay === this.activeDay) return;
    const previousPath = this.activePath;
    this.closeDatabase();
    this.activeDay = nextDay;
    this.activePath = databasePath(this.dataDir, nextDay);
    this.db = this.openDay(this.activePath);
    this.compressClosedDatabase(previousPath);
  }

  private closeDatabase() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
    this.db.close();
  }

  private compressClosedDatabase(path: string) {
    const archive = `${path}.gz`;
    const temporary = `${archive}.tmp`;
    if (existsSync(archive)) {
      this.compressionErrors.push(`Archive already exists; kept ${path} uncompressed.`);
      return;
    }
    const task = pipeline(createReadStream(path), createGzip(), createWriteStream(temporary, { flags: "wx" }))
      .then(async () => {
        renameSync(temporary, archive);
        unlinkSync(path);
      })
      .catch(async (error: unknown) => {
        try {
          await rm(temporary, { force: true });
        } catch {
          // Keep the original SQLite database if compression cleanup fails.
        }
        this.compressionErrors.push(error instanceof Error ? error.message : String(error));
      });
    this.compressionTasks.add(task);
    void task.finally(() => this.compressionTasks.delete(task));
  }

  recordRaw(message: RawRecordedMessage) {
    this.rotate(message.receivedAt);
    this.db
      .prepare("INSERT INTO raw_messages (received_at, source, venue, channel, market_id, asset, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        message.receivedAt,
        message.source,
        message.venue ?? null,
        message.channel ?? null,
        message.marketId ?? null,
        message.asset ?? null,
        message.payload,
      );
  }

  recordVenueTick(tick: RecordedVenueTick) {
    this.rotate(tick.receivedAt);
    this.db
      .prepare("INSERT INTO venue_ticks (received_at, exchange_at, venue, market_type, asset, price) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tick.receivedAt, tick.exchangeAt, tick.venue, tick.marketType, tick.asset, tick.price);
  }

  recordSnapshot(snapshot: MarketSnapshot) {
    this.rotate(snapshot.now);
    this.db
      .prepare("INSERT OR IGNORE INTO snapshots (market_id, at, asset, duration, snapshot_json) VALUES (?, ?, ?, ?, ?)")
      .run(snapshot.marketId, snapshot.now, snapshot.asset, snapshot.duration, asJson(snapshot));
  }

  recordDecision(marketId: string, at: number, signal: Signal) {
    this.rotate(at);
    this.db
      .prepare("INSERT OR IGNORE INTO decisions (market_id, at, action, gate, reason, signal_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(marketId, at, signal.action, signal.gate, signal.reason, asJson(signal));
  }

  recordPaperFill(fill: PaperFill) {
    this.rotate(fill.timestamp);
    this.db
      .prepare("INSERT OR IGNORE INTO simulated_fills (fill_id, at, market_id, action, fill_json) VALUES (?, ?, ?, ?, ?)")
      .run(fill.id, fill.timestamp, fill.marketId, fill.action, asJson(fill));
  }

  recordEvent(at: number, kind: string, payload: unknown) {
    this.rotate(at);
    this.db.prepare("INSERT INTO events (at, kind, payload_json) VALUES (?, ?, ?)").run(at, kind, asJson(payload));
  }

  recordResolution(resolution: Resolution) {
    this.rotate(resolution.resolvedAt);
    this.db
      .prepare(
        "INSERT INTO resolutions (market_id, resolved_at, outcome, payload_json) VALUES (?, ?, ?, ?) ON CONFLICT(market_id) DO UPDATE SET resolved_at=excluded.resolved_at, outcome=excluded.outcome, payload_json=excluded.payload_json",
      )
      .run(resolution.marketId, resolution.resolvedAt, resolution.outcome, asJson(resolution));
    this.calibrationDb
      .prepare("UPDATE calibration_observations SET outcome = ?, resolved_at = ? WHERE market_id = ?")
      .run(resolution.outcome, resolution.resolvedAt, resolution.marketId);
  }

  recordCalibrationCheckpoint(record: {
    marketId: string;
    at: number;
    remainingSeconds: number;
    posteriorProbability: number;
    bookProbability: number | null;
  }) {
    if (!Number.isFinite(record.posteriorProbability) || record.posteriorProbability < 0 || record.posteriorProbability > 1) return;
    if (record.bookProbability !== null && (!Number.isFinite(record.bookProbability) || record.bookProbability < 0 || record.bookProbability > 1)) return;
    this.calibrationDb
      .prepare(
        "INSERT OR IGNORE INTO calibration_observations (market_id, decision_at, remaining_seconds, posterior_probability, book_probability) VALUES (?, ?, ?, ?, ?)",
      )
      .run(record.marketId, record.at, record.remainingSeconds, record.posteriorProbability, record.bookProbability);
  }

  rollingCalibration(limit = 500) {
    const rows = this.calibrationDb
      .prepare(
        "SELECT posterior_probability, book_probability, outcome FROM calibration_observations WHERE outcome IN ('UP', 'DOWN') AND book_probability IS NOT NULL ORDER BY resolved_at DESC LIMIT ?",
      )
      .all(Math.max(1, Math.floor(limit))) as { posterior_probability: number; book_probability: number; outcome: "UP" | "DOWN" }[];
    if (!rows.length) return { markets: 0, posteriorBrier: null, bookBrier: null, brierDifferencePosteriorMinusBook: null };
    const posteriorBrier = rows.reduce((sum, row) => sum + (row.posterior_probability - Number(row.outcome === "UP")) ** 2, 0) / rows.length;
    const bookBrier = rows.reduce((sum, row) => sum + (row.book_probability - Number(row.outcome === "UP")) ** 2, 0) / rows.length;
    return { markets: rows.length, posteriorBrier, bookBrier, brierDifferencePosteriorMinusBook: posteriorBrier - bookBrier };
  }

  recordOfficialPrice(record: RecordedOfficialPrice) {
    this.rotate(record.price.fetchedAt);
    this.db
      .prepare(
        "INSERT INTO official_prices (market_id, asset, duration, start_time, end_time, open_price, close_price, completed, fetched_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(market_id) DO UPDATE SET open_price=excluded.open_price, close_price=excluded.close_price, completed=excluded.completed, fetched_at=excluded.fetched_at, payload_json=excluded.payload_json",
      )
      .run(
        record.marketId,
        record.asset,
        record.duration,
        record.startTime,
        record.endTime,
        record.price.openPrice,
        record.price.closePrice,
        Number(record.price.completed),
        record.price.fetchedAt,
        asJson(record.price),
      );
  }

  async waitForCompression() {
    await Promise.all([...this.compressionTasks]);
  }

  close() {
    this.closeDatabase();
    this.calibrationDb.close();
  }
}

export const listRecordingFiles = (dataDir: string) => {
  const directory = join(dataDir, "recordings");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => /^recording-\d{4}-\d{2}-\d{2}\.sqlite(?:\.gz)?$/.test(file))
    .sort()
    .map((file) => join(directory, file));
};

export const openRecordingFile = async (path: string, writable = false) => {
  if (!path.endsWith(".gz")) return { db: new DatabaseSync(path), close: () => {} };
  const directory = await mkdtemp(join(tmpdir(), "pqe-recording-"));
  const restored = join(directory, "recording.sqlite");
  try {
    await pipeline(createReadStream(path), createGunzip(), createWriteStream(restored, { flags: "wx" }));
    const db = new DatabaseSync(restored);
    return {
      db,
      close: async () => {
        db.close();
        if (writable) {
          const compressed = `${path}.tmp`;
          try {
            await pipeline(createReadStream(restored), createGzip(), createWriteStream(compressed, { flags: "wx" }));
            renameSync(compressed, path);
          } catch (error) {
            await rm(compressed, { force: true });
            throw error;
          }
        }
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};
