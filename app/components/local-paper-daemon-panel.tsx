"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PaperDaemonStatus = {
  service?: string;
  mode?: string;
  readiness?: string;
  tradingState?: string;
  lastCycleAt?: number | null;
  decisionIntervalMs?: number | null;
  marketRefreshIntervalMs?: number | null;
  lastMarketRefreshAt?: number | null;
  marketRefreshInFlight?: boolean;
  lastDecisionDurationMs?: number | null;
  lastDecisionIntervalMs?: number | null;
  decisionCycleOverruns?: number;
  lastHealthyDataAgeMs?: number | null;
  lastError?: string | null;
  marketsTracked?: number;
  usableMarkets?: number;
  controls?: { paused?: boolean; killed?: boolean; staleDataHalt?: boolean; riskHalt?: boolean };
  paper?: { cash?: number; equity?: number; totalPnl?: number; openPositions?: number };
};

const statusUrl = "http://127.0.0.1:8788/status";

function money(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value)
    : "—";
}

export default function LocalPaperDaemonPanel() {
  const [connected, setConnected] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<PaperDaemonStatus | null>(null);
  const [error, setError] = useState("");
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const [clock, setClock] = useState(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async (timeoutMs = 2500): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    try {
      const response = await fetch(statusUrl, {
        cache: "no-store",
        mode: "cors",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Local daemon returned HTTP ${response.status}.`);
      const payload = await response.json() as PaperDaemonStatus;
      if (payload.service !== "polymarket-quant-engine" || payload.mode !== "paper") {
        throw new Error("The local endpoint did not identify itself as the paper daemon.");
      }
      setStatus(payload);
      setLastSuccess(Date.now());
      setError("");
      return true;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Local daemon request failed.";
      setError(detail.toLowerCase().includes("timed out") || detail.toLowerCase().includes("signal timed out")
        ? "The browser timed out reaching localhost. Allow local network access for this Site, and confirm the terminal daemon is running."
        : detail.includes("Failed to fetch") || detail.includes("NetworkError")
        ? "The browser could not reach localhost. Allow local network access for this Site, and confirm the terminal daemon is running."
        : detail);
      return false;
    } finally {
      inFlight.current = false;
    }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    const ok = await refresh(15_000);
    if (ok) setConnected(true);
    setConnecting(false);
  }, [refresh]);

  const disconnect = useCallback(() => {
    setConnected(false);
    setStatus(null);
    setLastSuccess(null);
    setError("");
  }, []);

  useEffect(() => {
    if (!connected) return;
    const initialRefresh = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => {
      setClock(Date.now());
      void refresh();
    }, 1000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, [connected, refresh]);

  const ageMs = lastSuccess === null ? null : Math.max(0, clock - lastSuccess);
  const live = connected && ageMs !== null && ageMs < 5000;
  const ready = live && status?.readiness === "READY" && status?.tradingState === "PAPER_RUNNING";
  const state = !connected ? "DISCONNECTED" : !live ? "STALE" : status?.tradingState ?? "CONNECTED";
  const stateClass = ready ? "ready" : live ? "waiting" : "warning";
  const pnl = status?.paper?.totalPnl;

  return (
    <section className="panel" aria-label="Terminal paper daemon connection">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">LOCAL TERMINAL BRIDGE · READ ONLY</div>
          <h3>Persistent paper trader</h3>
          <p className="heading-muted">Reads the terminal daemon on this computer. Decision scans target one second; live feed updates arrive between book refreshes.</p>
        </div>
        <span className={`result-badge ${stateClass}`} aria-live="polite">{state}</span>
      </div>
      {connected && status ? (
        <div className="paper-test-stats">
          <span><b>{money(status.paper?.equity)}</b> daemon equity</span>
          <span><b>{money(status.paper?.cash)}</b> cash</span>
          <span className={typeof pnl === "number" && pnl < 0 ? "text-negative" : "text-positive"}><b>{money(pnl)}</b> total P&amp;L</span>
          <span><b>{status.paper?.openPositions ?? 0}</b> open positions</span>
          <span><b>{status.usableMarkets ?? 0}/{status.marketsTracked ?? 0}</b> usable markets</span>
          <span><b>{status.lastCycleAt ? new Date(status.lastCycleAt).toLocaleTimeString() : "—"}</b> last decision cycle</span>
        </div>
      ) : (
        <p className="risk-note">Connect to show the persistent terminal paper account here. The Site never sends orders to the daemon.</p>
      )}
      {error ? <p className="text-warning" role="status">{error}</p> : null}
      {status?.lastError ? <p className="text-warning" role="status">Daemon note: {status.lastError}</p> : null}
      <div className="paper-test-actions">
        {connected
          ? <button className="button-secondary" onClick={disconnect} type="button">DISCONNECT</button>
          : <button className="button-primary" disabled={connecting} onClick={() => void connect()} type="button">{connecting ? "CONNECTING…" : "CONNECT TO TERMINAL PAPER TRADER"}</button>}
        {lastSuccess !== null ? <span className="heading-muted">Last status: {ageMs === null ? "—" : `${Math.floor(ageMs / 1000)}s ago`}</span> : null}
      </div>
      <p className="risk-note">The daemon must be running on this same computer. Your browser may ask you to allow local network access. Decision scans run every {Math.max(1, Math.round((status?.decisionIntervalMs ?? 1000) / 1000))}s; market discovery and REST book refresh run every {Math.max(1, Math.round((status?.marketRefreshIntervalMs ?? 15000) / 1000))}s, with live stream updates between refreshes.</p>
      {status ? <p className="risk-note">Decision cadence: {status.lastDecisionIntervalMs ?? "—"} ms apart · last cycle took {status.lastDecisionDurationMs ?? "—"} ms · cycles over target: {status.decisionCycleOverruns ?? 0} · last complete REST refresh: {status.lastMarketRefreshAt ? new Date(status.lastMarketRefreshAt).toLocaleTimeString() : "waiting"}{status.marketRefreshInFlight ? " · refresh in progress" : ""}</p> : null}
    </section>
  );
}
