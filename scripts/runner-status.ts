import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { heartbeatFailureReason, parseRunnerHeartbeat, summarizeRunnerFeeds } from "./runner-health";

const args = process.argv.slice(2);
const dataIndex = args.indexOf("--data-dir");
const dataDir = resolve(dataIndex >= 0 && args[dataIndex + 1] ? args[dataIndex + 1] : "data");
const heartbeatPath = join(dataDir, "runner-heartbeat.json");
let heartbeat = null;
try {
  heartbeat = parseRunnerHeartbeat(JSON.parse(readFileSync(heartbeatPath, "utf8")) as unknown);
} catch {
  // A missing or incomplete heartbeat is reported as unhealthy below.
}

const failure = heartbeatFailureReason(heartbeat, {
  now: Date.now(),
  expectedPid: heartbeat?.pid,
});
const feedSummary = summarizeRunnerFeeds(heartbeat?.feeds ?? {}, Date.now());
let processAlive = false;
if (heartbeat) {
  try {
    process.kill(heartbeat.pid, 0);
    processAlive = true;
  } catch (error) {
    processAlive = (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const processFailure = failure ?? (processAlive ? null : "runner process is not alive");
const status = processFailure ? "UNHEALTHY" : feedSummary.status === "HEALTHY" ? "HEALTHY" : "DEGRADED";
console.log(
  JSON.stringify(
    {
      status,
      reason: processFailure ?? (feedSummary.issues.length ? feedSummary.issues.join("; ") : null),
      processStatus: processFailure ? "UNHEALTHY" : "RUNNING",
      feedSummary,
      heartbeatPath,
      heartbeat,
    },
    null,
    2,
  ),
);
if (status !== "HEALTHY") process.exitCode = 1;
