import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { buildPaperRunnerArgs, parseSupervisorArgs, runHeadlessSupervisor } from "../scripts/headless-supervisor";
import { acquireRunnerLease } from "../scripts/runner-lock";
import {
  heartbeatFailureReason,
  parseRunnerHeartbeat,
  readRunnerHeartbeatFile,
  restartDelayMs,
  summarizeRunnerFeeds,
  supervisorRestartReason,
  type RunnerHeartbeat,
  writeRunnerHeartbeat,
} from "../scripts/runner-health";

const heartbeat = (overrides: Partial<RunnerHeartbeat> = {}): RunnerHeartbeat => ({
  version: 1,
  pid: 1234,
  startedAt: 10_000,
  heartbeatAt: 20_000,
  lastTickAt: 19_900,
  lastTickDurationMs: 4,
  state: "running",
  markets: 256,
  feeds: { clob: "LIVE", rtds: "LIVE" },
  ...overrides,
});

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: (NodeJS.Signals | undefined)[] = [];

  constructor(readonly pid: number) {
    super();
  }

  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal);
    this.signalCode = signal ?? "SIGTERM";
    queueMicrotask(() => this.emit("close", null, this.signalCode));
    return true;
  }
}

describe("paper runner heartbeat and supervisor", () => {
  it("atomically writes a private heartbeat file that can be checked by the supervisor", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pqe-heartbeat-test-"));
    const path = join(dataDir, "runner-heartbeat.json");
    const current = heartbeat();
    try {
      writeRunnerHeartbeat(path, current);
      assert.deepEqual(readRunnerHeartbeatFile(path), current);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dataDir), ["runner-heartbeat.json"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed heartbeats and detects stale ticks, stale writes, and PID mismatches", () => {
    assert.equal(parseRunnerHeartbeat({ version: 1 }), null);
    assert.equal(heartbeatFailureReason(heartbeat(), { now: 25_000, expectedPid: 1234 }), null);
    assert.equal(heartbeatFailureReason(heartbeat(), { now: 51_000, expectedPid: 1234 }), "heartbeat has stopped updating");
    assert.equal(
      heartbeatFailureReason(heartbeat({ heartbeatAt: 50_000, lastTickAt: 10_000 }), { now: 51_000, expectedPid: 1234 }),
      "paper loop has stopped ticking",
    );
    assert.equal(heartbeatFailureReason(heartbeat(), { now: 25_000, expectedPid: 5678 }), "heartbeat belongs to another process");
    assert.equal(heartbeatFailureReason(heartbeat({ state: "stopping" }), { now: 25_000 }), "runner state is stopping");
    assert.equal(supervisorRestartReason(heartbeat({ state: "stopping" }), { now: 25_000 }), null);
    assert.equal(supervisorRestartReason(heartbeat({ state: "stopping" }), { now: 51_000 }), "runner state is stopping");
    assert.equal(supervisorRestartReason(heartbeat({ state: "stopping" }), { now: 25_000, expectedPid: 5678 }), "heartbeat belongs to another process");
  });

  it("keeps paper mode and recording mandatory under supervision", () => {
    const options = parseSupervisorArgs(["--", "--data-dir", "/tmp/pqe-data", "--cash", "250", "--latency", "900"]);
    assert.equal(options.dataDir, "/tmp/pqe-data");
    assert.deepEqual(options.runnerArgs, ["--cash", "250", "--latency", "900"]);
    assert.deepEqual(buildPaperRunnerArgs(options.dataDir, options.runnerArgs), ["--auto", "--data-dir", "/tmp/pqe-data", "--cash", "250", "--latency", "900"]);
    assert.throws(() => parseSupervisorArgs(["--minutes", "5"]), /Unsupported supervisor option/);
    assert.throws(() => parseSupervisorArgs(["--no-record"]), /Unsupported supervisor option/);
  });

  it("uses capped restart backoff and resets after a stable run", () => {
    assert.equal(restartDelayMs(1), 1_000);
    assert.equal(restartDelayMs(2), 2_000);
    assert.equal(restartDelayMs(20), 30_000);
    assert.equal(restartDelayMs(8, 60_000), 1_000);
  });

  it("reports process heartbeat separately from core and secondary feed health", () => {
    const fresh = summarizeRunnerFeeds(
      {
        polymarket: { clob: "LIVE", rtds: "LIVE", coinbase: "LIVE", lastMessageAt: 19_900 },
        venues: { "binance:spot": { status: "LIVE" }, "bybit:spot": { status: "DOWN" } },
      },
      20_000,
    );
    assert.equal(fresh.status, "HEALTHY");
    assert.equal(fresh.coreMessageAgeMs, 100);
    assert.deepEqual(fresh.secondaryVenues, { "binance:spot": "LIVE", "bybit:spot": "DOWN" });

    const stale = summarizeRunnerFeeds({ polymarket: { clob: "LIVE", rtds: "CONNECTING", coinbase: "LIVE", lastMessageAt: 1 }, venues: {} }, 40_000);
    assert.equal(stale.status, "DEGRADED");
    assert.deepEqual(stale.issues, ["core feed rtds is connecting", "core feed message is stale (39999 ms old)"]);
    assert.equal(summarizeRunnerFeeds({}, 20_000).status, "UNKNOWN");
  });

  it("allows one supervisor per data directory and reclaims a lease from a dead process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pqe-runner-lease-test-"));
    const lease = acquireRunnerLease(dataDir, process.pid, 10_000);
    try {
      assert.throws(() => acquireRunnerLease(dataDir, process.pid, 11_000), /already has a supervisor/);
      lease.refresh(12_000);
    } finally {
      lease.release();
    }

    const db = new DatabaseSync(join(dataDir, "runner-supervisor.sqlite"));
    try {
      db.prepare("INSERT INTO runner_lease (id, pid, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?)").run(2_147_483_647, 1, 1);
    } finally {
      db.close();
    }
    const reclaimed = acquireRunnerLease(dataDir, process.pid, 20_000);
    try {
      const check = new DatabaseSync(join(dataDir, "runner-supervisor.sqlite"));
      try {
        const row = check.prepare("SELECT pid, heartbeat_at FROM runner_lease WHERE id = 1").get() as { pid: number; heartbeat_at: number };
        assert.equal(row.pid, process.pid);
        assert.equal(row.heartbeat_at, 20_000);
      } finally {
        check.close();
      }
    } finally {
      reclaimed.release();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("kills a paper child when its heartbeat is missing and then stops cleanly", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pqe-supervisor-test-"));
    const child = new FakeChild(3210);
    const stop = new AbortController();
    const messages: string[] = [];
    let childArgs: string[] = [];
    try {
      await runHeadlessSupervisor(
        { dataDir, runnerArgs: [], heartbeatTimeoutMs: 10_000 },
        {
          spawnChild: ((_command: string, args: string[]) => {
            childArgs = args;
            return child as never;
          }) as never,
          stopSignal: stop.signal,
          monitorIntervalMs: 2,
          startupGraceMs: 0,
          staleKillGraceMs: 2,
          wait: async () => stop.abort(),
          onMessage: (message) => messages.push(message),
        },
      );
      assert.deepEqual(child.kills, ["SIGTERM"]);
      assert.ok(childArgs.includes("--auto"));
      assert.ok(childArgs.includes(dataDir));
      assert.ok(messages.some((message) => message.includes("heartbeat failed")));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
