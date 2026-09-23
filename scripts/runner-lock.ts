import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const acquireRunnerLease = (dataDir: string, pid = process.pid, now = Date.now()) => {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "runner-supervisor.sqlite"));
  db.exec(
    "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS runner_lease (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL)",
  );

  try {
    db.exec("BEGIN IMMEDIATE");
    const current = db.prepare("SELECT pid FROM runner_lease WHERE id = 1").get() as { pid: number } | undefined;
    if (current && processIsAlive(current.pid)) throw new Error(`Paper recorder already has a supervisor (pid ${current.pid}).`);
    db.prepare(
      "INSERT INTO runner_lease (id, pid, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at",
    ).run(pid, now, now);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed BEGIN or COMMIT may already have ended the transaction.
    }
    db.close();
    throw error;
  }

  let released = false;
  return {
    refresh(at = Date.now()) {
      if (released) return;
      db.prepare("UPDATE runner_lease SET heartbeat_at = ? WHERE id = 1 AND pid = ?").run(at, pid);
    },
    release() {
      if (released) return;
      released = true;
      try {
        db.prepare("DELETE FROM runner_lease WHERE id = 1 AND pid = ?").run(pid);
      } finally {
        db.close();
      }
    },
  };
};
