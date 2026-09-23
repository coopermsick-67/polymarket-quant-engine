import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildEvidenceReport, formatEvidenceReport } from "../app/lib/evidence-report";
import { listRecordingFiles, openRecordingFile } from "./recording-store";
import { backfillRecordings } from "./backfill";
import { walkForwardByDay, type ReplayOptions } from "../app/lib/replay";
import type { MarketSnapshot, Side } from "../app/lib/signal";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name: string) => args.includes(`--${name}`);
const dataDir = resolve(option("data-dir", "data"));
const reportsDir = resolve(option("reports-dir", join(dataDir, "reports")));

const loadRecordings = async (directory: string) => {
  const snapshots: MarketSnapshot[] = [];
  const outcomes = new Map<string, Side>();
  for (const path of listRecordingFiles(directory)) {
    const recording = await openRecordingFile(path);
    try {
      const snapshotRows = recording.db.prepare("SELECT snapshot_json FROM snapshots ORDER BY at").all() as { snapshot_json: string }[];
      for (const row of snapshotRows) {
        try {
          const snapshot = JSON.parse(row.snapshot_json) as MarketSnapshot;
          if (snapshot.marketId && Number.isFinite(snapshot.now) && Number.isFinite(snapshot.startTime)) snapshots.push(snapshot);
        } catch {
          // Keep reporting the valid parts of a database with a corrupt row.
        }
      }
      const resolutionRows = recording.db.prepare("SELECT market_id, outcome FROM resolutions").all() as { market_id: string; outcome: Side }[];
      for (const row of resolutionRows) if (row.outcome === "UP" || row.outcome === "DOWN") outcomes.set(row.market_id, row.outcome);
    } finally {
      await recording.close();
    }
  }
  return { snapshots, outcomes };
};

const atomicWrite = async (path: string, contents: string) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
};

const sendTelegram = async (text: string) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "not-configured";
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok ? "sent" : `failed-${response.status}`;
  } catch (error) {
    return `failed-${error instanceof Error ? error.message : String(error)}`;
  }
};

let backfill: { files: number; markets: number; resolutionsAdded: number; pricesUpdated: number } | null = null;
let backfillError: string | null = null;
if (!flag("skip-backfill")) {
  try {
    backfill = await backfillRecordings(dataDir);
  } catch (error) {
    backfillError = error instanceof Error ? error.message : String(error);
  }
}

const { snapshots, outcomes } = await loadRecordings(dataDir);
const grid = [0.02, 0.03, 0.05].flatMap((minEdge) => [0.4, 0.6, 0.8].map((modelWeight) => ({ minEdge, modelWeight })));
const options: Partial<ReplayOptions> = { latencyMs: Number(option("latency-ms", "750")), stakeUsd: Number(option("stake-usd", "25")) };
const folds = walkForwardByDay(snapshots, outcomes, grid, options, Number(option("min-train-trades", "30")));
const report = buildEvidenceReport({ snapshots, outcomes, folds });
const markdown = formatEvidenceReport(report);
const day = report.generatedAt.slice(0, 10);
const jsonPath = join(reportsDir, `${day}.json`);
const markdownPath = join(reportsDir, `${day}.md`);
await atomicWrite(jsonPath, `${JSON.stringify({ ...report, backfill, backfillError }, null, 2)}\n`);
await atomicWrite(markdownPath, `${markdown}${backfillError ? `\nBackfill error: ${backfillError}\n` : ""}`);

const summary = [
  `Nightly quant evidence ${day}`,
  `OOS ${report.sample.outOfSampleDays} days/${report.sample.outOfSampleResolvedMarkets} resolved markets; ${report.trading.outOfSampleTrades} settled trades.`,
  `Gates: ${Object.entries(report.gates)
    .map(([gate, value]) => `${gate} ${value.status}`)
    .join(" · ")}`,
  `Brier posterior/book ${report.calibration.posteriorBrier?.toFixed(4) ?? "n/a"}/${report.calibration.bookBrier?.toFixed(4) ?? "n/a"}; edge CI ${report.trading.realizedEdge.lower?.toFixed(4) ?? "n/a"}…${report.trading.realizedEdge.upper?.toFixed(4) ?? "n/a"}.`,
  `Report: ${markdownPath}`,
].join("\n");
const telegram = await sendTelegram(summary);
console.log(
  JSON.stringify(
    {
      markdownPath,
      jsonPath,
      snapshots: snapshots.length,
      recordedMarkets: report.sample.recordedMarkets,
      resolvedMarkets: report.sample.resolvedMarkets,
      outOfSampleDays: report.sample.outOfSampleDays,
      outOfSampleResolvedMarkets: report.sample.outOfSampleResolvedMarkets,
      outOfSampleTrades: report.trading.outOfSampleTrades,
      gates: Object.fromEntries(Object.entries(report.gates).map(([gate, value]) => [gate, value.status])),
      backfill,
      backfillError,
      telegram,
    },
    null,
    2,
  ),
);
