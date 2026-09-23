import { readFileSync, renameSync, writeFileSync } from "node:fs";

export type RunnerHeartbeat = {
  version: 1;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  lastTickAt: number | null;
  lastTickDurationMs: number | null;
  state: "starting" | "running" | "stopping" | "stopped";
  markets: number;
  feeds: Record<string, unknown>;
};

export const writeRunnerHeartbeat = (path: string, heartbeat: RunnerHeartbeat) => {
  const temporary = `${path}.${heartbeat.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(heartbeat)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

export const readRunnerHeartbeatFile = (path: string) => {
  try {
    return parseRunnerHeartbeat(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
};

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_RESTART_DELAY_MS = 1_000;
export const MAX_RESTART_DELAY_MS = 30_000;
export const STABLE_RUN_MS = 60_000;

export const parseRunnerHeartbeat = (value: unknown): RunnerHeartbeat | null => {
  if (!value || typeof value !== "object") return null;
  const heartbeat = value as Partial<RunnerHeartbeat>;
  if (
    heartbeat.version !== 1 ||
    !Number.isSafeInteger(heartbeat.pid) ||
    !Number.isFinite(heartbeat.startedAt) ||
    !Number.isFinite(heartbeat.heartbeatAt) ||
    (heartbeat.lastTickAt !== null && !Number.isFinite(heartbeat.lastTickAt)) ||
    (heartbeat.lastTickDurationMs !== null && !Number.isFinite(heartbeat.lastTickDurationMs)) ||
    !["starting", "running", "stopping", "stopped"].includes(heartbeat.state ?? "") ||
    !Number.isFinite(heartbeat.markets) ||
    !heartbeat.feeds ||
    typeof heartbeat.feeds !== "object" ||
    Array.isArray(heartbeat.feeds)
  ) {
    return null;
  }
  return heartbeat as RunnerHeartbeat;
};

export const heartbeatFailureReason = (
  heartbeat: RunnerHeartbeat | null,
  options: { now: number; expectedPid?: number; timeoutMs?: number },
): string | null => {
  if (!heartbeat) return "missing or invalid heartbeat";
  if (options.expectedPid !== undefined && heartbeat.pid !== options.expectedPid) return "heartbeat belongs to another process";
  if (heartbeat.state !== "running") return `runner state is ${heartbeat.state}`;
  const timeout = options.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  if (options.now - heartbeat.heartbeatAt > timeout) return "heartbeat has stopped updating";
  if (heartbeat.lastTickAt === null || options.now - heartbeat.lastTickAt > timeout) return "paper loop has stopped ticking";
  return null;
};

export const supervisorRestartReason = (heartbeat: RunnerHeartbeat | null, options: { now: number; expectedPid?: number; timeoutMs?: number }) => {
  const failure = heartbeatFailureReason(heartbeat, options);
  const timeout = options.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const belongsToExpectedProcess = heartbeat && (options.expectedPid === undefined || heartbeat.pid === options.expectedPid);
  const isFlushing = heartbeat && (heartbeat.state === "stopping" || heartbeat.state === "stopped");
  if (failure && failure.startsWith("runner state is ") && belongsToExpectedProcess && isFlushing && options.now - heartbeat.heartbeatAt <= timeout) {
    return null;
  }
  return failure;
};

export const restartDelayMs = (failures: number, stableForMs = 0) => {
  if (stableForMs >= STABLE_RUN_MS) return DEFAULT_RESTART_DELAY_MS;
  const exponent = Math.max(0, Math.floor(failures) - 1);
  return Math.min(MAX_RESTART_DELAY_MS, DEFAULT_RESTART_DELAY_MS * 2 ** exponent);
};

export type RunnerFeedSummary = {
  status: "HEALTHY" | "DEGRADED" | "UNKNOWN";
  core: Record<string, string>;
  coreMessageAgeMs: number | null;
  secondaryVenues: Record<string, string>;
  issues: string[];
};

export const summarizeRunnerFeeds = (feeds: Record<string, unknown>, now = Date.now(), staleAfterMs = 30_000): RunnerFeedSummary => {
  const polymarket = feeds.polymarket && typeof feeds.polymarket === "object" ? (feeds.polymarket as Record<string, unknown>) : null;
  const rawCore = polymarket ? (polymarket as Record<string, unknown>) : feeds;
  const core = Object.fromEntries(
    ["clob", "rtds", "coinbase"].map((source) => [source, typeof rawCore[source] === "string" ? (rawCore[source] as string) : "UNKNOWN"]),
  );
  const venues = feeds.venues && typeof feeds.venues === "object" ? (feeds.venues as Record<string, unknown>) : {};
  const secondaryVenues = Object.fromEntries(
    Object.entries(venues).map(([source, value]) => {
      const status = value && typeof value === "object" ? (value as Record<string, unknown>).status : null;
      return [source, typeof status === "string" ? status : "UNKNOWN"];
    }),
  );
  const rawLastMessageAt = polymarket?.lastMessageAt;
  const coreMessageAgeMs = typeof rawLastMessageAt === "number" && Number.isFinite(rawLastMessageAt) ? Math.max(0, now - rawLastMessageAt) : null;
  const issues = Object.entries(core).flatMap(([source, status]) => (status === "LIVE" ? [] : [`core feed ${source} is ${status.toLowerCase()}`]));
  if (coreMessageAgeMs === null) issues.push("no core feed message observed");
  else if (coreMessageAgeMs > staleAfterMs) issues.push(`core feed message is stale (${coreMessageAgeMs} ms old)`);
  const hasCoreState = Object.values(core).some((status) => status !== "UNKNOWN");
  return {
    status: !hasCoreState ? "UNKNOWN" : issues.length ? "DEGRADED" : "HEALTHY",
    core,
    coreMessageAgeMs,
    secondaryVenues,
    issues,
  };
};
