#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
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
const stateOperationLockFile = path.join(stateDir, "STATE_OPERATION.lock");
const stateOperationRecoveryLockFile = path.join(stateDir, "STATE_OPERATION_RECOVERY.lock");

async function acquireStateOperationLock() {
  await mkdir(stateDir, { recursive: true, mode: 0o750 });
  try { return await open(stateOperationLockFile, "wx", 0o640); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let recoveryLock;
  try { recoveryLock = await open(stateOperationRecoveryLockFile, "wx", 0o640); }
  catch (error) { if (error.code === "EEXIST") throw new Error("A daemon startup or paper reset is already recovering this state directory."); throw error; }
  try {
    const owner = Number((await readFile(stateOperationLockFile, "utf8")).trim());
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("A daemon startup or paper reset is still initializing its lock.");
    try {
      process.kill(owner, 0);
      throw new Error("A daemon startup or paper reset is already using this state directory.");
    } catch (error) { if (error.code !== "ESRCH") throw error; }
    await rm(stateOperationLockFile, { force: true });
    let lock;
    try { lock = await open(stateOperationLockFile, "wx", 0o640); }
    catch (error) { if (error.code === "EEXIST") throw new Error("A daemon startup or paper reset is already using this state directory."); throw error; }
    return lock;
  } finally {
    await recoveryLock.close();
    await rm(stateOperationRecoveryLockFile, { force: true });
  }
}

async function withStateOperationLock(work) {
  let lock;
  try { lock = await acquireStateOperationLock(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    await work();
  } finally {
    await lock.close();
    await rm(stateOperationLockFile, { force: true });
  }
}

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

async function daemonIsListening() {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 8788 });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
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
  await setFlag(flags.resetRiskDay, "Operator requested a new daily-loss baseline.");
  await Promise.all([rm(flags.kill, { force: true }), rm(flags.stale, { force: true }), rm(flags.risk, { force: true })]);
  process.stdout.write("Kill, stale-data, and daily-loss latches cleared. The daemon will establish a new loss baseline on its next fresh-data cycle. Use resume separately if paused.\n");
} else if (action === "reset-paper") {
  const startingCash = Number(process.argv[3] ?? process.env.PAPER_STARTING_CASH ?? 100);
  if (!Number.isFinite(startingCash) || startingCash < 1 || startingCash > 1_000_000_000) {
    process.stderr.write("Starting balance must be between $1 and $1,000,000,000.\n");
    process.exitCode = 64;
  } else {
    await withStateOperationLock(async () => {
      if (await daemonIsListening()) {
        process.stderr.write("Stop the paper daemon before resetting its account.\n");
        process.exitCode = 2;
        return;
      }
      let previous = null;
      try { previous = JSON.parse(await readFile(path.join(stateDir, "paper-state.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (previous && (previous.mode !== "paper" || !Array.isArray(previous.account?.positions) || previous.account.positions.length > 0)) {
        process.stderr.write("Reset is blocked unless the saved account is paper-only and has no open positions.\n");
        process.exitCode = 2;
        return;
      }
      let archived = null;
      if (previous) {
        archived = path.join(stateDir, `paper-state-before-reset-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        await rename(path.join(stateDir, "paper-state.json"), archived);
      }
      await writeFile(path.join(stateDir, "PAPER_RESET_BALANCE"), `${startingCash}\n`, { mode: 0o640 });
      await Promise.all([rm(flags.kill, { force: true }), rm(flags.pause, { force: true }), rm(flags.stale, { force: true }),
        rm(flags.risk, { force: true }), rm(flags.resetRiskDay, { force: true })]);
      process.stdout.write(`Paper account reset to $${startingCash.toFixed(2)}. Previous ledger${archived ? ` archived at ${archived}` : " not present"}; start the paper daemon to initialize the new account.\n`);
    });
  }
} else {
  process.stderr.write("Usage: daemon-control.mjs {status|pause|resume|kill|clear-halt|reset-paper [starting-cash]}\n");
  process.exitCode = 64;
}
