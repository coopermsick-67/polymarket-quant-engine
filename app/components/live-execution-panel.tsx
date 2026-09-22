"use client";

import { AlertTriangle, Check, LockKeyhole, Pause, Play, RefreshCw, ShieldCheck, SlidersHorizontal, Wallet, X, Zap } from "lucide-react";
import type { Horizon } from "../lib/polymarket-data";
import type { LiveRiskConfig } from "../lib/live-risk";

export type LiveSessionState = {
  connected: boolean;
  walletAddress: string;
  signerAddress: string;
  signatureType: number;
  balance: number | null;
  openOrders: number;
  expiresAt: number | null;
};

export type LiveExecutionStatus = {
  lastAction: string;
  lastDetail: string;
  lastError: string;
  lastLatencyMs: number | null;
};

type Props = {
  session: LiveSessionState | null;
  running: boolean;
  paused: boolean;
  consent: boolean;
  killSwitch: boolean;
  risk: LiveRiskConfig;
  marketCount: number;
  candidateCount: number;
  status: LiveExecutionStatus;
  onLink: () => void;
  onStart: () => void;
  onPause: () => void;
  onKill: () => void;
  onRefresh: () => void;
  onConsentChange: (checked: boolean) => void;
  onRiskChange: (patch: Partial<LiveRiskConfig>) => void;
};

const money = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value)
  ? "—"
  : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const percent = (value: number) => (value * 100).toFixed(value < 0.01 ? 2 : 1) + "%";

const sessionTime = (expiresAt: number | null) => {
  if (!expiresAt) return "—";
  const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s";
};

export default function LiveExecutionPanel({ session, running, paused, consent, killSwitch, risk, marketCount, candidateCount, status, onLink, onStart, onPause, onKill, onRefresh, onConsentChange, onRiskChange }: Props) {
  const baseUnit = session?.balance === null || session?.balance === undefined ? null : session.balance * risk.unitBalancePct;
  const exposureCap = session?.balance === null || session?.balance === undefined ? null : session.balance * risk.maxExposurePct;
  const maxStake = Math.min(risk.maxTradeUsd, exposureCap ?? risk.maxTradeUsd);
  const canStart = Boolean(session?.connected && consent && !running && !killSwitch);
  const toggleDuration = (duration: Horizon) => {
    const enabled = risk.allowedDurations.includes(duration);
    const next = enabled ? risk.allowedDurations.filter((item) => item !== duration) : [...risk.allowedDurations, duration];
    onRiskChange({ allowedDurations: next.length ? next : [duration] });
  };

  return (
    <section className="live-executor">
      <div className="section-heading">
        <div>
          <div className="eyebrow">LIVE EXECUTOR</div>
          <h2>Balance-aware order runner</h2>
          <p className="section-subtitle">Optional real-money execution for active Polymarket crypto 5m and 15m markets. Every order is revalidated on the server immediately before submission.</p>
        </div>
        <span className={"result-badge " + (session?.connected ? "ready" : "waiting")}>
          <span className={"status-dot " + (session?.connected ? "status-ready" : "status-locked")} />
          {session?.connected ? "LIVE SESSION" : "LOCKED"}
        </span>
      </div>

      {!session?.connected ? (
        <article className="panel live-lock-panel">
          <div className="live-lock-icon"><LockKeyhole size={23} /></div>
          <div>
            <h3>Link a wallet to arm live execution</h3>
            <p>Linking uses your private key once to derive Polymarket CLOB credentials. The browser clears the raw key after the encrypted short-lived session is established; live actions are restricted to the signed-in owner account.</p>
            <div className="gate-list">
              <div><Check size={15} /><span>Fresh Gamma market + CLOB book validation</span><b className="gate-pass">ON</b></div>
              <div><Check size={15} /><span>Balance, units, fractional Kelly, and exposure caps</span><b className="gate-pass">ON</b></div>
              <div><X size={15} /><span>Guaranteed fills or profit</span><b className="gate-pending">NEVER</b></div>
            </div>
            <button className="button-primary" onClick={onLink} type="button"><Wallet size={14} />LINK POLYMARKET WALLET</button>
          </div>
        </article>
      ) : (
        <>
          <div className="live-stat-grid">
            <article className="live-stat-card"><span>AVAILABLE USDC</span><strong>{money(session.balance)}</strong><small>fresh CLOB collateral</small></article>
            <article className="live-stat-card"><span>BASE UNIT</span><strong>{money(baseUnit)}</strong><small>{percent(risk.unitBalancePct)} of balance</small></article>
            <article className="live-stat-card"><span>MAX STAKE</span><strong>{money(maxStake)}</strong><small>Kelly + exposure capped</small></article>
            <article className="live-stat-card"><span>SESSION TTL</span><strong>{sessionTime(session.expiresAt)}</strong><small>{session.openOrders} open CLOB orders</small></article>
          </div>

          <div className="live-grid">
            <article className="panel live-control-card">
              <div className="panel-heading">
                <div><div className="eyebrow">EXECUTION CONTROL</div><h3>{running ? paused ? "Live runner paused" : "Live runner active" : "Live runner standby"}</h3></div>
                <span className={"feed-live " + (running && !paused ? "live-active" : "")}><span className={"status-dot " + (running && !paused ? "status-ready" : paused ? "status-warning" : "status-locked")} />{running ? paused ? "PAUSED" : "ARMED" : "STANDBY"}</span>
              </div>
              <div className="live-control-summary"><span><b>{marketCount}</b> validated markets</span><span><b>{candidateCount}</b> current candidates</span><span><b>{risk.allowedDurations.join(" + ")}</b> duration filter</span></div>
              <label className="live-consent"><input checked={consent} onChange={(event) => onConsentChange(event.target.checked)} type="checkbox" /><span>I understand this can place real orders using the linked wallet and that market orders can fill at variable prices.</span></label>
              <div className="live-actions">
                <button className="button-primary" disabled={!canStart} onClick={onStart} type="button"><Play fill="currentColor" size={14} />{running ? "RUNNING" : "START LIVE"}</button>
                <button className="button-secondary" disabled={!running} onClick={onPause} type="button"><Pause size={14} />{paused ? "RESUME" : "PAUSE"}</button>
                <button className="button-secondary" disabled={running} onClick={onRefresh} type="button"><RefreshCw size={14} />REFRESH BALANCE</button>
                <button className="button-danger" onClick={onKill} type="button"><Zap size={14} />KILL + CANCEL ALL</button>
              </div>
              <div className="live-session-line"><ShieldCheck size={14} /><span>{session.walletAddress.slice(0, 6)}…{session.walletAddress.slice(-4)} · signer {session.signerAddress.slice(0, 6)}…{session.signerAddress.slice(-4)} · signature type {session.signatureType}</span></div>
            </article>

            <article className="panel live-risk-card">
              <div className="panel-heading"><div><div className="eyebrow">LIVE RISK POLICY</div><h3>Units + fractional Kelly</h3></div><SlidersHorizontal size={17} className="heading-icon" /></div>
              <div className="duration-toggles"><span>MARKET DURATIONS</span>{(["5m", "15m"] as Horizon[]).map((duration) => <button className={risk.allowedDurations.includes(duration) ? "duration-toggle active" : "duration-toggle"} key={duration} onClick={() => toggleDuration(duration)} type="button">{duration}</button>)}</div>
              <div className="risk-controls live-risk-controls">
                <label className="range-control"><span><b>Units per trade</b><em>{risk.unitsPerTrade.toFixed(2)}u</em></span><input max="5" min="0.25" onChange={(event) => onRiskChange({ unitsPerTrade: Number(event.target.value) })} step="0.25" type="range" value={risk.unitsPerTrade} /></label>
                <label className="range-control"><span><b>Kelly fraction</b><em>{percent(risk.kellyFraction)}</em></span><input max="0.5" min="0.05" onChange={(event) => onRiskChange({ kellyFraction: Number(event.target.value) })} step="0.05" type="range" value={risk.kellyFraction} /></label>
                <label className="range-control"><span><b>Unit / balance</b><em>{percent(risk.unitBalancePct)}</em></span><input max="0.05" min="0.0025" onChange={(event) => onRiskChange({ unitBalancePct: Number(event.target.value) })} step="0.0025" type="range" value={risk.unitBalancePct} /></label>
                <label className="range-control"><span><b>Max trade USD</b><em>{money(risk.maxTradeUsd)}</em></span><input max="500" min="1" onChange={(event) => onRiskChange({ maxTradeUsd: Number(event.target.value) })} step="1" type="range" value={risk.maxTradeUsd} /></label>
                <label className="range-control"><span><b>Max exposure / balance</b><em>{percent(risk.maxExposurePct)}</em></span><input max="0.25" min="0.01" onChange={(event) => onRiskChange({ maxExposurePct: Number(event.target.value) })} step="0.01" type="range" value={risk.maxExposurePct} /></label>
                <label className="range-control"><span><b>Minimum net edge</b><em>{percent(risk.minEdge)}</em></span><input max="0.25" min="0.01" onChange={(event) => onRiskChange({ minEdge: Number(event.target.value) })} step="0.01" type="range" value={risk.minEdge} /></label>
              </div>
              <label className="live-checkbox"><input checked={risk.requireLock} onChange={(event) => onRiskChange({ requireLock: event.target.checked })} type="checkbox" /><span>Require LOCK tier before live submission</span></label>
              <div className="risk-note"><ShieldCheck size={15} /><span>Full Kelly is reduced by the selected fraction, then capped by unit size, max trade, exposure, balance, and a $1 minimum.</span></div>
            </article>
          </div>

          <article className="panel live-risk-card early-exit-card">
            <div className="panel-heading"><div><div className="eyebrow">MODEL-AWARE CASHOUT</div><h3>Protect profitable positions</h3></div><ShieldCheck size={17} className="heading-icon" /></div>
            <label className="live-checkbox"><input checked={risk.earlyExitEnabled} onChange={(event) => onRiskChange({ earlyExitEnabled: event.target.checked })} type="checkbox" /><span>Enable automatic early exits for live positions</span></label>
            <div className="risk-controls live-risk-controls">
              <label className="range-control"><span><b>Minimum cashout USD</b><em>{money(risk.earlyExitMinProfitUsd)}</em></span><input disabled={!risk.earlyExitEnabled} max="50" min="0" onChange={(event) => onRiskChange({ earlyExitMinProfitUsd: Number(event.target.value) })} step="1" type="range" value={risk.earlyExitMinProfitUsd} /></label>
              <label className="range-control"><span><b>Minimum profit</b><em>{percent(risk.earlyExitMinProfitPct)}</em></span><input disabled={!risk.earlyExitEnabled} max="1" min="0" onChange={(event) => onRiskChange({ earlyExitMinProfitPct: Number(event.target.value) })} step="0.05" type="range" value={risk.earlyExitMinProfitPct} /></label>
              <label className="range-control"><span><b>Bid above model by</b><em>{percent(risk.earlyExitModelGap)}</em></span><input disabled={!risk.earlyExitEnabled} max="0.15" min="0.01" onChange={(event) => onRiskChange({ earlyExitModelGap: Number(event.target.value) })} step="0.01" type="range" value={risk.earlyExitModelGap} /></label>
              <label className="range-control"><span><b>Confirmations</b><em>{risk.earlyExitConfirmations} ticks</em></span><input disabled={!risk.earlyExitEnabled} max="4" min="1" onChange={(event) => onRiskChange({ earlyExitConfirmations: Number(event.target.value) })} step="1" type="range" value={risk.earlyExitConfirmations} /></label>
              <label className="range-control"><span><b>Minimum time left</b><em>{risk.earlyExitMinRemainingSeconds}s</em></span><input disabled={!risk.earlyExitEnabled} max="300" min="0" onChange={(event) => onRiskChange({ earlyExitMinRemainingSeconds: Number(event.target.value) })} step="15" type="range" value={risk.earlyExitMinRemainingSeconds} /></label>
            </div>
            <div className="risk-note"><ShieldCheck size={15} /><span>It sells only after the current executable bid is above the model fair value by the configured gap and the position clears both profit thresholds on repeated ticks. The server rechecks everything before selling.</span></div>
          </article>

          <article className="panel live-status-card">
            <div className="panel-heading"><div><div className="eyebrow">ORDER STATUS</div><h3>Execution audit</h3></div><span className="panel-footnote"><LockKeyhole size={13} /> Server validated</span></div>
            {status.lastError ? <div className="data-alert"><AlertTriangle size={15} /><div><strong>Runner stopped safely</strong><span>{status.lastError}</span></div></div> : <div className="live-status-row"><span className="status-dot status-ready" /><strong>{status.lastAction || "No live order attempted"}</strong><span>{status.lastDetail || "Start remains opt-in and locked until you confirm the risk notice."}</span><b>{status.lastLatencyMs === null ? "—" : String(status.lastLatencyMs) + " ms"}</b></div>}
            <div className="risk-note"><AlertTriangle size={15} /><span>Keep this tab open while the browser loop is active. A closed or sleeping tab stops new submissions; it does not create a background 24/7 trading process.</span></div>
          </article>
        </>
      )}
    </section>
  );
}
