import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireRunnerLease } from "./runner-lock";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS, readRunnerHeartbeatFile, restartDelayMs, supervisorRestartReason } from "./runner-health";

export type SupervisorOptions = { dataDir: string; runnerArgs: string[]; heartbeatTimeoutMs: number };
type ChildExit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

const allowedRunnerOptions = new Set(["--cash", "--latency", "--record-interval"]);

export const parseSupervisorArgs = (args: string[]): SupervisorOptions => {
  const values = args.filter((argument) => argument !== "--");
  let dataDir = "data";
  let heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const runnerArgs: string[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const argument = values[i];
    if (argument === "--data-dir" || argument === "--heartbeat-timeout-seconds") {
      const value = values[++i];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--data-dir") dataDir = value;
      else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 10) throw new Error("Heartbeat timeout must be at least 10 seconds");
        heartbeatTimeoutMs = seconds * 1_000;
      }
      continue;
    }
    if (allowedRunnerOptions.has(argument)) {
      const value = values[++i];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      runnerArgs.push(argument, value);
      continue;
    }
    throw new Error(`Unsupported supervisor option: ${argument}`);
  }
  return { dataDir: resolve(dataDir), runnerArgs, heartbeatTimeoutMs };
};

export const buildPaperRunnerArgs = (dataDir: string, runnerArgs: string[]) => ["--auto", "--data-dir", dataDir, ...runnerArgs];

const wait = (milliseconds: number, shouldStop: () => boolean) =>
  new Promise<void>((resolvePromise) => {
    if (shouldStop()) return resolvePromise();
    const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
    const check = setInterval(() => {
      if (shouldStop()) {
        if (timeout.handle) clearTimeout(timeout.handle);
        clearInterval(check);
        resolvePromise();
      }
    }, 100);
    timeout.handle = setTimeout(() => {
      clearInterval(check);
      resolvePromise();
    }, milliseconds);
  });

const childExit = (child: ChildProcess) =>
  new Promise<ChildExit>((resolvePromise) => {
    let settled = false;
    const finish = (exit: ChildExit) => {
      if (settled) return;
      settled = true;
      resolvePromise(exit);
    };
    child.once("close", (code, signal) => finish({ code, signal }));
    child.once("error", (error) => finish({ code: null, signal: null, error }));
  });

export const runHeadlessSupervisor = async (
  options: SupervisorOptions,
  dependencies: {
    spawnChild?: typeof spawn;
    now?: () => number;
    wait?: (milliseconds: number, shouldStop: () => boolean) => Promise<void>;
    onMessage?: (message: string) => void;
    stopSignal?: AbortSignal;
    monitorIntervalMs?: number;
    startupGraceMs?: number;
    staleKillGraceMs?: number;
  } = {},
) => {
  const spawnChild = dependencies.spawnChild ?? spawn;
  const now = dependencies.now ?? Date.now;
  const delay = dependencies.wait ?? wait;
  const say = dependencies.onMessage ?? console.log;
  const monitorIntervalMs = dependencies.monitorIntervalMs ?? 5_000;
  const startupGraceMs = dependencies.startupGraceMs ?? 90_000;
  const staleKillGraceMs = dependencies.staleKillGraceMs ?? 15_000;
  mkdirSync(options.dataDir, { recursive: true });
  const lease = acquireRunnerLease(options.dataDir, process.pid, now());
  const heartbeatPath = join(options.dataDir, "runner-heartbeat.json");
  const scriptPath = fileURLToPath(new URL("./headless.ts", import.meta.url));
  let stopping = false;
  let activeChild: ChildProcess | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const leaseTimer = setInterval(() => {
    try {
      lease.refresh(now());
    } catch (error) {
      say(`Could not refresh the single-runner lease: ${error instanceof Error ? error.message : String(error)}`);
      requestStop();
    }
  }, 5_000);
  leaseTimer.unref?.();

  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    say("Supervisor received a stop signal; asking the paper runner to flush and stop.");
    activeChild?.kill("SIGTERM");
    killTimer = setTimeout(() => activeChild?.kill("SIGKILL"), 25_000);
    killTimer.unref?.();
  };

  const onInterrupt = () => requestStop();
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  dependencies.stopSignal?.addEventListener("abort", onInterrupt, { once: true });
  if (dependencies.stopSignal?.aborted) requestStop();

  let failures = 0;
  try {
    while (!stopping) {
      const launchedAt = now();
      const child = spawnChild(process.execPath, ["--import", "tsx", scriptPath, ...buildPaperRunnerArgs(options.dataDir, options.runnerArgs)], {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      });
      activeChild = child;
      say(`Paper recorder started (pid ${child.pid ?? "unknown"}); heartbeat ${heartbeatPath}`);

      let heartbeatHealthySince: number | null = null;
      let restartReason = "runner exited";
      let killStaleTimer: ReturnType<typeof setTimeout> | null = null;
      const monitor = setInterval(() => {
        if (stopping || child.exitCode !== null || child.signalCode !== null) return;
        const at = now();
        const heartbeat = readRunnerHeartbeatFile(heartbeatPath);
        const reason = supervisorRestartReason(heartbeat, {
          now: at,
          expectedPid: child.pid ?? undefined,
          timeoutMs: options.heartbeatTimeoutMs,
        });
        if (reason && at - launchedAt > startupGraceMs) {
          restartReason = reason;
          say(`Paper runner heartbeat failed: ${reason}; restarting the stalled process.`);
          child.kill("SIGTERM");
          killStaleTimer = setTimeout(() => child.kill("SIGKILL"), staleKillGraceMs);
          killStaleTimer.unref?.();
          clearInterval(monitor);
        } else if (!reason) {
          heartbeatHealthySince ??= at;
        }
      }, monitorIntervalMs);
      monitor.unref?.();

      const result = await childExit(child);
      clearInterval(monitor);
      if (killStaleTimer) clearTimeout(killStaleTimer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      activeChild = null;
      if (stopping) break;

      const stableForMs = heartbeatHealthySince === null ? 0 : Math.max(0, now() - heartbeatHealthySince);
      failures = stableForMs >= 60_000 ? 1 : failures + 1;
      const waitMs = restartDelayMs(failures, stableForMs);
      const exitDescription = result.error ? result.error.message : `code ${result.code ?? "unknown"}${result.signal ? `, signal ${result.signal}` : ""}`;
      say(`Paper runner stopped (${exitDescription}; ${restartReason}). Restarting in ${waitMs / 1_000}s.`);
      await delay(waitMs, () => stopping);
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    dependencies.stopSignal?.removeEventListener("abort", onInterrupt);
    clearInterval(leaseTimer);
    if (killTimer) clearTimeout(killTimer);
    if (activeChild) {
      activeChild.kill("SIGTERM");
      await childExit(activeChild);
    }
    lease.release();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runHeadlessSupervisor(parseSupervisorArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
