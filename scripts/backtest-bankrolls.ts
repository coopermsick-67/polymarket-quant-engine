import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseBankrollBacktestCsv, runMultiBankrollBacktest, type BankrollReplayOptions } from "../app/lib/bankroll-backtest";

const usage = `Usage: pnpm exec tsx scripts/backtest-bankrolls.ts recorded-market-history.csv [options]

Options:
  --fee-rate RATE             Flat entry fee assumption (default: 0.02)
  --slippage-bps BPS          Ask slippage assumption (default: 25)
  --minimum-order-usd USD     Minimum order assumption if not in each row
  --assumed-depth-usd USD     Fill missing ask depth (research-only)
  --assumed-spread-pct RATE   Fill missing bid/spread (research-only)
  --model-version VERSION     Analyze one recorded model version

The CSV must contain timestamp, asset, duration, market_id, reference, spot,
up_ask, down_ask, remaining_seconds, validation_probability_up,
validation_decision, and ideally settled outcome plus both bid and ask depth.
No market outcomes, executable depth, or venue minimums are invented by default.`;

const optionNames: Record<string, keyof BankrollReplayOptions> = {
  "--fee-rate": "feeRate",
  "--slippage-bps": "slippageBps",
  "--minimum-order-usd": "minimumOrderUsd",
  "--assumed-depth-usd": "assumedDepthUsd",
  "--assumed-spread-pct": "assumedSpreadPct",
  "--model-version": "modelVersion",
};

const args = process.argv.slice(2);
if (!args[0] || args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(`${usage}\n`);
  process.exit(args[0] ? 0 : 2);
}

const file = path.resolve(args[0]);
const options: BankrollReplayOptions = {};
for (let index = 1; index < args.length; index += 2) {
  const key = optionNames[args[index]];
  const raw = args[index + 1];
  if (!key || !raw) {
    process.stderr.write(`Invalid option or missing value: ${args[index]}\n${usage}\n`);
    process.exit(2);
  }
  if (key === "modelVersion") options.modelVersion = raw;
  else {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      process.stderr.write(`Invalid nonnegative number for ${args[index]}: ${raw}\n`);
      process.exit(2);
    }
    Object.assign(options, { [key]: value });
  }
}

try {
  const text = await readFile(file, "utf8");
  const parsed = parseBankrollBacktestCsv(text);
  if (!parsed.rows.length) {
    process.stderr.write("No valid recorded rows found. No performance estimate was produced.\n");
    process.exit(1);
  }
  const result = runMultiBankrollBacktest(parsed.rows, options);
  const summary = {
    source: file,
    parsedRows: parsed.rows.length,
    rejectedRows: parsed.rejected,
    recordedPredictions: result.recordedPredictions,
    resolvedMarkets: result.resolvedMarkets,
    datasetHasSettledOutcomes: result.datasetHasSettledOutcomes,
    assumptions: result.assumptions,
    limitations: result.limitations,
    calibration: {
      buckets: result.calibration.buckets,
      raw: result.calibration.raw,
      adjustedOutOfSample: result.calibration.adjustedOutOfSample,
      minimumTrainingSamples: result.calibration.minimumTrainingSamples,
      minimumBucketSamples: result.calibration.minimumBucketSamples,
    },
    accounts: result.accounts.map((account) => ({ ...account, tradeDetails: undefined })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
