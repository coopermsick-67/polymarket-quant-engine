#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.resolve(process.env.STATE_DIR || path.join(projectRoot, "var"));
const action = process.argv[2];
const flags = {
  kill: path.join(stateDir, "KILL_SWITCH"),
  pause: path.join(stateDir, "PAUSED"),
  stale: path.join(stateDir, "STALE_DATA_HALT"),
  risk: path.join(stateDir, "RISK_HALT"),
  resetRiskDay: path.join(stateDir, "RESET_RISK_DAY"),
};

async function hasFlag(filename) {
  try { await readFile(filename); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function setFlag(filename, detail) {
  await mkdir(stateDir, { recursive: true, mode: 0o750 });
  try { await writeFile(filename, `${new Date().toISOString()} ${detail}\n`, { flag: "wx", mode: 0o640 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}

async function currentStatus() {
  try {
    const response = await fetch("http://127.0.0.1:8788/status", { signal: AbortSignal.timeout(2500) });
    if (response.ok) return await response.json();
  } catch {}
  try {
    const saved = JSON.parse(await readFile(path.join(stateDir, "paper-state.json"), "utf8"));
    return {
      service: "polymarket-quant-engine",
      process: "unavailable",
      mode: saved.mode,
      tradingState: "PROCESS_UNAVAILABLE",
      lastCycleAt: saved.lastCycleAt,
      lastHealthyDataAt: saved.lastHealthyDataAt,
      lastError: saved.lastError,
      marketsTracked: saved.marketsTracked,
      usableMarkets: saved.usableMarkets,
      paper: {
        cash: saved.account?.cash,
        realizedPnl: saved.account?.realizedPnl,
        openPositions: saved.account?.positions?.length,
      },
    };
  } catch { return { service: "polymarket-quant-engine", process: "unavailable", tradingState: "NO_STATE_FILE" }; }
}

if (action === "status") {
  process.stdout.write(`${JSON.stringify(await currentStatus(), null, 2)}\n`);
} else if (action === "pause") {
  await setFlag(flags.pause, "Operator paused new paper entries.");
  process.stdout.write("New paper entries paused. Existing paper positions can still exit and settle.\n");
} else if (action === "resume") {
  if (await hasFlag(flags.kill) || await hasFlag(flags.stale) || await hasFlag(flags.risk)) {
    process.stderr.write("Resume blocked by a kill, stale-data, or daily-loss halt. Review status, then run clear-halt explicitly.\n");
    process.exitCode = 2;
  } else {
    await rm(flags.pause, { force: true });
    process.stdout.write("Paper entries resumed.\n");
  }
} else if (action === "kill") {
  await setFlag(flags.kill, "Operator kill switch latched.");
  process.stdout.write("Kill switch latched. New paper entries are blocked; existing paper positions remain simulated.\n");
} else if (action === "clear-halt") {
  await Promise.all([rm(flags.kill, { force: true }), rm(flags.stale, { force: true }), rm(flags.risk, { force: true })]);
  await setFlag(flags.resetRiskDay, "Operator requested a new daily-loss baseline.");
  process.stdout.write("Kill, stale-data, and daily-loss latches cleared. The daemon will establish a new loss baseline on its next fresh-data cycle. Use resume separately if paused.\n");
} else {
  process.stderr.write("Usage: daemon-control.mjs {status|pause|resume|kill|clear-halt}\n");
  process.exitCode = 64;
}
