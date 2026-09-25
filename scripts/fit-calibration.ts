/**
 * Fit the stacking weights that decide how much the model may move the book
 * probability: logit P(UP) = a + b_model * logit(model) + b_market * logit(mid).
 *
 * Reads the daemon's decision-time observations (STATE_DIR/observations.jsonl),
 * resolves each market's outcome from Gamma (cached in outcomes.json), and
 * writes model-calibration.json. The file is only marked usable when at least
 * 300 settled markets exist and the model coefficient's market-clustered lower
 * 95% bound is above zero; otherwise every process keeps the conservative prior.
 *
 *   pnpm run calibrate            # uses ./var
 *   STATE_DIR=/path pnpm run calibrate
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchResolvedMarketOutcomes } from "../app/lib/polymarket-data";
import { fitStackingCalibration, type CalibrationObservation } from "../app/lib/model-calibration";
import { saveCalibrationFile } from "./calibration-file";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.resolve(process.env.STATE_DIR || path.join(projectRoot, "var"));
const observationFile = path.join(stateDir, "observations.jsonl");
const outcomeCacheFile = path.join(stateDir, "outcomes.json");
const calibrationFile = path.resolve(process.env.POLYMARKET_CALIBRATION_FILE || path.join(stateDir, "model-calibration.json"));
const OUTCOME_BATCH = 20;

type StoredObservation = CalibrationObservation & { upTokenId: string; downTokenId: string };

const readObservations = async (): Promise<StoredObservation[]> => {
  let text: string;
  try { text = await readFile(observationFile, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line) as Partial<StoredObservation>;
      return typeof row.marketId === "string" && typeof row.upTokenId === "string" && typeof row.downTokenId === "string"
        && Number.isFinite(row.rawModelUp) && Number.isFinite(row.marketUp) && Number.isFinite(row.at)
        ? [row as StoredObservation] : [];
    } catch { return []; }
  });
};

const readOutcomeCache = async (): Promise<Record<string, "UP" | "DOWN">> => {
  try { return JSON.parse(await readFile(outcomeCacheFile, "utf8")) as Record<string, "UP" | "DOWN">; } catch { return {}; }
};

const main = async () => {
  const observations = await readObservations();
  const outcomes = await readOutcomeCache();
  const now = Date.now();
  const unresolved = [...new Map(observations.filter((row) => !outcomes[row.marketId] && row.at < now - 20 * 60_000)
    .map((row) => [row.marketId, { id: row.marketId, upTokenId: row.upTokenId, downTokenId: row.downTokenId }])).values()];
  for (let index = 0; index < unresolved.length; index += OUTCOME_BATCH) {
    const resolved = await fetchResolvedMarketOutcomes(unresolved.slice(index, index + OUTCOME_BATCH));
    for (const [marketId, outcome] of resolved) outcomes[marketId] = outcome;
  }
  await writeFile(outcomeCacheFile, `${JSON.stringify(outcomes)}\n`, "utf8");
  const labelled = observations.map((row) => ({ ...row, outcome: outcomes[row.marketId] ?? null }));
  const report = fitStackingCalibration(labelled, { now });
  await saveCalibrationFile(calibrationFile, report);
  const fmt = (value: number | null, digits = 3) => value === null ? "n/a" : value.toFixed(digits);
  console.log(`Observations: ${observations.length} · settled markets: ${report.markets} · settled observations: ${report.observations}`);
  console.log(`Coefficients: intercept ${fmt(report.intercept)} · model ${fmt(report.modelCoefficient)} [95% ${fmt(report.modelCoefficientLower)}, ${fmt(report.modelCoefficientUpper)}] · market ${fmt(report.marketCoefficient)}`);
  console.log(`Log loss: fit ${fmt(report.logLoss, 4)} · book mid alone ${fmt(report.marketOnlyLogLoss, 4)}`);
  console.log(`${report.calibration ? "USABLE" : "NOT USABLE"}: ${report.reason}`);
  console.log(`Wrote ${calibrationFile}`);
};

main().catch((error) => {
  console.error(`Calibration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
