// Command-line replay over recordings written by the headless runner.
//
//   pnpm run replay -- data/replay-2026-09-23.jsonl [more.jsonl] [--latency 750] [--stake 25] [--walk-forward]
//
// Resolutions missing from the recording are fetched from Gamma, so a
// recording can be scored after its markets settle.

import { readFileSync } from "node:fs";
import { fetchResolutions } from "../app/lib/polymarket-data";
import { parseReplayJsonl, runReplay, walkForward, type ReplayReport } from "../app/lib/replay";
import type { MarketSnapshot, Side } from "../app/lib/signal";
import { openRecordingFile } from "./recording-store";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};
const files = args.filter((arg) => /\.(?:jsonl|sqlite|sqlite\.gz)$/.test(arg));
if (!files.length) {
  console.error("usage: pnpm run replay -- <recording.jsonl|recording.sqlite|recording.sqlite.gz> [more files] [--latency ms] [--stake usd] [--walk-forward]");
  process.exit(1);
}

const snapshots: MarketSnapshot[] = [];
const outcomes = new Map<string, Side>();
for (const file of files) {
  if (file.endsWith(".jsonl")) {
    const parsed = parseReplayJsonl(readFileSync(file, "utf8"));
    snapshots.push(...parsed.snapshots);
    for (const [id, outcome] of parsed.outcomes) outcomes.set(id, outcome);
  } else {
    const recording = await openRecordingFile(file);
    try {
      const rows = recording.db.prepare("SELECT snapshot_json FROM snapshots ORDER BY at").all() as { snapshot_json: string }[];
      for (const row of rows) snapshots.push(JSON.parse(row.snapshot_json) as MarketSnapshot);
      const resolutions = recording.db.prepare("SELECT market_id, outcome FROM resolutions").all() as { market_id: string; outcome: Side }[];
      for (const row of resolutions) outcomes.set(row.market_id, row.outcome);
    } finally {
      await recording.close();
    }
  }
}
const marketIds = [...new Set(snapshots.map((snapshot) => snapshot.marketId))];
const missing = marketIds.filter((id) => !outcomes.has(id));
if (missing.length) {
  const fetched = await fetchResolutions(missing).catch(() => new Map());
  for (const [id, resolution] of fetched) outcomes.set(id, resolution.outcome);
}

const params = { minEdge: option("min-edge", 0.03), modelWeight: option("model-weight", 0.6) };
const options = { latencyMs: option("latency", 750), stakeUsd: option("stake", 25), params };
const fmt = (value: number | null | undefined, digits = 4) => (value === null || value === undefined ? "—" : value.toFixed(digits));
const print = (label: string, report: ReplayReport) => {
  console.log(`\n== ${label} ==`);
  console.log(
    `markets ${report.markets} · snapshots ${report.snapshots} · signals ${report.signals} · fills ${report.fills} (fill rate ${fmt(report.fillRate, 2)})`,
  );
  console.log(
    `settled ${report.settled} · win ${fmt(report.winRate, 3)} CI ${report.winRateCi ? report.winRateCi.map((value) => value.toFixed(3)).join("–") : "—"}`,
  );
  console.log(`net P&L ${report.netPnl.toFixed(2)} · EV/trade ${fmt(report.evPerTrade, 3)} · ROI on turnover ${fmt(report.roiOnTurnover, 3)}`);
  console.log(
    `edge predicted ${fmt(report.avgPredictedEdge)} realized ${fmt(report.avgRealizedEdge)} · slippage ${fmt(report.avgSlippage)} · markout 5s ${fmt(report.avgMarkout5s)} 30s ${fmt(report.avgMarkout30s)}`,
  );
  console.log(
    `max DD ${fmt(report.maxDrawdown, 3)} · daily Sharpe ${fmt(report.dailySharpe, 2)} · trades for significance ${report.tradesNeededForSignificance ?? "—"}`,
  );
  const c = report.calibration;
  console.log(
    `calibration (${c.rows} checkpoints): Brier model ${fmt(c.model.brier)} posterior ${fmt(c.posterior.brier)} book ${fmt(c.market.brier)} · log-loss model ${fmt(c.model.logLoss)} book ${fmt(c.market.logLoss)}`,
  );
  console.log(
    "reliability (model):",
    c.reliability
      .filter((bin) => bin.n)
      .map((bin) => `${bin.from.toFixed(1)}-${bin.to.toFixed(1)}: n=${bin.n} pred ${bin.predicted.toFixed(2)} obs ${bin.observed.toFixed(2)}`)
      .join(" | "),
  );
  console.log("by asset:", JSON.stringify(report.byAsset));
};

console.log(`${snapshots.length} snapshots, ${marketIds.length} markets, ${outcomes.size} with official outcomes`);
print("replay", runReplay(snapshots, outcomes, options));
if (args.includes("--walk-forward")) {
  const grid = [0.02, 0.03, 0.05].flatMap((minEdge) => [0.4, 0.6, 0.8].map((modelWeight) => ({ minEdge, modelWeight })));
  const result = walkForward(snapshots, outcomes, grid, options, 0.6, 20);
  console.log(`\nwalk-forward: train ${result.trainMarkets} markets, test ${result.testMarkets}; chosen ${JSON.stringify(result.chosen)}`);
  if (result.test) print("out-of-sample", result.test);
}
